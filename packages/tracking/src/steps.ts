import {
  WORK_STAGE_ORDER,
  type Ms,
  type Step,
  type WorkStage,
} from "./types.js";

export type TrackingErrorCode =
  | "STEP_CONFLICT"
  | "STEP_ORDER"
  | "AFTER_PHOTO_REQUIRED"
  | "INVALID_TIMELINE";

export type StepAction =
  | { type: "START"; stage: WorkStage }
  | { type: "SKIP"; stage: WorkStage }
  | { type: "READY" };

export interface StepContext {
  at: Ms;
  performedBy: string;
  recordedBy: string;
  requireAfterPhoto: boolean;
  hasAfterPhoto: boolean;
}

type VisitStepStatus = "RECEIVED" | "IN_PROGRESS" | "READY";

export type StepResult =
  | { ok: true; steps: Step[]; visitStatus: VisitStepStatus }
  | { ok: false; code: TrackingErrorCode };

const isWork = (s: Step): boolean => s.stage !== "RECEIVED" && s.stage !== "READY";

export function buildInitialSteps(args: { stages: WorkStage[]; at: Ms; actor: string }): Step[] {
  const wanted = WORK_STAGE_ORDER.filter((s) => args.stages.includes(s));
  const blank = (stage: Step["stage"], sort: number): Step => ({
    stage,
    sort,
    status: "PENDING",
    startedAt: null,
    finishedAt: null,
    performedBy: null,
    recordedBy: null,
  });
  return [
    {
      ...blank("RECEIVED", 0),
      status: "DONE",
      startedAt: args.at,
      finishedAt: args.at,
      performedBy: args.actor,
      recordedBy: args.actor,
    },
    ...wanted.map((stage, i) => blank(stage, i + 1)),
    blank("READY", wanted.length + 1),
  ];
}

export function visitStatusFromSteps(steps: Step[]): VisitStepStatus {
  if (steps.some((s) => s.stage === "READY" && s.status === "DONE")) return "READY";
  if (steps.some((s) => isWork(s) && (s.status === "IN_PROGRESS" || s.status === "DONE"))) {
    return "IN_PROGRESS";
  }
  return "RECEIVED";
}

function latestTimestamp(steps: Step[]): Ms {
  let latest = -Infinity;
  for (const s of steps) {
    // A skip-ahead (SKIPPED, never started) has no work interval and does not bound later actions.
    if (s.status === "SKIPPED" && s.startedAt === null) continue;
    if (s.startedAt !== null) latest = Math.max(latest, s.startedAt);
    if (s.finishedAt !== null) latest = Math.max(latest, s.finishedAt);
  }
  return latest;
}

const fail = (code: TrackingErrorCode): StepResult => ({ ok: false, code });

export function applyStepAction(steps: Step[], action: StepAction, ctx: StepContext): StepResult {
  const received = steps.find((s) => s.stage === "RECEIVED");
  const ready = steps.find((s) => s.stage === "READY");
  if (!received || received.status !== "DONE" || !ready || ready.status === "DONE") {
    return fail("STEP_CONFLICT");
  }
  const target =
    action.type === "READY" ? undefined : steps.find((s) => s.stage === action.stage);
  if (action.type !== "READY" && !target) return fail("STEP_CONFLICT");

  const at = Math.max(ctx.at, latestTimestamp(steps));
  const people = { performedBy: ctx.performedBy, recordedBy: ctx.recordedBy };
  const next = steps.map((s) => ({ ...s }));
  const find = (stage: Step["stage"]) => next.find((s) => s.stage === stage)!;
  const closeOpen = () => {
    for (const s of next) {
      if (isWork(s) && s.status === "IN_PROGRESS") {
        s.status = "DONE";
        s.finishedAt = at;
      }
    }
  };

  if (action.type === "START" && target) {
    if (target.status !== "PENDING") return fail("STEP_CONFLICT");
    if (steps.some((s) => isWork(s) && s.sort < target.sort && s.status === "PENDING")) {
      return fail("STEP_ORDER");
    }
    closeOpen();
    Object.assign(find(target.stage), { status: "IN_PROGRESS", startedAt: at, ...people });
  } else if (action.type === "SKIP" && target) {
    if (target.status !== "PENDING" && target.status !== "IN_PROGRESS") {
      return fail("STEP_CONFLICT");
    }
    Object.assign(find(target.stage), { status: "SKIPPED", finishedAt: at, ...people });
  } else {
    closeOpen();
    if (next.some((s) => isWork(s) && s.status === "PENDING")) return fail("STEP_ORDER");
    if (ctx.requireAfterPhoto && !ctx.hasAfterPhoto) return fail("AFTER_PHOTO_REQUIRED");
    Object.assign(find("READY"), { status: "DONE", startedAt: at, finishedAt: at, ...people });
  }
  return { ok: true, steps: next, visitStatus: visitStatusFromSteps(next) };
}

export function validateSteps(steps: Step[]): TrackingErrorCode | null {
  const bad: TrackingErrorCode = "INVALID_TIMELINE";
  const n = steps.length;
  if (n < 2) return bad;
  if (steps.some((s, i) => s.sort !== i)) return bad;
  if (steps[0]!.stage !== "RECEIVED" || steps[n - 1]!.stage !== "READY") return bad;
  const work = steps.slice(1, n - 1);
  let lastIdx = -1;
  for (const s of work) {
    const idx = WORK_STAGE_ORDER.indexOf(s.stage as WorkStage);
    if (idx <= lastIdx) return bad; // unknown, duplicate or out of order
    lastIdx = idx;
  }
  if (steps.filter((s) => s.status === "IN_PROGRESS").length > 1) return bad;

  for (const s of steps) {
    const { startedAt: a, finishedAt: b } = s;
    switch (s.status) {
      case "PENDING":
        if (a !== null || b !== null) return bad;
        break;
      case "IN_PROGRESS":
        if (a === null || b !== null) return bad;
        break;
      case "DONE":
        if (a === null || b === null || a > b) return bad;
        break;
      case "SKIPPED":
        if (b === null || (a !== null && a > b)) return bad;
        break;
    }
  }

  const firstPending = work.findIndex((s) => s.status === "PENDING");
  if (firstPending >= 0 && work.slice(firstPending).some((s) => s.status === "DONE" || s.status === "IN_PROGRESS")) {
    return bad;
  }
  const ready = steps[n - 1]!;
  if (ready.status === "DONE" && work.some((s) => s.status !== "DONE" && s.status !== "SKIPPED")) {
    return bad;
  }

  let prevLast: Ms | null = null;
  for (const s of steps) {
    if (s.status === "PENDING") continue;
    if (s.status === "SKIPPED" && s.startedAt === null) continue; // no work interval
    const first = s.startedAt ?? s.finishedAt;
    if (prevLast !== null && first !== null && first < prevLast) return bad;
    prevLast = s.finishedAt ?? s.startedAt;
  }
  return null;
}
