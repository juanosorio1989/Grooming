import { Injectable } from "@nestjs/common";
import type { Prisma } from "@prisma/client";
import type { AccessClaims, Locale, MeExport } from "@grooming/contracts";
import { AuditService } from "../audit/audit.service.js";
import { APPOINTMENT_VIEW_INCLUDE, appointmentStartsAt, toAppointmentView } from "../booking/appointment-view.js";
import { AppointmentsService } from "../booking/appointments.service.js";
import { HoldReleaseService } from "../booking/hold-release.service.js";
import { PetsService, withVaccines } from "../pets/pets.service.js";
import { PrismaService } from "../prisma/prisma.service.js";
import { RateLimitService } from "../rate-limit/rate-limit.service.js";
import { TenancyService } from "../tenancy/tenancy.service.js";
import { assertActiveCustomer } from "./active-customer.js";
import { CUSTOMER_AUDIT_PII_KEYS } from "./customers.service.js";

/** `GET /me/export` per customer: 5 per hour. */
const EXPORT_PER_CUSTOMER = [5, 3600] as const;

export const MEDIA_PURGE_EVENT = "media.purge";
export const ACCOUNT_DELETED_REASON = "ACCOUNT_DELETED";
export const DELETED_PET_NAME = "Deleted pet";

/** Media kinds that belong to the owner's profile and go with the account. Visit media (BEFORE, AFTER, STEP) stay for the shop. */
const PROFILE_MEDIA_KINDS = ["PET_PHOTO", "VACCINE_CARD"] as const;

/**
 * The owner's own data: `export` (everything the shop holds about them) and
 * `delete` (irreversible anonymization of the customer, their pets and identities).
 */
@Injectable()
export class AccountService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly tenancy: TenancyService,
    private readonly audit: AuditService,
    private readonly rateLimit: RateLimitService,
    private readonly pets: PetsService,
    private readonly appointments: AppointmentsService,
    private readonly release: HoldReleaseService,
  ) {}

  /**
   * Deleted customer 401 first, then the rate limit (`me:export:<customerId>`, 5 per hour).
   * Live pets with vaccines; bookings only (holds and released holds are left out);
   * media rows of every pet of the customer, without links. Never private notes or
   * provider subjects.
   */
  async export(p: AccessClaims): Promise<MeExport> {
    const orgId = await this.tenancy.getOrgId();
    await assertActiveCustomer(this.prisma, orgId, p.sub);
    await this.rateLimit.enforce(`me:export:${p.sub}`, ...EXPORT_PER_CUSTOMER);

    const customer = await this.prisma.customer.findFirstOrThrow({ where: { id: p.sub, organizationId: orgId } });
    const [identities, consents, pets, appointments, media] = await Promise.all([
      this.prisma.customerIdentity.findMany({
        where: { organizationId: orgId, customerId: p.sub },
        select: { provider: true, email: true, createdAt: true },
        orderBy: { provider: "asc" },
      }),
      this.prisma.notificationConsent.findMany({
        where: { organizationId: orgId, customerId: p.sub },
        orderBy: [{ changedAt: "asc" }, { id: "asc" }],
      }),
      this.prisma.pet.findMany({
        where: { organizationId: orgId, customerId: p.sub, deletedAt: null },
        include: withVaccines,
        orderBy: [{ name: "asc" }, { id: "asc" }],
      }),
      // Same filter as the owner's appointment list: real bookings, never holds.
      this.prisma.appointment.findMany({
        where: { organizationId: orgId, customerId: p.sub, status: { not: "HELD" }, holdExpiresAt: null },
        include: APPOINTMENT_VIEW_INCLUDE,
        orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      }),
      this.prisma.media.findMany({
        where: { organizationId: orgId, pet: { customerId: p.sub } },
        select: { id: true, kind: true, petId: true, createdAt: true },
        orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      }),
    ]);

    return {
      exportedAt: new Date().toISOString(),
      customer: {
        id: customer.id,
        name: customer.name,
        phone: customer.phoneE164,
        email: customer.email,
        locale: customer.locale as Locale,
        emergencyPhone: customer.emergencyPhoneE164,
        createdAt: customer.createdAt.toISOString(),
      },
      identities: identities.map((i) => ({ provider: i.provider, email: i.email, linkedAt: i.createdAt.toISOString() })),
      consents: consents.map((c) => ({ channel: c.channel, granted: c.granted, source: c.source, changedAt: c.changedAt.toISOString() })),
      pets: pets.map((row) => this.pets.view(row)),
      appointments: appointments.map(toAppointmentView),
      media: media.map((m) => ({ id: m.id, kind: m.kind, petId: m.petId, createdAt: m.createdAt.toISOString() })),
    };
  }

  /**
   * `DELETE /me`, one transaction. Lock order: customer `FOR UPDATE` → pets → appointments
   * (the order every write on this branch follows). Deleted customer → 401.
   *
   * 1. Not-yet-started appointments of the customer: HELD → released (`HOLD_RELEASED`, by
   *    CUSTOMER; no outbox row), BOOKED → `cancelInTx` with reason `ACCOUNT_DELETED`.
   *    IN_SHOP, started and finished appointments are untouched.
   * 2. Pets: PET_PHOTO / VACCINE_CARD media → one `media.purge` outbox row with their keys,
   *    photo links nulled, vaccines deleted, those media rows deleted. Every pet anonymized;
   *    live pets get `deletedAt = now` (already removed pets keep their deletion time).
   * 3. Identities deleted; unprocessed outbox rows whose payload names this customer deleted.
   * 4. Customer anonymized (`phoneE164 = "deleted:" + id` keeps the per-org unique index),
   *    `deletedAt = now`. Consents stay as evidence.
   * 5. Customer refresh tokens revoked.
   * 6. PII keys stripped from this customer's audit rows, then audit `customer.delete`.
   *
   * Visits, visit media and payments stay for the shop, detached through the anonymized pet.
   */
  async delete(p: AccessClaims, ip: string | null): Promise<void> {
    const orgId = await this.tenancy.getOrgId();
    const customerId = p.sub;
    await this.prisma.$transaction(async (tx) => {
      const now = new Date();
      await assertActiveCustomer(tx, orgId, customerId, "update");

      const petRows = await tx.$queryRaw<{ id: string; deleted_at: Date | null }[]>`
        SELECT id, deleted_at FROM pet
        WHERE customer_id = ${customerId}::uuid AND organization_id = ${orgId}::uuid
        ORDER BY id
        FOR UPDATE`;
      const petIds = petRows.map((r) => r.id);
      const petsDeleted = petRows.filter((r) => r.deleted_at === null).length;

      const appointmentsCancelled = await this.endFutureAppointments(tx, orgId, customerId, now, ip);

      if (petIds.length > 0) await this.anonymizePets(tx, orgId, petIds, now);

      await tx.customerIdentity.deleteMany({ where: { organizationId: orgId, customerId } });
      await tx.$executeRaw`
        DELETE FROM outbox_event
        WHERE organization_id = ${orgId}::uuid AND processed_at IS NULL AND payload->>'customerId' = ${customerId}`;

      await tx.customer.update({
        where: { id: customerId },
        data: { name: null, email: null, emergencyPhoneE164: null, privateNotesEnc: null, phoneE164: `deleted:${customerId}`, deletedAt: now },
      });

      await tx.refreshToken.updateMany({
        where: { subjectType: "CUSTOMER", subjectId: customerId, revokedAt: null },
        data: { revokedAt: now },
      });

      const keys = [...CUSTOMER_AUDIT_PII_KEYS];
      await tx.$executeRaw`
        UPDATE audit_log SET
          before = CASE WHEN jsonb_typeof(before) = 'object' THEN before - ${keys}::text[] ELSE before END,
          after = CASE WHEN jsonb_typeof(after) = 'object' THEN after - ${keys}::text[] ELSE after END
        WHERE organization_id = ${orgId}::uuid AND entity = 'customer' AND entity_id = ${customerId}`;

      await this.audit.record(
        {
          orgId,
          actorType: "CUSTOMER",
          actorId: customerId,
          action: "customer.delete",
          entity: "customer",
          entityId: customerId,
          after: { petsDeleted, appointmentsCancelled },
          ip,
        },
        tx,
      );
    });
  }

  /** Releases future holds and cancels future bookings of the customer (rows locked in id order). Returns the bookings cancelled. */
  private async endFutureAppointments(
    tx: Prisma.TransactionClient,
    orgId: string,
    customerId: string,
    now: Date,
    ip: string | null,
  ): Promise<number> {
    const locked = await tx.$queryRaw<{ id: string }[]>`
      SELECT id FROM appointment
      WHERE customer_id = ${customerId}::uuid AND organization_id = ${orgId}::uuid AND status IN ('HELD', 'BOOKED')
      ORDER BY id
      FOR UPDATE`;
    if (locked.length === 0) return 0;
    const rows = await tx.appointment.findMany({
      where: { id: { in: locked.map((r) => r.id) }, organizationId: orgId },
      select: {
        id: true,
        status: true,
        bookingMode: true,
        dropOffAt: true,
        segments: { select: { stage: true, startsAt: true, occupies: true } },
      },
      orderBy: { id: "asc" },
    });
    let cancelled = 0;
    for (const a of rows) {
      const startsAt = appointmentStartsAt(a, a.segments);
      // Not yet started only; an appointment without any time is never a running visit.
      if (startsAt !== null && startsAt.getTime() <= now.getTime()) continue;
      if (a.status === "HELD") {
        // A hold is not a booking: no appointment.cancelled notice.
        await this.release.release(tx, a.id, "HOLD_RELEASED", "CUSTOMER");
      } else if (a.status === "BOOKED") {
        await this.appointments.cancelInTx(tx, { id: a.id, organizationId: orgId }, {
          actorType: "CUSTOMER",
          actorId: customerId,
          reason: ACCOUNT_DELETED_REASON,
          ip,
        });
        cancelled += 1;
      }
    }
    return cancelled;
  }

  /** Profile media purge (FK order: photo link and vaccines first) and pet anonymization. */
  private async anonymizePets(tx: Prisma.TransactionClient, orgId: string, petIds: string[], now: Date): Promise<void> {
    const profileMedia = await tx.media.findMany({
      where: { organizationId: orgId, petId: { in: petIds }, kind: { in: [...PROFILE_MEDIA_KINDS] } },
      select: { id: true, objectKey: true },
      orderBy: { id: "asc" },
    });
    if (profileMedia.length > 0) {
      await tx.outboxEvent.create({
        data: { organizationId: orgId, type: MEDIA_PURGE_EVENT, payload: { objectKeys: profileMedia.map((m) => m.objectKey) } },
      });
    }
    await tx.pet.updateMany({
      where: { id: { in: petIds }, organizationId: orgId },
      data: {
        photoMediaId: null,
        name: DELETED_PET_NAME,
        breed: "-",
        breedCode: null,
        birthDate: null,
        medicalNotesEnc: null,
        behaviorNotes: null,
        vetName: null,
        vetPhoneE164: null,
        allergies: [],
        temperament: [],
      },
    });
    await tx.pet.updateMany({ where: { id: { in: petIds }, organizationId: orgId, deletedAt: null }, data: { deletedAt: now } });
    await tx.petVaccine.deleteMany({ where: { organizationId: orgId, petId: { in: petIds } } });
    if (profileMedia.length > 0) {
      await tx.media.deleteMany({ where: { organizationId: orgId, id: { in: profileMedia.map((m) => m.id) } } });
    }
  }
}
