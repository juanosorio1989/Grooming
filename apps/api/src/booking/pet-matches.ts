import type { PetMatch } from "@grooming/contracts";
import type { Prisma } from "@prisma/client";
import { z } from "zod";
import type { PendingPet } from "./plan-writer.js";

/** Runtime shape of `pet_visit.pending_pet` (written by `PlanWriter.insert`). */
const PendingPetSchema = z.object({
  ref: z.string(),
  species: z.enum(["DOG", "CAT"]),
  name: z.string(),
  breed: z.string(),
  breedCode: z.string().nullable(),
  weightG: z.number().int().nullable(),
});

/** Parses a stored `pending_pet`; null when the column is empty. A malformed value is a server bug (throws). */
export function parsePendingPet(value: Prisma.JsonValue | null): PendingPet | null {
  if (value === null) return null;
  return PendingPetSchema.parse(value);
}

const normalize = (name: string) => name.trim().toLowerCase();

/**
 * The customer's saved pets that may be the same animal as each pending pet:
 * not deleted, same species, and a name equal ignoring case and surrounding
 * spaces. Keyed by the pending pet's `ref`, in pet creation order. Shared by
 * `GET /holds/:id` and the confirm step (`usePets` must name one of these).
 */
export async function findPetMatches(
  db: Prisma.TransactionClient,
  orgId: string,
  customerId: string,
  pending: PendingPet[],
): Promise<Map<string, PetMatch[]>> {
  const out = new Map<string, PetMatch[]>(pending.map((p) => [p.ref, []]));
  if (pending.length === 0) return out;
  const pets = await db.pet.findMany({
    where: { organizationId: orgId, customerId, deletedAt: null, species: { in: [...new Set(pending.map((p) => p.species))] } },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    select: { id: true, name: true, breed: true, weightG: true, species: true },
  });
  for (const p of pending) {
    out.set(
      p.ref,
      pets
        .filter((x) => x.species === p.species && normalize(x.name) === normalize(p.name))
        .map((x) => ({ petId: x.id, name: x.name, breed: x.breed, weightG: x.weightG })),
    );
  }
  return out;
}
