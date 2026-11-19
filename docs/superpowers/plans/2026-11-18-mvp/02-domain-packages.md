# Plan 02 — Pure Domain Packages

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Three pure, fully tested packages: `@grooming/pricing` (size class and
price matrix), `@grooming/tracking` (step state machine, statuses, ETA) and the
grooming planner in `@grooming/availability` (`findSlots` for wait and drop-off
mode, kennels, multi-pet, plus `validatePlan` for holds).

**Architecture:** No I/O, no framework, no Node APIs (eslint platform rule).
Every package works on plain inputs (UTC milliseconds, integer cents, integer
grams) and returns plain values or typed error codes. The API (Plans 03–05)
loads data, calls these functions and maps codes to HTTP errors. The planner
reuses the kept availability base (`intervals`, `free-time`) and ports three
small helpers from BeautySpa's `plan.ts` at `8a778d5`; the search itself is new.

**Tech Stack:** TypeScript 5 strict (`noUncheckedIndexedAccess`), Vitest, tsup,
`@grooming/datetime` (date-fns 4 + `@date-fns/tz`).

**Spec:** `docs/superpowers/specs/2026-11-18-mvp-design/` — read
`availability.md`, `tracking.md`, `data-model.md` (catalog, `service_price`,
`visit_step`, location settings).

**Branch:** `feat/mvp-02-domain`

## Routing

Main session: Opus 5.5. It orchestrates and does not implement tasks.

| Task | What | Implementer | Reviewer | Why |
|---|---|---|---|---|
| 1 | `@grooming/pricing`: size class, lb/g, price lookup, pet quote | implementer-sonnet | reviewer-opus | small pure functions, exact values given |
| 2 | `@grooming/tracking`: statuses, initial steps, step actions, timeline check, `occurredAt` | implementer-sonnet | reviewer-opus | rules listed one by one with tests |
| 3 | `@grooming/tracking`: ETA and notify rules | implementer-sonnet | reviewer-opus | formula given in the spec |
| 4 | availability: grooming types, errors, fixtures, `prepare`, request resolution | implementer-sonnet | reviewer-opus | interfaces and checks fully listed |
| 5 | availability: backtracking search, `findSlots` (wait + drop-off + kennels) | **implementer-opus** | reviewer-opus | search with deferred buffer blocks, symmetry and budget needs design judgment |
| 6 | availability: `validatePlan` for holds | implementer-sonnet | reviewer-opus | check list and order given; reuses Task 5 helpers |

Final branch review: reviewer-opus. Not a money/production-data branch (one review).

## Global Constraints

- Packages: `packages/pricing` (`@grooming/pricing`), `packages/tracking` (`@grooming/tracking`), `packages/availability` (`@grooming/availability`). New packages copy `package.json` scripts, `tsconfig.json`, `eslint.config.mjs`, `vitest.config.ts`, `tsup.config.ts` from `packages/availability` (same shape, own name).
- `packages/*` import no DOM, Next.js, NestJS or Node-only APIs (`@grooming/config/eslint.platform.mjs`).
- Time is UTC epoch milliseconds (`Ms = number`); `MINUTE` from `@grooming/datetime`. Intervals are half-open `[start, end)`.
- Money is integer cents. Weight is integer grams. 1 lb = `453.59237` g.
- Enum string values match the Prisma schema exactly: `SizeClass` `S|M|L|XL`; `CoatType` `SMOOTH|DOUBLE|CURLY|WIRE|LONG|HAIRLESS`; `Species` `DOG|CAT`; service species `DOG|CAT|ANY`; stages `BATH|DRY|GROOM|FINISH` (+ `KENNEL` for segments, + `RECEIVED|READY` for steps); step status `PENDING|IN_PROGRESS|DONE|SKIPPED`; skills `BATHER|GROOMER`; booking mode `WAIT|DROP_OFF`.
- Stage order is fixed: `BATH → DRY → GROOM → FINISH`.
- Limits: ≤ 4 pets per appointment, ≤ 6 services per pet.
- Defaults from the spec: size thresholds `{ S: 20, M: 50, L: 90 }` lb; `maxQueueWaitMin` 90; `pickupGraceMin` 60; `etaNotifyThresholdMin` 30; wait-mode idle between one pet's segments ≤ 15 min; drop-off intake 10 min; in-progress step ends no earlier than now + 5 min; owner page updates when ETA moves ≥ 5 min; ETA WhatsApp at most once per hour.
- Every task: `pnpm turbo run lint typecheck test build --filter='./packages/*'` exits 0; `git grep -n -i -E 'beautyspa|bs_refresh|\bbs_' -- ':!docs/provenance.md' ':!docs/superpowers/**'` prints nothing; docs change in the same commit; one commit per task (plus fix commits after review).
- Code, comments, docs and commits in English.

## Review Focus

1. **A pet asks for a service that has no price row for its size/coat** → the planner must throw `NO_PRICE_FOR_PET`, never plan a zero-minute segment. Test in Task 4.
2. **The same service twice for one pet, or the same pet twice** (double tap in the UI) → `DUPLICATE_SERVICE` / `DUPLICATE_PET`, not a doubled bath. Test in Task 4.
3. **Online booking later the same day** → drop-off times before `now + minLeadMinutes` are not offered; the first offered time is on the grid. Test in Task 5.
4. **Offline replay with an `occurredAt` older than the step already in progress** → the timeline stays in order (the action time is clamped to the latest timestamp). Test in Task 2.
5. **Work that would run past closing** → no slot whose last segment ends after the employee's hours; the last wait-mode slot of the day is exact. Test in Task 5.

---

### Task 1: `@grooming/pricing`

**Files:**
- Create: `packages/pricing/{package.json,tsconfig.json,eslint.config.mjs,vitest.config.ts,tsup.config.ts,README.md}`
- Create: `packages/pricing/src/{types.ts,errors.ts,size-class.ts,lookup.ts,index.ts}`
- Test: `packages/pricing/src/size-class.test.ts`, `packages/pricing/src/lookup.test.ts`
- Modify: `docs/README.md` (add a "Domain packages" line linking the three package READMEs; the other two links are added by Tasks 2 and 4)

**Interfaces:**
- Produces (exported from `@grooming/pricing`):
  - `type SizeClass = "S" | "M" | "L" | "XL"`; `type CoatType = "SMOOTH" | "DOUBLE" | "CURLY" | "WIRE" | "LONG" | "HAIRLESS"`
  - `interface SizeThresholdsLb { S: number; M: number; L: number }`; `const DEFAULT_SIZE_THRESHOLDS_LB: SizeThresholdsLb = { S: 20, M: 50, L: 90 }`
  - `const GRAMS_PER_LB = 453.59237`; `lbToGrams(lb: number): number` (`Math.round`); `gramsToLb(g: number): number` (rounded to 1 decimal)
  - `sizeClassFromWeight(weightG: number, thresholds?: SizeThresholdsLb): SizeClass` — class S when `weightG <= lbToGrams(thresholds.S)`, M when `<= lbToGrams(M)`, L when `<= lbToGrams(L)`, else XL
  - `interface ServicePriceRow { serviceId: string; sizeClass: SizeClass; coatType: CoatType | null; durationMin: number; priceCents: number }`
  - `interface PriceTerms { durationMin: number; priceCents: number }`
  - `lookupPrice(rows: ServicePriceRow[], serviceId: string, sizeClass: SizeClass, coatType: CoatType): PriceTerms | null` — exact coat row, else the `coatType: null` row, else `null`
  - `quotePet(args: { rows: ServicePriceRow[]; serviceIds: string[]; sizeClass: SizeClass; coatType: CoatType }): { ok: true; lines: (PriceTerms & { serviceId: string })[]; totalCents: number; totalMin: number } | { ok: false; missing: string[] }` — lines in input order; `missing` lists every service without a row, in input order
  - `class PricingError extends Error { code: "INVALID_WEIGHT" | "INVALID_THRESHOLDS" }` — `INVALID_WEIGHT` when `weightG` is not a positive integer; `INVALID_THRESHOLDS` unless `0 < S < M < L` and all finite

- [ ] **Step 1: Scaffold** the package from `packages/availability`'s config files (name `@grooming/pricing`, no runtime dependencies). Run `pnpm install`.

- [ ] **Step 2: Write the failing tests**

```ts
// size-class.test.ts
it("converts lb and grams", () => {
  expect(lbToGrams(20)).toBe(9072);
  expect(gramsToLb(9072)).toBe(20);
  expect(gramsToLb(19051)).toBe(42);
});
it("default thresholds are inclusive upper bounds", () => {
  expect(sizeClassFromWeight(9072)).toBe("S");   // exactly 20 lb
  expect(sizeClassFromWeight(9073)).toBe("M");
  expect(sizeClassFromWeight(lbToGrams(50))).toBe("M");
  expect(sizeClassFromWeight(lbToGrams(50) + 1)).toBe("L");
  expect(sizeClassFromWeight(lbToGrams(90))).toBe("L");
  expect(sizeClassFromWeight(lbToGrams(90) + 1)).toBe("XL");
});
it("custom thresholds", () => {
  expect(sizeClassFromWeight(lbToGrams(15), { S: 10, M: 15, L: 30 })).toBe("M");
});
it("rejects bad input", () => {
  for (const w of [0, -1, 1.5, Number.NaN]) expect(() => sizeClassFromWeight(w)).toThrow(expect.objectContaining({ code: "INVALID_WEIGHT" }));
  for (const t of [{ S: 20, M: 20, L: 90 }, { S: 0, M: 50, L: 90 }, { S: 20, M: 50, L: Infinity }])
    expect(() => sizeClassFromWeight(9000, t)).toThrow(expect.objectContaining({ code: "INVALID_THRESHOLDS" }));
});

// lookup.test.ts — rows: BATH M null 45/4000, BATH M CURLY 60/5000, CUT M null 60/6000
it("exact coat row wins", () => expect(lookupPrice(rows, "BATH", "M", "CURLY")).toEqual({ durationMin: 60, priceCents: 5000 }));
it("falls back to the any-coat row", () => expect(lookupPrice(rows, "BATH", "M", "SMOOTH")).toEqual({ durationMin: 45, priceCents: 4000 }));
it("missing row is null", () => {
  expect(lookupPrice(rows, "BATH", "L", "SMOOTH")).toBeNull();
  expect(lookupPrice(rows, "NOPE", "M", "SMOOTH")).toBeNull();
});
it("quotes a pet", () => {
  expect(quotePet({ rows, serviceIds: ["CUT", "BATH"], sizeClass: "M", coatType: "CURLY" })).toEqual({
    ok: true, totalCents: 11000, totalMin: 120,
    lines: [{ serviceId: "CUT", durationMin: 60, priceCents: 6000 }, { serviceId: "BATH", durationMin: 60, priceCents: 5000 }],
  });
  expect(quotePet({ rows, serviceIds: ["X", "BATH", "Y"], sizeClass: "M", coatType: "SMOOTH" })).toEqual({ ok: false, missing: ["X", "Y"] });
});
```

- [ ] **Step 3: Run** `pnpm --filter @grooming/pricing test` · Expected: FAIL (modules missing).
- [ ] **Step 4: Implement** the interfaces above.
- [ ] **Step 5: Run** `pnpm --filter @grooming/pricing test` · Expected: PASS. Then the global turbo command and grep · Expected: exit 0, no output.
- [ ] **Step 6: Docs** — `packages/pricing/README.md` (≤ 20 lines: purpose, exports, the inclusive-threshold rule, lookup order); `docs/README.md` "Domain packages" line.
- [ ] **Step 7: Commit** — `feat(pricing): size class from weight and price matrix lookup`

---

### Task 2: `@grooming/tracking` — statuses and step state machine

**Files:**
- Create: `packages/tracking/{package.json,tsconfig.json,eslint.config.mjs,vitest.config.ts,tsup.config.ts,README.md}`
- Create: `packages/tracking/src/{types.ts,status.ts,steps.ts,occurred-at.ts,index.ts}`
- Test: `packages/tracking/src/{status.test.ts,steps.test.ts,occurred-at.test.ts}`
- Modify: `docs/README.md` (tracking link)

**Interfaces:**
- Produces (exported from `@grooming/tracking`):
  - `type Ms = number`; `type WorkStage = "BATH" | "DRY" | "GROOM" | "FINISH"`; `const WORK_STAGE_ORDER: readonly WorkStage[]`; `type StepStage = "RECEIVED" | WorkStage | "READY"`; `type StepStatus = "PENDING" | "IN_PROGRESS" | "DONE" | "SKIPPED"`
  - `interface Step { stage: StepStage; sort: number; status: StepStatus; startedAt: Ms | null; finishedAt: Ms | null; performedBy: string | null; recordedBy: string | null }`
  - `type PetVisitStatus = "BOOKED" | "RECEIVED" | "IN_PROGRESS" | "READY" | "PICKED_UP" | "CANCELLED" | "NO_SHOW"`; `type AppointmentStatus = "HELD" | "BOOKED" | "IN_SHOP" | "COMPLETED" | "CANCELLED" | "NO_SHOW"`
  - `canTransitionVisit(from: PetVisitStatus, to: PetVisitStatus): boolean` — allowed: BOOKED→RECEIVED, BOOKED→CANCELLED, BOOKED→NO_SHOW, RECEIVED→IN_PROGRESS, RECEIVED→READY, IN_PROGRESS→READY, READY→PICKED_UP
  - `canTransitionAppointment(from, to): boolean` — allowed: HELD→BOOKED, HELD→CANCELLED, BOOKED→IN_SHOP, BOOKED→CANCELLED, BOOKED→NO_SHOW, IN_SHOP→COMPLETED
  - `appointmentStatusAfterVisits(current: AppointmentStatus, visits: PetVisitStatus[]): AppointmentStatus` — from BOOKED: any visit in RECEIVED/IN_PROGRESS/READY/PICKED_UP → IN_SHOP. From IN_SHOP (including one just reached): every visit that is not CANCELLED/NO_SHOW is PICKED_UP, and at least one is → COMPLETED. Otherwise `current`.
  - `buildInitialSteps(args: { stages: WorkStage[]; at: Ms; actor: string }): Step[]` — `RECEIVED` (DONE, `startedAt = finishedAt = at`, performed/recorded by `actor`), then the given stages de-duplicated in `WORK_STAGE_ORDER`, then `READY`; work and READY steps PENDING with nulls; `sort` 0..n-1
  - `visitStatusFromSteps(steps: Step[]): "RECEIVED" | "IN_PROGRESS" | "READY"` — READY step DONE → READY; any work step IN_PROGRESS or DONE → IN_PROGRESS; else RECEIVED
  - `type StepAction = { type: "START"; stage: WorkStage } | { type: "SKIP"; stage: WorkStage } | { type: "READY" }`
  - `interface StepContext { at: Ms; performedBy: string; recordedBy: string; requireAfterPhoto: boolean; hasAfterPhoto: boolean }`
  - `type TrackingErrorCode = "STEP_CONFLICT" | "STEP_ORDER" | "AFTER_PHOTO_REQUIRED" | "INVALID_TIMELINE"`
  - `applyStepAction(steps: Step[], action: StepAction, ctx: StepContext): { ok: true; steps: Step[]; visitStatus: "RECEIVED" | "IN_PROGRESS" | "READY" } | { ok: false; code: TrackingErrorCode }` — pure (never mutates input)
  - `validateSteps(steps: Step[]): TrackingErrorCode | null` — returns `INVALID_TIMELINE` or `null`
  - `const OCCURRED_AT_MAX_AGE_MS = 12 * 60 * MINUTE`; `const OCCURRED_AT_MAX_SKEW_MS = 2 * MINUTE`; `effectiveOccurredAt(occurredAt: Ms | null, now: Ms): Ms` — `occurredAt` in `[now − 12 h, now + 2 min]` → `Math.min(occurredAt, now)`; otherwise (or null) → `now`
- Depends on `@grooming/datetime` (for `MINUTE`).

**`applyStepAction` rules** (checked in this order; `at = max(ctx.at, latest non-null startedAt/finishedAt in steps)`):
1. `STEP_CONFLICT` if the RECEIVED step is not DONE, or the READY step is DONE, or (START/SKIP) the stage has no step.
2. START: target must be PENDING, else `STEP_CONFLICT`. Any earlier work step still PENDING → `STEP_ORDER`. The current IN_PROGRESS step (if any) becomes DONE with `finishedAt = at`. Target becomes IN_PROGRESS, `startedAt = at`, `performedBy`, `recordedBy` from ctx.
3. SKIP: target must be PENDING or IN_PROGRESS, else `STEP_CONFLICT`. It becomes SKIPPED with `finishedAt = at` (keeps `startedAt` if it had one), `performedBy`/`recordedBy` from ctx. Order is not enforced for SKIP.
4. READY: the IN_PROGRESS step (if any) becomes DONE at `at`. Any work step still PENDING → `STEP_ORDER`. `requireAfterPhoto && !hasAfterPhoto` → `AFTER_PHOTO_REQUIRED`. READY step becomes DONE with `startedAt = finishedAt = at` and ctx people.
5. Result `visitStatus = visitStatusFromSteps(newSteps)`.

**`validateSteps` rules** (any failure → `INVALID_TIMELINE`): sorts are 0..n-1 with RECEIVED first, READY last, work stages unique and in `WORK_STAGE_ORDER`; at most one IN_PROGRESS; PENDING has both timestamps null; IN_PROGRESS has `startedAt` only; DONE has both with `startedAt <= finishedAt`; SKIPPED has `finishedAt` (and `startedAt <= finishedAt` when set); no PENDING work step sorts before a DONE or IN_PROGRESS work step; READY DONE implies every work step DONE or SKIPPED; each step's first timestamp (`startedAt ?? finishedAt`) is ≥ the previous non-PENDING step's last timestamp (`finishedAt ?? startedAt`).

- [ ] **Step 1: Scaffold** the package (dependency `@grooming/datetime: workspace:*`). `pnpm install`.

- [ ] **Step 2: Write the failing tests** (helpers: `const T0 = Date.parse("2026-12-07T14:00:00Z")`, `m = (n) => T0 + n * MINUTE`, `ctx = (o = {}) => ({ at: m(10), performedBy: "ana", recordedBy: "ana", requireAfterPhoto: true, hasAfterPhoto: true, ...o })`, `base = buildInitialSteps({ stages: ["GROOM", "BATH"], at: T0, actor: "rec" })`)

`status.test.ts`:
- `"visit transitions"`: every allowed edge is true; `READY→IN_PROGRESS`, `PICKED_UP→READY`, `RECEIVED→CANCELLED` are false.
- `"appointment transitions"`: allowed edges true; `COMPLETED→IN_SHOP`, `HELD→IN_SHOP` false.
- `"appointment follows visits"`: `("BOOKED", ["BOOKED","BOOKED"]) → "BOOKED"`; `("BOOKED", ["RECEIVED","BOOKED"]) → "IN_SHOP"`; `("IN_SHOP", ["PICKED_UP","READY"]) → "IN_SHOP"`; `("IN_SHOP", ["PICKED_UP","CANCELLED"]) → "COMPLETED"`; `("BOOKED", ["PICKED_UP"]) → "COMPLETED"`; `("IN_SHOP", ["CANCELLED"]) → "IN_SHOP"`; `("CANCELLED", ["RECEIVED"]) → "CANCELLED"`.

`steps.test.ts`:
- `"initial steps"`: `base.map(s => [s.stage, s.status, s.sort])` equals `[["RECEIVED","DONE",0],["BATH","PENDING",1],["GROOM","PENDING",2],["READY","PENDING",3]]`; RECEIVED `startedAt === finishedAt === T0`, `performedBy === "rec"`; duplicates in `stages` are dropped.
- `"start finishes the previous step"`: START BATH at m(10), then START GROOM at m(50) → BATH DONE `finishedAt m(50)`, GROOM IN_PROGRESS `startedAt m(50)`, `visitStatus "IN_PROGRESS"`; input array unchanged (deep-equal to a copy taken before).
- `"start out of order"`: START GROOM on `base` → `{ ok: false, code: "STEP_ORDER" }`.
- `"start twice"`: START BATH twice → second is `STEP_CONFLICT`.
- `"skip then start"`: SKIP BATH → BATH SKIPPED `finishedAt m(10)`, visitStatus `"RECEIVED"`; START GROOM → ok.
- `"skip a later stage early"`: SKIP GROOM on `base` → ok (order not enforced for SKIP).
- `"ready finishes the open step"`: START BATH, START GROOM, READY at m(90) → GROOM DONE m(90), READY DONE m(90), `visitStatus "READY"`.
- `"ready with pending stage"`: START BATH, READY → `STEP_ORDER`.
- `"ready without after photo"`: all stages done, `hasAfterPhoto: false` → `AFTER_PHOTO_REQUIRED`; with `requireAfterPhoto: false` → ok.
- `"nothing after ready"`: after READY, START/SKIP/READY → `STEP_CONFLICT`.
- `"not received"`: steps whose RECEIVED is PENDING → `STEP_CONFLICT`.
- `"on behalf"`: `performedBy "ana", recordedBy "rec"` are stored as given.
- `"late replay is clamped"` (Review Focus 4): START BATH at m(30); START GROOM with `at: m(20)` → BATH `finishedAt m(30)`, GROOM `startedAt m(30)`; `validateSteps(result.steps) === null`.
- `"validateSteps"`: `null` for `base` and for every result above; `INVALID_TIMELINE` for: two IN_PROGRESS; DONE with `finishedAt < startedAt`; PENDING BATH before DONE GROOM; READY DONE with a PENDING work step; GROOM started before BATH finished; READY not last.

`occurred-at.test.ts`: `now = T0`; `null → now`; `now − 12 h → itself`; `now − 12 h − 1 → now`; `now + 2 min → now`; `now + 2 min + 1 → now`; `now − 5 min → itself`.

- [ ] **Step 3: Run** `pnpm --filter @grooming/tracking test` · Expected: FAIL.
- [ ] **Step 4: Implement** `status.ts`, `steps.ts`, `occurred-at.ts` per the rules above.
- [ ] **Step 5: Run** the package tests, then the global turbo command and grep · Expected: PASS, exit 0, no output.
- [ ] **Step 6: Docs** — `packages/tracking/README.md` (≤ 30 lines: exports, the action rules in one line each, error codes and the API codes they map to: `STEP_CONFLICT`, `STEP_ORDER`, `AFTER_PHOTO_REQUIRED` → same names; `INVALID_TIMELINE` → 422 on reception corrections); `docs/README.md` link.
- [ ] **Step 7: Commit** — `feat(tracking): visit statuses and step state machine`

---

### Task 3: `@grooming/tracking` — ETA and notify rules

**Files:**
- Create: `packages/tracking/src/eta.ts`
- Test: `packages/tracking/src/eta.test.ts`
- Modify: `packages/tracking/src/index.ts`, `packages/tracking/README.md`

**Interfaces:**
- Consumes: `Step`, `WorkStage`, `WORK_STAGE_ORDER`, `Ms` (Task 2).
- Produces:
  - `interface PlannedStage { stage: WorkStage; plannedStart: Ms; durationMin: number }` (from the pet's appointment segments)
  - `const IN_PROGRESS_MIN_REMAINING_MIN = 5`; `const OWNER_PAGE_ETA_STEP_MIN = 5`; `const ETA_NOTIFY_MIN_INTERVAL_MIN = 60`
  - `estimateReady(args: { planned: PlannedStage[]; steps: Step[]; now: Ms }): Ms`
  - `ownerPageEtaChanged(prevEta: Ms | null, nextEta: Ms): boolean` — `prevEta === null` or `|next − prev| >= 5 min`
  - `shouldNotifyEtaChange(args: { baselineEta: Ms; lastNotifiedAt: Ms | null; nextEta: Ms; now: Ms; thresholdMin: number }): boolean` — `|nextEta − baselineEta| >= thresholdMin` min AND (`lastNotifiedAt === null` or `now − lastNotifiedAt >= 60 min`). `baselineEta` is the last notified ETA, or the booked `estimated_ready_at` when none was sent (caller's choice, documented in the README).

**`estimateReady` algorithm** (spec, tracking.md "ETA"):
- READY step DONE → return its `finishedAt`.
- Walk `planned` in `WORK_STAGE_ORDER`; `prevEnd = -Infinity`. For each planned stage, look up its step (missing step = PENDING, e.g. before check-in):
  - DONE or SKIPPED → skip.
  - IN_PROGRESS → `end = max(startedAt + durationMin, now + 5 min)`.
  - PENDING → `start = max(plannedStart, prevEnd, now)`, `end = start + durationMin`.
  - `prevEnd = end`.
- An IN_PROGRESS step whose stage is not in `planned` counts as a stage with `durationMin` 0 at its place in the order.
- Return `prevEnd`, or `now` when no stage remains.

- [ ] **Step 1: Write the failing tests** (`T0` 9:00 local as UTC ms, `m(n)`; planned: BATH 9:00/45, DRY 9:45/30, GROOM 10:15/60)
  - `"before check-in follows the plan"`: no steps, `now = m(-60)` → `m(135)` (11:15).
  - `"pending stages never start in the past"`: no steps, `now = m(30)` → `m(165)`.
  - `"in-progress on time"`: BATH IN_PROGRESS since m(0), now m(20) → `m(135)`.
  - `"in-progress overrun uses now + 5"`: BATH IN_PROGRESS since m(0), now m(50) → BATH end m(55), DRY m(55)–m(85), GROOM m(85)–m(145) → `m(145)`.
  - `"skipped stage is removed"`: BATH DONE, DRY SKIPPED, GROOM PENDING, now m(50) → GROOM starts max(m(75), m(50)) → `m(135)`.
  - `"ready returns the ready time"`: READY DONE at m(100) → `m(100)`.
  - `"nothing left"`: all work DONE, READY PENDING, now m(130) → `m(130)`.
  - `"owner page threshold"`: `(null, x) → true`; `(m(0), m(4)) → false`; `(m(0), m(5)) → true`; `(m(5), m(0)) → true`.
  - `"notify threshold and hourly cap"`: baseline m(0), threshold 30: next m(29) → false; next m(30), never notified → true; next m(-30) → true; next m(40) with `lastNotifiedAt = now − 59 min` → false; `now − 60 min` → true.
- [ ] **Step 2: Run** `pnpm --filter @grooming/tracking test` · Expected: FAIL.
- [ ] **Step 3: Implement** `eta.ts`.
- [ ] **Step 4: Run** the package tests, global turbo command, grep · Expected: PASS, exit 0, no output.
- [ ] **Step 5: Docs** — README section "ETA" (formula in 3 lines, the two notify helpers and the baseline rule).
- [ ] **Step 6: Commit** — `feat(tracking): ETA estimate and notify thresholds`

---

### Task 4: availability — grooming types, errors, fixtures, request resolution

**Files:**
- Modify: `packages/availability/package.json` (add `@grooming/pricing: workspace:*`)
- Modify: `packages/availability/src/types.ts`, `src/errors.ts`, `src/index.ts`, `test/fixtures.ts`
- Create: `packages/availability/src/prepare.ts`, `src/resolve.ts`, `packages/availability/README.md`
- Test: `packages/availability/src/prepare.test.ts`, `src/resolve.test.ts` (existing `intervals`/`free-time` tests must stay green unchanged except fixture field additions)
- Modify: `docs/provenance.md` (availability row: ported `prepare`/`earliestStart`/`beyondHorizon`/`candidatesFor` ordering from `plan.ts` at `8a778d5`), `docs/README.md` (availability link), `docs/superpowers/specs/2026-11-18-mvp-design/availability.md` (see Step 6)

**Interfaces:**
- Consumes: `ServicePriceRow`, `SizeClass`, `CoatType`, `lookupPrice` from `@grooming/pricing` (Task 1).
- Produces — `types.ts` (keep `Ms`, `Interval`, `WeeklyHours`; change/add):
  - `LocationInput` adds `dropOffWindows: WeeklyHours[]` (half-open `[start, end)` local times), `maxQueueWaitMin: number`, `pickupGraceMin: number`
  - `type Skill = "BATHER" | "GROOMER"`; `type WorkStage = "BATH" | "DRY" | "GROOM" | "FINISH"`; `const WORK_STAGE_ORDER: readonly WorkStage[]`; `type SegmentStage = WorkStage | "KENNEL"`; `type Species = "DOG" | "CAT"`; `type BookingMode = "WAIT" | "DROP_OFF"`; `type Mode = "ONLINE" | "STAFF"`
  - `interface ServiceInput { id: string; stage: WorkStage; species: Species | "ANY"; resourceTypeId: string | null; requiredSkill: Skill; bufferAfterMin: number; onlineBookable: boolean }`
  - `EmployeeInput` adds `skills: Skill[]`
  - `ResourceInput` adds `kind: "STATION" | "KENNEL"`
  - `BusySegment.employeeId: string | null` (kennel segments have no person)
  - `interface PetRequest { petId: string; species: Species; sizeClass: SizeClass; coatType: CoatType; serviceIds: string[]; preferredGroomerId: string | "ANY" }`
  - `interface Context { location: LocationInput; services: ServiceInput[]; prices: ServicePriceRow[]; employees: EmployeeInput[]; resources: ResourceInput[]; busy: BusySegment[]; mode: Mode; now: Ms; override?: boolean }`
  - `interface SlotRequest { bookingMode: BookingMode; pets: PetRequest[] }`; `interface FindSlotsInput extends Context, SlotRequest { date: IsoDate }`
  - `interface PlannedSegment { petId: string; stage: SegmentStage; serviceIds: string[]; employeeId: string | null; resourceId: string | null; start: Ms; end: Ms; blockEnd: Ms; durationMin: number; priceCents: number }`
  - `interface PetPlan { petId: string; priceCents: number; segments: PlannedSegment[] }` (work segments in stage order, then the KENNEL segment in drop-off mode)
  - `interface Slot { start: Ms; readyAt: Ms; bookingMode: BookingMode; pets: PetPlan[] }` (`start` = first segment start in wait mode, drop-off time in drop-off mode; `readyAt` = latest work segment end)
  - `type PlanRejection = "NOT_QUALIFIED" | "EMPLOYEE_UNAVAILABLE" | "RESOURCE_UNAVAILABLE" | "TOO_SOON" | "BEYOND_HORIZON" | "NOT_BOOKABLE_ONLINE" | "OUTSIDE_DROP_OFF_WINDOW" | "MALFORMED_PLAN"`
- `errors.ts`: `AvailabilityErrorCode = "NO_PETS" | "TOO_MANY_PETS" | "DUPLICATE_PET" | "NO_SERVICES" | "TOO_MANY_SERVICES" | "DUPLICATE_SERVICE" | "UNKNOWN_SERVICE" | "UNKNOWN_EMPLOYEE" | "SPECIES_MISMATCH" | "NO_PRICE_FOR_PET" | "STAGE_RESOURCE_MISMATCH"` (closes the handoff carry-over). `AvailabilityError` class unchanged.
- `prepare.ts` (port from `git -C ~/Claude/beautySpa/BeautySpa show 8a778d5:packages/availability/src/plan.ts`, same behavior):
  - `const MAX_PETS = 4`; `const MAX_SERVICES_PER_PET = 6`
  - `interface Prepared { ctx: Context; date: IsoDate; dayStart: Ms; dayEnd: Ms; employeeFree: Map<string, Interval[]>; resourceFree: Map<string, Interval[]>; booked: Map<string, number> }`
  - `prepare(ctx: Context, date: IsoDate): Prepared` — as BeautySpa (`ignoreHours = mode === "STAFF" && override === true`; `booked` counts only input busy minutes starting that local day; busy rows with `employeeId === null` count for nobody)
  - `earliestStart(ctx: Context, dayStart: Ms): Ms`, `beyondHorizon(ctx: Context, date: IsoDate): boolean` — as BeautySpa
- `resolve.ts`:
  - `interface SegmentSpec { petId: string; stage: WorkStage; serviceIds: string[]; durationMin: number; priceCents: number; bufferAfterMin: number; resourceTypeId: string | null; candidates: EmployeeInput[] }`
  - `interface PetSpec { petId: string; priceCents: number; segments: SegmentSpec[] }`
  - `resolvePets(p: Prepared, pets: PetRequest[]): PetSpec[]` — throws `AvailabilityError`, checks in this order: `NO_PETS` (0 pets), `TOO_MANY_PETS` (> 4), `DUPLICATE_PET` (same `petId` twice); then per pet in order: `NO_SERVICES`, `TOO_MANY_SERVICES` (> 6), `DUPLICATE_SERVICE`, `UNKNOWN_SERVICE`, `SPECIES_MISMATCH` (service species not `ANY` and ≠ pet species), `UNKNOWN_EMPLOYEE` (`preferredGroomerId` not `ANY` and not in `ctx.employees`), `NO_PRICE_FOR_PET` (`lookupPrice` null), `STAGE_RESOURCE_MISMATCH` (services of one stage with different `resourceTypeId`).
  - Segment per non-empty stage, in `WORK_STAGE_ORDER`; `serviceIds` in request order; `durationMin`/`priceCents` = sums of the price terms; `bufferAfterMin` = max; `resourceTypeId` = the shared one.
  - `candidates`: employees with every service's `requiredSkill` in `skills` and every service id in `serviceIds`, `bookableOnline` when `mode === "ONLINE"`, and for GROOM/FINISH only, `id === preferredGroomerId` when it is not `ANY`. Ordered by `booked` minutes ascending, then `id` (as BeautySpa `candidatesFor`). An empty list is allowed (the search returns no slots).
  - `PetSpec.priceCents` = sum of its segments.
- `index.ts` exports: types, `normalize/subtract/intersect/covers`, `weeklyToUtc/employeeFreeTime/resourceFreeTime`, `AvailabilityError`, `AvailabilityErrorCode`, `MAX_PETS`, `MAX_SERVICES_PER_PET`. (`findSlots`, `validatePlan` are added by Tasks 5 and 6.)

**Fixtures** (`test/fixtures.ts`; keep every existing export, add fields: `dani.skills = ["GROOMER"]`, `chair1.kind = "STATION"`, `makeLocation` defaults `dropOffWindows: everyDay("09:00", "11:00")`, `maxQueueWaitMin: 90`, `pickupGraceMin: 60`). Add, with distinct UUID-like id constants in the existing style:
- Resource types `TUB`, `TABLE`, `DRYER`, `KENNEL`. Resources `tub1`, `tub2`, `table1`, `table2`, `dryer1` (kind STATION), `kennel1`, `kennel2` (kind KENNEL), names `"tub-1"` etc.
- Services (all `bufferAfterMin: 0`, `onlineBookable: true`):

| const | stage | resource type | skill | species | price rows (size, coat → min / cents) |
|---|---|---|---|---|---|
| `bath` | BATH | TUB | BATHER | ANY | S null → 30/3000; M null → 45/4000; M CURLY → 60/5000 |
| `deshed` | BATH | TUB | BATHER | DOG | M null → 15/2000 |
| `dry` | DRY | DRYER | BATHER | ANY | M null → 30/1500 |
| `haircut` | GROOM | TABLE | GROOMER | DOG | S null → 45/5000; M null → 60/6000 |
| `teeth` | GROOM | TABLE | GROOMER | ANY | M null → 10/1000 |
| `nails` | FINISH | null | GROOMER | ANY | M null → 15/1500 |
| `catBath` | BATH | TUB | BATHER | CAT | M null → 45/4500 |

  `prices: ServicePriceRow[]` holds all rows; `services` holds all seven.
- Employees, all `everyDay("09:00","19:00")`, `bookableOnline: true`, no time off: `batherA` (BATHER; bath, deshed, dry, catBath), `batherB` (BATHER; bath, dry, catBath — no deshed), `groomerA`, `groomerB` (GROOMER; haircut, teeth, nails). Ids sort `batherA < batherB < groomerA < groomerB`.
- Pets (`preferredGroomerId: "ANY"`, `serviceIds` set per test): `rex` (DOG, M, SMOOTH), `luna` (DOG, M, SMOOTH), `max` (DOG, M, CURLY), `mia` (CAT, M, SMOOTH). Helper `pet(base, serviceIds, o?)`.
- `GROOM_NOW = Date.parse("2026-12-06T12:00:00Z")`; `groomCtx(o?: Partial<FindSlotsInput>): FindSlotsInput` with all of the above, `mode: "ONLINE"`, `bookingMode: "WAIT"`, `date: MON`, `busy: []`, `pets: []`.

- [ ] **Step 1: Write the failing tests**

`prepare.test.ts`:
- `"earliest start online is now + lead"`: `now = 2026-12-07T15:10Z` → `now + 60 min`.
- `"earliest start staff floors to the grid"` → `2026-12-07T15:00Z`.
- `"horizon"`: `2027-02-05` beyond online (today 2026-12-06 + 60 days = 2027-02-04 allowed), never beyond in STAFF.
- `"kennel busy counts for nobody"`: busy `{ employeeId: null, resourceId: KENNEL_1_ID, … }` leaves every `booked` at 0 and removes that range from `kennel1` free time.

`resolve.test.ts` (`p = prepare(groomCtx(), MON)`):
- `"groups services into stages in fixed order"`: rex `[nails, haircut, deshed, bath, teeth]` → stages `["BATH","GROOM","FINISH"]`; BATH `serviceIds [deshed, bath]`, `durationMin 60`, `priceCents 6000`; GROOM `[haircut, teeth]` 70 / 7000; FINISH 15 / 1500; pet `priceCents 14500`.
- `"coat row is used"`: max `[bath]` → 60 / 5000.
- `"buffer is the stage max"`: services with bath buffer 5, deshed buffer 10 → BATH `bufferAfterMin 10`.
- `"candidates need skill and every service"`: rex `[bath, deshed]` → BATH candidates `[batherA]`; rex `[bath]` → `[batherA, batherB]`.
- `"preferred groomer only on GROOM and FINISH"`: rex `[bath, haircut, nails]`, `preferredGroomerId: groomerB.id` → BATH `[batherA, batherB]`, GROOM `[groomerB]`, FINISH `[groomerB]`; `preferredGroomerId: batherA.id` → GROOM `[]`.
- `"online drops employees not bookable online"`: groomerA `bookableOnline: false` → GROOM `[groomerB]`; in STAFF mode `[groomerA, groomerB]`.
- `"candidates ordered by booked minutes"`: groomerA busy 60 min that day → GROOM `[groomerB, groomerA]`.
- `"input errors"` (Review Focus 1 and 2): one assertion per code — `[]` pets → `NO_PETS`; 5 pets → `TOO_MANY_PETS`; rex twice → `DUPLICATE_PET`; `serviceIds: []` → `NO_SERVICES`; 7 services → `TOO_MANY_SERVICES`; `[bath, bath]` → `DUPLICATE_SERVICE`; `["nope"]` → `UNKNOWN_SERVICE`; mia `[haircut]` → `SPECIES_MISMATCH`; preferred `"nope"` → `UNKNOWN_EMPLOYEE`; rex `sizeClass: "L"` `[bath]` → `NO_PRICE_FOR_PET`; teeth with `resourceTypeId: null` plus haircut → `STAGE_RESOURCE_MISMATCH`.

- [ ] **Step 2: Run** `pnpm --filter @grooming/availability test` · Expected: FAIL (new modules missing); `intervals`/`free-time` still pass.
- [ ] **Step 3: Implement** types, errors, fixtures, `prepare.ts`, `resolve.ts`, index exports.
- [ ] **Step 4: Run** the package tests, global turbo command, grep · Expected: PASS (existing free-time and interval counts unchanged), exit 0, no output.
- [ ] **Step 5: Docs** — `packages/availability/README.md` (≤ 30 lines: inputs, outputs, error codes, which file does what; Tasks 5–6 extend it); provenance and docs index rows.
- [ ] **Step 6: Spec amendment** in `availability.md` "Inputs": the request field is `bookingMode` (not `mode`); `date` only (the API loops a range); kennel busy rows have `employeeId: null`.
- [ ] **Step 7: Commit** — `feat(availability): grooming inputs, error codes and request resolution`

---

### Task 5: availability — search and `findSlots` (Opus)

**Files:**
- Create: `packages/availability/src/search.ts`, `src/find-slots.ts`
- Test: `packages/availability/src/search.test.ts`, `src/find-slots.test.ts`
- Modify: `src/index.ts` (export `findSlots`, `blockEndFor`, constants), `README.md`, spec `availability.md` (Step 7)

**Interfaces:**
- Consumes: `Prepared`, `prepare`, `earliestStart`, `beyondHorizon`, `MAX_*` (Task 4 `prepare.ts`); `PetSpec`, `SegmentSpec`, `resolvePets` (Task 4); types from Task 4.
- Produces:
  - `const WAIT_MAX_GAP_MIN = 15`; `const DROP_OFF_INTAKE_MIN = 10`; `const MAX_NODES_PER_START = 5000`
  - `blockEndFor(seg: { employeeId: string | null; resourceId: string | null; end: Ms; bufferAfterMin: number }, next: { employeeId: string | null; resourceId: string | null; start: Ms } | null): Ms` — Rule B below
  - `planWait(p: Prepared, specs: PetSpec[], t: Ms, maxNodes?: number): PetPlan[] | null`
  - `planDropOff(p: Prepared, specs: PetSpec[], d: Ms, maxNodes?: number): PetPlan[] | null`
  - `findSlots(input: FindSlotsInput): Slot[]`

**Rules the search implements** (the spec plus the decisions recorded in Step 8):
- **Placement order:** pets in request order; each pet's segments in stage order; a pet is finished (all blocks fixed, kennel assigned) before the next pet starts. Later pets see earlier pets' segments as busy.
- **Start candidates** for a segment with lower bound `lb`: `lb` itself, then every grid time (`dayStart + k·slotIntervalMin`) strictly after `lb`, ascending, while the idle limit allows and `start + duration <= dayEnd`. `lb` = `t` for every pet's first segment in wait mode; `d + 10 min` in drop-off; the previous segment's `end` otherwise.
- **Idle limits:** wait mode — for each pet, every gap between consecutive segments ≤ 15 min (a pet's first segment has no limit beyond the day). Drop-off — per pet, `(first.start − (d + 10 min)) + Σ gaps ≤ maxQueueWaitMin`.
- **Rule B (buffer):** `blockEnd = end + bufferAfterMin`, except `blockEnd = end` when the same pet's next segment has the same employee, starts exactly at `end`, and (this segment has no resource, or the next has the same resource). Kennel segments: `blockEnd = end`.
- **Deferred block:** while a pet's segment is the latest placed one, it is "open": checks against it use `end`. Placing the next segment of the same pet closes it with `blockEndFor(seg, next)`; closing re-checks `[end, blockEnd)` against the employee's and resource's free time and against every other segment already in the plan. The pet's last work segment closes with `next = null`.
- **Feasibility of a placement:** employee free time covers `[start, end)`; no overlap with the employee's other segments in the plan (closed: `[start, blockEnd)`, open: `[start, end)`); same for the resource when `resourceTypeId` is set — try resources of that type ordered by `name`, then `id`.
- **Symmetry reduction** (per segment and start): skip an employee whose key was already tried, key = `id` if the employee is already in the plan, else `JSON(free intervals) + "|" + membership in each later segment's candidate list`; same for resources with key = `id` if used, else `JSON(free intervals)`.
- **Kennel (drop-off):** before placing a pet's first segment, require some kennel (`kind KENNEL`) unused in the plan that is free over the lower bound `[d, d + 10 min + Σ pet durations + pickupGraceMin)` — else backtrack. After the pet's last segment closes, assign the first kennel by `name` that is free over `[d, lastEnd + pickupGraceMin)` and not overlapping another kennel segment in the plan; none → backtrack. Kennel segment: `stage "KENNEL"`, `employeeId null`, `serviceIds []`, `start = d`, `end = blockEnd = lastEnd + pickupGraceMin`, `durationMin = (end − start) / MINUTE`, `priceCents 0`, appended last.
- **Budget:** count one node per (employee, resource) placement attempt; beyond `maxNodes` the start `t`/`d` yields `null`.
- **First feasible plan wins** (earliest-first by construction).

**`findSlots`:** `resolvePets` (errors propagate); ONLINE and any requested service `onlineBookable === false` → `[]`; `beyondHorizon` → `[]`; `prepare`; any segment with no candidates → `[]`. Candidate starts: grid times of the local day `≥ earliestStart`. WAIT: every such `t`. DROP_OFF: only grid times inside `dropOffWindows` for that weekday (via `weeklyToUtc`), unless `mode === "STAFF" && override` (then every grid time). For each start, `planWait`/`planDropOff`; a plan becomes `Slot { start, readyAt: max work end, bookingMode, pets }`.

- [ ] **Step 1: Write the failing tests** (`search.test.ts` covers `blockEndFor`; everything else in `find-slots.test.ts` through `findSlots(groomCtx({...}))`, `at(MON, "hh:mm")` from fixtures)

`blockEndFor`: same employee + no resource + starts at end → `end`; same employee + same resource → `end`; same employee + different resource → `end + buffer`; different employee → `end + buffer`; next starts later → `end + buffer`; `next = null` → `end + buffer`.

Wait mode:
- `"single pet: day bounds"` (Review Focus 5): rex `[bath, haircut]` → 34 slots; first `start 09:00`, segments BATH 09:00–09:45 (batherA, tub1), GROOM 09:45–10:45 (groomerA, table1), `readyAt 10:45`; last `start 17:15`, `readyAt 19:00`; `priceCents 10000`.
- `"two bathers start two pets together"`: employees `[batherA, batherB]`, rex `[bath]`, luna `[bath]` → first slot: both BATH at 09:00, employees `{batherA, batherB}`, tubs `{tub1, tub2}`.
- `"pipelined with one bather and one groomer"`: employees `[batherA, groomerA]`, rex and luna `[bath, haircut]` → first slot `09:00`: rex BATH 09:00–09:45, GROOM 09:45–10:45; luna BATH 09:45–10:30, GROOM 10:45–11:45; `readyAt 11:45`.
- `"idle over 15 min drops the start"`: employees `[batherA, groomerA]`, groomerA busy 09:45–10:15, rex `[bath, haircut]` → no slot at 09:00; slot at 09:15 has GROOM at 10:15 (gap exactly 15).
- `"busy station"`: tub1 and tub2 busy all day → `[]`.
- `"buffer blocks a different next person"`: `bath.bufferAfterMin 10`, employees `[batherA, groomerA]`, rex and luna `[bath, haircut]` → rex BATH `blockEnd 09:55`; luna BATH starts 10:00.
- `"buffer dropped on same groomer and same table"`: `nails` with `resourceTypeId: TABLE`, `haircut.bufferAfterMin 15`, employees `[groomerA]`, resources only `table1`, rex `[haircut, nails]` → GROOM 09:00–10:00 `blockEnd 10:00`, FINISH 10:00–10:15.
- `"buffer kept when the station is released"`: as above but `nails.resourceTypeId null` → GROOM `blockEnd 10:15`, FINISH 10:15–10:30.
- `"preferred groomer"`: rex `[bath, haircut]` preferred groomerB → GROOM employee groomerB.
- `"tie-break by booked minutes"`: groomerA busy 15:00–17:00 → first slot GROOM by groomerB.
- `"lead time and staff mode"`: `now 2026-12-07T15:10Z` → first start `16:15Z`; `mode STAFF` → `15:00Z`.
- `"horizon and past date"`: `2027-02-04` has slots, `2027-02-05` `[]` online and non-empty STAFF; `2026-12-05` online `[]`.
- `"not online bookable"`: `haircut.onlineBookable false` → `[]` online, slots in STAFF; employee `bookableOnline false` for both groomers → `[]` online.
- `"staff override ignores hours"`: STAFF + override, groomerA and groomerB time off all day, rex `[bath, haircut]` → first start `00:00` local.
- `"DST day"`: `date 2026-03-08`, `now 2026-03-01T12:00Z`, rex `[bath]` → first start `2026-03-08T13:00:00Z`.

Drop-off mode (`bookingMode: "DROP_OFF"`):
- `"windows define drop-off times"`: rex `[bath]` → 8 slots `09:00 … 10:45`; first slot BATH 09:10–09:55, kennel segment `[09:00, 10:55)` on kennel1, `readyAt 09:55`.
- `"no window that weekday"`: `dropOffWindows` without Monday → `[]`.
- `"staff override ignores windows"`: STAFF + override → first start `00:00` local.
- `"lead time"` (Review Focus 3): `now = at(MON, "08:50")` → starts `10:00, 10:15, 10:30, 10:45`.
- `"queue wait boundary"`: employees `[batherA, groomerA]`, batherA busy 09:00–10:15, groomerA busy 09:00–11:15, rex `[bath, haircut]`: `maxQueueWaitMin 80` → slot at 09:00 with BATH 10:15–11:00, GROOM 11:15–12:15, kennel `[09:00, 13:15)`; `maxQueueWaitMin 79` → no slot at 09:00.
- `"later pets see earlier pets"`: employees `[batherA]`, rex and luna `[bath]` → slot 09:00: rex 09:10–09:55, luna 10:00–10:45, kennels kennel1 and kennel2, `readyAt 10:45`.
- `"no free kennel"`: kennel1 and kennel2 busy all day → `[]`.
- `"one kennel, two pets"`: resources without kennel2, rex and luna `[bath]` → `[]`.
- `"pickup grace boundary"`: resources without kennel2, rex `[bath, haircut]` (BATH 09:10–09:55, GROOM 09:55–10:55, kennel to 11:55): kennel1 busy from 11:55 → slot at 09:00; busy from 11:54 → no slot at 09:00; busy ending exactly 09:00 → slot at 09:00.
- `"DST day"`: `2026-03-08` → 8 drop-off times, first `13:00Z`.

Budget and performance:
- `"budget exhausted yields no plan"`: `planWait(p, specs, at(MON,"09:00"), 1)` for rex `[bath, haircut]` → `null`; default budget → a plan.
- `"heavy infeasible search stays fast"`: 4 pets × `[bath, dry, haircut, nails]`, drop-off, both kennels busy all day → `[]` within 2000 ms; same 4 pets in wait mode with employees `[batherA, groomerA]` → returns within 2000 ms (any result).

- [ ] **Step 2: Run** `pnpm --filter @grooming/availability test` · Expected: FAIL.
- [ ] **Step 3: Implement** `blockEndFor` and the recursive search in `search.ts` (one shared recursion parameterized by lower bound and idle rule; `planWait`/`planDropOff` are thin wrappers), then `findSlots`.
- [ ] **Step 4: Run** the package tests · Expected: PASS. Fix the implementation, not the expected values; if an expected value looks wrong against the rules above, stop and report it.
- [ ] **Step 5: Run** the global turbo command and grep · Expected: exit 0, no output.
- [ ] **Step 6: Docs** — README: search rules in one line each (start candidates, idle limits, Rule B, kennel, budget).
- [ ] **Step 7: Spec amendment** in `availability.md` (same commit): (a) a segment may start exactly at its lower bound even off the grid, later starts are grid times; (b) Rule B for buffers; (c) drop-off windows are half-open; (d) STAFF override ignores drop-off windows; (e) the "two concurrent holds on the last kennel" test belongs to Plan 04 (integration).
- [ ] **Step 8: Commit** — `feat(availability): grooming planner for wait and drop-off with kennels`

---

### Task 6: availability — `validatePlan`

**Files:**
- Create: `packages/availability/src/validate-plan.ts`
- Test: `packages/availability/src/validate-plan.test.ts`
- Modify: `src/index.ts`, `README.md`

**Interfaces:**
- Consumes: `prepare`, `earliestStart`, `beyondHorizon` (Task 4); `resolvePets`, `PetSpec` (Task 4); `blockEndFor`, `WAIT_MAX_GAP_MIN`, `DROP_OFF_INTAKE_MIN`, `findSlots` (Task 5, tests only for `findSlots`).
- Produces: `validatePlan(input: Context & SlotRequest, slot: Slot): { ok: true } | { ok: false; reason: PlanRejection }` — used by `POST /holds` in Plan 04.

**Checks, in order (first failure wins):**
1. `MALFORMED_PLAN`: `resolvePets` throws; `slot.bookingMode !== input.bookingMode`; `slot.pets` length or `petId` order differs from the request.
2. `NOT_BOOKABLE_ONLINE`: ONLINE and any requested service not online-bookable.
3. Per pet, `MALFORMED_PLAN` unless: work segments match the spec's segments one-to-one (stage, `serviceIds` same order, `durationMin`, `priceCents`, `end − start = durationMin` min); in DROP_OFF exactly one extra KENNEL segment last, none in WAIT; `PetPlan.priceCents` = spec sum.
4. Per work segment: employee unknown → `NOT_QUALIFIED`; ONLINE and `!bookableOnline` → `NOT_BOOKABLE_ONLINE`; not in the spec's candidates → `NOT_QUALIFIED`.
5. Date: local date of `slot.start`; `BEYOND_HORIZON`; `slot.start < earliestStart` → `TOO_SOON`; `slot.start` off the grid → `MALFORMED_PLAN`; DROP_OFF and `slot.start` outside that weekday's windows (unless STAFF + override) → `OUTSIDE_DROP_OFF_WINDOW`; any segment `blockEnd > dayEnd` → `MALFORMED_PLAN`.
6. Shape, `MALFORMED_PLAN` unless: WAIT — first pet's first segment starts at `slot.start`, every pet's first segment ≥ `slot.start`, each segment ≥ previous end with gap ≤ 15 min. DROP_OFF — first segment ≥ `d + 10 min`, idle ≤ `maxQueueWaitMin`; kennel segment as defined in Task 5. `slot.readyAt` = max work end.
7. Every `blockEnd` equals `blockEndFor(seg, nextOfSamePet)` → else `MALFORMED_PLAN`.
8. Resources: needed but null → `RESOURCE_UNAVAILABLE`; given but not needed → `MALFORMED_PLAN`; unknown id, wrong type, or kennel segment on a non-KENNEL resource → `RESOURCE_UNAVAILABLE`.
9. `prepare`; each employee's free time covers `[start, blockEnd)` and no overlap with their other segments → else `EMPLOYEE_UNAVAILABLE`; each resource (kennels included) free over `[start, blockEnd)` and not overlapping in the plan → else `RESOURCE_UNAVAILABLE`.

- [ ] **Step 1: Write the failing tests** (build slots with `findSlots`, then mutate copies)
  - `"accepts every slot findSlots returns"`: for the Task 5 scenarios "single pet", "pipelined", "later pets see earlier pets" (drop-off) and "buffer kept", every returned slot → `{ ok: true }`.
  - `"bookingMode or pets mismatch"` → `MALFORMED_PLAN`.
  - `"wrong price, duration or stage grouping"` → `MALFORMED_PLAN` (three mutations).
  - `"unqualified employee"`: BATH assigned to groomerA → `NOT_QUALIFIED`; GROOM to groomerA when preferred is groomerB → `NOT_QUALIFIED`.
  - `"not online bookable"`: service flag → `NOT_BOOKABLE_ONLINE`; employee flag → `NOT_BOOKABLE_ONLINE`.
  - `"too soon and beyond horizon"`: `now` moved past the slot → `TOO_SOON`; slot on `2027-02-05` built in STAFF, validated ONLINE → `BEYOND_HORIZON`.
  - `"outside drop-off window"`: the 08:00 drop-off slot built with STAFF + override, validated in STAFF without override → `OUTSIDE_DROP_OFF_WINDOW`.
  - `"gap and idle limits"`: wait GROOM moved 30 min later (and end/blockEnd) → `MALFORMED_PLAN`; drop-off with `maxQueueWaitMin` lowered below the plan's idle → `MALFORMED_PLAN`.
  - `"dropped buffer that Rule B does not allow"`: buffer-kept slot with GROOM `blockEnd` set to `end` → `MALFORMED_PLAN`.
  - `"missing or wrong resource"`: tub removed → `RESOURCE_UNAVAILABLE`; table id on BATH → `RESOURCE_UNAVAILABLE`; resource on `nails` (no resource type) → `MALFORMED_PLAN`.
  - `"taken since search"`: add busy for the BATH employee over its range → `EMPLOYEE_UNAVAILABLE`; add busy on the kennel → `RESOURCE_UNAVAILABLE`.
- [ ] **Step 2: Run** `pnpm --filter @grooming/availability test` · Expected: FAIL.
- [ ] **Step 3: Implement** `validatePlan` with the checks in the order above.
- [ ] **Step 4: Run** the package tests, global turbo command, grep · Expected: PASS, exit 0, no output.
- [ ] **Step 5: Docs** — README: `validatePlan` and its rejection codes (API maps every rejection except `MALFORMED_PLAN` to `SLOT_TAKEN`/`409`, `MALFORMED_PLAN` to `422`; final mapping in Plan 04).
- [ ] **Step 6: Commit** — `feat(availability): validatePlan for holds`

---

## After the last task (main session)

Final branch review (reviewer-opus) → fixes → push, PR, merge to `main`.
Then update `docs/handoff.md` (done, next = write Plan 03) and the plans README
status row, commit, and resume-point memory.
