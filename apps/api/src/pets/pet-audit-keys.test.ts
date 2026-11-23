import type { Pet } from "@prisma/client";
import { describe, expect, it } from "vitest";
import { PET_AUDIT_PII_KEYS, PetsService, type PetRow } from "./pets.service.js";

/** Keys of the pet audit shape that are neither free text nor identify the animal or its owner. */
const NON_PII_KEYS = [
  "id",
  "customerId",
  "species",
  "sex",
  "neutered",
  "weightG",
  "weightMeasuredAt",
  "sizeClass",
  "coatType",
  "photoMediaId",
  "hasMedicalNotes",
];

/** A pet with every optional column set, so every key of the shape is present. */
const pet: PetRow = {
  id: "p1",
  organizationId: "o1",
  customerId: "c1",
  name: "Rex",
  species: "DOG",
  breed: "Poodle",
  breedCode: "POO",
  birthDate: new Date("2020-01-02T00:00:00Z"),
  sex: "MALE",
  neutered: true,
  weightG: 12_000,
  weightMeasuredAt: new Date("2026-01-01T00:00:00Z"),
  sizeClass: "M",
  coatType: "CURLY",
  temperament: "Calm",
  allergies: "None",
  medicalNotesEnc: "enc",
  behaviorNotes: "Nervous",
  vetName: "Dr Vet",
  vetPhoneE164: "+13055550100",
  photoMediaId: "m1",
  deletedAt: null,
  createdAt: new Date(),
  updatedAt: new Date(),
  vaccines: [],
} as unknown as Pet & { vaccines: [] };

describe("pet audit shape", () => {
  it("every key is a listed PII key or an explicit non-PII key, so a new field must be classified", () => {
    const service = new PetsService({} as never, {} as never, {} as never, { decrypt: () => "secret" } as never, {} as never, {} as never);
    const shape = (service as unknown as { auditShape(p: PetRow): Record<string, unknown> }).auditShape(pet);
    const known = new Set<string>([...PET_AUDIT_PII_KEYS, ...NON_PII_KEYS]);
    const unclassified = Object.keys(shape).filter((k) => !known.has(k));
    expect(unclassified).toEqual([]);
    // The shape never carries the notes text.
    expect(shape).not.toHaveProperty("medicalNotes");
  });
});
