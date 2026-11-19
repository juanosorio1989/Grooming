# Handoff

Last update: 2026-11-19 · after Plan 01

## Done

- Spec approved: `docs/superpowers/specs/2026-11-18-mvp-design/`. Mockups: https://claude.ai/artifact/Vn2VWpxCPYQC68d6xdWJhF
- Plan 01 (foundation, auth, schema) implemented and reviewed on `feat/mvp-01-foundation`, merged to `main` via PR.
  - Monorepo copied from BeautySpa `8a778d5` and renamed (`@grooming/*`, `gr_refresh`, JWT `grooming`, CSRF `x-grooming-csrf`).
  - Local stack: postgres 5433, redis 6380, mailpit 1026/8026, SeaweedFS S3 9010. MinIO images are no longer published, so SeaweedFS replaced minio.
  - Grooming Prisma schema in one squashed init migration, enforced in the database:
    - no overlapping bookings for people or for resources (kennels included);
    - `segment_staff_matches_stage`;
    - a partial unique index for the any-coat price row;
    - `client_ref` unique per organization.

## Next

Write **Plan 02** (pure domain packages: `pricing`, `tracking`, grooming
`availability` planner) in detail against the merged code, show the routing
table, then execute it.

## Carry-over for later plans

- Plan 02: replace `AvailabilityErrorCode` planner codes in `packages/availability/src/errors.ts`.
- Plan 03 cleanup:
  - secrets:gen test with real generators on empty S3 lines;
  - CORS should use `AUTH_HEADERS.csrf`;
  - `pgCode` should assert `meta.target`;
  - kennel fixture `priceCents: 0`;
  - assert `service_price_any_coat` `indexdef`;
  - turbo `test:int` `passThroughEnv` should add `REDIS_URL_TEST` and `DEFAULT_ORG_SLUG`.
- Plan 04: `pet_visit.pet_id` is nullable while a hold carries a new pet. Set it on confirm.
- Plan 05: `visit_step.client_ref` is a single column, so it only deduplicates the latest write. Decide whether offline idempotency needs a per-write log.

## Open questions

None.
