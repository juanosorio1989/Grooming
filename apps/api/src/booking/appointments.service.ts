import { BadRequestException, ConflictException, Injectable, NotFoundException } from "@nestjs/common";
import { AvailabilityError, validatePlan, type PlanVerdict } from "@grooming/availability";
import type { AccessClaims, AppointmentCreate, AppointmentView, MeAppointmentsQuery, Reschedule, SlotView } from "@grooming/contracts";
import { addDays, localDayBoundsUtc, utcToWall } from "@grooming/datetime";
import { Prisma } from "@prisma/client";
import { AuditService } from "../audit/audit.service.js";
import { AvailabilityContextLoader } from "../availability/context-loader.js";
import { resolveBookingMode } from "../availability/context-mapper.js";
import { assertActiveCustomer } from "../customers/active-customer.js";
import { LocationService } from "../location/location.service.js";
import { PetsService, type PetActor } from "../pets/pets.service.js";
import { PrismaService } from "../prisma/prisma.service.js";
import { TenancyService } from "../tenancy/tenancy.service.js";
import { APPOINTMENT_VIEW_INCLUDE, appointmentStartsAt, toAppointmentView, type AppointmentWithVisits } from "./appointment-view.js";
import { HoldReleaseService } from "./hold-release.service.js";
import { HoldsService } from "./holds.service.js";
import { findPetMatches, parsePendingPet } from "./pet-matches.js";
import { PetRequestResolver } from "./pet-requests.js";
import { PlanWriter } from "./plan-writer.js";
import { engineError, slotFromView, verdictError } from "./slot-codec.js";

/** Outbox type written when a booking is made. */
export const APPOINTMENT_BOOKED_EVENT = "appointment.booked";
/** Outbox type written when a booking gets new times (reschedule or staff move). */
export const APPOINTMENT_CHANGED_EVENT = "appointment.changed";
/** Outbox type written when a booking is cancelled. */
export const APPOINTMENT_CANCELLED_EVENT = "appointment.cancelled";

const HOUR = 3_600_000;
/** `upcoming` keeps an appointment for this long after its start (a visit in progress). */
const UPCOMING_GRACE_MS = 12 * HOUR;
/** Most appointments `scope=past` returns. */
const PAST_LIMIT = 50;
/** A slot further than this from now is rejected before any calendar math (same guard as holds). */
const MAX_SLOT_DISTANCE_MS = 400 * 24 * HOUR;

/**
 * Appointments a customer sees: theirs, in this organization, and real bookings.
 * `hold_expires_at` is null on every booking (confirm clears it, staff bookings never
 * set it) and set on every hold, live or released, so this also leaves out HELD rows
 * and released holds (CANCELLED, possibly with a pending pet the view cannot show).
 */
const mineWhere = (orgId: string, customerId: string): Prisma.AppointmentWhereInput => ({
  organizationId: orgId,
  customerId,
  status: { not: "HELD" },
  holdExpiresAt: null,
});

/** Who cancels, for `cancelInTx`. `reason` goes to `cancel_reason` (null for an owner cancel). */
export interface CancelBy {
  actorType: "CUSTOMER" | "STAFF";
  actorId: string;
  reason: string | null;
  ip: string | null;
}

/** Options of `replaceSlot` (owner reschedule or staff move). */
export interface ReplaceSlotOptions {
  mode: "ONLINE" | "STAFF";
  override: boolean;
  action: "appointment.reschedule" | "appointment.move";
  actorType: "CUSTOMER" | "STAFF";
  actorId: string;
  ip: string | null;
}

const notFound = () => new NotFoundException({ code: "NOT_FOUND" });
const notBooked = () => new ConflictException({ code: "CONFLICT", message: "The appointment is not booked" });

const holdExpired = () => new ConflictException({ code: "HOLD_EXPIRED", message: "The hold has expired" });
const petUnavailable = () => new ConflictException({ code: "PET_UNAVAILABLE", message: "A pet of this booking is no longer available" });

/**
 * Owner bookings. `confirm` turns a hold into a BOOKED appointment of the
 * signed-in customer, saving its new pets (or using the saved pets the owner
 * picked as the same animal). The owner lists, reads, cancels and reschedules
 * their bookings; `cancelInTx` and `replaceSlot` are shared with staff writes.
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
    private readonly locations: LocationService,
    private readonly loader: AvailabilityContextLoader,
    private readonly resolver: PetRequestResolver,
    private readonly planWriter: PlanWriter,
  ) {}

  /**
   * `upcoming`: BOOKED or IN_SHOP with `startsAt >= now - 12 h`, ascending.
   * `past`: every other booking of the customer, descending, at most 50.
   * Holds (live or released) are never listed.
   */
  async listMine(p: AccessClaims, q: MeAppointmentsQuery): Promise<AppointmentView[]> {
    const orgId = await this.tenancy.getOrgId();
    await assertActiveCustomer(this.prisma, orgId, p.sub);
    // Light rows first: `startsAt` is derived (drop-off time or first work segment), so it is
    // computed here with the shared rule, then only the chosen appointments are loaded in full.
    const light = await this.prisma.appointment.findMany({
      where: mineWhere(orgId, p.sub),
      select: { id: true, status: true, bookingMode: true, dropOffAt: true, segments: { select: { stage: true, startsAt: true } } },
    });
    const cutoff = Date.now() - UPCOMING_GRACE_MS;
    const timed = light.map((a) => ({ id: a.id, status: a.status, start: appointmentStartsAt(a, a.segments)?.getTime() ?? 0 }));
    const isUpcoming = (a: (typeof timed)[number]) => (a.status === "BOOKED" || a.status === "IN_SHOP") && a.start >= cutoff;
    const chosen =
      q.scope === "upcoming"
        ? timed.filter(isUpcoming).sort((a, b) => a.start - b.start || a.id.localeCompare(b.id))
        : timed
            .filter((a) => !isUpcoming(a))
            .sort((a, b) => b.start - a.start || b.id.localeCompare(a.id))
            .slice(0, PAST_LIMIT);
    if (chosen.length === 0) return [];
    const rows = await this.prisma.appointment.findMany({
      where: { ...mineWhere(orgId, p.sub), id: { in: chosen.map((a) => a.id) } },
      include: APPOINTMENT_VIEW_INCLUDE,
    });
    const byId = new Map(rows.map((r) => [r.id, r]));
    return chosen.flatMap((a) => {
      const row = byId.get(a.id);
      return row ? [toAppointmentView(row)] : [];
    });
  }

  /** One booking of the signed-in customer; another customer's, a hold or an unknown id is 404. */
  async getMine(p: AccessClaims, id: string): Promise<AppointmentView> {
    const orgId = await this.tenancy.getOrgId();
    await assertActiveCustomer(this.prisma, orgId, p.sub);
    const row = await this.prisma.appointment.findFirst({ where: { ...mineWhere(orgId, p.sub), id }, include: APPOINTMENT_VIEW_INCLUDE });
    if (!row) throw notFound();
    return toAppointmentView(row);
  }

  /** Owner cancel: only BOOKED (409 CONFLICT) and only while `now <= startsAt - cancelWindowHours` (409 OUTSIDE_CANCEL_WINDOW). */
  async cancelMine(p: AccessClaims, id: string, ip: string | null): Promise<AppointmentView> {
    const orgId = await this.tenancy.getOrgId();
    await assertActiveCustomer(this.prisma, orgId, p.sub);
    const { settings } = await this.locations.getDefault();
    return this.prisma.$transaction(async (tx) => {
      const now = new Date();
      await this.release.releaseExpired(tx, now, orgId);
      // The row lock makes a concurrent cancel, reschedule or staff write wait, then see the new state.
      await this.lockAppointment(tx, orgId, id);
      const row = await tx.appointment.findFirst({ where: { ...mineWhere(orgId, p.sub), id }, include: APPOINTMENT_VIEW_INCLUDE });
      if (!row) throw notFound();
      assertOwnerMayChange(row, settings.cancelWindowHours, now);
      await this.cancelInTx(tx, row, { actorType: "CUSTOMER", actorId: p.sub, reason: null, ip });
      return toAppointmentView(await tx.appointment.findUniqueOrThrow({ where: { id: row.id }, include: APPOINTMENT_VIEW_INCLUDE }));
    });
  }

  /**
   * Owner reschedule to a slot from `/availability?excludeAppointmentId=<id>`:
   * same status and window rules as cancel, then `replaceSlot` in ONLINE mode.
   * Pets and services cannot change (they are rebuilt from the appointment).
   */
  async rescheduleMine(p: AccessClaims, id: string, body: Reschedule, ip: string | null): Promise<AppointmentView> {
    const orgId = await this.tenancy.getOrgId();
    await assertActiveCustomer(this.prisma, orgId, p.sub);
    const { settings } = await this.locations.getDefault();
    const row = await this.prisma.appointment.findFirst({ where: { ...mineWhere(orgId, p.sub), id }, include: APPOINTMENT_VIEW_INCLUDE });
    if (!row) throw notFound();
    assertOwnerMayChange(row, settings.cancelWindowHours, new Date());
    return this.replaceSlot(id, body.slot, {
      mode: "ONLINE",
      override: false,
      action: "appointment.reschedule",
      actorType: "CUSTOMER",
      actorId: p.sub,
      ip,
    });
  }

  /**
   * Cancels a BOOKED appointment the caller loaded org-scoped and locked
   * (`FOR UPDATE`) in `tx`: status CANCELLED, cancelledAt, cancelReason,
   * cancelledBy, every segment `occupies = false`, every visit CANCELLED,
   * manageVersion + 1, outbox `appointment.cancelled`, audit `appointment.cancel`.
   * 409 CONFLICT when it is not BOOKED (the update is conditional on it).
   * Shared with staff cancel and account deletion.
   */
  async cancelInTx(tx: Prisma.TransactionClient, appt: { id: string; organizationId: string }, by: CancelBy): Promise<void> {
    const now = new Date();
    const { count } = await tx.appointment.updateMany({
      where: { id: appt.id, organizationId: appt.organizationId, status: "BOOKED" },
      data: { status: "CANCELLED", cancelledAt: now, cancelReason: by.reason, cancelledBy: by.actorType, manageVersion: { increment: 1 } },
    });
    if (count === 0) throw notBooked();
    await tx.appointmentSegment.updateMany({ where: { appointmentId: appt.id, organizationId: appt.organizationId }, data: { occupies: false } });
    await tx.petVisit.updateMany({ where: { appointmentId: appt.id, organizationId: appt.organizationId }, data: { status: "CANCELLED" } });
    await tx.outboxEvent.create({
      data: { organizationId: appt.organizationId, type: APPOINTMENT_CANCELLED_EVENT, payload: { appointmentId: appt.id } },
    });
    await this.audit.record(
      {
        orgId: appt.organizationId,
        actorType: by.actorType,
        actorId: by.actorId,
        action: "appointment.cancel",
        entity: "appointment",
        entityId: appt.id,
        before: { status: "BOOKED" },
        after: { status: "CANCELLED", reason: by.reason },
        ip: by.ip,
      },
      tx,
    );
  }

  /**
   * New times for a BOOKED appointment, from a slot the client got from
   * `/availability` with `excludeAppointmentId`. Callers check ownership (and,
   * for owners, the window) first. Validated outside the transaction: pets
   * rebuilt with `fromAppointment` (404/409), the slot must list those pets in
   * that order (400 `slot.pets`), the context loaded without the appointment's
   * own segments, booking mode, `validatePlan` (`verdictError`). Then one
   * transaction: release expired holds → lock the row `FOR UPDATE` → re-check
   * BOOKED (409 CONFLICT) → `PlanWriter.replace` → booking mode, manageVersion
   * + 1 → outbox `appointment.changed` → audit `opts.action` with before/after
   * times and `override`. A lost race is 23P01 → 409 SLOT_TAKEN and nothing changes.
   */
  async replaceSlot(id: string, view: SlotView, opts: ReplaceSlotOptions): Promise<AppointmentView> {
    const orgId = await this.tenancy.getOrgId();
    const location = await this.locations.getDefault();
    const { pets, labels } = await this.resolver.fromAppointment(id);
    const slot = slotFromView(view, labels);
    if (slot.pets.length !== pets.length || slot.pets.some((sp, i) => sp.petId !== pets[i]?.petId)) {
      throw fieldError("slot.pets", "Must list the appointment's pets in the same order");
    }
    if (Math.abs(slot.start - Date.now()) > MAX_SLOT_DISTANCE_MS) throw fieldError("slot.startsAt", "Out of range");
    const tz = location.timezone;
    const day = utcToWall(slot.start, tz).date;
    // One extra local day: kennel blocks can run past midnight. The appointment's own segments are not busy.
    const { rows, context } = await this.loader.load(
      { from: new Date(localDayBoundsUtc(day, tz).start), to: new Date(localDayBoundsUtc(addDays(day, 1), tz).end) },
      { excludeAppointmentId: id },
    );
    const requested = new Set(pets.flatMap((pet) => pet.serviceIds));
    const bookingMode = resolveBookingMode(rows.services.filter((s) => requested.has(s.id)), location.settings.defaultBookingMode);
    if (slot.bookingMode !== bookingMode) throw fieldError("slot.bookingMode", `Must be ${bookingMode}`);
    let verdict: PlanVerdict;
    try {
      verdict = validatePlan({ ...context, mode: opts.mode, override: opts.override, bookingMode, pets }, slot);
    } catch (err) {
      throw err instanceof AvailabilityError ? engineError(err) : err;
    }
    if (!verdict.ok) throw verdictError(verdict.reason);

    return this.prisma.$transaction(async (tx) => {
      await this.release.releaseExpired(tx, new Date(), orgId);
      await this.lockAppointment(tx, orgId, id);
      const current = await tx.appointment.findFirst({ where: { id, organizationId: orgId }, select: { status: true } });
      if (!current) throw notFound();
      if (current.status !== "BOOKED") throw notBooked();
      // Old segments are deleted before the new ones go in; a lost race (23P01) rolls both back.
      const times = await this.planWriter.replace(tx, id, { orgId, locationId: location.id, slot, pets, prices: rows.prices });
      await tx.appointment.update({ where: { id }, data: { bookingMode: slot.bookingMode, manageVersion: { increment: 1 } } });
      await tx.outboxEvent.create({ data: { organizationId: orgId, type: APPOINTMENT_CHANGED_EVENT, payload: { appointmentId: id } } });
      await this.audit.record(
        {
          orgId,
          actorType: opts.actorType,
          actorId: opts.actorId,
          action: opts.action,
          entity: "appointment",
          entityId: id,
          before: times.before,
          after: { ...times.after, override: opts.override },
          ip: opts.ip,
        },
        tx,
      );
      return toAppointmentView(await tx.appointment.findUniqueOrThrow({ where: { id }, include: APPOINTMENT_VIEW_INCLUDE }));
    });
  }

  /** `FOR UPDATE` on the appointment row when it is in this organization (no row, no lock). */
  private async lockAppointment(tx: Prisma.TransactionClient, orgId: string, id: string): Promise<void> {
    await tx.$queryRaw`SELECT id FROM appointment WHERE id = ${id}::uuid AND organization_id = ${orgId}::uuid FOR UPDATE`;
  }
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

/**
 * Owner cancel and reschedule rule: only BOOKED (409 CONFLICT), and only while
 * `now <= startsAt - cancelWindowHours` (409 OUTSIDE_CANCEL_WINDOW). `startsAt`
 * is the one the view shows (`appointmentStartsAt`).
 */
function assertOwnerMayChange(row: AppointmentWithVisits, cancelWindowHours: number, now: Date): void {
  if (row.status !== "BOOKED") throw notBooked();
  const startsAt = appointmentStartsAt(row, row.petVisits.flatMap((v) => v.segments));
  if (startsAt === null || now.getTime() > startsAt.getTime() - cancelWindowHours * HOUR) {
    throw new ConflictException({ code: "OUTSIDE_CANCEL_WINDOW", message: "Too late to change this appointment online" });
  }
}

function fieldError(path: string, message: string): BadRequestException {
  return new BadRequestException({ code: "VALIDATION_FAILED", message: "Validation failed", errors: [{ path, message }] });
}
