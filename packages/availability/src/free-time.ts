import { localDayBoundsUtc, wallTimeToUtc, weekdayOf } from "@grooming/datetime";
import type { IsoDate } from "@grooming/datetime";
import { intersect, normalize, subtract } from "./intervals";
import type {
  BusySegment,
  EmployeeInput,
  Interval,
  LocationInput,
  ResourceInput,
  WeeklyHours,
} from "./types";

/** Normalized UTC intervals for the weekday of `date` ("24:00" end allowed). */
export function weeklyToUtc(hours: WeeklyHours[], date: IsoDate, timeZone: string): Interval[] {
  const weekday = weekdayOf(date);
  return normalize(
    hours
      .filter((h) => h.weekday === weekday)
      .map((h) => ({
        start: wallTimeToUtc(date, h.start, timeZone),
        end: wallTimeToUtc(date, h.end, timeZone),
      })),
  );
}

export function employeeFreeTime(args: {
  employee: EmployeeInput;
  location: LocationInput;
  date: IsoDate;
  busy: BusySegment[];
  ignoreHours: boolean;
}): Interval[] {
  const { employee, location, date, busy, ignoreHours } = args;
  const tz = location.timezone;
  const busyRanges = busy
    .filter((b) => b.employeeId === employee.id)
    .map((b) => ({ start: b.start, end: b.blockEnd }));
  if (ignoreHours) {
    return subtract([localDayBoundsUtc(date, tz)], busyRanges);
  }
  const base = intersect(
    weeklyToUtc(employee.workingHours, date, tz),
    weeklyToUtc(location.hours, date, tz),
  );
  return subtract(base, [...location.closures, ...employee.timeOff, ...busyRanges]);
}

export function resourceFreeTime(args: {
  resource: ResourceInput;
  location: LocationInput;
  date: IsoDate;
  busy: BusySegment[];
}): Interval[] {
  const { resource, location, date, busy } = args;
  const busyRanges = busy
    .filter((b) => b.resourceId === resource.id)
    .map((b) => ({ start: b.start, end: b.blockEnd }));
  return subtract([localDayBoundsUtc(date, location.timezone)], busyRanges);
}
