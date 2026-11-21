# Handoff

Last update: 2026-11-20 · Plan 02 merged; owner Google sign-in added to spec; next: write Plan 03

## Done

- Plan 01 merged to `main` (see git history and `docs/provenance.md`).
- Plan 02 merged to `main`: `pricing`, `tracking` and the grooming `availability` planner
  (`docs/superpowers/plans/2026-11-18-mvp/02-domain-packages.md`). The final review fix wave
  (`513b997` kennel backtracking, `aea04fa` skip-ahead clamp) passed a scoped re-review.

## Next

- Write Plan 03 (catalog, staff, pets API) in detail, using the carry-over below.

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
- Availability hardening (any plan that touches it):
  - add the kennel-backtrack drop-off input to `validate-plan.test.ts` "accepts every slot";
  - key the `freeKeys` memo in `search.ts` by map kind (`e:`/`r:`) as well as id.

## Decisions made during Plan 02 (owner to check)

- In wait mode, the first pet's first segment starts exactly at the slot time. Later pets start at or after it, with no idle limit.
- `validateSteps` ignores SKIPPED steps that never started (a skip ahead is valid at any time).
- The name-leak grep excludes `*.md`, because prose docs may name the source product.

## Open questions

None.
