# Handoff

Last update: 2026-11-22 · Plan 04a merged to `main` (PR #5, `dd2f54b`); writing Plan 04b on `feat/mvp-04b-booking-writes`

## Done

- Plan 01 merged to `main` (see git history and `docs/provenance.md`).
- Plan 02 merged to `main`: `pricing`, `tracking` and the grooming `availability` planner
  (`docs/superpowers/plans/2026-11-18-mvp/02-domain-packages.md`). The final review fix wave
  (`513b997` kennel backtracking, `aea04fa` skip-ahead clamp) passed a scoped re-review.
- Plan 03 merged to `main` (PR #4): catalog, staff, pets, public reads, audit reader, seed.
- Plan 04 split into 04a and 04b (owner-approved 2026-11-21). The owner confirmed the three Plan 02 decisions below.
- Plan 04a merged to `main` (PR #5, `dd2f54b`)
  (`docs/superpowers/plans/2026-11-18-mvp/04a-owner-signin-availability.md`): owner Google sign-in API
  (nonce/ticket, link on OTP verify, Profile link/unlink, `/me` identities, outbox row, 90-day customer refresh),
  `OTP_CHANNELS` (owner request, default `sms`), `GET /availability` (online, 7-day cap). Every task reviewed by
  reviewer-opus; final branch review fix wave applied.

## Next

- Write Plan 04b (booking writes) in detail on `feat/mvp-04b-booking-writes`, show the routing table, then execute.

## Blocked on the owner (before launch, not blocking code)

- **WhatsApp:** no company/EIN yet (2026-11-21), so no Meta business verification and no WhatsApp sender in
  Twilio Verify. OTP runs on SMS (`OTP_CHANNELS=sms`, the default); switch to `whatsapp,sms` once the sender is
  active. Plan 06 visit notifications over WhatsApp need the same sender before real shops.
- **Google production:** privacy-policy URL, production origin, Publish app; needs the domain and the Plan 07 web.

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

- Plan 04b (see also the 04a plan's "Moved to Plan 04b"):
  - from 04a: staff-mode availability + `excludeAppointmentId`; `DELETE /me` removes identity rows and the
    customer's unprocessed outbox rows and must lock the customer row (`FOR UPDATE`) so a racing Profile link
    cannot leave an identity on a deleted customer; export lists linked identities;
  - from 04a: `/availability` CPU budget — worst case ~0.4–0.7 s per date × 7 dates runs synchronously on the event
    loop for anonymous callers (120 req / 10 min / IP). Decide a per-request time budget, a lower anonymous limit,
    a concurrency cap or a worker thread; at least log search time;
  - from 04a: reject a soft-deleted customer's token in `/availability` pet resolution (with the other deleted-customer checks);
  - from 04a: decide link-notice `notify` inside the verify transaction (today a read just before it);
  - from 04a (tests): `linkInTx` `count === 0` path, `isNew` on a new-phone link, deleted customer + ticket,
    Profile-link outbox payload, busy-range edges (`endsAt < from < blockEndsAt`), `STAGE_RESOURCE_MISMATCH` and
    missing `coatType` on `/availability`; move `FIXTURE_SETTINGS` out of `test/integration/helpers.ts` for unit tests;
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
- Plan 07 (from 04a, accept or polish): feature-off routes answer 400/401 before 404; empty `Authorization`
  counts as anonymous on `/availability`; `"unknown"` client IPs share one rate-limit bucket.
- Availability hardening (any plan that touches it):
  - add the kennel-backtrack drop-off input to `validate-plan.test.ts` "accepts every slot";
  - key the `freeKeys` memo in `search.ts` by map kind (`e:`/`r:`) as well as id.

## Decisions made during Plan 02 (owner confirmed 2026-11-21)

- In wait mode, the first pet's first segment starts exactly at the slot time. Later pets start at or after it, with no idle limit.
- `validateSteps` ignores SKIPPED steps that never started (a skip ahead is valid at any time).
- The name-leak grep excludes `*.md`, because prose docs may name the source product.

## Open questions

None.
