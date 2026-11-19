import { describe, expect, it } from "vitest";
import { addDays, datesInRange, weekdayOf } from "./dates";

describe("dates", () => {
  it("weekdayOf uses 0 = Sunday", () => {
    expect(weekdayOf("2026-12-06")).toBe(0);
  });
  it("addDays crosses year boundaries", () => {
    expect(addDays("2026-12-31", 1)).toBe("2027-01-01");
    expect(addDays("2027-01-01", -1)).toBe("2026-12-31");
  });
  it("datesInRange is inclusive", () => {
    expect(datesInRange("2026-12-30", "2027-01-01")).toEqual(["2026-12-30", "2026-12-31", "2027-01-01"]);
  });
  it("datesInRange throws RangeError when from > to", () => {
    expect(() => datesInRange("2026-12-02", "2026-12-01")).toThrow(RangeError);
  });
  it("datesInRange throws RangeError on a malformed bound", () => {
    expect(() => datesInRange("2026-12-01", "garbage")).toThrow(RangeError);
    expect(() => datesInRange("garbage", "2026-12-01")).toThrow(RangeError);
  });
  it("rejects impossible dates instead of rolling over", () => {
    expect(() => weekdayOf("2026-02-31")).toThrow(RangeError);
    expect(() => addDays("2026-13-01", 1)).toThrow(RangeError);
  });
});
