# Handoff

Last update: 2026-11-18 · Plan 02 in progress (final-review fix wave pending)

## Done

- Plan 01 merged to `main` (see git history and `docs/provenance.md`).
- Plan 02 written: `docs/superpowers/plans/2026-11-18-mvp/02-domain-packages.md`.
- Branch `feat/mvp-02-domain` (not pushed), Tasks 1–6 implemented, each reviewed and clean:
  - `a3d7308` pricing · `c4e6c23`, `64574d4` tracking steps · `b375b05` tracking ETA
  - `f4f8da1` availability inputs · `e79e71a` planner (search, `findSlots`) · `948ebdc`, `1f67208` `validatePlan`
- Final branch review (reviewer-opus) done: **ready with fixes**. Gate green: lint, typecheck, test, build; name-leak grep clean. A fuzz run gave 3054/3054 valid slots.

## Next: one fix wave, then one scoped re-review, then merge

Dispatch one implementer-opus with all of these (Task 5 code), then one reviewer-opus re-review of the fix range (base `1f67208`):

1. **Important.** `packages/availability/src/search.ts` `finishPet` picks the kennel greedily and never backtracks.
   - Scenario: kennel-A free all day, kennel-B busy from 11:00. Two pets drop off at 09:00.
   - Pet 1 has a bath only (kennel to 10:55). Pet 2 has a bath plus a 120-min cut (kennel to about 12:55).
   - Today this returns 0 slots. Expected: at least one slot at 09:00, with pet 1 in kennel-B.
   - Fix: make the kennel a choice point, trying kennels in name order with backtracking. Symmetry skip is optional. Count each kennel attempt as a node.
   - Add the scenario as a test. Update the plan's Task 5 "Kennel" rule and the README kennel line to "first feasible kennel by name, backtracking".
2. Add two search tests:
   - Station contention: `[batherA, batherB]`, only `tub1`, rex and luna `[bath]` in wait mode → luna's BATH starts at 09:45.
   - Symmetry must not hide a feasible employee: the first bather in candidate order is busy at `t`, so the second bather is used at `t`.
3. Availability README: one line on how the node budget is counted. Keep the README ≤ 30 lines.
4. Tracking `steps.ts`: `latestTimestamp` ignores SKIPPED steps with `startedAt === null`.
   - Test: SKIP GROOM at m(60), then START BATH at m(50) → BATH `startedAt` is m(50), and `validateSteps` returns null.
5. Tracking README:
   - Add a note that `appointmentStatusAfterVisits` may move BOOKED straight to COMPLETED, and that the API writes that status directly.
   - Trim the README to ≤ 30 lines.

After that: push, open the PR, merge to `main`, mark the plans README row 02 as merged, update this file, and delete `.superpowers/sdd/02-domain-packages/`.

## Carry-over for later plans

- Plan 03:
  - catalog DTOs: `durationMin >= 1` (or a DB CHECK);
  - size thresholds are whole lb and strictly increasing;
  - existing cleanup:
    - `secrets:gen` test with real generators on empty S3 lines;
    - CORS should use `AUTH_HEADERS.csrf`;
    - `pgCode` should assert `meta.target`;
    - kennel fixture `priceCents: 0`;
    - assert the `service_price_any_coat` `indexdef`;
    - turbo `test:int` `passThroughEnv` should add `REDIS_URL_TEST` and `DEFAULT_ORG_SLUG`.
- Plan 04:
  - cap the `/availability` date range (worst-case search is about 0.4–0.7 s per date) or add a precheck;
  - DTOs validate integer ms (NaN makes `validatePlan` throw);
  - decide whether to grid-check segments after the first;
  - kennel holds past local midnight (STAFF late drop-off);
  - exclude the hold's own segments from `busy`;
  - test two concurrent holds on the last kennel → one `SLOT_TAKEN`;
  - `pet_visit.pet_id` is nullable while a hold carries a new pet; set it on confirm.
- Plan 05:
  - load steps ordered by `sort` (`validateSteps` requires index == sort);
  - audit the skip reason;
  - bound reception corrections to ≥ check-in time;
  - test the untested step paths (SKIP on DONE/SKIPPED, START on an unknown stage, READY with nothing open);
  - document one `PlannedStage` per stage;
  - `visit_step.client_ref` only deduplicates the latest write; decide whether offline needs a per-write log.

## Decisions made during Plan 02 (owner to check)

- In wait mode, the first pet's first segment starts exactly at the slot time. Later pets start at or after it, with no idle limit.
- `validateSteps` ignores SKIPPED steps that never started (a skip ahead is valid at any time).
- The name-leak grep excludes `*.md`, because prose docs may name the source product.

## Open questions

None.
