import { addDays, localDayBoundsUtc, MINUTE, todayIn } from "@grooming/datetime";
import type { IsoDate } from "@grooming/datetime";
import { employeeFreeTime, resourceFreeTime } from "./free-time";
import type { Context, Interval, Ms } from "./types";

export const MAX_PETS = 4;
export const MAX_SERVICES_PER_PET = 6;

/** Per-call precomputed data: free time per employee/resource, booked minutes per employee. */
export interface Prepared {
  ctx: Context;
  date: IsoDate;
  dayStart: Ms;
  dayEnd: Ms;
  employeeFree: Map<string, Interval[]>;
  resourceFree: Map<string, Interval[]>;
  booked: Map<string, number>;
}

export function prepare(ctx: Context, date: IsoDate): Prepared {
  const { location, busy } = ctx;
  const ignoreHours = ctx.mode === "STAFF" && ctx.override === true;
  const { start: dayStart, end: dayEnd } = localDayBoundsUtc(date, location.timezone);
  const employeeFree = new Map<string, Interval[]>();
  const booked = new Map<string, number>();
  for (const employee of ctx.employees) {
    employeeFree.set(employee.id, employeeFreeTime({ employee, location, date, busy, ignoreHours }));
    // Booked minutes come only from the input busy list (rows without an employee count for nobody).
    const minutes = busy
      .filter((b) => b.employeeId === employee.id && b.start >= dayStart && b.start < dayEnd)
      .reduce((sum, b) => sum + (b.blockEnd - b.start) / MINUTE, 0);
    booked.set(employee.id, minutes);
  }
  const resourceFree = new Map<string, Interval[]>();
  for (const resource of ctx.resources) {
    resourceFree.set(resource.id, resourceFreeTime({ resource, location, date, busy }));
  }
  return { ctx, date, dayStart, dayEnd, employeeFree, resourceFree, booked };
}

/** Earliest allowed start for the given day, on the slot grid. */
export function earliestStart(ctx: Context, dayStart: Ms): Ms {
  if (ctx.mode === "ONLINE") return ctx.now + ctx.location.minLeadMinutes * MINUTE;
  const step = ctx.location.slotIntervalMin * MINUTE;
  if (ctx.now <= dayStart) return dayStart;
  return dayStart + Math.floor((ctx.now - dayStart) / step) * step;
}

export function beyondHorizon(ctx: Context, date: IsoDate): boolean {
  if (ctx.mode !== "ONLINE") return false;
  const today = todayIn(ctx.location.timezone, ctx.now);
  return date > addDays(today, ctx.location.bookingHorizonDays);
}
