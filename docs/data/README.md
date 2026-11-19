# Data model

Authority: [data-model.md](../superpowers/specs/2026-11-18-mvp-design/data-model.md)
(statuses: [tracking.md](../superpowers/specs/2026-11-18-mvp-design/tracking.md)).
Code: `apps/api/prisma/schema.prisma`, one squashed migration
`apps/api/prisma/migrations/*_init`. Prisma models are PascalCase, mapped to
the snake_case tables below.

Conventions: UUID v7 ids, `timestamptz(3)` in UTC, money in integer cents
(USD), weights in integer grams, translatable text as jsonb `{ "en", "es" }`,
`*_enc` columns hold AES-256-GCM ciphertext, `deleted_at` for soft deletes.
Every tenant table has `organization_id` with an `ON DELETE RESTRICT` FK.

| Area | Tables |
|---|---|
| Tenancy | `organization`, `location` (`settings` jsonb), `location_hours`, `location_closure` |
| Staff and auth | `staff_user`, `staff_recovery_code`, `staff_auth_token`, `staff_location`, `employee_profile` (`skills`), `employee_service`, `working_hours`, `time_off`, `refresh_token` |
| Customers and pets | `customer`, `notification_consent`, `pet`, `pet_vaccine`, `media` |
| Catalog and resources | `service_category`, `service`, `service_price`, `resource_type` (`kind` STATION/KENNEL), `resource` |
| Appointments and visits | `appointment`, `pet_visit`, `pet_visit_service`, `appointment_segment`, `visit_step`, `visit_observation`, `visit_report`, `payment_record` |
| Notifications and audit | `notification_log`, `audit_log` |

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
defaults), 3 tubs, 3 tables, 2 dryers, 10 kennels.
