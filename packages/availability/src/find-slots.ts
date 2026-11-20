import { MINUTE } from "@grooming/datetime";
import { weeklyToUtc } from "./free-time";
import { beyondHorizon, earliestStart, prepare } from "./prepare";
import { resolvePets } from "./resolve";
import { planDropOff, planWait } from "./search";
import type { FindSlotsInput, Ms, Slot } from "./types";

/** Bookable slots for one local date: wait-mode start times or drop-off times, each with a full plan. */
export function findSlots(input: FindSlotsInput): Slot[] {
  const { date, bookingMode, pets, ...ctx } = input;
  const p = prepare(ctx, date);
  const specs = resolvePets(p, pets);
  if (ctx.mode === "ONLINE") {
    const requested = new Set(pets.flatMap((x) => x.serviceIds));
    if (ctx.services.some((s) => requested.has(s.id) && !s.onlineBookable)) return [];
  }
  if (beyondHorizon(ctx, date)) return [];
  if (specs.some((s) => s.segments.some((seg) => seg.candidates.length === 0))) return [];

  const step = ctx.location.slotIntervalMin * MINUTE;
  const earliest = earliestStart(ctx, p.dayStart);
  const ignoreWindows = ctx.mode === "STAFF" && ctx.override === true;
  // Drop-off windows are half-open [start, end) local times.
  const windows = weeklyToUtc(ctx.location.dropOffWindows, date, ctx.location.timezone);
  const inWindow = (t: Ms) => ignoreWindows || windows.some((w) => w.start <= t && t < w.end);

  const slots: Slot[] = [];
  for (let t = p.dayStart; t < p.dayEnd; t += step) {
    if (t < earliest) continue;
    if (bookingMode === "DROP_OFF" && !inWindow(t)) continue;
    const plan = bookingMode === "WAIT" ? planWait(p, specs, t) : planDropOff(p, specs, t);
    if (plan === null) continue;
    const readyAt = Math.max(...plan.flatMap((x) => x.segments.filter((s) => s.stage !== "KENNEL").map((s) => s.end)));
    slots.push({ start: t, readyAt, bookingMode, pets: plan });
  }
  return slots;
}
