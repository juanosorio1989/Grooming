import { describe, expect, it } from "vitest";
import { WallRangeSchema, WallTimeSchema } from "@grooming/contracts";
import { dbTimeToWall, wallToDbTime } from "./wall-time.js";

describe("wall time conversion", () => {
  it('maps "24:00" to midnight and back for end times', () => {
    expect(wallToDbTime("24:00")).toEqual(new Date("1970-01-01T00:00:00Z"));
    expect(dbTimeToWall(new Date("1970-01-01T00:00:00Z"), true)).toBe("24:00");
    expect(dbTimeToWall(new Date("1970-01-01T00:00:00Z"), false)).toBe("00:00");
  });

  it("round-trips 08:30", () => {
    expect(wallToDbTime("08:30")).toEqual(new Date("1970-01-01T08:30:00Z"));
    expect(dbTimeToWall(wallToDbTime("08:30"), false)).toBe("08:30");
    expect(dbTimeToWall(wallToDbTime("08:30"), true)).toBe("08:30");
  });
});

describe("wall time schemas", () => {
  it("rejects malformed times", () => {
    for (const bad of ["24:01", "7:00", "12:60"]) expect(WallTimeSchema.safeParse(bad).success).toBe(false);
    for (const good of ["00:00", "23:59", "24:00"]) expect(WallTimeSchema.safeParse(good).success).toBe(true);
  });

  it("requires from < to and from !== 24:00", () => {
    expect(WallRangeSchema.safeParse({ from: "10:00", to: "10:00" }).success).toBe(false);
    expect(WallRangeSchema.safeParse({ from: "24:00", to: "24:00" }).success).toBe(false);
    expect(WallRangeSchema.safeParse({ from: "11:00", to: "10:00" }).success).toBe(false);
    expect(WallRangeSchema.safeParse({ from: "09:00", to: "24:00" }).success).toBe(true);
  });
});
