# Handoff

Last update: 2026-11-23 · Plan 04b done on `feat/mvp-04b-booking-writes` (final reviews + fix wave); merging to `main`

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
- Plan 04b done (`docs/superpowers/plans/2026-11-18-mvp/04b-booking-writes.md`, API docs `docs/api/booking.md`):
  holds with new pets + sweeper, confirm with duplicate-pet choice, owner list/cancel/reschedule, staff-mode
  `/availability`, staff booking/move/cancel/no-show/walk-in, `GET /me/export`, `DELETE /me`. Every task reviewed by
  reviewer-opus; two independent final reviews; one fix wave (lock order, deadlock → 409 CONFLICT).
  Every 04b carry-over from 04a is done except the ones moved below.

## Next

- Write Plan 05 (visits, media, realtime API) in detail on a new branch, show the routing table, then execute.
  Order agreed with the owner 2026-11-23: 05 → 06 → 07 → 08 → 09.

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

- Any plan (unchanged from before 04b):
  - org provisioning must write settings that pass `LocationSettingsSchema` (invalid stored settings make PATCH 500);
  - any future role-changing path (CLI/admin) must reuse the last-login-capable-owner guard;
  - deactivating a service/resource/employee with future bookings has no warning yet (Plan 08 UI);
  - staff vaccine edit keeps the original verifier stamp (decide: re-stamp or clear);
  - location settings cache TTL is 30 s across processes.
- Known limits from 04b: kennels never pass local midnight (a late drop-off whose pickup grace passes midnight gets
  no slot, even with override); a residual deadlock while releasing an expired hold is answered 409 `CONFLICT`
  (client retries), never 500; `/me/pets*` answers 404 (not 401) for a deleted customer's still-valid access token.
- Plan 05:
  - load steps ordered by `sort` (`validateSteps` requires index == sort);
  - audit the skip reason;
  - bound reception corrections to ≥ check-in time;
  - test the untested step paths (SKIP on DONE/SKIPPED, START on an unknown stage, READY with nothing open);
  - document one `PlannedStage` per stage;
  - `visit_step.client_ref` only deduplicates the latest write; decide whether offline needs a per-write log;
  - from 04b: `media.purge` outbox worker (delete object keys from storage; `DELETE /me` writes the row);
  - from 04b: per-segment drag on the board (04b moves whole appointments); check-in re-planning when the size class changes;
  - from 04b: EMPLOYEE pet scope ignores a cancelled `pet_visit` inside a non-cancelled appointment; revisit with per-pet cancel;
  - from 04b: export media download links (export lists media ids today).
- Plan 06 (from 04b and 04a):
  - consume `appointment.booked` / `appointment.changed` / `appointment.cancelled` outbox rows (payload `{ appointmentId }`);
    the worker must skip deleted customers;
  - link-notice `notify` decided inside the verify transaction (today a read just before it);
  - consent capture at booking (WhatsApp checkbox);
  - scrub or detach the `notification_log` recipient on `DELETE /me`.
- Plan 07: Turnstile on anonymous `POST /holds` (security-quality.md, "(call)"; anonymous holds can squat slots at
  20 per IP per 10 min); and from 04a (accept or polish): feature-off routes answer 400/401 before 404; empty `Authorization`
  counts as anonymous on `/availability`; `"unknown"` client IPs share one rate-limit bucket.
- Plan 09: revisit `/availability` limits with the timing logs (debug per request, warn above 1 s).
- Availability hardening (any plan that touches it):
  - add the kennel-backtrack drop-off input to `validate-plan.test.ts` "accepts every slot";
  - key the `freeKeys` memo in `search.ts` by map kind (`e:`/`r:`) as well as id.

## Decisions made during Plan 02 (owner confirmed 2026-11-21)

- In wait mode, the first pet's first segment starts exactly at the slot time. Later pets start at or after it, with no idle limit.
- `validateSteps` ignores SKIPPED steps that never started (a skip ahead is valid at any time).
- The name-leak grep excludes `*.md`, because prose docs may name the source product.

## Open questions

None.
