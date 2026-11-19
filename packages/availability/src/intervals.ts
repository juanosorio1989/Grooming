import type { Interval } from "./types";

/** Sort, merge overlapping/adjacent, drop empty. */
export function normalize(xs: Interval[]): Interval[] {
  const sorted = xs.filter((x) => x.end > x.start).sort((a, b) => a.start - b.start);
  const out: Interval[] = [];
  for (const x of sorted) {
    const last = out[out.length - 1];
    if (last && x.start <= last.end) {
      if (x.end > last.end) last.end = x.end;
    } else {
      out.push({ start: x.start, end: x.end });
    }
  }
  return out;
}

export function subtract(a: Interval[], b: Interval[]): Interval[] {
  const cuts = normalize(b);
  const out: Interval[] = [];
  for (const x of normalize(a)) {
    let cursor = x.start;
    for (const c of cuts) {
      if (c.end <= cursor) continue;
      if (c.start >= x.end) break;
      if (c.start > cursor) out.push({ start: cursor, end: c.start });
      cursor = Math.max(cursor, c.end);
    }
    if (cursor < x.end) out.push({ start: cursor, end: x.end });
  }
  return out;
}

export function intersect(a: Interval[], b: Interval[]): Interval[] {
  const na = normalize(a);
  const nb = normalize(b);
  const out: Interval[] = [];
  let i = 0;
  let j = 0;
  while (i < na.length && j < nb.length) {
    const x = na[i]!;
    const y = nb[j]!;
    const start = Math.max(x.start, y.start);
    const end = Math.min(x.end, y.end);
    if (end > start) out.push({ start, end });
    if (x.end < y.end) i++;
    else j++;
  }
  return out;
}

/** True when a single normalized interval of xs contains range entirely. */
export function covers(xs: Interval[], range: Interval): boolean {
  return normalize(xs).some((x) => x.start <= range.start && x.end >= range.end);
}
