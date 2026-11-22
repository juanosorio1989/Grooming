# Data model

Authority: [data-model.md](../superpowers/specs/2026-11-18-mvp-design/data-model.md)
(statuses: [tracking.md](../superpowers/specs/2026-11-18-mvp-design/tracking.md)).
Code: `apps/api/prisma/schema.prisma`, migrations in
`apps/api/prisma/migrations/` (the squashed `*_init`, then one folder per
change). Prisma models are PascalCase, mapped to the snake_case tables below.

Conventions: UUID v7 ids, `timestamptz(3)` in UTC, money in integer cents
(USD), weights in integer grams, translatable text as jsonb `{ "en", "es" }`,
`*_enc` columns hold AES-256-GCM ciphertext, `deleted_at` for soft deletes.
Every tenant table has `organization_id` with an `ON DELETE RESTRICT` FK.

| Area | Tables |
|---|---|
| Tenancy | `organization`, `location` (`settings` jsonb), `location_hours`, `location_closure` |
| Staff and auth | `staff_user`, `staff_recovery_code`, `staff_auth_token`, `staff_location`, `employee_profile` (`skills`), `employee_service`, `working_hours`, `time_off`, `refresh_token` |
| Customers and pets | `customer`, `customer_identity`, `notification_consent`, `pet`, `pet_vaccine`, `media` |
| Catalog and resources | `service_category`, `service`, `service_price`, `resource_type` (`kind` STATION/KENNEL), `resource` |
| Appointments and visits | `appointment`, `pet_visit`, `pet_visit_service`, `appointment_segment`, `visit_step`, `visit_observation`, `visit_report`, `payment_record` |
| Notifications and audit | `notification_log`, `audit_log`, `outbox_event` |

- `customer_identity`: a Google account linked to a customer (owner sign-in);
  unique `(organization_id, provider, subject)` and `(organization_id,
  customer_id, provider)`, FKs `ON DELETE RESTRICT`.
- `outbox_event`: events written in the same transaction as the change and
  read by workers (`processed_at` null until handled); index `(processed_at, created_at)`.

Raw SQL in the init migration (not modelled by Prisma; tests in
`apps/api/test/integration/booking-constraints.int.test.ts` and
`grooming-constraints.int.test.ts`):

- `appointment_segment.segment_time_order`: `starts_at < ends_at <= block_ends_at`.
- `segment_staff_matches_stage`: `KENNEL` segments have no person and a kennel
  `resource_id`; every other stage has a person.
- `no_employee_overlap`: no two occupying segments of one person overlap
  (only rows with a `staff_user_id`; kennel segments have none).
- `no_resource_overlap`: no two occupying segments on one station or kennel overlap.
- `service_price_any_coat`: one `NULL`-coat price row per service and size.

Seed (`pnpm --filter @grooming/api db:seed`, idempotent): organization
`demo-salon`, location `Main` (America/New_York, Mon–Sat 08:00–18:00, settings
defaults), 3 tubs, 3 tables, 2 dryers, 10 kennels, plus the demo shop:
3 categories and 15 services (EN/ES) with an S/M/L/XL price matrix (main DOG
services also have DOUBLE and CURLY rows, +15 % and +15 min), 6 staff (owner,
receptionist, 2 bathers, 2 groomers, one with both skills) with working hours
and `employee_service` per skill, 4 owners with 5 dogs and 1 cat (one dog with
allergies and `NEEDS_MUZZLE`, one expired vaccine) and 3 completed past visits
with steps, one observation and published reports. Data lives in
`apps/api/prisma/seed-data/`; the entry point is `runSeed` in `prisma/seed.ts`.
Medical notes are not seeded (no encryption key).
