import { describe, it, expect } from "vitest";
import { PhoneE164Schema, LocalizedTextSchema, IsoInstantSchema, IsoDateSchema } from "./common";

describe("PhoneE164Schema", () => {
  it("accepts E.164", () => expect(PhoneE164Schema.safeParse("+17185550123").success).toBe(true));
  it("rejects missing plus", () => expect(PhoneE164Schema.safeParse("7185550123").success).toBe(false));
  it("rejects leading zero", () => expect(PhoneE164Schema.safeParse("+0123").success).toBe(false));
});

describe("LocalizedTextSchema", () => {
  it("rejects missing es", () => expect(LocalizedTextSchema.safeParse({ en: "Hi" }).success).toBe(false));
  it("accepts both", () => expect(LocalizedTextSchema.safeParse({ en: "Hi", es: "Hola" }).success).toBe(true));
});

describe("IsoInstantSchema", () => {
  it("accepts Z", () => expect(IsoInstantSchema.safeParse("2026-12-07T14:00:00Z").success).toBe(true));
  it("accepts offset", () => expect(IsoInstantSchema.safeParse("2026-12-07T09:00:00-05:00").success).toBe(true));
  it("rejects space format", () => expect(IsoInstantSchema.safeParse("2026-12-07 09:00").success).toBe(false));
});

describe("IsoDateSchema", () => {
  it("rejects impossible date", () => expect(IsoDateSchema.safeParse("2026-02-30").success).toBe(false));
  it("accepts valid date", () => expect(IsoDateSchema.safeParse("2026-02-28").success).toBe(true));
  it("accepts leap day", () => expect(IsoDateSchema.safeParse("2028-02-29").success).toBe(true));
});
