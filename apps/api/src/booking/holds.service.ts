import { BadRequestException, ConflictException, Injectable, NotFoundException } from "@nestjs/common";
import { AvailabilityError, validatePlan, type PlanVerdict } from "@grooming/availability";
import type { AccessClaims, HoldRequest, HoldResponse, HoldView } from "@grooming/contracts";
import { addDays, localDayBoundsUtc, utcToWall } from "@grooming/datetime";
import type { BookingMode, Prisma } from "@prisma/client";
import { AvailabilityContextLoader } from "../availability/context-loader.js";
import { resolveBookingMode } from "../availability/context-mapper.js";
import { assertActiveCustomer } from "../customers/active-customer.js";
import { LocationService } from "../location/location.service.js";
import { PrismaService } from "../prisma/prisma.service.js";
import { RateLimitService } from "../rate-limit/rate-limit.service.js";
import { TenancyService } from "../tenancy/tenancy.service.js";
import { HoldReleaseService } from "./hold-release.service.js";
import { findPetMatches, parsePendingPet } from "./pet-matches.js";
import { assertNewPetSizes, PetRequestResolver } from "./pet-requests.js";
import { PlanWriter, type PendingPet } from "./plan-writer.js";
import { engineError, slotFromView, verdictError } from "./slot-codec.js";

/** Rate limit on `POST /holds` per client IP: [limit, window seconds]. */
const PER_IP = [20, 600] as const;
const MINUTE = 60_000;
/** A slot further than this from now is rejected before any calendar math (far years would break the time zone code). */
const MAX_SLOT_DISTANCE_MS = 400 * 24 * 60 * MINUTE;

/** A HELD appointment the principal may use (see `loadUsable`). */
export interface HeldAppointment {
  id: string;
  organizationId: string;
  locationId: string;
  /** Null for an anonymous hold. */
  customerId: string | null;
  holdExpiresAt: Date;
  bookingMode: BookingMode;
  dropOffAt: Date | null;
  estimatedReadyAt: Date | null;
}

const HELD_SELECT = {
  id: true,
  organizationId: true,
  locationId: true,
  customerId: true,
  holdExpiresAt: true,
  bookingMode: true,
  dropOffAt: true,
  estimatedReadyAt: true,
} satisfies Prisma.AppointmentSelect;

const notFound = () => new NotFoundException({ code: "NOT_FOUND" });

/**
 * Slot holds: a HELD appointment with the exact plan the client picked from
 * `/availability`, re-checked with `validatePlan` and written in one
 * transaction. Holds expire after `settings.holdMinutes`; the sweeper and every
 * booking write release expired ones. No audit and no outbox for holds.
 */
@Injectable()
export class HoldsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly tenancy: TenancyService,
    private readonly locations: LocationService,
    private readonly loader: AvailabilityContextLoader,
    private readonly resolver: PetRequestResolver,
    private readonly planWriter: PlanWriter,
    private readonly release: HoldReleaseService,
    private readonly rateLimit: RateLimitService,
  ) {}

  async create(body: HoldRequest, principal: AccessClaims | undefined, ip: string): Promise<HoldResponse> {
    await this.rateLimit.enforce(`holds:ip:${this.rateLimit.hashKeyPart(ip)}`, ...PER_IP);
    const location = await this.locations.getDefault();
    const { settings, timezone } = location;

    // Validate outside the transaction. The resolver runs first so a deleted customer is 401 before any 400.
    const { pets, labels } = await this.resolver.resolve(body.pets, principal?.sub ?? null);
    assertNewPetSizes(body.pets, settings.sizeThresholdsLb);
    const slot = slotFromView(body.slot, labels);
    if (Math.abs(slot.start - Date.now()) > MAX_SLOT_DISTANCE_MS) throw fieldError("slot.startsAt", "Out of range");
    const day = utcToWall(slot.start, timezone).date;
    const orgId = await this.tenancy.getOrgId();
    // Only the principal's own HELD hold is left out of the busy segments; anything else excludes nothing.
    const replaced = body.replaceHoldId === undefined ? null : await this.replaceable(this.prisma, orgId, body.replaceHoldId, principal);
    // One extra local day: kennel blocks can run past midnight.
    const { rows, context } = await this.loader.load(
      { from: new Date(localDayBoundsUtc(day, timezone).start), to: new Date(localDayBoundsUtc(addDays(day, 1), timezone).end) },
      { excludeAppointmentId: replaced?.status === "HELD" ? replaced.id : undefined },
    );
    const requested = new Set(pets.flatMap((p) => p.serviceIds));
    const bookingMode = resolveBookingMode(rows.services.filter((s) => requested.has(s.id)), settings.defaultBookingMode);
    if (slot.bookingMode !== bookingMode) throw fieldError("slot.bookingMode", `Must be ${bookingMode}`);
    let verdict: PlanVerdict;
    try {
      verdict = validatePlan({ ...context, mode: "ONLINE", bookingMode, pets }, slot);
    } catch (err) {
      throw err instanceof AvailabilityError ? engineError(err) : err;
    }
    if (!verdict.ok) throw verdictError(verdict.reason);

    const petIds = body.pets.map((p) => ("petId" in p ? p.petId : null));
    const pendingPets = body.pets.map((p): PendingPet | null =>
      "ref" in p
        ? { ref: p.ref, species: p.species, name: p.name, breed: p.breed, breedCode: p.breedCode ?? null, weightG: p.weightG ?? null }
        : null,
    );
    // A lost race on any segment is a 23P01 here, answered as 409 SLOT_TAKEN by the problem filter.
    return this.prisma.$transaction(async (tx) => {
      const now = new Date();
      // Customer first (the branch lock order): a concurrent `DELETE /me` either commits first (401 here)
      // or waits for this hold and then releases it. The check above ran outside this transaction.
      if (principal) await assertActiveCustomer(tx, orgId, principal.sub, "update");
      // Then the hold being replaced (customer → appointment), and only then other expired holds.
      if (body.replaceHoldId !== undefined) {
        await tx.$queryRaw`SELECT id FROM appointment WHERE id = ${body.replaceHoldId}::uuid AND organization_id = ${orgId}::uuid FOR UPDATE`;
      }
      await this.release.releaseExpired(tx, now, orgId);
      if (body.replaceHoldId !== undefined) {
        // Re-read in the transaction: it may have expired (just released) or been confirmed since.
        const row = await this.replaceable(tx, orgId, body.replaceHoldId, principal);
        if (row.status === "HELD") await this.release.release(tx, row.id, "HOLD_RELEASED", "CUSTOMER");
      }
      const expiresAt = new Date(now.getTime() + settings.holdMinutes * MINUTE);
      const appt = await tx.appointment.create({
        data: {
          organizationId: orgId,
          locationId: location.id,
          customerId: principal?.sub ?? null,
          status: "HELD",
          source: "ONLINE",
          bookingMode,
          holdExpiresAt: expiresAt,
          dropOffAt: bookingMode === "DROP_OFF" ? new Date(slot.start) : null,
          estimatedReadyAt: new Date(slot.readyAt),
        },
        select: { id: true },
      });
      await this.planWriter.insert(tx, appt.id, { orgId, locationId: location.id, slot, pets, petIds, pendingPets, prices: rows.prices });
      return { holdId: appt.id, expiresAt: expiresAt.toISOString() };
    });
  }

  async view(holdId: string, principal: AccessClaims | undefined): Promise<HoldView> {
    const orgId = await this.tenancy.getOrgId();
    if (principal) await assertActiveCustomer(this.prisma, orgId, principal.sub);
    const held = await this.loadUsable(this.prisma, holdId, principal);
    if (held.holdExpiresAt.getTime() <= Date.now()) throw new ConflictException({ code: "HOLD_EXPIRED", message: "The hold has expired" });

    const [visits, segments] = await Promise.all([
      this.prisma.petVisit.findMany({
        where: { appointmentId: held.id, organizationId: orgId },
        orderBy: { position: "asc" },
        select: { id: true, petId: true, pendingPet: true, priceCentsQuoted: true, pet: { select: { name: true } } },
      }),
      this.prisma.appointmentSegment.findMany({
        where: { appointmentId: held.id, organizationId: orgId, stage: { not: "KENNEL" } },
        select: { startsAt: true, endsAt: true },
      }),
    ]);
    const pending = visits.map((v) => parsePendingPet(v.pendingPet));
    const matches = principal
      ? await findPetMatches(this.prisma, orgId, principal.sub, pending.filter((p): p is PendingPet => p !== null))
      : new Map<string, HoldView["pets"][number]["matches"]>();

    const firstStart = minTime(segments.map((s) => s.startsAt));
    const startsAt = held.bookingMode === "DROP_OFF" && held.dropOffAt ? held.dropOffAt : firstStart;
    const readyAt = held.estimatedReadyAt ?? maxTime(segments.map((s) => s.endsAt));
    if (startsAt === null || readyAt === null) throw new Error(`HoldsService.view: hold ${held.id} has no times`);
    return {
      holdId: held.id,
      expiresAt: held.holdExpiresAt.toISOString(),
      bookingMode: held.bookingMode,
      startsAt: startsAt.toISOString(),
      readyAt: readyAt.toISOString(),
      pets: visits.map((v, i) => {
        const p = pending[i] ?? null;
        return {
          visitId: v.id,
          petId: v.petId,
          ref: p?.ref ?? null,
          name: v.pet?.name ?? p?.name ?? "",
          priceCents: v.priceCentsQuoted,
          matches: p ? (matches.get(p.ref) ?? []) : [],
        };
      }),
    };
  }

  async cancel(holdId: string, principal: AccessClaims | undefined): Promise<void> {
    const orgId = await this.tenancy.getOrgId();
    if (principal) await assertActiveCustomer(this.prisma, orgId, principal.sub);
    await this.prisma.$transaction(async (tx) => {
      // Loaded org-scoped first: `release` itself has no organization filter.
      const held = await this.loadUsable(tx, holdId, principal);
      if (!(await this.release.release(tx, held.id, "HOLD_RELEASED", "CUSTOMER"))) throw notFound();
    });
  }

  /**
   * `replaceHoldId`: an id that does not exist in this organization, or an
   * appointment of another customer, is 404. The principal's own appointment
   * is returned when it is HELD (to release) or CANCELLED (expired or
   * released: ignored, the client cannot know it expired). Any other status
   * (BOOKED, IN_SHOP, COMPLETED, NO_SHOW) is 404: a live booking is never
   * replaced or left out of the busy segments.
   */
  private async replaceable(
    db: Prisma.TransactionClient,
    orgId: string,
    id: string,
    principal: AccessClaims | undefined,
  ): Promise<{ id: string; status: "HELD" | "CANCELLED" }> {
    const row = await db.appointment.findFirst({ where: { id, organizationId: orgId }, select: { id: true, status: true, customerId: true } });
    if (!row || (row.customerId !== null && row.customerId !== principal?.sub)) throw notFound();
    if (row.status !== "HELD" && row.status !== "CANCELLED") throw notFound();
    return { id: row.id, status: row.status };
  }

  /**
   * Shared with confirm: loads a HELD appointment of this organization that the
   * principal may use. A hold with `customerId` is usable only by that
   * customer's token; an anonymous hold by anyone holding the id. 404 when
   * missing, not HELD, or owned by another customer. Does not check expiry.
   * With `lock`, takes `FOR UPDATE` on the row first (inside a transaction), so
   * a concurrent confirm or release waits and then sees the new status.
   */
  async loadUsable(
    tx: Prisma.TransactionClient,
    holdId: string,
    principal: AccessClaims | undefined,
    opts: { lock?: boolean } = {},
  ): Promise<HeldAppointment> {
    const orgId = await this.tenancy.getOrgId();
    if (opts.lock) {
      await tx.$queryRaw`SELECT id FROM appointment WHERE id = ${holdId}::uuid AND organization_id = ${orgId}::uuid FOR UPDATE`;
    }
    const row = await tx.appointment.findFirst({ where: { id: holdId, organizationId: orgId, status: "HELD" }, select: HELD_SELECT });
    if (!row || row.holdExpiresAt === null) throw notFound();
    if (row.customerId !== null && row.customerId !== principal?.sub) throw notFound();
    return { ...row, holdExpiresAt: row.holdExpiresAt };
  }
}

function fieldError(path: string, message: string): BadRequestException {
  return new BadRequestException({ code: "VALIDATION_FAILED", message: "Validation failed", errors: [{ path, message }] });
}

const minTime = (ds: Date[]) => ds.reduce<Date | null>((m, d) => (m === null || d < m ? d : m), null);
const maxTime = (ds: Date[]) => ds.reduce<Date | null>((m, d) => (m === null || d > m ? d : m), null);
