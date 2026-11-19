import { localDayBoundsUtc } from "@grooming/datetime";
import { describe, expect, it } from "vitest";
import { at, dani, DANI_ID, location, makeEmployee, makeLocation, MON, NY, chair1, CHAIR_1_ID } from "../test/fixtures";
import { employeeFreeTime, resourceFreeTime } from "./free-time";
import type { BusySegment } from "./types";

const day = (from: string, to: string) => ({ start: at(MON, from), end: at(MON, to) });
const run = (o: Partial<Parameters<typeof employeeFreeTime>[0]> = {}) =>
  employeeFreeTime({ employee: dani, location, date: MON, busy: [], ignoreHours: false, ...o });
const busy = (start: number, blockEnd: number): BusySegment => ({ employeeId: DANI_ID, resourceId: null, start, blockEnd });
const everyDay = dani.workingHours;

describe("employeeFreeTime", () => {
  it("full day with no busy", () => {
    expect(run()).toEqual([day("09:00", "19:00")]);
  });
  it("split shift", () => {
    const wh = everyDay.flatMap((h) => [
      { ...h, start: "09:00" as const, end: "13:00" as const },
      { ...h, start: "14:00" as const, end: "19:00" as const },
    ]);
    expect(run({ employee: makeEmployee(dani, { workingHours: wh }) })).toEqual([day("09:00", "13:00"), day("14:00", "19:00")]);
  });
  it("busy segment", () => {
    expect(run({ busy: [busy(at(MON, "10:00"), at(MON, "11:00"))] })).toEqual([day("09:00", "10:00"), day("11:00", "19:00")]);
  });
  it("clamps to location hours", () => {
    const wh = everyDay.map((h) => ({ ...h, start: "08:00" as const, end: "21:00" as const }));
    expect(run({ employee: makeEmployee(dani, { workingHours: wh }) })).toEqual([day("09:00", "19:00")]);
  });
  it("multi-day time off and overnight busy", () => {
    const off = [{ start: at("2026-12-05", "00:00"), end: at("2026-12-09", "00:00") }];
    expect(run({ employee: makeEmployee(dani, { timeOff: off }) })).toEqual([]);
    const overnight = busy(at("2026-12-06", "23:30"), at(MON, "09:30"));
    expect(run({ busy: [overnight] })).toEqual([day("09:30", "19:00")]);
  });
  it("location closure", () => {
    const closures = [{ start: at(MON, "00:00"), end: at("2026-12-08", "00:00") }];
    expect(run({ location: makeLocation({ closures }) })).toEqual([]);
  });
  it("ignoreHours uses the whole local day minus busy", () => {
    const off = [day("00:00", "23:59")];
    const b = busy(at(MON, "10:00"), at(MON, "11:00"));
    const bounds = localDayBoundsUtc(MON, NY);
    expect(run({ ignoreHours: true, employee: makeEmployee(dani, { timeOff: off }), busy: [b] })).toEqual([
      { start: bounds.start, end: b.start },
      { start: b.blockEnd, end: bounds.end },
    ]);
  });
  it("DST spring-forward day", () => {
    expect(run({ date: "2026-03-08" })).toEqual([
      { start: Date.parse("2026-03-08T13:00:00Z"), end: Date.parse("2026-03-08T23:00:00Z") },
    ]);
  });
});

describe("resourceFreeTime", () => {
  it("day minus resource busy", () => {
    const b: BusySegment = { employeeId: "x", resourceId: CHAIR_1_ID, start: at(MON, "10:00"), blockEnd: at(MON, "11:00") };
    const bounds = localDayBoundsUtc(MON, NY);
    expect(resourceFreeTime({ resource: chair1, location, date: MON, busy: [b] })).toEqual([
      { start: bounds.start, end: b.start },
      { start: b.blockEnd, end: bounds.end },
    ]);
  });
});
