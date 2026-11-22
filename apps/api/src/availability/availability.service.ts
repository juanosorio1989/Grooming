import { BadRequestException, Injectable, NotFoundException, UnauthorizedException } from "@nestjs/common";
import { AvailabilityError, findSlots, type PetRequest, type Slot } from "@grooming/availability";
import type { AccessClaims, AvailabilityQuery, AvailabilityResponse, PetPlanView, SlotView } from "@grooming/contracts";
import { addDays, datesInRange, localDayBoundsUtc } from "@grooming/datetime";
import { LocationService } from "../location/location.service.js";
import { PrismaService } from "../prisma/prisma.service.js";
import { RateLimitService } from "../rate-limit/rate-limit.service.js";
import { TenancyService } from "../tenancy/tenancy.service.js";
import { AvailabilityContextLoader } from "./context-loader.js";
import { resolveBookingMode } from "./context-mapper.js";

/** Rate limit per client IP: [limit, window seconds]. */
const PER_IP = [120, 600] as const;

/** How a response pet is labeled: the saved pet's id or the inline `ref`. */
type PetLabel = { petId: string } | { ref: string };

const iso = (ms: number) => new Date(ms).toISOString();

/**
 * Online slots for owners and anonymous visitors. Saved pets (`petId`) need
 * a customer token and must belong to that customer; inline pets (`ref`) work
 * for anyone. Engine input errors become 400, never 500.
 */
@Injectable()
export class AvailabilityService {
  constructor(
    private readonly loader: AvailabilityContextLoader,
    private readonly locations: LocationService,
    private readonly prisma: PrismaService,
    private readonly tenancy: TenancyService,
    private readonly rateLimit: RateLimitService,
  ) {}

  async find(q: AvailabilityQuery, principal: AccessClaims | undefined, ip: string): Promise<AvailabilityResponse> {
    await this.rateLimit.enforce(`availability:ip:${this.rateLimit.hashKeyPart(ip)}`, ...PER_IP);
    const { pets, labels } = await this.resolvePets(q.pets, principal);

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
    return { bookingMode, slots: slots.map((s) => toView(s, labels)) };
  }

  /** Engine pet requests in query order, and the response label for each engine pet id. */
  private async resolvePets(
    entries: AvailabilityQuery["pets"],
    principal: AccessClaims | undefined,
  ): Promise<{ pets: PetRequest[]; labels: Map<string, PetLabel> }> {
    const ids = entries.flatMap((e) => ("petId" in e ? [e.petId] : []));
    const saved = new Map<string, { species: "DOG" | "CAT"; sizeClass: PetRequest["sizeClass"] | null; coatType: PetRequest["coatType"] | null }>();
    if (ids.length > 0) {
      if (!principal) throw new UnauthorizedException({ code: "UNAUTHORIZED" });
      const rows = await this.prisma.pet.findMany({
        where: { id: { in: ids }, organizationId: await this.tenancy.getOrgId(), customerId: principal.sub, deletedAt: null },
        select: { id: true, species: true, sizeClass: true, coatType: true },
      });
      for (const r of rows) saved.set(r.id, r);
      if (ids.some((id) => !saved.has(id))) throw new NotFoundException({ code: "NOT_FOUND" });
    }

    const pets: PetRequest[] = [];
    const labels = new Map<string, PetLabel>();
    const errors: { path: string; message: string }[] = [];
    entries.forEach((e, i) => {
      const choice = { serviceIds: e.serviceIds, preferredGroomerId: e.preferredGroomerId };
      if ("ref" in e) {
        pets.push({ petId: e.ref, species: e.species, sizeClass: e.sizeClass, coatType: e.coatType, ...choice });
        labels.set(e.ref, { ref: e.ref });
        return;
      }
      const pet = saved.get(e.petId)!;
      // Stored values win; the request fills only what the pet record lacks.
      const sizeClass = pet.sizeClass ?? e.sizeClass;
      const coatType = pet.coatType ?? e.coatType;
      if (!sizeClass) errors.push({ path: `pets.${i}.sizeClass`, message: "Required: the pet has no size class" });
      if (!coatType) errors.push({ path: `pets.${i}.coatType`, message: "Required: the pet has no coat type" });
      if (sizeClass && coatType) pets.push({ petId: e.petId, species: pet.species, sizeClass, coatType, ...choice });
      labels.set(e.petId, { petId: e.petId });
    });
    if (errors.length > 0) {
      throw new BadRequestException({ code: "VALIDATION_FAILED", message: "Validation failed", errors });
    }
    return { pets, labels };
  }
}

function engineError(err: AvailabilityError): BadRequestException {
  if (err.code === "NO_PRICE_FOR_PET" || err.code === "STAGE_RESOURCE_MISMATCH") {
    return new BadRequestException({ code: err.code, message: err.code });
  }
  return new BadRequestException({ code: "VALIDATION_FAILED", message: err.code });
}

function toView(slot: Slot, labels: Map<string, PetLabel>): SlotView {
  return {
    startsAt: iso(slot.start),
    readyAt: iso(slot.readyAt),
    bookingMode: slot.bookingMode,
    pets: slot.pets.map(
      (p): PetPlanView => ({
        ...(labels.get(p.petId) ?? { ref: p.petId }),
        priceCents: p.priceCents,
        segments: p.segments.map((s) => ({
          stage: s.stage,
          serviceIds: s.serviceIds,
          employeeId: s.employeeId,
          resourceId: s.resourceId,
          startsAt: iso(s.start),
          endsAt: iso(s.end),
          blockEndsAt: iso(s.blockEnd),
          durationMin: s.durationMin,
          priceCents: s.priceCents,
        })),
      }),
    ),
  };
}
