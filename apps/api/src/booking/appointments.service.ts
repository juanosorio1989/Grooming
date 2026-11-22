import { BadRequestException, ConflictException, Injectable } from "@nestjs/common";
import type { AccessClaims, AppointmentCreate, AppointmentView } from "@grooming/contracts";
import { Prisma } from "@prisma/client";
import { AuditService } from "../audit/audit.service.js";
import { assertActiveCustomer } from "../customers/active-customer.js";
import { PetsService, type PetActor } from "../pets/pets.service.js";
import { PrismaService } from "../prisma/prisma.service.js";
import { TenancyService } from "../tenancy/tenancy.service.js";
import { APPOINTMENT_VIEW_INCLUDE, toAppointmentView } from "./appointment-view.js";
import { HoldReleaseService } from "./hold-release.service.js";
import { HoldsService } from "./holds.service.js";
import { findPetMatches, parsePendingPet } from "./pet-matches.js";

/** Outbox type written when a booking is made. */
export const APPOINTMENT_BOOKED_EVENT = "appointment.booked";

const holdExpired = () => new ConflictException({ code: "HOLD_EXPIRED", message: "The hold has expired" });
const petUnavailable = () => new ConflictException({ code: "PET_UNAVAILABLE", message: "A pet of this booking is no longer available" });

/**
 * Owner bookings. `confirm` turns a hold into a BOOKED appointment of the
 * signed-in customer, saving its new pets (or using the saved pets the owner
 * picked as the same animal).
 */
@Injectable()
export class AppointmentsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly tenancy: TenancyService,
    private readonly holds: HoldsService,
    private readonly release: HoldReleaseService,
    private readonly pets: PetsService,
    private readonly audit: AuditService,
  ) {}

  async confirm(p: AccessClaims, body: AppointmentCreate, ip: string | null): Promise<AppointmentView> {
    const orgId = await this.tenancy.getOrgId();
    await assertActiveCustomer(this.prisma, orgId, p.sub);

    // 1. An expired hold is released in its own transaction, which commits before the 409.
    const expired = await this.prisma.$transaction(async (tx) => {
      const held = await this.holds.loadUsable(tx, body.holdId, p);
      if (held.holdExpiresAt.getTime() > Date.now()) return false;
      await this.release.release(tx, held.id, "HOLD_EXPIRED", "SYSTEM");
      return true;
    });
    if (expired) throw holdExpired();

    return this.prisma.$transaction(async (tx) => {
      const now = new Date();
      await this.release.releaseExpired(tx, now, orgId);
      // FOR UPDATE, not FOR SHARE: `createInTx` locks the customer FOR UPDATE, and upgrading a
      // share lock two transactions hold would deadlock. Customer before appointment, always.
      await assertActiveCustomer(tx, orgId, p.sub, "update");
      // 2. The row lock makes a concurrent confirm wait, then see BOOKED (404).
      const held = await this.holds.loadUsable(tx, body.holdId, p, { lock: true });
      if (held.holdExpiresAt.getTime() <= now.getTime()) throw holdExpired();

      const visits = await tx.petVisit.findMany({
        where: { appointmentId: held.id, organizationId: orgId },
        orderBy: { position: "asc" },
        select: { id: true, petId: true, pendingPet: true, sizeClassAtBooking: true, coatTypeAtBooking: true },
      });
      const savedIds = visits.flatMap((v) => (v.petId ? [v.petId] : []));

      // 3. Pending pets: a picked saved pet must be one of the matches, else the pet is created.
      const pending = visits.flatMap((v) => {
        const pet = parsePendingPet(v.pendingPet);
        return pet ? [{ visit: v, pet }] : [];
      });
      const usePets = body.usePets ?? {};
      const refs = new Set(pending.map((x) => x.pet.ref));
      const errors = Object.keys(usePets)
        .filter((ref) => !refs.has(ref))
        .map((ref) => ({ path: `usePets.${ref}`, message: "No new pet with this ref in the hold" }));
      const matches = await findPetMatches(tx, orgId, p.sub, pending.map((x) => x.pet));
      const used = new Set(savedIds);
      for (const { pet } of pending) {
        const choice = usePets[pet.ref];
        if (choice === undefined) continue;
        if (!(matches.get(pet.ref) ?? []).some((m) => m.petId === choice)) {
          errors.push({ path: `usePets.${pet.ref}`, message: "Not a matching pet of this customer" });
        } else if (used.has(choice)) {
          errors.push({ path: `usePets.${pet.ref}`, message: "The pet is already in this booking" });
        }
        used.add(choice);
      }
      const chosen = pending.flatMap(({ pet }) => (usePets[pet.ref] ? [usePets[pet.ref]!] : []));
      // Saved and chosen pets are locked in one id-ordered statement, like PetMergeService, so a
      // concurrent merge of two of them cannot deadlock with this booking.
      const live = await this.lockLivePets(tx, orgId, p.sub, [...savedIds, ...chosen]);
      if (savedIds.some((id) => !live.has(id))) throw petUnavailable();
      if (errors.length > 0) throw new BadRequestException({ code: "VALIDATION_FAILED", message: "Validation failed", errors });
      if (chosen.some((id) => !live.has(id))) throw petUnavailable();

      const actor: PetActor = { type: "CUSTOMER", claims: p };
      for (const { visit, pet } of pending) {
        const petId =
          usePets[pet.ref] ??
          (
            await this.pets.createInTx(
              tx,
              actor,
              p.sub,
              {
                name: pet.name,
                species: pet.species,
                breed: pet.breed,
                breedCode: pet.breedCode,
                weightG: pet.weightG,
                sizeClass: visit.sizeClassAtBooking,
                coatType: visit.coatTypeAtBooking,
              },
              ip,
            )
          ).id;
        await tx.petVisit.update({ where: { id: visit.id }, data: { petId, pendingPet: Prisma.DbNull } });
      }

      // 4. The booking itself, its audit row and its outbox row.
      await tx.appointment.update({
        where: { id: held.id },
        data: { customerId: p.sub, status: "BOOKED", holdExpiresAt: null, notes: body.notes ?? null },
      });
      await this.audit.record(
        {
          orgId,
          actorType: "CUSTOMER",
          actorId: p.sub,
          action: "appointment.create",
          entity: "appointment",
          entityId: held.id,
          after: { source: "ONLINE", status: "BOOKED", petVisitIds: visits.map((v) => v.id) },
          ip,
        },
        tx,
      );
      await tx.outboxEvent.create({ data: { organizationId: orgId, type: APPOINTMENT_BOOKED_EVENT, payload: { appointmentId: held.id } } });

      const row = await tx.appointment.findUniqueOrThrow({ where: { id: held.id }, include: APPOINTMENT_VIEW_INCLUDE });
      return toAppointmentView(row);
    });
  }

  /**
   * `FOR SHARE`, in id order, on the given pets that are the customer's, in
   * this organization and not deleted, so a concurrent delete or merge waits
   * for the booking. Returns the ids that qualified.
   */
  private async lockLivePets(tx: Prisma.TransactionClient, orgId: string, customerId: string, ids: string[]): Promise<Set<string>> {
    const unique = [...new Set(ids)];
    if (unique.length === 0) return new Set();
    const rows = await tx.$queryRaw<{ id: string }[]>`
      SELECT id FROM pet
      WHERE id IN (${Prisma.join(unique.map((id) => Prisma.sql`${id}::uuid`))})
        AND organization_id = ${orgId}::uuid AND customer_id = ${customerId}::uuid AND deleted_at IS NULL
      ORDER BY id
      FOR SHARE`;
    return new Set(rows.map((r) => r.id));
  }
}
