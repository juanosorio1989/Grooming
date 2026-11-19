import { describe, expect, it } from "vitest";
import { lookupPrice, quotePet, type ServicePriceRow } from "./index.js";

const rows: ServicePriceRow[] = [
  { serviceId: "BATH", sizeClass: "M", coatType: null, durationMin: 45, priceCents: 4000 },
  { serviceId: "BATH", sizeClass: "M", coatType: "CURLY", durationMin: 60, priceCents: 5000 },
  { serviceId: "CUT", sizeClass: "M", coatType: null, durationMin: 60, priceCents: 6000 },
];

describe("lookup", () => {
  it("exact coat row wins", () =>
    expect(lookupPrice(rows, "BATH", "M", "CURLY")).toEqual({ durationMin: 60, priceCents: 5000 }));
  it("falls back to the any-coat row", () =>
    expect(lookupPrice(rows, "BATH", "M", "SMOOTH")).toEqual({ durationMin: 45, priceCents: 4000 }));
  it("missing row is null", () => {
    expect(lookupPrice(rows, "BATH", "L", "SMOOTH")).toBeNull();
    expect(lookupPrice(rows, "NOPE", "M", "SMOOTH")).toBeNull();
  });
  it("quotes a pet", () => {
    expect(quotePet({ rows, serviceIds: ["CUT", "BATH"], sizeClass: "M", coatType: "CURLY" })).toEqual({
      ok: true,
      totalCents: 11000,
      totalMin: 120,
      lines: [
        { serviceId: "CUT", durationMin: 60, priceCents: 6000 },
        { serviceId: "BATH", durationMin: 60, priceCents: 5000 },
      ],
    });
    expect(quotePet({ rows, serviceIds: ["X", "BATH", "Y"], sizeClass: "M", coatType: "SMOOTH" })).toEqual({
      ok: false,
      missing: ["X", "Y"],
    });
  });
});
