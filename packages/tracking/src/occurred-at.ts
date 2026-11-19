import { MINUTE } from "@grooming/datetime";
import type { Ms } from "./types.js";

export const OCCURRED_AT_MAX_AGE_MS = 12 * 60 * MINUTE;
export const OCCURRED_AT_MAX_SKEW_MS = 2 * MINUTE;

export function effectiveOccurredAt(occurredAt: Ms | null, now: Ms): Ms {
  if (
    occurredAt !== null &&
    occurredAt >= now - OCCURRED_AT_MAX_AGE_MS &&
    occurredAt <= now + OCCURRED_AT_MAX_SKEW_MS
  ) {
    return Math.min(occurredAt, now);
  }
  return now;
}
