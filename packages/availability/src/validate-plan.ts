import { MINUTE, utcToWall } from "@grooming/datetime";
import { AvailabilityError } from "./errors";
import { covers } from "./intervals";
import { weeklyToUtc } from "./free-time";
import { beyondHorizon, earliestStart, prepare } from "./prepare";
import { resolvePets } from "./resolve";
import type { PetSpec, SegmentSpec } from "./resolve";
import { DROP_OFF_INTAKE_MIN, WAIT_MAX_GAP_MIN, blockEndFor } from "./search";
import type { Context, Interval, PetPlan, PlanRejection, PlannedSegment, Slot, SlotRequest } from "./types";

export type PlanVerdict = { ok: true } | { ok: false; reason: PlanRejection };

const fail = (reason: PlanRejection): PlanVerdict => ({ ok: false, reason });
const sameList = (a: string[], b: string[]): boolean => a.length === b.length && a.every((x, i) => x === b[i]);
const overlaps = (a: Interval, b: Interval): boolean => a.start < b.end && b.start < a.end;

/** A pet's work segments paired with their spec, plus its kennel segment (drop-off only). */
interface PetView {
  plan: PetPlan;
  spec: PetSpec;
  work: { seg: PlannedSegment; spec: SegmentSpec }[];
  kennel: PlannedSegment | null;
}

/** Check 1-3: structure. Returns the per-pet views or a rejection. */
function structure(
  input: Context & SlotRequest,
  slot: Slot,
  specs: PetSpec[],
): PetView[] | PlanVerdict {
  const dropOff = input.bookingMode === "DROP_OFF";
  if (slot.bookingMode !== input.bookingMode) return fail("MALFORMED_PLAN");
  if (slot.pets.length !== input.pets.length || slot.pets.some((x, i) => x.petId !== input.pets[i]!.petId)) {
    return fail("MALFORMED_PLAN");
  }
  if (input.mode === "ONLINE") {
    const requested = new Set(input.pets.flatMap((x) => x.serviceIds));
    if (input.services.some((s) => requested.has(s.id) && !s.onlineBookable)) return fail("NOT_BOOKABLE_ONLINE");
  }
  const views: PetView[] = [];
  for (const [i, plan] of slot.pets.entries()) {
    const spec = specs[i]!;
    const kennel = dropOff ? (plan.segments[plan.segments.length - 1] ?? null) : null;
    const workSegs = dropOff ? plan.segments.slice(0, -1) : plan.segments;
    if (dropOff && (kennel === null || kennel.stage !== "KENNEL")) return fail("MALFORMED_PLAN");
    if (workSegs.length !== spec.segments.length) return fail("MALFORMED_PLAN");
    const work: PetView["work"] = [];
    for (const [k, seg] of workSegs.entries()) {
      const s = spec.segments[k]!;
      if (
        seg.stage !== s.stage ||
        !sameList(seg.serviceIds, s.serviceIds) ||
        seg.durationMin !== s.durationMin ||
        seg.priceCents !== s.priceCents ||
        seg.end - seg.start !== s.durationMin * MINUTE
      ) {
        return fail("MALFORMED_PLAN");
      }
      work.push({ seg, spec: s });
    }
    if (plan.priceCents !== spec.priceCents) return fail("MALFORMED_PLAN");
    views.push({ plan, spec, work, kennel });
  }
  return views;
}

/** Check 4: employees. */
function employees(input: Context, views: PetView[]): PlanVerdict | null {
  for (const v of views) {
    for (const { seg, spec } of v.work) {
      const employee = input.employees.find((e) => e.id === seg.employeeId);
      if (!employee) return fail("NOT_QUALIFIED");
      if (input.mode === "ONLINE" && !employee.bookableOnline) return fail("NOT_BOOKABLE_ONLINE");
      if (!spec.candidates.some((c) => c.id === employee.id)) return fail("NOT_QUALIFIED");
    }
  }
  return null;
}

/** Check 6 and the kennel definition: timing shape inside the day. */
function shape(input: Context & SlotRequest, slot: Slot, views: PetView[]): PlanVerdict | null {
  const { location } = input;
  const wait = input.bookingMode === "WAIT";
  let readyAt = -Infinity;
  for (const [pi, v] of views.entries()) {
    let idle = 0;
    let prevEnd = 0;
    for (const [si, { seg }] of v.work.entries()) {
      if (si === 0) {
        if (wait ? (pi === 0 ? seg.start !== slot.start : seg.start < slot.start) : false) return fail("MALFORMED_PLAN");
        if (!wait && seg.start < slot.start + DROP_OFF_INTAKE_MIN * MINUTE) return fail("MALFORMED_PLAN");
        if (!wait) idle += seg.start - (slot.start + DROP_OFF_INTAKE_MIN * MINUTE);
      } else {
        const gap = seg.start - prevEnd;
        if (gap < 0) return fail("MALFORMED_PLAN");
        if (wait && gap > WAIT_MAX_GAP_MIN * MINUTE) return fail("MALFORMED_PLAN");
        if (!wait) idle += gap;
      }
      prevEnd = seg.end;
    }
    if (!wait && idle > location.maxQueueWaitMin * MINUTE) return fail("MALFORMED_PLAN");
    readyAt = Math.max(readyAt, prevEnd);
    if (v.kennel !== null) {
      const k = v.kennel;
      const end = prevEnd + location.pickupGraceMin * MINUTE;
      if (
        k.employeeId !== null ||
        k.serviceIds.length !== 0 ||
        k.priceCents !== 0 ||
        k.start !== slot.start ||
        k.end !== end ||
        k.blockEnd !== end ||
        k.durationMin !== (end - slot.start) / MINUTE
      ) {
        return fail("MALFORMED_PLAN");
      }
    }
  }
  return slot.readyAt === readyAt ? null : fail("MALFORMED_PLAN");
}

/** Check 7: every work segment's blockEnd follows Rule B. */
function buffers(views: PetView[]): PlanVerdict | null {
  for (const v of views) {
    for (const [i, { seg, spec }] of v.work.entries()) {
      const next = v.work[i + 1]?.seg ?? null;
      if (seg.blockEnd !== blockEndFor({ ...seg, bufferAfterMin: spec.bufferAfterMin }, next)) {
        return fail("MALFORMED_PLAN");
      }
    }
  }
  return null;
}

/** Check 8: resource presence, type and kind. */
function resources(input: Context, views: PetView[]): PlanVerdict | null {
  const all = views.flatMap((v) => [
    ...v.work.map(({ seg, spec }) => ({ seg, typeId: spec.resourceTypeId, kennel: false })),
    ...(v.kennel ? [{ seg: v.kennel, typeId: null, kennel: true }] : []),
  ]);
  if (all.some((x) => (x.kennel || x.typeId !== null) && x.seg.resourceId === null)) return fail("RESOURCE_UNAVAILABLE");
  if (all.some((x) => !x.kennel && x.typeId === null && x.seg.resourceId !== null)) return fail("MALFORMED_PLAN");
  for (const x of all) {
    if (x.seg.resourceId === null) continue;
    const r = input.resources.find((y) => y.id === x.seg.resourceId);
    if (!r) return fail("RESOURCE_UNAVAILABLE");
    if (x.kennel ? r.kind !== "KENNEL" : r.kind !== "STATION" || r.resourceTypeId !== x.typeId) {
      return fail("RESOURCE_UNAVAILABLE");
    }
  }
  return null;
}

/**
 * Write-time re-check of an exact slot plan (used by hold creation). Does not search: it verifies
 * the given plan against the request, qualifications, calendar rules and current availability.
 * Checks run in a fixed order and the first failure wins.
 */
export function validatePlan(input: Context & SlotRequest, slot: Slot): PlanVerdict {
  const { bookingMode, pets, ...ctx } = input;
  const { location } = ctx;
  const dropOff = bookingMode === "DROP_OFF";

  // 1. Request resolution (needs a Prepared for candidate ordering; the date is only used for free time).
  const date = utcToWall(slot.start, location.timezone).date;
  const p = prepare(ctx, date);
  let specs: PetSpec[];
  try {
    specs = resolvePets(p, pets);
  } catch (e) {
    if (e instanceof AvailabilityError) return fail("MALFORMED_PLAN");
    throw e;
  }
  // 1-3
  const views = structure(input, slot, specs);
  if (!Array.isArray(views)) return views;

  // 4
  const emp = employees(ctx, views);
  if (emp) return emp;

  // 5. Date rules
  if (beyondHorizon(ctx, date)) return fail("BEYOND_HORIZON");
  if (slot.start < earliestStart(ctx, p.dayStart)) return fail("TOO_SOON");
  const step = location.slotIntervalMin * MINUTE;
  if ((slot.start - p.dayStart) % step !== 0) return fail("MALFORMED_PLAN");
  if (dropOff && !(ctx.mode === "STAFF" && ctx.override === true)) {
    const windows = weeklyToUtc(location.dropOffWindows, date, location.timezone);
    if (!windows.some((w) => w.start <= slot.start && slot.start < w.end)) return fail("OUTSIDE_DROP_OFF_WINDOW");
  }
  const segments = views.flatMap((v) => v.plan.segments);
  if (segments.some((s) => s.blockEnd > p.dayEnd)) return fail("MALFORMED_PLAN");

  // 6, 7, 8
  const rejected = shape(input, slot, views) ?? buffers(views) ?? resources(ctx, views);
  if (rejected) return rejected;

  // 9. Availability: free time covers every block and nothing in the plan collides.
  const blocks = segments.map((s) => ({ seg: s, range: { start: s.start, end: s.blockEnd } }));
  for (const [i, a] of blocks.entries()) {
    const { seg, range } = a;
    if (seg.employeeId !== null && !covers(p.employeeFree.get(seg.employeeId) ?? [], range)) {
      return fail("EMPLOYEE_UNAVAILABLE");
    }
    if (seg.resourceId !== null && !covers(p.resourceFree.get(seg.resourceId) ?? [], range)) {
      return fail("RESOURCE_UNAVAILABLE");
    }
    for (const b of blocks.slice(i + 1)) {
      if (!overlaps(range, b.range)) continue;
      if (seg.employeeId !== null && seg.employeeId === b.seg.employeeId) return fail("EMPLOYEE_UNAVAILABLE");
      if (seg.resourceId !== null && seg.resourceId === b.seg.resourceId) return fail("RESOURCE_UNAVAILABLE");
    }
  }
  return { ok: true };
}
