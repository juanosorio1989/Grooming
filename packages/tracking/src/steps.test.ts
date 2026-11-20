import { describe, expect, it } from "vitest";
import { MINUTE } from "@grooming/datetime";
import {
  applyStepAction,
  buildInitialSteps,
  validateSteps,
  type StepAction,
  type StepContext,
} from "./steps";
import type { Step } from "./types";

const T0 = Date.parse("2026-12-07T14:00:00Z");
const m = (n: number) => T0 + n * MINUTE;
const ctx = (o: Partial<StepContext> = {}): StepContext => ({
  at: m(10),
  performedBy: "ana",
  recordedBy: "ana",
  requireAfterPhoto: true,
  hasAfterPhoto: true,
  ...o,
});
const base = buildInitialSteps({ stages: ["GROOM", "BATH"], at: T0, actor: "rec" });

function run(steps: Step[], action: StepAction, c: StepContext) {
  const r = applyStepAction(steps, action, c);
  if (!r.ok) throw new Error(r.code);
  return r;
}
const get = (steps: Step[], stage: string) => steps.find((s) => s.stage === stage)!;

describe("steps", () => {
  it("initial steps", () => {
    expect(base.map((s) => [s.stage, s.status, s.sort])).toEqual([
      ["RECEIVED", "DONE", 0],
      ["BATH", "PENDING", 1],
      ["GROOM", "PENDING", 2],
      ["READY", "PENDING", 3],
    ]);
    expect(base[0]).toMatchObject({ startedAt: T0, finishedAt: T0, performedBy: "rec", recordedBy: "rec" });
    const dup = buildInitialSteps({ stages: ["BATH", "BATH", "GROOM"], at: T0, actor: "rec" });
    expect(dup.map((s) => s.stage)).toEqual(["RECEIVED", "BATH", "GROOM", "READY"]);
  });

  it("start finishes the previous step", () => {
    const a = run(base, { type: "START", stage: "BATH" }, ctx());
    const copy = structuredClone(a.steps);
    const b = run(a.steps, { type: "START", stage: "GROOM" }, ctx({ at: m(50) }));
    expect(a.steps).toEqual(copy);
    expect(get(b.steps, "BATH")).toMatchObject({ status: "DONE", finishedAt: m(50) });
    expect(get(b.steps, "GROOM")).toMatchObject({ status: "IN_PROGRESS", startedAt: m(50) });
    expect(b.visitStatus).toBe("IN_PROGRESS");
    expect(validateSteps(b.steps)).toBeNull();
  });

  it("does not mutate input", () => {
    const copy = structuredClone(base);
    run(base, { type: "START", stage: "BATH" }, ctx());
    expect(base).toEqual(copy);
  });

  it("start out of order", () => {
    expect(applyStepAction(base, { type: "START", stage: "GROOM" }, ctx())).toEqual({
      ok: false,
      code: "STEP_ORDER",
    });
  });

  it("start twice", () => {
    const a = run(base, { type: "START", stage: "BATH" }, ctx());
    expect(applyStepAction(a.steps, { type: "START", stage: "BATH" }, ctx())).toEqual({
      ok: false,
      code: "STEP_CONFLICT",
    });
  });

  it("skip then start", () => {
    const a = run(base, { type: "SKIP", stage: "BATH" }, ctx());
    expect(get(a.steps, "BATH")).toMatchObject({ status: "SKIPPED", finishedAt: m(10) });
    expect(a.visitStatus).toBe("RECEIVED");
    const b = run(a.steps, { type: "START", stage: "GROOM" }, ctx({ at: m(20) }));
    expect(validateSteps(b.steps)).toBeNull();
    expect(validateSteps(a.steps)).toBeNull();
  });

  it("skip a later stage early", () => {
    const a = run(base, { type: "SKIP", stage: "GROOM" }, ctx());
    expect(get(a.steps, "GROOM").status).toBe("SKIPPED");
    expect(validateSteps(a.steps)).toBeNull();
    const b = run(a.steps, { type: "START", stage: "BATH" }, ctx({ at: m(20) }));
    expect(validateSteps(b.steps)).toBeNull();
  });

  it("skipped-ahead steps keep a valid timeline", () => {
    const a = run(base, { type: "SKIP", stage: "GROOM" }, ctx());
    const b = run(a.steps, { type: "START", stage: "BATH" }, ctx({ at: m(20) }));
    expect(validateSteps(b.steps)).toBeNull();
    const c = run(base, { type: "START", stage: "BATH" }, ctx());
    const d = run(c.steps, { type: "SKIP", stage: "GROOM" }, ctx({ at: m(20) }));
    const e = run(d.steps, { type: "READY" }, ctx({ at: m(30) }));
    expect(validateSteps(d.steps)).toBeNull();
    expect(validateSteps(e.steps)).toBeNull();
  });

  it("skip-ahead time does not clamp a later start", () => {
    const a = run(base, { type: "SKIP", stage: "GROOM" }, ctx({ at: m(60) }));
    const b = run(a.steps, { type: "START", stage: "BATH" }, ctx({ at: m(50) }));
    expect(get(b.steps, "BATH")).toMatchObject({ status: "IN_PROGRESS", startedAt: m(50) });
    expect(validateSteps(b.steps)).toBeNull();
  });

  it("ready finishes the open step", () => {
    const a = run(base, { type: "START", stage: "BATH" }, ctx());
    const b = run(a.steps, { type: "START", stage: "GROOM" }, ctx({ at: m(50) }));
    const c = run(b.steps, { type: "READY" }, ctx({ at: m(90) }));
    expect(get(c.steps, "GROOM")).toMatchObject({ status: "DONE", finishedAt: m(90) });
    expect(get(c.steps, "READY")).toMatchObject({ status: "DONE", startedAt: m(90), finishedAt: m(90) });
    expect(c.visitStatus).toBe("READY");
    expect(validateSteps(c.steps)).toBeNull();
  });

  it("ready with pending stage", () => {
    const a = run(base, { type: "START", stage: "BATH" }, ctx());
    expect(applyStepAction(a.steps, { type: "READY" }, ctx({ at: m(20) }))).toEqual({
      ok: false,
      code: "STEP_ORDER",
    });
  });

  it("ready without after photo", () => {
    const a = run(base, { type: "START", stage: "BATH" }, ctx());
    const b = run(a.steps, { type: "START", stage: "GROOM" }, ctx({ at: m(30) }));
    expect(
      applyStepAction(b.steps, { type: "READY" }, ctx({ at: m(40), hasAfterPhoto: false })),
    ).toEqual({ ok: false, code: "AFTER_PHOTO_REQUIRED" });
    const ok = applyStepAction(
      b.steps,
      { type: "READY" },
      ctx({ at: m(40), hasAfterPhoto: false, requireAfterPhoto: false }),
    );
    expect(ok.ok).toBe(true);
    if (ok.ok) expect(validateSteps(ok.steps)).toBeNull();
  });

  it("nothing after ready", () => {
    const a = run(base, { type: "SKIP", stage: "BATH" }, ctx());
    const b = run(a.steps, { type: "SKIP", stage: "GROOM" }, ctx());
    const c = run(b.steps, { type: "READY" }, ctx({ at: m(20) }));
    expect(validateSteps(c.steps)).toBeNull();
    for (const action of [
      { type: "START", stage: "BATH" },
      { type: "SKIP", stage: "BATH" },
      { type: "READY" },
    ] as StepAction[]) {
      expect(applyStepAction(c.steps, action, ctx({ at: m(30) }))).toEqual({
        ok: false,
        code: "STEP_CONFLICT",
      });
    }
  });

  it("not received", () => {
    const steps = base.map((s) =>
      s.stage === "RECEIVED" ? { ...s, status: "PENDING" as const, startedAt: null, finishedAt: null } : s,
    );
    expect(applyStepAction(steps, { type: "START", stage: "BATH" }, ctx())).toEqual({
      ok: false,
      code: "STEP_CONFLICT",
    });
  });

  it("on behalf", () => {
    const a = run(base, { type: "START", stage: "BATH" }, ctx({ performedBy: "ana", recordedBy: "rec" }));
    expect(get(a.steps, "BATH")).toMatchObject({ performedBy: "ana", recordedBy: "rec" });
    expect(validateSteps(a.steps)).toBeNull();
  });

  it("late replay is clamped", () => {
    const a = run(base, { type: "START", stage: "BATH" }, ctx({ at: m(30) }));
    const b = run(a.steps, { type: "START", stage: "GROOM" }, ctx({ at: m(20) }));
    expect(get(b.steps, "BATH").finishedAt).toBe(m(30));
    expect(get(b.steps, "GROOM").startedAt).toBe(m(30));
    expect(validateSteps(b.steps)).toBeNull();
  });

  it("validateSteps", () => {
    expect(validateSteps(base)).toBeNull();
    const patch = (stage: string, p: Partial<Step>) =>
      base.map((s) => (s.stage === stage ? { ...s, ...p } : s));
    const inProg = { status: "IN_PROGRESS" as const, startedAt: m(1) };
    expect(validateSteps(patch("BATH", inProg).map((s) => (s.stage === "GROOM" ? { ...s, ...inProg, startedAt: m(2) } : s)))).toBe("INVALID_TIMELINE");
    expect(validateSteps(patch("BATH", { status: "DONE", startedAt: m(5), finishedAt: m(4) }))).toBe("INVALID_TIMELINE");
    expect(validateSteps(patch("GROOM", { status: "DONE", startedAt: m(5), finishedAt: m(6) }))).toBe("INVALID_TIMELINE");
    expect(validateSteps(patch("READY", { status: "DONE", startedAt: m(5), finishedAt: m(5) }))).toBe("INVALID_TIMELINE");
    const overlap = patch("BATH", { status: "DONE", startedAt: m(1), finishedAt: m(10) }).map((s) =>
      s.stage === "GROOM" ? { ...s, status: "IN_PROGRESS" as const, startedAt: m(5) } : s,
    );
    expect(validateSteps(overlap)).toBe("INVALID_TIMELINE");
    const swapped = [...base.slice(0, 3), ...[base[3]!]].map((s) => ({ ...s }));
    const last = swapped.pop()!;
    swapped.splice(1, 0, { ...last, sort: 1 });
    expect(validateSteps(swapped)).toBe("INVALID_TIMELINE");
  });
});
