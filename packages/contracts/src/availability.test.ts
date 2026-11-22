import { describe, expect, it } from "vitest";
import { AvailabilityQuerySchema, MAX_AVAILABILITY_DAYS } from "./availability";

const SERVICE = "0194b2a0-0000-7000-8000-000000000001";
const PET = "0194b2a0-0000-7000-8000-000000000002";
const inline = (over: Record<string, unknown> = {}) => ({
  ref: "new-1",
  species: "DOG",
  sizeClass: "M",
  coatType: "CURLY",
  serviceIds: [SERVICE],
  ...over,
});
const query = (pets: unknown, over: Record<string, unknown> = {}) => ({
  from: "2026-12-01",
  pets: typeof pets === "string" ? pets : JSON.stringify(pets),
  ...over,
});
const issuePaths = (v: unknown) => {
  const r = AvailabilityQuerySchema.safeParse(v);
  return r.success ? null : r.error.issues.map((i) => i.path.join("."));
};

describe("AvailabilityQuerySchema", () => {
  it("parses inline and petId entries and defaults preferredGroomerId to ANY", () => {
    const r = AvailabilityQuerySchema.parse(query([inline(), { petId: PET, serviceIds: [SERVICE] }]));
    expect(r.pets).toHaveLength(2);
    expect(r.pets[0]).toMatchObject({ ref: "new-1", preferredGroomerId: "ANY" });
    expect(r.pets[1]).toMatchObject({ petId: PET, preferredGroomerId: "ANY" });
  });

  it('pets not JSON → issue on "pets"', () => {
    expect(issuePaths(query("{oops"))).toEqual(["pets"]);
  });

  it("pets longer than 4000 chars → issue on pets", () => {
    expect(issuePaths(query(" ".repeat(4001)))).toEqual(["pets"]);
  });

  it("5 pets → rejected", () => {
    const five = [1, 2, 3, 4, 4].map((n) => inline({ ref: `new-${n}` }));
    expect(issuePaths(query(five))).not.toBeNull();
    expect(issuePaths(query([]))).not.toBeNull();
  });

  it('to 7 days after from → issue on "to"; to = from + 6 → ok', () => {
    expect(MAX_AVAILABILITY_DAYS).toBe(7);
    expect(issuePaths(query([inline()], { to: "2026-12-08" }))).toEqual(["to"]);
    expect(issuePaths(query([inline()], { to: "2026-12-07" }))).toBeNull();
  });

  it('to before from → issue on "to"', () => {
    expect(issuePaths(query([inline()], { to: "2026-11-30" }))).toEqual(["to"]);
  });

  it('ref "new-5" rejected', () => {
    expect(issuePaths(query([inline({ ref: "new-5" })]))).not.toBeNull();
  });

  it("unknown key in a pet → rejected", () => {
    expect(issuePaths(query([inline({ weight: 10 })]))).not.toBeNull();
    expect(issuePaths(query([{ petId: PET, serviceIds: [SERVICE], species: "DOG" }]))).not.toBeNull();
  });

  it("unknown query key → rejected", () => {
    expect(issuePaths(query([inline()], { mode: "STAFF" }))).not.toBeNull();
  });
});
