import { BadRequestException, Injectable, NotFoundException, UnauthorizedException } from "@nestjs/common";
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
 * Online slots for owners and anonymous visitors. Saved pets (`petId`) need
 * a customer token and must belong to that customer; inline pets (`ref`) work
 * for anyone. A token whose customer is soft-deleted is 401. Engine input
 * errors become 400, never 500. Reschedule (`excludeAppointmentId`, customer
 * token only): the pets come from that BOOKED appointment of the customer and
 * its own segments are not busy.
 */
@Injectable()
export class AvailabilityService {
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
    // Reschedule needs a customer token (a staff token never reaches this service: 403 at the guard).
    if (exclude !== undefined && principal === undefined) throw new UnauthorizedException({ code: "UNAUTHORIZED" });
    // The schema refine already requires exactly one of `pets` and `excludeAppointmentId`.
    if (exclude === undefined && q.pets === undefined) throw fieldError("pets", "Required");
    await this.rateLimit.enforce(`availability:ip:${this.rateLimit.hashKeyPart(ip)}`, ...PER_IP);
    const { pets, labels } =
      exclude !== undefined && principal !== undefined
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

    const slots: Slot[] = [];
    try {
      for (const date of datesInRange(q.from, to)) {
        slots.push(...findSlots({ ...context, mode: "ONLINE", date, bookingMode, pets }));
      }
    } catch (err) {
      throw err instanceof AvailabilityError ? engineError(err) : err;
    }
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
}

function fieldError(path: string, message: string): BadRequestException {
  return new BadRequestException({ code: "VALIDATION_FAILED", message: "Validation failed", errors: [{ path, message }] });
}
