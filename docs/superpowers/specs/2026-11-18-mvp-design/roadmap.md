# Roadmap after the MVP

## Phase 2 — money and trust

Stripe deposits/prepayment (reusing holds) and configurable cancellation /
no-show fees; digital consents (shave-down for matting, senior or medical
pets) signed at booking or check-in; authorized-pickup list; products used per
step with brand and lot; PDF export of a pet's history; waitlist (auto-offer
freed slots via BullMQ); reviews per visit and per groomer; SMS on after 10DLC.

## Phase 3 — retention, business, native

Packages and memberships; loyalty; tips (Stripe); recurring "time for a bath
every N weeks" reminders from `next_visit_weeks`; admin dashboard (day load per
person, revenue, top services, inactive clients, no-shows); pet taxi;
email/Google/Apple login for owners.

Native app (Expo): `apps/mobile` with Expo Router; reuse `contracts`,
`api-client` (SecureStore `TokenStore`), `availability`, `pricing`, `tracking`,
`datetime`, `i18n`; Expo push as a new notification provider with a
`device_token` table; native camera and background upload for groomers.

## Scale to many shops (when sellable)

As BeautySpa's roadmap: Postgres RLS by `organization_id`, tenant from
subdomain, onboarding wizard and platform admin, subscription billing, Stripe
Connect, one WhatsApp sender per shop.

## Shared core with BeautySpa (revisit)

When both products are stable, compare `availability`, `datetime`, `auth` and
`notifications` across repos and decide whether to extract shared packages.
