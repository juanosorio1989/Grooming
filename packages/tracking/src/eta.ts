import { MINUTE } from "@grooming/datetime";
import { WORK_STAGE_ORDER, type Ms, type Step, type WorkStage } from "./types.js";

export interface PlannedStage {
  stage: WorkStage;
  plannedStart: Ms;
  durationMin: number;
}

export const IN_PROGRESS_MIN_REMAINING_MIN = 5;
export const OWNER_PAGE_ETA_STEP_MIN = 5;
export const ETA_NOTIFY_MIN_INTERVAL_MIN = 60;

export function estimateReady(args: { planned: PlannedStage[]; steps: Step[]; now: Ms }): Ms {
  const { planned, steps, now } = args;
  const ready = steps.find((s) => s.stage === "READY");
  if (ready?.status === "DONE" && ready.finishedAt !== null) return ready.finishedAt;

  let prevEnd = -Infinity;
  for (const stage of WORK_STAGE_ORDER) {
    const plan = planned.find((p) => p.stage === stage);
    const step = steps.find((s) => s.stage === stage);
    const status = step?.status ?? "PENDING";
    if (status === "DONE" || status === "SKIPPED") continue;
    const durationMs = (plan?.durationMin ?? 0) * MINUTE;
    let end: Ms;
    if (status === "IN_PROGRESS") {
      const startedAt = step?.startedAt ?? now;
      end = Math.max(startedAt + durationMs, now + IN_PROGRESS_MIN_REMAINING_MIN * MINUTE);
    } else {
      if (!plan) continue;
      end = Math.max(plan.plannedStart, prevEnd, now) + durationMs;
    }
    prevEnd = end;
  }
  return prevEnd === -Infinity ? now : prevEnd;
}

export function ownerPageEtaChanged(prevEta: Ms | null, nextEta: Ms): boolean {
  return prevEta === null || Math.abs(nextEta - prevEta) >= OWNER_PAGE_ETA_STEP_MIN * MINUTE;
}

export function shouldNotifyEtaChange(args: {
  baselineEta: Ms;
  lastNotifiedAt: Ms | null;
  nextEta: Ms;
  now: Ms;
  thresholdMin: number;
}): boolean {
  const { baselineEta, lastNotifiedAt, nextEta, now, thresholdMin } = args;
  if (Math.abs(nextEta - baselineEta) < thresholdMin * MINUTE) return false;
  return lastNotifiedAt === null || now - lastNotifiedAt >= ETA_NOTIFY_MIN_INTERVAL_MIN * MINUTE;
}
