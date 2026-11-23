import { BadRequestException, ConflictException, Injectable, NotFoundException, UnauthorizedException } from "@nestjs/common";
import { AvailabilityError, findSlots, validatePlan, type PetRequest, type PlanVerdict, type Slot } from "@grooming/availability";
import type { AccessClaims, HoldPet, StaffAppointmentView, StaffBooking, StaffMove, StaffStatus, WalkIn } from "@grooming/contracts";
import { addDays, localDayBoundsUtc, todayIn, utcToWall, type IsoDate } from "@grooming/datetime";
import type { ServicePriceRow } from "@grooming/pricing";
import type { AppointmentSource, Prisma } from "@prisma/client";
import { AuditService } from "../audit/audit.service.js";
import { AvailabilityContextLoader } from "../availability/context-loader.js";
import { resolveBookingMode } from "../availability/context-mapper.js";
import { assertActiveCustomer } from "../customers/active-customer.js";
import { LocationService } from "../location/location.service.js";
import { PetsService, type PetActor } from "../pets/pets.service.js";
import { PrismaService } from "../prisma/prisma.service.js";
import { TenancyService } from "../tenancy/tenancy.service.js";
import { APPOINTMENT_VIEW_INCLUDE, appointmentStartsAt, toStaffAppointmentView } from "./appointment-view.js";
import { APPOINTMENT_BOOKED_EVENT, AppointmentsService } from "./appointments.service.js";
import { HoldReleaseService } from "./hold-release.service.js";
import { assertNewPetSizes, PetRequestResolver, type ResolvedPets } from "./pet-requests.js";
import { PlanWriter } from "./plan-writer.js";
import { engineError, slotFromView, verdictError } from "./slot-codec.js";

const MINUTE = 60_000;
/** A slot further than this from now is rejected before any calendar math (same guard as holds). */
const MAX_SLOT_DISTANCE_MS = 400 * 24 * 60 * MINUTE;

const notFound = () => new NotFoundException({ code: "NOT_FOUND" });
const conflict = (message: string) => new ConflictException({ code: "CONFLICT", message });
const petUnavailable = () => new ConflictException({ code: "PET_UNAVAILABLE", message: "A pet of this booking is no longer available" });

/**
 * Staff-visible appointments: real bookings only. Holds (live or released) carry
 * `hold_expires_at`; staff and confirmed bookings never do.
 */
const staffWhere = (orgId: string, id: string): Prisma.AppointmentWhereInput => ({
  id,
  organizationId: orgId,
  status: { not: "HELD" },
  holdExpiresAt: null,
});

/** A validated plan ready to write as a staff booking or walk-in. */
interface StaffWrite {
  customerId: string;
  entries: HoldPet[];
  pets: PetRequest[];
  slot: Slot;
  prices: ServicePriceRow[];
  locationId: string;
  override: boolean;
  source: Extract<AppointmentSource, "RECEPTION" | "WALK_IN">;
  notes: string | null;
}

/**
 * Staff bookings (OWNER, RECEPTION): book for a customer from a staff-mode
 * `/availability` slot, walk-in (the first slot starting now), move, cancel or
 * mark no-show, and read one appointment (EMPLOYEE only when a segment is theirs).
 * Staff mode: no lead time, horizon or online-bookable checks; `override`
 * ignores working hours, location hours and drop-off windows. No cancel window.
 */
@Injectable()
export class StaffAppointmentsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly tenancy: TenancyService,
    private readonly locations: LocationService,
    private readonly loader: AvailabilityContextLoader,
    private readonly resolver: PetRequestResolver,
    private readonly planWriter: PlanWriter,
    private readonly release: HoldReleaseService,
    private readonly pets: PetsService,
    private readonly audit: AuditService,
    private readonly appointments: AppointmentsService,
  ) {}

  /** One appointment; an EMPLOYEE sees it only with a segment assigned to them (else 404). */
  async get(p: AccessClaims, id: string): Promise<StaffAppointmentView> {
    const orgId = await this.tenancy.getOrgId();
    const where: Prisma.AppointmentWhereInput =
      p.role === "EMPLOYEE" ? { ...staffWhere(orgId, id), segments: { some: { staffUserId: p.sub } } } : staffWhere(orgId, id);
    const row = await this.prisma.appointment.findFirst({ where, include: APPOINTMENT_VIEW_INCLUDE });
    if (!row) throw notFound();
    return toStaffAppointmentView(row);
  }

  /**
   * Books `body.pets` for the customer on a slot from staff `/availability`
   * (with the same `override`). Validated outside the transaction: customer
   * (404), pets, new-pet sizes, slot, booking mode and `validatePlan` in STAFF mode.
   */
  async create(p: AccessClaims, body: StaffBooking, ip: string | null): Promise<StaffAppointmentView> {
    const location = await this.locations.getDefault();
    const { pets, labels } = await this.staffPets(body.pets, body.customerId, location.settings.sizeThresholdsLb);
    const slot = slotFromView(body.slot, labels);
    if (Math.abs(slot.start - Date.now()) > MAX_SLOT_DISTANCE_MS) throw fieldError("slot.startsAt", "Out of range");
    const { rows, context, bookingMode } = await this.loadDay(utcToWall(slot.start, location.timezone).date, location.timezone, pets);
    if (slot.bookingMode !== bookingMode) throw fieldError("slot.bookingMode", `Must be ${bookingMode}`);
    let verdict: PlanVerdict;
    try {
      verdict = validatePlan({ ...context, mode: "STAFF", override: body.override, bookingMode, pets }, slot);
    } catch (err) {
      throw err instanceof AvailabilityError ? engineError(err) : err;
    }
    if (!verdict.ok) throw verdictError(verdict.reason);
    return this.write(p, ip, {
      customerId: body.customerId,
      entries: body.pets,
      pets,
      slot,
      prices: rows.prices,
      locationId: location.id,
      override: body.override,
      source: "RECEPTION",
      notes: body.notes ?? null,
    });
  }

  /**
   * Walk-in: the first STAFF-mode slot of today (local). The engine's earliest
   * start is now rounded down to the grid; the slot is taken only when it starts
   * within one slot interval of now, else 409 SLOT_TAKEN with detail NO_SLOT_NOW.
   */
  async walkIn(p: AccessClaims, body: WalkIn, ip: string | null): Promise<StaffAppointmentView> {
    const location = await this.locations.getDefault();
    const { pets } = await this.staffPets(body.pets, body.customerId, location.settings.sizeThresholdsLb);
    const today = todayIn(location.timezone, Date.now());
    const { rows, context, bookingMode } = await this.loadDay(today, location.timezone, pets);
    let first: Slot | undefined;
    try {
      first = findSlots({ ...context, mode: "STAFF", override: body.override, date: today, bookingMode, pets })[0];
    } catch (err) {
      throw err instanceof AvailabilityError ? engineError(err) : err;
    }
    if (!first || first.start > context.now + location.settings.slotIntervalMin * MINUTE) {
      throw new ConflictException({ code: "SLOT_TAKEN", message: "NO_SLOT_NOW" });
    }
    return this.write(p, ip, {
      customerId: body.customerId,
      entries: body.pets,
      pets,
      slot: first,
      prices: rows.prices,
      locationId: location.id,
      override: body.override,
      source: "WALK_IN",
      notes: null,
    });
  }

  /**
   * New times from a slot of staff `/availability?excludeAppointmentId=<id>`.
   * A deleted customer's appointment is 404; the rest is `replaceSlot` in
   * STAFF mode (status first, no cancel window).
   */
  async move(p: AccessClaims, id: string, body: StaffMove, ip: string | null): Promise<StaffAppointmentView> {
    const orgId = await this.tenancy.getOrgId();
    const found = await this.prisma.appointment.findFirst({
      where: { ...staffWhere(orgId, id), customer: { deletedAt: null } },
      select: { id: true },
    });
    if (!found) throw notFound();
    await this.appointments.replaceSlot(id, body.slot, {
      mode: "STAFF",
      override: body.override,
      action: "appointment.move",
      actorType: "STAFF",
      actorId: p.sub,
      ip,
    });
    return this.get(p, id);
  }

  /**
   * CANCEL: a BOOKED appointment → `cancelInTx` with the reason. NO_SHOW: a
   * BOOKED appointment whose start has passed → NO_SHOW, visits NO_SHOW (a
   * cancelled visit stays CANCELLED), every segment stops occupying, audit
   * `appointment.no_show`, no outbox. Anything else is 409 CONFLICT.
   */
  async setStatus(p: AccessClaims, id: string, body: StaffStatus, ip: string | null): Promise<StaffAppointmentView> {
    const orgId = await this.tenancy.getOrgId();
    return this.prisma.$transaction(async (tx) => {
      const now = new Date();
      await this.release.releaseExpired(tx, now, orgId);
      await tx.$queryRaw`SELECT id FROM appointment WHERE id = ${id}::uuid AND organization_id = ${orgId}::uuid FOR UPDATE`;
      const row = await tx.appointment.findFirst({ where: staffWhere(orgId, id), include: APPOINTMENT_VIEW_INCLUDE });
      if (!row) throw notFound();
      if (row.status !== "BOOKED") throw conflict("The appointment is not booked");
      if (body.action === "CANCEL") {
        await this.appointments.cancelInTx(tx, row, { actorType: "STAFF", actorId: p.sub, reason: body.reason ?? null, ip });
      } else {
        const startsAt = appointmentStartsAt(row, row.petVisits.flatMap((v) => v.segments));
        if (startsAt === null || now.getTime() < startsAt.getTime()) throw conflict("The appointment has not started yet");
        await tx.appointment.update({ where: { id }, data: { status: "NO_SHOW", manageVersion: { increment: 1 } } });
        await tx.appointmentSegment.updateMany({ where: { appointmentId: id, organizationId: orgId }, data: { occupies: false } });
        await tx.petVisit.updateMany({
          where: { appointmentId: id, organizationId: orgId, status: { not: "CANCELLED" } },
          data: { status: "NO_SHOW" },
        });
        await this.audit.record(
          {
            orgId,
            actorType: "STAFF",
            actorId: p.sub,
            action: "appointment.no_show",
            entity: "appointment",
            entityId: id,
            before: { status: "BOOKED" },
            after: { status: "NO_SHOW", startsAt: startsAt.toISOString() },
            ip,
          },
          tx,
        );
      }
      return toStaffAppointmentView(await tx.appointment.findUniqueOrThrow({ where: { id }, include: APPOINTMENT_VIEW_INCLUDE }));
    });
  }

  /** Entries resolved for an active customer of this organization (unknown or deleted 404), plus the new-pet size check. */
  private async staffPets(
    entries: HoldPet[],
    customerId: string,
    thresholds: Parameters<typeof assertNewPetSizes>[1],
  ): Promise<ResolvedPets> {
    let resolved: ResolvedPets;
    try {
      resolved = await this.resolver.resolve(entries, customerId);
    } catch (err) {
      // With an owner the resolver's only 401 is `assertActiveCustomer` (that 401 is for customer tokens).
      if (err instanceof UnauthorizedException) throw notFound();
      throw err;
    }
    assertNewPetSizes(entries, thresholds);
    return resolved;
  }

  /** Context for `date` plus one extra local day (kennel blocks can run past midnight) and the booking mode of the pets' services. */
  private async loadDay(date: IsoDate, tz: string, pets: PetRequest[]) {
    const { rows, context } = await this.loader.load({
      from: new Date(localDayBoundsUtc(date, tz).start),
      to: new Date(localDayBoundsUtc(addDays(date, 1), tz).end),
    });
    const requested = new Set(pets.flatMap((p) => p.serviceIds));
    const bookingMode = resolveBookingMode(rows.services.filter((s) => requested.has(s.id)), rows.location.settings.defaultBookingMode);
    return { rows, context, bookingMode };
  }

  /**
   * One transaction: release expired holds → lock the customer (`FOR UPDATE`;
   * deleted 404) → lock the saved pets (`FOR SHARE`; gone 409 PET_UNAVAILABLE)
   * → create the new pets → BOOKED appointment (`hold_expires_at` stays null) →
   * plan rows → audit `appointment.create` → outbox `appointment.booked`.
   * A lost race on a segment is 23P01 → 409 SLOT_TAKEN.
   */
  private async write(p: AccessClaims, ip: string | null, w: StaffWrite): Promise<StaffAppointmentView> {
    const orgId = await this.tenancy.getOrgId();
    return this.prisma.$transaction(async (tx) => {
      await this.release.releaseExpired(tx, new Date(), orgId);
      try {
        // FOR UPDATE, not FOR SHARE: `createInTx` locks the customer FOR UPDATE too (an upgrade would deadlock).
        await assertActiveCustomer(tx, orgId, w.customerId, "update");
      } catch (err) {
        if (err instanceof UnauthorizedException) throw notFound();
        throw err;
      }
      const savedIds = w.entries.flatMap((e) => ("petId" in e ? [e.petId] : []));
      const live = await this.appointments.lockLivePets(tx, orgId, w.customerId, savedIds);
      if (savedIds.some((id) => !live.has(id))) throw petUnavailable();

      const actor: PetActor = { type: "STAFF", claims: p };
      const petIds: string[] = [];
      for (const [i, e] of w.entries.entries()) {
        if ("petId" in e) {
          petIds.push(e.petId);
          continue;
        }
        const request = w.pets[i]!;
        const created = await this.pets.createInTx(
          tx,
          actor,
          w.customerId,
          {
            name: e.name,
            species: e.species,
            breed: e.breed,
            breedCode: e.breedCode,
            weightG: e.weightG,
            sizeClass: request.sizeClass,
            coatType: request.coatType,
          },
          ip,
        );
        petIds.push(created.id);
      }

      const appt = await tx.appointment.create({
        data: {
          organizationId: orgId,
          locationId: w.locationId,
          customerId: w.customerId,
          status: "BOOKED",
          source: w.source,
          bookingMode: w.slot.bookingMode,
          dropOffAt: w.slot.bookingMode === "DROP_OFF" ? new Date(w.slot.start) : null,
          estimatedReadyAt: new Date(w.slot.readyAt),
          notes: w.notes,
          createdByStaffId: p.sub,
        },
        select: { id: true },
      });
      // The plan still names a new pet by its ref (as validated); `petIds` holds the saved id per position.
      await this.planWriter.insert(tx, appt.id, {
        orgId,
        locationId: w.locationId,
        slot: w.slot,
        pets: w.pets,
        petIds,
        pendingPets: petIds.map(() => null),
        prices: w.prices,
      });
      await this.audit.record(
        {
          orgId,
          actorType: "STAFF",
          actorId: p.sub,
          action: "appointment.create",
          entity: "appointment",
          entityId: appt.id,
          after: {
            source: w.source,
            status: "BOOKED",
            override: w.override,
            customerId: w.customerId,
            petIds,
            startsAt: new Date(w.slot.start).toISOString(),
            readyAt: new Date(w.slot.readyAt).toISOString(),
          },
          ip,
        },
        tx,
      );
      await tx.outboxEvent.create({ data: { organizationId: orgId, type: APPOINTMENT_BOOKED_EVENT, payload: { appointmentId: appt.id } } });
      return toStaffAppointmentView(await tx.appointment.findUniqueOrThrow({ where: { id: appt.id }, include: APPOINTMENT_VIEW_INCLUDE }));
    });
  }
}

function fieldError(path: string, message: string): BadRequestException {
  return new BadRequestException({ code: "VALIDATION_FAILED", message: "Validation failed", errors: [{ path, message }] });
}
