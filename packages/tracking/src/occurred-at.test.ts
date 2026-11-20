import { describe, expect, it } from "vitest";
import { MINUTE } from "@grooming/datetime";
import { effectiveOccurredAt } from "./occurred-at";

const now = Date.parse("2026-12-07T14:00:00Z");
const H12 = 12 * 60 * MINUTE;

describe("effectiveOccurredAt", () => {
  it("falls back to now", () => {
    expect(effectiveOccurredAt(null, now)).toBe(now);
  });
  it("accepts the 12 h boundary and rejects older", () => {
    expect(effectiveOccurredAt(now - H12, now)).toBe(now - H12);
    expect(effectiveOccurredAt(now - H12 - 1, now)).toBe(now);
  });
  it("clamps small future skew to now and rejects larger", () => {
    expect(effectiveOccurredAt(now + 2 * MINUTE, now)).toBe(now);
    expect(effectiveOccurredAt(now + 2 * MINUTE + 1, now)).toBe(now);
  });
  it("keeps recent past", () => {
    expect(effectiveOccurredAt(now - 5 * MINUTE, now)).toBe(now - 5 * MINUTE);
  });
});
