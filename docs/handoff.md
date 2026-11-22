# Handoff

Last update: 2026-11-21 · Plan 04a written, awaiting owner review

## Done

- Plan 01 merged to `main` (see git history and `docs/provenance.md`).
- Plan 02 merged to `main`: `pricing`, `tracking` and the grooming `availability` planner
  (`docs/superpowers/plans/2026-11-18-mvp/02-domain-packages.md`). The final review fix wave
  (`513b997` kennel backtracking, `aea04fa` skip-ahead clamp) passed a scoped re-review.
- Plan 03 merged to `main` (PR #4): catalog, staff, pets, public reads, audit reader, seed.
- Plan 04 split into 04a and 04b (owner-approved 2026-11-21). The owner confirmed the three Plan 02 decisions below.
- Plan 04a written on branch `feat/mvp-04a-signin-availability`:
  `docs/superpowers/plans/2026-11-18-mvp/04a-owner-signin-availability.md`.

## Next

- Owner reviews Plan 04a, then execute it subagent-driven (routing table in the plan).
- After 04a merges, write Plan 04b (booking writes).

## Spec change 2026-11-20

- Owner sign-in: Google (one tap) or phone code; phone verified once per shop;
  customer refresh 90 days. Spec page `docs/superpowers/specs/2026-11-18-mvp-design/owner-sign-in.md`.
  API goes in Plan 04, link-notice templates in Plan 06, web in Plan 07.
- Google OAuth web client created by the owner (2026-11-20, project `Grooming`,
  Testing mode, origins `http://localhost:3000` and `http://localhost`). Its ID is
  in the local `.env` (`GOOGLE_OAUTH_CLIENT_IDS`, `NEXT_PUBLIC_GOOGLE_OAUTH_CLIENT_ID`).
  Plan 04/07 add both to `.env.example` as placeholders. Still open for
  production: privacy-policy URL in Branding, production origin, Publish app;
  optionally a Twilio Verify custom SMS template for Android autofill.

## Carry-over for later plans

- Plan 04b (04a takes only the `/availability` date-range cap; see the plan's "Moved to Plan 04b"):
  - DTOs validate integer ms (NaN makes `validatePlan` throw);
  - decide whether to grid-check segments after the first;
  - kennel holds past local midnight (STAFF late drop-off);
  - exclude the hold's own segments from `busy`;
  - test two concurrent holds on the last kennel → one `SLOT_TAKEN`;
  - `pet_visit.pet_id` is nullable while a hold carries a new pet; set it on confirm;
  - booking/hold writers reject deleted pets (an insert racing a merge can land on the soft-deleted source); also reject pets of soft-deleted customers;
  - `DELETE /me` soft-deletes the customer's pets and scrubs name/phone/email from `customer.*` audit before/after;
  - EMPLOYEE pet scope ignores a cancelled `pet_visit` inside a non-cancelled appointment; revisit with per-pet cancel;
  - org provisioning must write settings that pass `LocationSettingsSchema` (invalid stored settings make PATCH 500);
  - any future role-changing path (CLI/admin) must reuse the last-login-capable-owner guard;
  - deactivating a service/resource/employee with future bookings has no warning yet;
  - staff vaccine edit keeps the original verifier stamp (decide: re-stamp or clear);
  - location settings cache TTL is 30 s across processes.
- Plan 05:
  - load steps ordered by `sort` (`validateSteps` requires index == sort);
  - audit the skip reason;
  - bound reception corrections to ≥ check-in time;
  - test the untested step paths (SKIP on DONE/SKIPPED, START on an unknown stage, READY with nothing open);
  - document one `PlannedStage` per stage;
  - `visit_step.client_ref` only deduplicates the latest write; decide whether offline needs a per-write log.
- Availability hardening (any plan that touches it):
  - add the kennel-backtrack drop-off input to `validate-plan.test.ts` "accepts every slot";
  - key the `freeKeys` memo in `search.ts` by map kind (`e:`/`r:`) as well as id.

## Decisions made during Plan 02 (owner confirmed 2026-11-21)

- In wait mode, the first pet's first segment starts exactly at the slot time. Later pets start at or after it, with no idle limit.
- `validateSteps` ignores SKIPPED steps that never started (a skip ahead is valid at any time).
- The name-leak grep excludes `*.md`, because prose docs may name the source product.

## Open questions

None.
