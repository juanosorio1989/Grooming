import { BadRequestException, ForbiddenException, Injectable, Logger, NotFoundException, UnauthorizedException } from "@nestjs/common";
import { AvailabilityError, findSlots, type Slot } from "@grooming/availability";
import type { AccessClaims, AvailabilityQuery, AvailabilityResponse } from "@grooming/contracts";
import { addDays, datesInRange, localDayBoundsUtc } from "@grooming/datetime";
import { PetRequestResolver, type ResolvedPets } from "../booking/pet-requests.js";
import { engineError, toSlotView } from "../booking/slot-codec.js";
import { assertActiveCustomer } from "../customers/active-customer.js";
import { LocationService } from "../location/location.service.js";
import { PrismaService } from "../prisma/prisma.service.js";
import { RateLimitService } from "../rate-limit/rate-limit.service.js";
import { TenancyService } from "../tenancy/tenancy.service.js";
import { AvailabilityContextLoader } from "./context-loader.js";
import { resolveBookingMode } from "./context-mapper.js";

/** Rate limit per client IP: [limit, window seconds]. */
const PER_IP = [120, 600] as const;

/**
 * Slots for owners, anonymous visitors and staff. The mode comes from the
 * principal.
 *
 * Customer or anonymous (engine mode ONLINE): saved pets (`petId`) need a
 * customer token and must belong to that customer; inline pets (`ref`) work
 * for anyone. A token whose customer is soft-deleted is 401. The staff-only
 * params `override` and `customerId` are 403. Reschedule
 * (`excludeAppointmentId`, customer token only): the pets come from that
 * BOOKED appointment of the customer and its own segments are not busy.
 * Rate limited per client IP.
 *
 * Staff (OWNER or RECEPTION, engine mode STAFF, `override` from the query):
 * no lead time, horizon or online-bookable checks, and no rate limit. Saved
 * pets need `customerId` (400 on `customerId`) and must belong to that active
 * customer; an unknown or deleted customer is 404. `excludeAppointmentId`
 * may be any BOOKED appointment of the organization; `customerId` with it is
 * 400 (the appointment already names the customer).
 *
 * Engine input errors become 400, never 500.
 */
@Injectable()
export class AvailabilityService {
  private readonly logger = new Logger(AvailabilityService.name);

  constructor(
    private readonly loader: AvailabilityContextLoader,
    private readonly locations: LocationService,
    private readonly resolver: PetRequestResolver,
    private readonly rateLimit: RateLimitService,
    private readonly prisma: PrismaService,
    private readonly tenancy: TenancyService,
  ) {}

  async find(q: AvailabilityQuery, principal: AccessClaims | undefined, ip: string): Promise<AvailabilityResponse> {
    const exclude = q.excludeAppointmentId;
    const staff = principal?.typ === "staff";
    // Staff-only params are refused, not ignored, for customers and anonymous visitors.
    if (!staff && (q.override !== undefined || q.customerId !== undefined)) throw new ForbiddenException({ code: "FORBIDDEN" });
    // Reschedule needs a token (customer or staff).
    if (exclude !== undefined && principal === undefined) throw new UnauthorizedException({ code: "UNAUTHORIZED" });
    // The schema refine already requires exactly one of `pets` and `excludeAppointmentId`.
    if (exclude === undefined && q.pets === undefined) throw fieldError("pets", "Required");
    if (staff && exclude !== undefined && q.customerId !== undefined) {
      throw fieldError("customerId", "Not allowed with excludeAppointmentId");
    }
    if (staff && q.customerId === undefined && (q.pets ?? []).some((p) => "petId" in p)) {
      throw fieldError("customerId", "Required with a saved pet (petId)");
    }
    if (!staff) await this.rateLimit.enforce(`availability:ip:${this.rateLimit.hashKeyPart(ip)}`, ...PER_IP);
    const { pets, labels } = staff
      ? exclude !== undefined
        ? await this.staffRescheduledPets(exclude)
        : await this.staffPets(q.pets ?? [], q.customerId ?? null)
      : exclude !== undefined && principal !== undefined
        ? await this.rescheduledPets(exclude, principal)
        : await this.resolver.resolve(q.pets ?? [], principal?.sub ?? null);

    const { timezone } = await this.locations.getDefault();
    const to = q.to ?? q.from;
    // One extra local day: kennel blocks can run past midnight.
    // Reschedule: the appointment's own segments are not busy.
    const { rows, context } = await this.loader.load(
      { from: new Date(localDayBoundsUtc(q.from, timezone).start), to: new Date(localDayBoundsUtc(addDays(to, 1), timezone).end) },
      { excludeAppointmentId: exclude },
    );
    const requested = new Set(pets.flatMap((p) => p.serviceIds));
    const bookingMode = resolveBookingMode(
      rows.services.filter((s) => requested.has(s.id)),
      rows.location.settings.defaultBookingMode,
    );

    const mode = staff ? "STAFF" : "ONLINE";
    const override = staff ? (q.override ?? false) : false;
    const slots: Slot[] = [];
    const t0 = performance.now();
    try {
      for (const date of datesInRange(q.from, to)) {
        slots.push(...findSlots({ ...context, mode, override, date, bookingMode, pets }));
      }
    } catch (err) {
      throw err instanceof AvailabilityError ? engineError(err) : err;
    }
    // Timing of the slot search, to size the `/availability` limits later.
    const ms = Math.round(performance.now() - t0);
    const timing = { dates: datesInRange(q.from, to).length, pets: pets.length, ms };
    if (ms > 1000) this.logger.warn(`slow availability search ${JSON.stringify(timing)}`);
    else this.logger.debug(`availability search ${JSON.stringify(timing)}`);
    return { bookingMode, slots: slots.map((s) => toSlotView(s, labels)) };
  }

  /** The pets of a BOOKED appointment of the signed-in customer (401 when deleted, else 404), rebuilt with `fromAppointment`. */
  private async rescheduledPets(appointmentId: string, principal: AccessClaims): Promise<ResolvedPets> {
    const orgId = await this.tenancy.getOrgId();
    await assertActiveCustomer(this.prisma, orgId, principal.sub);
    const appt = await this.prisma.appointment.findFirst({
      where: { id: appointmentId, organizationId: orgId, customerId: principal.sub, status: "BOOKED" },
      select: { id: true },
    });
    if (!appt) throw new NotFoundException({ code: "NOT_FOUND" });
    return this.resolver.fromAppointment(appt.id);
  }

  /** Staff: entries resolved for `customerId`; an unknown or deleted customer is 404 (the resolver's 401 is for customer tokens). */
  private async staffPets(entries: NonNullable<AvailabilityQuery["pets"]>, customerId: string | null): Promise<ResolvedPets> {
    try {
      return await this.resolver.resolve(entries, customerId);
    } catch (err) {
      // With a customerId the resolver's only 401 is `assertActiveCustomer`; without one no petId reaches it (400 above).
      if (err instanceof UnauthorizedException) throw new NotFoundException({ code: "NOT_FOUND" });
      throw err;
    }
  }

  /** Staff: the pets of any BOOKED appointment of this organization (else 404), rebuilt with `fromAppointment`. */
  private async staffRescheduledPets(appointmentId: string): Promise<ResolvedPets> {
    const orgId = await this.tenancy.getOrgId();
    const appt = await this.prisma.appointment.findFirst({
      where: { id: appointmentId, organizationId: orgId, status: "BOOKED" },
      select: { id: true },
    });
    if (!appt) throw new NotFoundException({ code: "NOT_FOUND" });
    return this.resolver.fromAppointment(appt.id);
  }
}

function fieldError(path: string, message: string): BadRequestException {
  return new BadRequestException({ code: "VALIDATION_FAILED", message: "Validation failed", errors: [{ path, message }] });
}
