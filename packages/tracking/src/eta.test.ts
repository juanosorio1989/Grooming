import { describe, expect, it } from "vitest";
import { MINUTE } from "@grooming/datetime";
import {
  estimateReady,
  ownerPageEtaChanged,
  shouldNotifyEtaChange,
  type PlannedStage,
} from "./eta";
import type { Step, StepStage, StepStatus } from "./types";

const T0 = Date.parse("2026-12-07T14:00:00Z");
const m = (n: number) => T0 + n * MINUTE;

const planned: PlannedStage[] = [
  { stage: "BATH", plannedStart: m(0), durationMin: 45 },
  { stage: "DRY", plannedStart: m(45), durationMin: 30 },
  { stage: "GROOM", plannedStart: m(75), durationMin: 60 },
];

const step = (
  stage: StepStage,
  status: StepStatus,
  startedAt: number | null = null,
  finishedAt: number | null = null,
): Step => ({
  stage,
  sort: 0,
  status,
  startedAt,
  finishedAt,
  performedBy: null,
  recordedBy: null,
});

describe("estimateReady", () => {
  it("before check-in follows the plan", () => {
    expect(estimateReady({ planned, steps: [], now: m(-60) })).toBe(m(135));
  });
  it("pending stages never start in the past", () => {
    expect(estimateReady({ planned, steps: [], now: m(30) })).toBe(m(165));
  });
  it("in-progress on time", () => {
    const steps = [step("BATH", "IN_PROGRESS", m(0))];
    expect(estimateReady({ planned, steps, now: m(20) })).toBe(m(135));
  });
  it("in-progress overrun uses now + 5", () => {
    const steps = [step("BATH", "IN_PROGRESS", m(0))];
    expect(estimateReady({ planned, steps, now: m(50) })).toBe(m(145));
  });
  it("skipped stage is removed", () => {
    const steps = [
      step("BATH", "DONE", m(0), m(45)),
      step("DRY", "SKIPPED"),
      step("GROOM", "PENDING"),
    ];
    expect(estimateReady({ planned, steps, now: m(50) })).toBe(m(135));
  });
  it("ready returns the ready time", () => {
    const steps = [step("READY", "DONE", m(100), m(100))];
    expect(estimateReady({ planned, steps, now: m(110) })).toBe(m(100));
  });
  it("nothing left", () => {
    const steps = [
      step("BATH", "DONE", m(0), m(45)),
      step("DRY", "DONE", m(45), m(75)),
      step("GROOM", "DONE", m(75), m(120)),
      step("READY", "PENDING"),
    ];
    expect(estimateReady({ planned, steps, now: m(130) })).toBe(m(130));
  });
  it("in-progress stage missing from the plan counts as zero duration", () => {
    const steps = [step("FINISH", "IN_PROGRESS", m(0))];
    expect(estimateReady({ planned: [], steps, now: m(20) })).toBe(m(25));
  });
});

describe("thresholds", () => {
  it("owner page threshold", () => {
    expect(ownerPageEtaChanged(null, m(0))).toBe(true);
    expect(ownerPageEtaChanged(m(0), m(4))).toBe(false);
    expect(ownerPageEtaChanged(m(0), m(5))).toBe(true);
    expect(ownerPageEtaChanged(m(5), m(0))).toBe(true);
  });
  it("notify threshold and hourly cap", () => {
    const base = { baselineEta: m(0), thresholdMin: 30, now: m(500) };
    const f = (nextEta: number, lastNotifiedAt: number | null) =>
      shouldNotifyEtaChange({ ...base, nextEta, lastNotifiedAt });
    expect(f(m(29), null)).toBe(false);
    expect(f(m(30), null)).toBe(true);
    expect(f(m(-30), null)).toBe(true);
    expect(f(m(40), m(500) - 59 * MINUTE)).toBe(false);
    expect(f(m(40), m(500) - 60 * MINUTE)).toBe(true);
  });
});
