import { describe, expect, it } from "vitest";
import { AppointmentCreateSchema, HoldRequestSchema, StaffBookingSchema, StaffStatusSchema } from "./booking";
import { ErrorCode } from "./errors";

const SERVICE = "0194b2a0-0000-7000-8000-000000000001";
const PET = "0194b2a0-0000-7000-8000-000000000002";
const HOLD = "0194b2a0-0000-7000-8000-000000000003";
const T0 = "2026-12-01T14:00:00.000Z";
const T1 = "2026-12-01T15:00:00.000Z";

const saved = { petId: PET, serviceIds: [SERVICE] };
const fresh = (over: Record<string, unknown> = {}) => ({
  ref: "new-1",
  species: "DOG",
  sizeClass: "M",
  coatType: "CURLY",
  serviceIds: [SERVICE],
  name: "Rex",
  breed: "Poodle",
  ...over,
});
const plan = (label: { petId: string } | { ref: string }) => ({
  ...label,
  priceCents: 4000,
  segments: [
    {
      stage: "BATH",
      serviceIds: [SERVICE],
      employeeId: null,
      resourceId: null,
      startsAt: T0,
      endsAt: T1,
      blockEndsAt: T1,
      durationMin: 60,
      priceCents: 4000,
    },
  ],
});
const slot = (labels: ({ petId: string } | { ref: string })[]) => ({
  startsAt: T0,
  readyAt: T1,
  bookingMode: "WAIT",
  pets: labels.map(plan),
});
const issuePaths = (r: { success: boolean; error?: { issues: { path: (string | number)[] }[] } }) =>
  r.success ? null : (r.error?.issues ?? []).map((i) => i.path.join("."));

describe("HoldRequestSchema", () => {
  it("accepts a saved pet entry", () => {
    expect(HoldRequestSchema.safeParse({ pets: [saved], slot: slot([{ petId: PET }]) }).success).toBe(true);
  });

  it("accepts a new pet with details", () => {
    const r = HoldRequestSchema.safeParse({ pets: [fresh({ weightG: 9000 })], slot: slot([{ ref: "new-1" }]) });
    expect(r.success).toBe(true);
  });

  it('slot labels in a different order than pets → issue on "slot"', () => {
    const r = HoldRequestSchema.safeParse({
      pets: [saved, fresh()],
      slot: slot([{ ref: "new-1" }, { petId: PET }]),
    });
    expect(issuePaths(r)).toEqual(["slot"]);
  });

  it('slot with a different number of pets → issue on "slot"', () => {
    const r = HoldRequestSchema.safeParse({ pets: [saved, fresh()], slot: slot([{ petId: PET }]) });
    expect(issuePaths(r)).toEqual(["slot"]);
  });

  it("rejects a new pet without name", () => {
    const noName: Record<string, unknown> = fresh();
    delete noName.name;
    expect(HoldRequestSchema.safeParse({ pets: [noName], slot: slot([{ ref: "new-1" }]) }).success).toBe(false);
  });

  it("rejects unknown top-level keys", () => {
    expect(HoldRequestSchema.safeParse({ pets: [saved], slot: slot([{ petId: PET }]), extra: 1 }).success).toBe(false);
  });
});

describe("StaffBookingSchema", () => {
  it('applies the same label refine (issue on "slot") and defaults override to false', () => {
    const base = { customerId: PET, pets: [saved, fresh()] };
    expect(issuePaths(StaffBookingSchema.safeParse({ ...base, slot: slot([{ ref: "new-1" }, { petId: PET }]) }))).toEqual([
      "slot",
    ]);
    const ok = StaffBookingSchema.parse({ ...base, slot: slot([{ petId: PET }, { ref: "new-1" }]) });
    expect(ok.override).toBe(false);
  });
});

describe("AppointmentCreateSchema", () => {
  it("accepts usePets keyed new-1..new-4", () => {
    expect(AppointmentCreateSchema.safeParse({ holdId: HOLD, usePets: { "new-4": PET } }).success).toBe(true);
  });

  it("rejects usePets key new-5", () => {
    expect(AppointmentCreateSchema.safeParse({ holdId: HOLD, usePets: { "new-5": PET } }).success).toBe(false);
  });
});

describe("StaffStatusSchema", () => {
  it('rejects action "COMPLETE"', () => {
    expect(StaffStatusSchema.safeParse({ action: "COMPLETE" }).success).toBe(false);
    expect(StaffStatusSchema.safeParse({ action: "NO_SHOW" }).success).toBe(true);
  });
});

describe("ErrorCode", () => {
  it("has PET_UNAVAILABLE", () => {
    expect(ErrorCode.options).toContain("PET_UNAVAILABLE");
  });
});
