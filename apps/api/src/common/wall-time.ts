import type { WallTime } from "@grooming/contracts";

/** Postgres `TIME` columns are read by Prisma as a `Date` on 1970-01-01 UTC. `"24:00"` is stored as `00:00`. */
export function wallToDbTime(t: WallTime): Date {
  const [h, m] = t.split(":").map(Number) as [number, number];
  return new Date(Date.UTC(1970, 0, 1, h === 24 ? 0 : h, m));
}

/** Inverse of `wallToDbTime`; `00:00` read as an end time (`isEnd`) is `"24:00"`. */
export function dbTimeToWall(d: Date, isEnd: boolean): WallTime {
  const h = d.getUTCHours();
  const m = d.getUTCMinutes();
  if (isEnd && h === 0 && m === 0) return "24:00";
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}
