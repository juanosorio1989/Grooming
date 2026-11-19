import { describe, expect, it } from "vitest";
import { localDayBoundsUtc, todayIn, utcToWall, wallTimeToUtc } from "./zoned";

const NY = "America/New_York";

describe("wallTimeToUtc", () => {
  it("handles standard and daylight time", () => {
    expect(wallTimeToUtc("2026-12-07", "09:00", NY)).toBe(Date.parse("2026-12-07T14:00:00Z"));
    expect(wallTimeToUtc("2026-03-07", "09:00", NY)).toBe(Date.parse("2026-03-07T14:00:00Z"));
    expect(wallTimeToUtc("2026-03-08", "09:00", NY)).toBe(Date.parse("2026-03-08T13:00:00Z"));
    expect(wallTimeToUtc("2026-11-01", "09:00", NY)).toBe(Date.parse("2026-11-01T14:00:00Z"));
  });
  it("shifts a nonexistent spring-forward time forward by the gap", () => {
    expect(wallTimeToUtc("2026-03-08", "02:30", NY)).toBe(Date.parse("2026-03-08T07:30:00Z"));
  });
  it("uses the first occurrence for an ambiguous fall-back time", () => {
    expect(wallTimeToUtc("2026-11-01", "01:30", NY)).toBe(Date.parse("2026-11-01T05:30:00Z"));
  });
});

describe("localDayBoundsUtc", () => {
  it("is 23 h on spring-forward day", () => {
    expect(localDayBoundsUtc("2026-03-08", NY)).toEqual({
      start: Date.parse("2026-03-08T05:00:00Z"),
      end: Date.parse("2026-03-09T04:00:00Z"),
    });
  });
  it("is 25 h on fall-back day", () => {
    expect(localDayBoundsUtc("2026-11-01", NY)).toEqual({
      start: Date.parse("2026-11-01T04:00:00Z"),
      end: Date.parse("2026-11-02T05:00:00Z"),
    });
  });
});

describe("utcToWall", () => {
  it("converts an instant to local wall time", () => {
    expect(utcToWall(Date.parse("2026-12-07T14:00:00Z"), NY)).toEqual({
      date: "2026-12-07",
      time: "09:00",
      weekday: 1,
    });
  });
});

describe("todayIn", () => {
  it("returns the local date", () => {
    expect(todayIn(NY, Date.parse("2026-12-08T03:00:00Z"))).toBe("2026-12-07");
  });
});

describe("validation", () => {
  it("rejects impossible wall times", () => {
    expect(() => wallTimeToUtc("2026-12-07", "09:60", NY)).toThrow(RangeError);
    expect(() => wallTimeToUtc("2026-12-07", "25:00", NY)).toThrow(RangeError);
    expect(() => wallTimeToUtc("2026-12-07", "24:01", NY)).toThrow(RangeError);
    expect(() => wallTimeToUtc("2026-12-07", "9:00", NY)).toThrow(RangeError);
  });
  it("accepts 24:00 as the end of the local day", () => {
    expect(wallTimeToUtc("2026-12-07", "24:00", NY)).toBe(wallTimeToUtc("2026-12-08", "00:00", NY));
  });
  it("rejects invalid time zones", () => {
    expect(() => wallTimeToUtc("2026-12-07", "09:00", "Not/AZone")).toThrow(RangeError);
    expect(() => utcToWall(0, "Not/AZone")).toThrow(RangeError);
    expect(() => todayIn("Not/AZone", 0)).toThrow(RangeError);
  });
});
