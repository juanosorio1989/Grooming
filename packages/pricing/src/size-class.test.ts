import { describe, expect, it } from "vitest";
import { gramsToLb, lbToGrams, sizeClassFromWeight } from "./index.js";

describe("size class", () => {
  it("converts lb and grams", () => {
    expect(lbToGrams(20)).toBe(9072);
    expect(gramsToLb(9072)).toBe(20);
    expect(gramsToLb(19051)).toBe(42);
  });
  it("default thresholds are inclusive upper bounds", () => {
    expect(sizeClassFromWeight(9072)).toBe("S");
    expect(sizeClassFromWeight(9073)).toBe("M");
    expect(sizeClassFromWeight(lbToGrams(50))).toBe("M");
    expect(sizeClassFromWeight(lbToGrams(50) + 1)).toBe("L");
    expect(sizeClassFromWeight(lbToGrams(90))).toBe("L");
    expect(sizeClassFromWeight(lbToGrams(90) + 1)).toBe("XL");
  });
  it("custom thresholds", () => {
    expect(sizeClassFromWeight(lbToGrams(15), { S: 10, M: 15, L: 30 })).toBe("M");
  });
  it("rejects bad input", () => {
    for (const w of [0, -1, 1.5, Number.NaN])
      expect(() => sizeClassFromWeight(w)).toThrow(expect.objectContaining({ code: "INVALID_WEIGHT" }));
    for (const t of [
      { S: 20, M: 20, L: 90 },
      { S: 0, M: 50, L: 90 },
      { S: 20, M: 50, L: Infinity },
    ])
      expect(() => sizeClassFromWeight(9000, t)).toThrow(expect.objectContaining({ code: "INVALID_THRESHOLDS" }));
  });
});
