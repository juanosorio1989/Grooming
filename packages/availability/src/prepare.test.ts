import { describe, expect, it } from "vitest";
import { MINUTE } from "@grooming/datetime";
import { beyondHorizon, earliestStart, prepare } from "./prepare";
import { covers } from "./intervals";
import { at, groomCtx, KENNEL_1_ID, MON, batherA, groomerA } from "../test/fixtures";

describe("prepare helpers", () => {
  it("earliest start online is now + lead", () => {
    const now = Date.parse("2026-12-07T15:10:00Z");
    expect(earliestStart(groomCtx({ now }), at(MON, "00:00"))).toBe(now + 60 * MINUTE);
  });

  it("earliest start staff floors to the grid", () => {
    const now = Date.parse("2026-12-07T15:10:00Z");
    expect(earliestStart(groomCtx({ now, mode: "STAFF" }), at(MON, "00:00"))).toBe(Date.parse("2026-12-07T15:00:00Z"));
  });

  it("horizon", () => {
    const ctx = groomCtx();
    expect(beyondHorizon(ctx, "2027-02-04")).toBe(false);
    expect(beyondHorizon(ctx, "2027-02-05")).toBe(true);
    expect(beyondHorizon(groomCtx({ mode: "STAFF" }), "2027-02-05")).toBe(false);
  });

  it("kennel busy counts for nobody", () => {
    const start = at(MON, "10:00");
    const ctx = groomCtx({ busy: [{ employeeId: null, resourceId: KENNEL_1_ID, start, blockEnd: at(MON, "12:00") }] });
    const p = prepare(ctx, MON);
    for (const e of [batherA, groomerA]) expect(p.booked.get(e.id)).toBe(0);
    expect([...p.booked.values()].every((v) => v === 0)).toBe(true);
    expect(covers(p.resourceFree.get(KENNEL_1_ID) ?? [], { start, end: start + MINUTE })).toBe(false);
    expect(covers(p.resourceFree.get(KENNEL_1_ID) ?? [], { start: at(MON, "12:00"), end: at(MON, "13:00") })).toBe(true);
  });
});
