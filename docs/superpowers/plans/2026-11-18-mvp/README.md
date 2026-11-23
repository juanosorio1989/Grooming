# MVP implementation plans

Spec: [`docs/superpowers/specs/2026-11-18-mvp-design/`](../../specs/2026-11-18-mvp-design/README.md)
Mockups: https://claude.ai/artifact/Vn2VWpxCPYQC68d6xdWJhF (approved 2026-11-18)

The MVP is split into milestone plans (Plan 04 was split into 04a and 04b on 2026-11-21). Each one produces working, tested
software on its own branch. It is reviewed and merged before the next plan is
written in detail, so each plan builds on real code, not guesses.

| # | Plan | Delivers | Status |
|---|---|---|---|
| 01 | [Foundation, auth and schema](01-foundation.md) | Monorepo copied from BeautySpa `8a778d5` and renamed; `datetime`, `contracts`, `api-client`, availability base; NestJS API with auth; grooming Prisma schema with exclusion constraints (kennels included); SeaweedFS (local S3); CI | merged |
| 02 | [Pure domain packages](02-domain-packages.md) | `pricing` (size class, price matrix lookup), `tracking` (step state machine, ETA), grooming `availability` planner (stages, wait/pipelined, drop-off, kennels) with every test listed in availability.md | merged |
| 03 | [Catalog, staff, pets API](03-catalog-staff-pets.md) | Services + price matrix, stages, skills, resources and kennels, schedules, settings, staff customers and owner `/me`, pets + vaccines + merge, public reads incl. breeds, audit reader, full seeds | merged |
| 04a | [Owner sign-in and availability](04a-owner-signin-availability.md) | Owner Google sign-in API (`customer_identity`, phone linked once, 90-day sessions, link outbox row, Profile link/unlink), `OTP_CHANNELS`, `GET /availability` (online, 7-day cap) | merged |
| 04b | [Booking writes](04b-booking-writes.md) | Holds with new pets, multi-pet booking, reschedule/move, cancel, walk-in, staff-mode availability, sweeper, export/delete incl. pets and identities | merged |
| 05 | Visits, media, realtime API | Check-in/out, steps (idempotent `client_ref`), observations, report card, payments, presigned media on SeaweedFS/R2, SSE board + tracking, ETA worker, kennel overstay worker | to write |
| 06 | Notifications | Providers, router, Google link notice worker from the outbox (EN/ES), consent, BullMQ reminders, signed manage + tracking links, Twilio webhooks, visit templates EN/ES with ETA debounce | to write |
| 07 | Web: owner | Next.js, next-intl EN/ES, booking in 3 steps with Google one tap or phone code, owner area (pets, history), tracking page, report card | to write |
| 08 | Web: staff | Staff login/2FA, day board + kennels strip, check-in/out, groomer screen with offline queue, catalog/price matrix screens | to write |
| 09 | PWA and release hardening | Manifest, service worker, Playwright e2e (3 flows from security-quality.md), Lighthouse, Sentry, README | to write |

Execution for every plan: subagent-driven (implementer per task → `reviewer-opus`
→ fix → re-review), one final branch review, then merge to `main`.
