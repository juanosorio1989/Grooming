import { describe, expect, it } from "vitest";
import { BreedSchema } from "@grooming/contracts";
import breeds from "./breeds.json";

describe("breeds.json", () => {
  it("every row matches the Breed contract (kebab-case code, DOG|CAT, CoatType or null)", () => {
    for (const b of breeds) expect(BreedSchema.safeParse(b).success, b.code).toBe(true);
  });
  it("codes are unique", () => {
    expect(new Set(breeds.map((b) => b.code)).size).toBe(breeds.length);
  });
  it("has at least 40 dogs and 12 cats", () => {
    expect(breeds.filter((b) => b.species === "DOG").length).toBeGreaterThanOrEqual(40);
    expect(breeds.filter((b) => b.species === "CAT").length).toBeGreaterThanOrEqual(12);
  });
  it("includes the common breeds", () => {
    const codes = breeds.map((b) => b.code);
    for (const c of ["poodle", "golden-retriever", "shih-tzu", "domestic-shorthair"]) expect(codes).toContain(c);
  });
});
