import { ConflictException, BadRequestException } from "@nestjs/common";
import type { Slot } from "@grooming/availability";
import { describe, expect, it } from "vitest";
import { slotFromView, toSlotView, verdictError, type PetLabel } from "./slot-codec.js";

const MIN = 60_000;
const T0 = Date.parse("2026-12-01T13:00:00.000Z");
const PET = "0194b2a0-0000-7000-8000-0000000000a1";
const SVC = "0194b2a0-0000-7000-8000-0000000000b1";
const EMP = "0194b2a0-0000-7000-8000-0000000000c1";
const TUB = "0194b2a0-0000-7000-8000-0000000000d1";
const K1 = "0194b2a0-0000-7000-8000-0000000000e1";
const K2 = "0194b2a0-0000-7000-8000-0000000000e2";

/** Two pets dropped off at T0: a saved pet and an inline `new-1`, each with a bath and a kennel segment. */
function dropOffSlot(): Slot {
  const pet = (petId: string, offset: number, kennel: string) => ({
    petId,
    priceCents: 4500,
    segments: [
      {
        petId, stage: "BATH" as const, serviceIds: [SVC], employeeId: EMP, resourceId: TUB,
        start: T0 + (15 + offset) * MIN, end: T0 + (75 + offset) * MIN, blockEnd: T0 + (80 + offset) * MIN,
        durationMin: 60, priceCents: 4500,
      },
      {
        petId, stage: "KENNEL" as const, serviceIds: [], employeeId: null, resourceId: kennel,
        start: T0, end: T0 + 180 * MIN, blockEnd: T0 + 180 * MIN, durationMin: 180, priceCents: 0,
      },
    ],
  });
  return { start: T0, readyAt: T0 + 140 * MIN, bookingMode: "DROP_OFF", pets: [pet(PET, 0, K1), pet("new-1", 65, K2)] };
}

const labels = new Map<string, PetLabel>([
  [PET, { petId: PET }],
  ["new-1", { ref: "new-1" }],
]);

describe("slot codec", () => {
  it("slotFromView(toSlotView(slot)) deep-equals slot", () => {
    const slot = dropOffSlot();
    const view = toSlotView(slot, labels);
    expect(view.pets[0]?.petId).toBe(PET);
    expect(view.pets[1]?.ref).toBe("new-1");
    expect(slotFromView(view, labels)).toEqual(slot);
  });

  it('slotFromView maps a ref label to the engine petId "new-1"', () => {
    const view = toSlotView(dropOffSlot(), labels);
    const slot = slotFromView(view, labels);
    expect(slot.pets[1]?.petId).toBe("new-1");
    expect(slot.pets[1]?.segments.every((s) => s.petId === "new-1")).toBe(true);
  });

  it("slotFromView rejects a pet that is not in the labels → 400", () => {
    const view = toSlotView(dropOffSlot(), labels);
    expect(() => slotFromView(view, new Map([[PET, { petId: PET }]]))).toThrow(BadRequestException);
  });

  it('verdictError: TOO_SOON → 409 SLOT_TAKEN; MALFORMED_PLAN → 400 VALIDATION_FAILED with detail "MALFORMED_PLAN"', () => {
    for (const reason of ["TOO_SOON", "EMPLOYEE_UNAVAILABLE", "RESOURCE_UNAVAILABLE"] as const) {
      const err = verdictError(reason);
      expect(err).toBeInstanceOf(ConflictException);
      expect(err.getStatus()).toBe(409);
      expect(err.getResponse()).toMatchObject({ code: "SLOT_TAKEN" });
    }
    const bad = verdictError("MALFORMED_PLAN");
    expect(bad.getStatus()).toBe(400);
    expect(bad.getResponse()).toMatchObject({ code: "VALIDATION_FAILED", message: "MALFORMED_PLAN" });
  });
});
