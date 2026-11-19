import { TZDate } from "@date-fns/tz";
import { _isoToNoonUtc, addDays, MINUTE } from "./dates";
import type { IsoDate, WallTime, Weekday } from "./dates";


/** Offset (UTC minus local, in minutes) of `timeZone` at `instant`. */
function offsetMinutes(instant: number, timeZone: string): number {
  const offset = new TZDate(instant, timeZone).getTimezoneOffset();
  if (!Number.isFinite(offset)) throw new RangeError(`Invalid time zone: ${timeZone}`);
  return offset;
}

/**
 * Epoch ms for a local wall time. Nonexistent times (spring-forward gap) shift
 * forward by the gap; ambiguous times (fall-back) resolve to the first occurrence.
 */
export function wallTimeToUtc(date: IsoDate, time: WallTime, timeZone: string): number {
  const match = /^(\d{2}):(\d{2})$/.exec(time);
  if (!match) throw new RangeError(`Invalid wall time: ${time}`);
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  const validTime = (hours < 24 && minutes < 60) || (hours === 24 && minutes === 0);
  if (!validTime) throw new RangeError(`Invalid wall time: ${time}`);
  const wall = _isoToNoonUtc(date) - 12 * 60 * MINUTE + (hours * 60 + minutes) * MINUTE;

  const before = offsetMinutes(wall - 24 * 60 * MINUTE, timeZone);
  const after = offsetMinutes(wall + 24 * 60 * MINUTE, timeZone);
  const candidates = [...new Set([before, after])]
    .map((off) => wall + off * MINUTE)
    .filter((t) => t - offsetMinutes(t, timeZone) * MINUTE === wall)
    .sort((a, b) => a - b);

  // Gap: no candidate round-trips; apply the pre-gap offset to shift forward.
  return candidates[0] ?? wall + before * MINUTE;
}

const pad = (n: number): string => String(n).padStart(2, "0");

export function utcToWall(
  instant: number,
  timeZone: string,
): { date: IsoDate; time: WallTime; weekday: Weekday } {
  offsetMinutes(instant, timeZone);
  const z = new TZDate(instant, timeZone);
  return {
    date: `${z.getFullYear()}-${pad(z.getMonth() + 1)}-${pad(z.getDate())}`,
    time: `${pad(z.getHours())}:${pad(z.getMinutes())}`,
    weekday: z.getDay() as Weekday,
  };
}

/** Half-open bounds of a local day; `end` is the start of the next local day. */
export function localDayBoundsUtc(date: IsoDate, timeZone: string): { start: number; end: number } {
  return {
    start: wallTimeToUtc(date, "00:00", timeZone),
    end: wallTimeToUtc(addDays(date, 1), "00:00", timeZone),
  };
}

export function todayIn(timeZone: string, now: number): IsoDate {
  return utcToWall(now, timeZone).date;
}

