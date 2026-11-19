import { MINUTE } from "@grooming/datetime";
import { covers } from "./intervals";
import type { Prepared } from "./prepare";
import type { PetSpec, SegmentSpec } from "./resolve";
import type { Interval, Ms, PetPlan, PlannedSegment, ResourceInput } from "./types";

/** Wait mode: max idle between two consecutive segments of one pet. */
export const WAIT_MAX_GAP_MIN = 15;
/** Drop-off mode: intake time between the drop-off time and the earliest first segment. */
export const DROP_OFF_INTAKE_MIN = 10;
/** Safety net: placement attempts per start; beyond it that start yields no plan. */
export const MAX_NODES_PER_START = 5000;

/**
 * Rule B: the buffer blocks the employee and resource after a segment, except when the same
 * employee starts the pet's next segment exactly at its end and the segment has no resource or the
 * next one keeps the same resource (a station is never released early). Kennels use `end` (callers).
 */
export function blockEndFor(
  seg: { employeeId: string | null; resourceId: string | null; end: Ms; bufferAfterMin: number },
  next: { employeeId: string | null; resourceId: string | null; start: Ms } | null,
): Ms {
  const dropped =
    next !== null &&
    seg.employeeId !== null &&
    next.employeeId === seg.employeeId &&
    next.start === seg.end &&
    (seg.resourceId === null || next.resourceId === seg.resourceId);
  return dropped ? seg.end : seg.end + seg.bufferAfterMin * MINUTE;
}

const overlaps = (a: Interval, b: Interval): boolean => a.start < b.end && b.start < a.end;
const byNameThenId = (a: ResourceInput, b: ResourceInput): number =>
  a.name < b.name ? -1 : a.name > b.name ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0;

type SearchMode = "WAIT" | "DROP_OFF";

/**
 * Backtracking search shared by both booking modes. Pets in request order, segments in stage
 * order, one pet finished before the next. The latest placed segment is "open" (its blockEnd is
 * still its end); placing the pet's next segment closes it with Rule B and re-checks the buffer.
 */
function search(p: Prepared, specs: PetSpec[], base: Ms, mode: SearchMode, maxNodes: number): PetPlan[] | null {
  const { ctx, dayStart, dayEnd } = p;
  const step = ctx.location.slotIntervalMin * MINUTE;
  const flat: SegmentSpec[] = specs.flatMap((s) => s.segments);
  const firstFlat: number[] = [];
  specs.reduce((k, s) => (firstFlat.push(k), k + s.segments.length), 0);
  const kennels = ctx.resources.filter((r) => r.kind === "KENNEL").sort(byNameThenId);
  const byType = new Map<string, ResourceInput[]>();
  const resourcesOfType = (typeId: string): ResourceInput[] => {
    let list = byType.get(typeId);
    if (!list) {
      list = ctx.resources.filter((r) => r.kind === "STATION" && r.resourceTypeId === typeId).sort(byNameThenId);
      byType.set(typeId, list);
    }
    return list;
  };
  const freeKeys = new Map<string, string>();
  const freeKey = (map: Map<string, Interval[]>, id: string): string => {
    let key = freeKeys.get(id);
    if (key === undefined) {
      key = JSON.stringify(map.get(id) ?? []);
      freeKeys.set(id, key);
    }
    return key;
  };
  const laterKeys = new Map<string, string>();
  const laterMembership = (k: number, employeeId: string): string => {
    const memo = `${k}|${employeeId}`;
    let key = laterKeys.get(memo);
    if (key === undefined) {
      key = flat
        .slice(k + 1)
        .map((s) => (s.candidates.some((e) => e.id === employeeId) ? "1" : "0"))
        .join("");
      laterKeys.set(memo, key);
    }
    return key;
  };

  const plan: PlannedSegment[] = [];
  let nodes = 0;
  let aborted = false;

  const employeeFree = (id: string) => p.employeeFree.get(id) ?? [];
  const resourceFree = (id: string) => p.resourceFree.get(id) ?? [];
  /** Plan segments sharing the employee or resource whose block overlaps the range (open: blockEnd = end). */
  const clashes = (employeeId: string | null, resourceId: string | null, range: Interval, skip?: PlannedSegment) =>
    plan.some(
      (o) =>
        o !== skip &&
        ((employeeId !== null && o.employeeId === employeeId) || (resourceId !== null && o.resourceId === resourceId)) &&
        overlaps(range, { start: o.start, end: o.blockEnd }),
    );
  /** Close a segment at `blockEnd`: the buffer range must be free and clash with nothing in the plan. */
  const canClose = (seg: PlannedSegment, blockEnd: Ms): boolean => {
    if (blockEnd <= seg.end) return true;
    const range = { start: seg.end, end: blockEnd };
    if (seg.employeeId !== null && !covers(employeeFree(seg.employeeId), range)) return false;
    if (seg.resourceId !== null && !covers(resourceFree(seg.resourceId), range)) return false;
    return !clashes(seg.employeeId, seg.resourceId, range, seg);
  };
  const kennelUsed = (id: string) => plan.some((o) => o.resourceId === id);

  const startsFor = (pi: number, si: number, lb: Ms, idleUsed: number, durMs: number): Ms[] => {
    if (mode === "WAIT" && pi === 0 && si === 0) return base + durMs <= dayEnd ? [base] : [];
    const out: Ms[] = [];
    const firstGrid = dayStart + (Math.floor((lb - dayStart) / step) + 1) * step;
    for (let s = lb; s + durMs <= dayEnd; s = s === lb ? firstGrid : s + step) {
      const idle = s - lb;
      if (mode === "WAIT" && si > 0 && idle > WAIT_MAX_GAP_MIN * MINUTE) break;
      if (mode === "DROP_OFF" && idleUsed + idle > ctx.location.maxQueueWaitMin * MINUTE) break;
      out.push(s);
    }
    return out;
  };

  const placePet = (pi: number): boolean => {
    const spec = specs[pi];
    if (spec === undefined) return true;
    if (mode === "DROP_OFF") {
      const total = spec.segments.reduce((n, s) => n + s.durationMin, 0);
      const range = {
        start: base,
        end: base + (DROP_OFF_INTAKE_MIN + total + ctx.location.pickupGraceMin) * MINUTE,
      };
      if (!kennels.some((k) => !kennelUsed(k.id) && covers(resourceFree(k.id), range))) return false;
      return placeSeg(pi, 0, base + DROP_OFF_INTAKE_MIN * MINUTE, 0);
    }
    return placeSeg(pi, 0, base, 0);
  };

  /** After the pet's last segment: close it, assign a kennel in drop-off, continue with the next pet. */
  const finishPet = (pi: number, last: PlannedSegment, spec: SegmentSpec): boolean => {
    const lastBlock = blockEndFor({ ...last, bufferAfterMin: spec.bufferAfterMin }, null);
    if (!canClose(last, lastBlock)) return false;
    last.blockEnd = lastBlock;
    if (mode === "DROP_OFF") {
      const range = { start: base, end: last.end + ctx.location.pickupGraceMin * MINUTE };
      const kennel = kennels.find((k) => covers(resourceFree(k.id), range) && !clashes(null, k.id, range));
      if (kennel === undefined) return false;
      plan.push({
        petId: last.petId,
        stage: "KENNEL",
        serviceIds: [],
        employeeId: null,
        resourceId: kennel.id,
        start: range.start,
        end: range.end,
        blockEnd: range.end,
        durationMin: (range.end - range.start) / MINUTE,
        priceCents: 0,
      });
      if (placePet(pi + 1)) return true;
      plan.pop();
      return false;
    }
    return placePet(pi + 1);
  };

  const placeSeg = (pi: number, si: number, lb: Ms, idleUsed: number): boolean => {
    const petSpec = specs[pi]!;
    const spec = petSpec.segments[si]!;
    const k = firstFlat[pi]! + si;
    const isLast = si === petSpec.segments.length - 1;
    const durMs = spec.durationMin * MINUTE;
    const prev = si > 0 ? plan[plan.length - 1]! : null;
    const prevSpec = si > 0 ? petSpec.segments[si - 1]! : null;
    const resources: (ResourceInput | null)[] = spec.resourceTypeId ? resourcesOfType(spec.resourceTypeId) : [null];

    for (const start of startsFor(pi, si, lb, idleUsed, durMs)) {
      const end = start + durMs;
      const range = { start, end };
      const seenE = new Set<string>();
      for (const employee of spec.candidates) {
        const used = plan.some((o) => o.employeeId === employee.id);
        const eKey = used ? `id:${employee.id}` : `${freeKey(p.employeeFree, employee.id)}|${laterMembership(k, employee.id)}`;
        if (seenE.has(eKey)) continue;
        seenE.add(eKey);
        if (!covers(employeeFree(employee.id), range) || clashes(employee.id, null, range)) continue;
        const seenR = new Set<string>();
        for (const resource of resources) {
          if (resource !== null) {
            const rKey = plan.some((o) => o.resourceId === resource.id)
              ? `id:${resource.id}`
              : freeKey(p.resourceFree, resource.id);
            if (seenR.has(rKey)) continue;
            seenR.add(rKey);
          }
          if (++nodes > maxNodes) {
            aborted = true;
            return false;
          }
          if (resource !== null && (!covers(resourceFree(resource.id), range) || clashes(null, resource.id, range))) {
            continue;
          }
          const seg: PlannedSegment = {
            petId: petSpec.petId,
            stage: spec.stage,
            serviceIds: [...spec.serviceIds],
            employeeId: employee.id,
            resourceId: resource?.id ?? null,
            start,
            end,
            blockEnd: end,
            durationMin: spec.durationMin,
            priceCents: spec.priceCents,
          };
          plan.push(seg);
          let ok = true;
          if (prev !== null && prevSpec !== null) {
            const prevBlock = blockEndFor({ ...prev, bufferAfterMin: prevSpec.bufferAfterMin }, seg);
            ok = canClose(prev, prevBlock);
            if (ok) prev.blockEnd = prevBlock;
          }
          if (ok) {
            const found = isLast ? finishPet(pi, seg, spec) : placeSeg(pi, si + 1, end, idleUsed + (start - lb));
            if (found) return true;
          }
          if (prev !== null) prev.blockEnd = prev.end;
          seg.blockEnd = seg.end;
          plan.pop();
          if (aborted) return false;
        }
      }
    }
    return false;
  };

  if (!placePet(0) || aborted) return null;
  return specs.map((s) => ({
    petId: s.petId,
    priceCents: s.priceCents,
    segments: plan.filter((seg) => seg.petId === s.petId),
  }));
}

/** Wait mode at grid time `t`: the first pet's first segment starts at `t`. */
export function planWait(p: Prepared, specs: PetSpec[], t: Ms, maxNodes: number = MAX_NODES_PER_START): PetPlan[] | null {
  return search(p, specs, t, "WAIT", maxNodes);
}

/** Drop-off mode at drop-off time `d`: work from `d + 10 min`, one kennel per pet over `[d, lastEnd + grace)`. */
export function planDropOff(
  p: Prepared,
  specs: PetSpec[],
  d: Ms,
  maxNodes: number = MAX_NODES_PER_START,
): PetPlan[] | null {
  return search(p, specs, d, "DROP_OFF", maxNodes);
}
