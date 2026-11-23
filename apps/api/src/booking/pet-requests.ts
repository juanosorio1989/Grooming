import { BadRequestException, ConflictException, Injectable, NotFoundException, UnauthorizedException } from "@nestjs/common";
import type { PetRequest } from "@grooming/availability";
import type { AvailabilityQuery, HoldPet } from "@grooming/contracts";
import { sizeClassFromWeight, type SizeThresholdsLb } from "@grooming/pricing";
import { assertActiveCustomer } from "../customers/active-customer.js";
import { PrismaService } from "../prisma/prisma.service.js";
import { TenancyService } from "../tenancy/tenancy.service.js";
import type { PetLabel } from "./slot-codec.js";

export type { PetLabel } from "./slot-codec.js";

/** Engine pet requests in entry order, the view label of each engine pet id, and the customer they belong to. */
export interface ResolvedPets {
  pets: PetRequest[];
  labels: Map<string, PetLabel>;
  customerId: string | null;
}

type PetEntry = NonNullable<AvailabilityQuery["pets"]>[number] | HoldPet;

/**
 * A new pet's stated size must agree with its weight (same thresholds as saved
 * pets): 400 VALIDATION_FAILED on `pets.<i>.sizeClass`. Shared by holds and
 * staff bookings.
 */
export function assertNewPetSizes(entries: HoldPet[], thresholds: SizeThresholdsLb): void {
  const errors = entries.flatMap((p, i) =>
    "ref" in p && p.weightG != null && sizeClassFromWeight(p.weightG, thresholds) !== p.sizeClass
      ? [{ path: `pets.${i}.sizeClass`, message: "Does not match the weight" }]
      : [],
  );
  if (errors.length > 0) throw new BadRequestException({ code: "VALIDATION_FAILED", message: "Validation failed", errors });
}

/**
 * Turns pet entries (saved `petId` or inline `ref`) into engine pet requests,
 * shared by `/availability`, holds, reschedule and staff writes so the plan a
 * client gets is the plan the server re-checks.
 */
@Injectable()
export class PetRequestResolver {
  constructor(
    private readonly prisma: PrismaService,
    private readonly tenancy: TenancyService,
  ) {}

  /**
   * `owner`: the customer whose saved pets may be used (null = anonymous: a
   * `petId` is 401). When `owner` is set it must be an active customer (401).
   * A saved pet of someone else, or deleted, is 404. Stored size and coat win;
   * the entry fills only what the pet lacks, and a value still missing is 400.
   */
  async resolve(entries: PetEntry[], owner: string | null): Promise<ResolvedPets> {
    const orgId = await this.tenancy.getOrgId();
    if (owner !== null) await assertActiveCustomer(this.prisma, orgId, owner);

    const ids = entries.flatMap((e) => ("petId" in e ? [e.petId] : []));
    const saved = new Map<string, { species: PetRequest["species"]; sizeClass: PetRequest["sizeClass"] | null; coatType: PetRequest["coatType"] | null }>();
    if (ids.length > 0) {
      if (owner === null) throw new UnauthorizedException({ code: "UNAUTHORIZED" });
      const rows = await this.prisma.pet.findMany({
        where: { id: { in: ids }, organizationId: orgId, customerId: owner, deletedAt: null },
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
    return { pets, labels, customerId: owner };
  }

  /**
   * The request of an existing appointment, rebuilt from its visits in
   * position order (CANCELLED visits skipped): species from the pet, size and
   * coat from the booking snapshot, services from `pet_visit_service`,
   * preferred groomer or "ANY".
   * 404 when the appointment is not in this organization. Only appointments
   * whose visits all have a saved pet can be rebuilt (a hold with a pending
   * pet cannot): 409 CONFLICT otherwise.
   */
  async fromAppointment(appointmentId: string): Promise<ResolvedPets> {
    const orgId = await this.tenancy.getOrgId();
    const appt = await this.prisma.appointment.findFirst({
      where: { id: appointmentId, organizationId: orgId },
      select: {
        customerId: true,
        petVisits: {
          where: { status: { not: "CANCELLED" } },
          orderBy: { position: "asc" },
          select: {
            petId: true,
            sizeClassAtBooking: true,
            coatTypeAtBooking: true,
            preferredGroomerId: true,
            pet: { select: { species: true } },
            services: { orderBy: { id: "asc" }, select: { serviceId: true } },
          },
        },
      },
    });
    if (!appt) throw new NotFoundException({ code: "NOT_FOUND" });

    const pets: PetRequest[] = [];
    const labels = new Map<string, PetLabel>();
    for (const v of appt.petVisits) {
      if (v.petId === null || v.pet === null) {
        throw new ConflictException({ code: "CONFLICT", message: "The appointment has a pet that is not saved yet" });
      }
      pets.push({
        petId: v.petId,
        species: v.pet.species,
        sizeClass: v.sizeClassAtBooking,
        coatType: v.coatTypeAtBooking,
        serviceIds: v.services.map((s) => s.serviceId),
        preferredGroomerId: v.preferredGroomerId ?? "ANY",
      });
      labels.set(v.petId, { petId: v.petId });
    }
    return { pets, labels, customerId: appt.customerId };
  }
}
