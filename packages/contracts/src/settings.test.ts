import { describe, expect, it } from "vitest";
import { ClosureItemSchema, ClosureSchema, LocationHoursListSchema, LocationSettingsPatchSchema, LocationSettingsSchema } from "./settings";

const SETTINGS = {
  slotIntervalMin: 15,
  holdMinutes: 5,
  cancelWindowHours: 24,
  bookingHorizonDays: 60,
  minLeadMinutes: 60,
  defaultBookingMode: "DROP_OFF",
  dropOffWindows: Object.fromEntries([1, 2, 3, 4, 5, 6].map((d) => [String(d), [{ from: "08:00", to: "11:00" }]])),
  maxQueueWaitMin: 90,
  pickupGraceMin: 60,
  sizeThresholdsLb: { S: 20, M: 50, L: 90 },
  requireAfterPhoto: true,
  vaccinePolicy: "WARN",
  requiredVaccines: { DOG: ["RABIES"] },
  etaNotifyThresholdMin: 30,
};
const ok = (v: unknown) => LocationSettingsSchema.safeParse(v).success;

describe("LocationSettingsSchema", () => {
  it("accepts the seed settings", () => expect(ok(SETTINGS)).toBe(true));
  it("rejects fractional thresholds", () => expect(ok({ ...SETTINGS, sizeThresholdsLb: { S: 20.5, M: 50, L: 90 } })).toBe(false));
  it("rejects non-increasing thresholds", () => expect(ok({ ...SETTINGS, sizeThresholdsLb: { S: 50, M: 50, L: 90 } })).toBe(false));
  it("rejects L above 300", () => expect(ok({ ...SETTINGS, sizeThresholdsLb: { S: 20, M: 50, L: 301 } })).toBe(false));
  it("rejects overlapping drop-off windows", () =>
    expect(ok({ ...SETTINGS, dropOffWindows: { "1": [{ from: "08:00", to: "10:00" }, { from: "09:00", to: "11:00" }] } })).toBe(false));
  it("rejects unsorted drop-off windows", () =>
    expect(ok({ ...SETTINGS, dropOffWindows: { "1": [{ from: "12:00", to: "13:00" }, { from: "09:00", to: "10:00" }] } })).toBe(false));
  it("rejects a weekday key of 7", () => expect(ok({ ...SETTINGS, dropOffWindows: { "7": [] } })).toBe(false));
  it("rejects slotIntervalMin 7", () => expect(ok({ ...SETTINGS, slotIntervalMin: 7 })).toBe(false));
  it("rejects duplicate required vaccines", () => expect(ok({ ...SETTINGS, requiredVaccines: { DOG: ["RABIES", "RABIES"] } })).toBe(false));
  it("requires every key", () => expect(ok({ ...SETTINGS, holdMinutes: undefined })).toBe(false));
});

describe("LocationSettingsPatchSchema", () => {
  it("accepts a subset and rejects unknown keys", () => {
    expect(LocationSettingsPatchSchema.safeParse({ holdMinutes: 10 }).success).toBe(true);
    expect(LocationSettingsPatchSchema.safeParse({ nope: 1 }).success).toBe(false);
    expect(LocationSettingsPatchSchema.safeParse({ holdMinutes: 31 }).success).toBe(false);
  });
});

describe("LocationHoursListSchema", () => {
  it("accepts 24:00 closes", () => expect(LocationHoursListSchema.safeParse([{ weekday: 1, opens: "08:00", closes: "24:00" }]).success).toBe(true));
  it("rejects opens >= closes", () => expect(LocationHoursListSchema.safeParse([{ weekday: 1, opens: "09:00", closes: "09:00" }]).success).toBe(false));
  it("rejects overlap on one weekday but not across weekdays", () => {
    const a = { weekday: 1, opens: "08:00", closes: "12:00" };
    expect(LocationHoursListSchema.safeParse([a, { weekday: 1, opens: "11:00", closes: "14:00" }]).success).toBe(false);
    expect(LocationHoursListSchema.safeParse([a, { weekday: 1, opens: "13:00", closes: "14:00" }]).success).toBe(true);
    expect(LocationHoursListSchema.safeParse([a, { weekday: 2, opens: "11:00", closes: "14:00" }]).success).toBe(true);
  });
  it("rejects more than 14 ranges", () =>
    expect(LocationHoursListSchema.safeParse(Array.from({ length: 15 }, () => ({ weekday: 0, opens: "08:00", closes: "09:00" }))).success).toBe(false));
});

describe("ClosureSchema", () => {
  it("requires startsAt before endsAt", () => {
    expect(ClosureSchema.safeParse({ startsAt: "2026-12-25T00:00:00Z", endsAt: "2026-12-26T00:00:00Z" }).success).toBe(true);
    expect(ClosureSchema.safeParse({ startsAt: "2026-12-25T00:00:00Z", endsAt: "2026-12-25T00:00:00Z" }).success).toBe(false);
  });
  it("ClosureItemSchema accepts an item with id", () =>
    expect(ClosureItemSchema.safeParse({ id: "11111111-1111-4111-8111-111111111111", startsAt: "2026-12-25T00:00:00Z", endsAt: "2026-12-26T00:00:00Z" }).success).toBe(true));
});
