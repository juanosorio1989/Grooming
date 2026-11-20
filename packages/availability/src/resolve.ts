import { AvailabilityError } from "./errors";
import { MAX_PETS, MAX_SERVICES_PER_PET } from "./prepare";
import type { Prepared } from "./prepare";
import { lookupPrice } from "@grooming/pricing";
import { WORK_STAGE_ORDER } from "./types";
import type { EmployeeInput, PetRequest, ServiceInput, WorkStage } from "./types";

export interface SegmentSpec {
  petId: string;
  stage: WorkStage;
  serviceIds: string[];
  durationMin: number;
  priceCents: number;
  bufferAfterMin: number;
  resourceTypeId: string | null;
  candidates: EmployeeInput[];
}
export interface PetSpec {
  petId: string;
  priceCents: number;
  segments: SegmentSpec[];
}

const byBookedThenId = (p: Prepared) => (a: EmployeeInput, b: EmployeeInput) =>
  (p.booked.get(a.id) ?? 0) - (p.booked.get(b.id) ?? 0) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

/** Group each pet's services into stage segments with summed terms and ordered candidate employees. */
export function resolvePets(p: Prepared, pets: PetRequest[]): PetSpec[] {
  const { ctx } = p;
  if (pets.length === 0) throw new AvailabilityError("NO_PETS");
  if (pets.length > MAX_PETS) throw new AvailabilityError("TOO_MANY_PETS");
  if (new Set(pets.map((x) => x.petId)).size !== pets.length) throw new AvailabilityError("DUPLICATE_PET");

  return pets.map((pet) => {
    if (pet.serviceIds.length === 0) throw new AvailabilityError("NO_SERVICES");
    if (pet.serviceIds.length > MAX_SERVICES_PER_PET) throw new AvailabilityError("TOO_MANY_SERVICES");
    if (new Set(pet.serviceIds).size !== pet.serviceIds.length) throw new AvailabilityError("DUPLICATE_SERVICE");
    const services = pet.serviceIds.map((id) => {
      const s = ctx.services.find((x) => x.id === id);
      if (!s) throw new AvailabilityError("UNKNOWN_SERVICE", id);
      return s;
    });
    for (const s of services) {
      if (s.species !== "ANY" && s.species !== pet.species) throw new AvailabilityError("SPECIES_MISMATCH", s.id);
    }
    if (pet.preferredGroomerId !== "ANY" && !ctx.employees.some((e) => e.id === pet.preferredGroomerId)) {
      throw new AvailabilityError("UNKNOWN_EMPLOYEE", pet.preferredGroomerId);
    }
    const terms = services.map((s) => {
      const t = lookupPrice(ctx.prices, s.id, pet.sizeClass, pet.coatType);
      if (!t) throw new AvailabilityError("NO_PRICE_FOR_PET", s.id);
      return t;
    });

    const segments: SegmentSpec[] = [];
    for (const stage of WORK_STAGE_ORDER) {
      const idx = services.flatMap((s, i) => (s.stage === stage ? [i] : []));
      if (idx.length === 0) continue;
      const group: ServiceInput[] = idx.map((i) => services[i]!);
      const resourceTypeId = group[0]!.resourceTypeId;
      if (group.some((s) => s.resourceTypeId !== resourceTypeId)) {
        throw new AvailabilityError("STAGE_RESOURCE_MISMATCH", stage);
      }
      const candidates = ctx.employees
        .filter(
          (e) =>
            group.every((s) => e.skills.includes(s.requiredSkill) && e.serviceIds.includes(s.id)) &&
            (ctx.mode === "STAFF" || e.bookableOnline) &&
            ((stage !== "GROOM" && stage !== "FINISH") ||
              pet.preferredGroomerId === "ANY" ||
              e.id === pet.preferredGroomerId),
        )
        .sort(byBookedThenId(p));
      segments.push({
        petId: pet.petId,
        stage,
        serviceIds: group.map((s) => s.id),
        durationMin: idx.reduce((n, i) => n + terms[i]!.durationMin, 0),
        priceCents: idx.reduce((n, i) => n + terms[i]!.priceCents, 0),
        bufferAfterMin: Math.max(...group.map((s) => s.bufferAfterMin)),
        resourceTypeId,
        candidates,
      });
    }
    return { petId: pet.petId, priceCents: segments.reduce((n, s) => n + s.priceCents, 0), segments };
  });
}
