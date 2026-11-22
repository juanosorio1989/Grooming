import { BadRequestException, Injectable } from "@nestjs/common";
import { AvailabilityError, findSlots, type Slot } from "@grooming/availability";
import type { AccessClaims, AvailabilityQuery, AvailabilityResponse } from "@grooming/contracts";
import { addDays, datesInRange, localDayBoundsUtc } from "@grooming/datetime";
import { PetRequestResolver } from "../booking/pet-requests.js";
import { engineError, toSlotView } from "../booking/slot-codec.js";
import { LocationService } from "../location/location.service.js";
import { RateLimitService } from "../rate-limit/rate-limit.service.js";
import { AvailabilityContextLoader } from "./context-loader.js";
import { resolveBookingMode } from "./context-mapper.js";

/** Rate limit per client IP: [limit, window seconds]. */
const PER_IP = [120, 600] as const;

/**
 * Online slots for owners and anonymous visitors. Saved pets (`petId`) need
 * a customer token and must belong to that customer; inline pets (`ref`) work
 * for anyone. A token whose customer is soft-deleted is 401. Engine input
 * errors become 400, never 500.
 */
@Injectable()
export class AvailabilityService {
  constructor(
    private readonly loader: AvailabilityContextLoader,
    private readonly locations: LocationService,
    private readonly resolver: PetRequestResolver,
    private readonly rateLimit: RateLimitService,
  ) {}

  async find(q: AvailabilityQuery, principal: AccessClaims | undefined, ip: string): Promise<AvailabilityResponse> {
    // Reschedule availability (`excludeAppointmentId`, pets from that appointment) is not served yet.
    if (q.excludeAppointmentId !== undefined) throw fieldError("excludeAppointmentId", "not supported yet");
    if (q.pets === undefined) throw fieldError("pets", "Required");
    await this.rateLimit.enforce(`availability:ip:${this.rateLimit.hashKeyPart(ip)}`, ...PER_IP);
    const { pets, labels } = await this.resolver.resolve(q.pets, principal?.sub ?? null);

    const { timezone } = await this.locations.getDefault();
    const to = q.to ?? q.from;
    // One extra local day: kennel blocks can run past midnight.
    const { rows, context } = await this.loader.load({
      from: new Date(localDayBoundsUtc(q.from, timezone).start),
      to: new Date(localDayBoundsUtc(addDays(to, 1), timezone).end),
    });
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
}

function fieldError(path: string, message: string): BadRequestException {
  return new BadRequestException({ code: "VALIDATION_FAILED", message: "Validation failed", errors: [{ path, message }] });
}
