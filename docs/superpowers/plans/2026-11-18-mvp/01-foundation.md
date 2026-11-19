# Plan 01 — Foundation, Auth and Grooming Schema

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A working monorepo built from BeautySpa's proven pieces at commit
`8a778d5`, renamed to `@grooming/*`. It contains the platform packages, the
NestJS API with full auth, the complete grooming database schema with
database-enforced no-double-booking (people, stations and kennels), and green CI.

**Architecture:** Copy, don't fork. Every copied file comes from
`git -C ~/Claude/beautySpa/BeautySpa archive 8a778d5 <paths> | tar -x -C <repo>`,
never from BeautySpa's working tree, because that tree is on a later branch.
After the copy, rename and prove behavior is unchanged by running the copied
tests. Only then is the BeautySpa schema replaced with the grooming schema
(Task 4).

**Tech Stack:** As BeautySpa: Node 22, pnpm 10, Turborepo 2, TypeScript 5 strict,
Vitest, tsup, date-fns 4 + `@date-fns/tz`, Zod, NestJS 11, `nestjs-zod`,
Prisma 6, PostgreSQL 16, Redis 7, minio (S3), Docker Compose, GitHub Actions.

**Spec:** `docs/superpowers/specs/2026-11-18-mvp-design/`. Read `README.md`,
`architecture.md`, `data-model.md` and `security-quality.md`. BeautySpa's spec
at `~/Claude/beautySpa/BeautySpa/docs/superpowers/specs/2026-11-17-mvp-design/`
is the reference for anything marked "copied".

**Branch:** `feat/mvp-01-foundation`

## Routing

Main session: Opus 5.5. It orchestrates and does not implement tasks.

| Task | What | Implementer | Reviewer | Why |
|---|---|---|---|---|
| 1 | Root tooling, config, Docker (+ minio), CI, project docs | implementer-sonnet | reviewer-opus | mechanical copy and rename; exact values given |
| 2 | Platform packages: `datetime`, `contracts`, `api-client`, availability base | implementer-sonnet | reviewer-opus | copy and rename; copied tests prove it |
| 3 | API app copy (auth, tenancy, audit, rate-limit, redis, mail, config, common, health, prisma, CLI) on BeautySpa's schema | **implementer-opus** | reviewer-opus | auth/secrets code (Opus rule) |
| 4 | Grooming Prisma schema, one squashed initial migration with exclusion constraints, minimal seed | **implementer-opus** | reviewer-opus | schema/migration (Opus rule) |

## Global Constraints

- Node `22` (`.nvmrc`), pnpm `10` (`packageManager`), TypeScript `strict: true`, `noUncheckedIndexedAccess: true`.
- Rename everywhere: `@beautyspa/*` → `@grooming/*`, root package name `grooming`, cookie/header prefix `bs_` → `gr_` (e.g. `gr_refresh`), JWT `iss`/`aud` `beautyspa` → `grooming`, visible product name `BeautySpa` → `Grooming` (placeholder until the brand is named; TOTP issuer, emails, OpenAPI title).
- After every task: `git grep -n -i -E 'beautyspa|bs_refresh|\bbs_'` returns nothing, except in `docs/provenance.md` and `docs/superpowers/**`.
- Local ports must not collide with a running BeautySpa stack: postgres `5433`, redis `6380`, mailpit `1026` (SMTP) / `8026` (UI), minio `9010` (S3) / `9011` (console). Database names `grooming` and `grooming_test`, user/password `grooming` (local only).
- `packages/*` except `config` import no DOM, Next.js, NestJS or Node-only APIs (copied eslint platform rule and no-DOM typecheck).
- Money is integer cents (USD). Weights are integer grams. Timestamps UTC; default zone `America/New_York`.
- Code, comments, docs and commits in English. UI strings EN + ES only.
- Secrets never committed: `.env` gitignored, `.env.example` placeholders only, real values from `pnpm --filter @grooming/api secrets:gen`.
- Every task ends with green `pnpm turbo run lint typecheck test build` for what it touched, docs updated in the same commit, and one commit.

## Review Focus

1. **Leftover BeautySpa names** in code, cookies, JWT claims or emails mean tokens and cookies collide between the two products → the global grep above is part of every task's acceptance.
2. **Both stacks running at once** (owner works on BeautySpa and Grooming the same day) → no port or volume collisions. Test in Task 1: compose project name `grooming`, ports above.
3. **Kennel segments have no person** (`staff_user_id IS NULL`). Two kennel segments on different kennels at the same time must be allowed, and the same kennel overlapping must be rejected → tests in Task 4.
4. **Pickup frees a kennel early**: shortening a kennel segment to `ends_at = block_ends_at = now` must pass `segment_time_order`, and a new kennel segment starting exactly at `now` must be accepted (half-open `[)`) → test in Task 4.
5. **Offline replays**: the same `client_ref` sent twice in one organization must be rejected by the database (for `visit_step` and `media`), while the same value in another organization is accepted → test in Task 4.

---

### Task 1: Root tooling, config, Docker, CI, project docs

**Files:**
- Copy from `8a778d5`: `package.json`, `pnpm-workspace.yaml`, `turbo.json`, `.nvmrc`, `.npmrc`, `.gitignore`, `.env.example`, `eslint.config.mjs`, `docker-compose.yml`, `docker/postgres/init.sql`, `.github/workflows/ci.yml`, `packages/config/**`, `apps/mobile/README.md`
- Create: `CLAUDE.md` (project facts), `README.md` (short), `docs/README.md` (index), `docs/development/README.md`, `docs/provenance.md`

**Interfaces:**
- Produces: workspace `@grooming/config` (same exports as BeautySpa's: `tsconfig.base.json`, `tsconfig.platform.json`, `tsconfig.node.json`, `eslint.base.mjs`, `eslint.platform.mjs`, `vitest.preset.mjs`). Turbo tasks as copied (`build`, `dev`, `lint`, `typecheck`, `test`, `test:int`).
- Produces: compose services `postgres`, `redis`, `mailpit`, `minio`, and a one-shot `minio-init` (`minio/mc`) that creates the private bucket `pet-media` with versioning on. Top-level `name: grooming`.
- Produces: `.env.example` keys as copied (ports and names updated) plus `S3_ENDPOINT=http://localhost:9010`, `S3_REGION=auto`, `S3_BUCKET=pet-media`, `S3_ACCESS_KEY_ID=`, `S3_SECRET_ACCESS_KEY=` (placeholders; minio's local root user/password come from `.env`, read by compose).

- [ ] **Step 1: Branch** — `git checkout -b feat/mvp-01-foundation`
- [ ] **Step 2: Copy** — `git -C ~/Claude/beautySpa/BeautySpa archive 8a778d5 package.json pnpm-workspace.yaml turbo.json .nvmrc .npmrc .gitignore .env.example eslint.config.mjs docker-compose.yml docker .github packages/config apps/mobile | tar -x -C .`
- [ ] **Step 3: Rename and adjust** per Global Constraints. Change the ports, add minio + minio-init (healthcheck `mc ready local`), and give CI's service containers and env the `grooming` names.
- [ ] **Step 4: Write docs.**
  - `CLAUDE.md`: what the product is (one paragraph from the spec intent), stack, ports, the copy-from-BeautySpa rule, where the spec and plans live.
  - `docs/provenance.md`: source repo, commit `8a778d5`, a table of copied paths with "as is / renamed / changed".
  - `docs/development/README.md`: setup commands and ports.
  - `docs/README.md`: an index linking these and the spec.
- [ ] **Step 5: Verify install** — `pnpm install && pnpm turbo run lint typecheck test` · Expected: exit 0.
- [ ] **Step 6: Verify Docker** — `cp .env.example .env` (fill minio local credentials), `docker compose up -d && docker compose ps --format '{{.Service}} {{.Health}}'` · Expected: postgres, redis, mailpit, minio `healthy`; `minio-init` exited 0. `docker compose exec postgres psql -U grooming -lqt | cut -d'|' -f1 | grep -w grooming_test` prints `grooming_test`. `docker compose run --rm minio-init mc ls local/` lists `pet-media/`.
- [ ] **Step 7: Verify no leftovers** — the global grep returns nothing.
- [ ] **Step 8: Commit** — `chore: scaffold monorepo from BeautySpa 8a778d5, minio, CI, docs`

---

### Task 2: Platform packages

**Files:**
- Copy from `8a778d5`: `packages/datetime/**`, `packages/contracts/**`, `packages/api-client/**`, `packages/availability/**`
- Modify (availability): keep `src/intervals.ts`, `src/free-time.ts`, `src/errors.ts`, `src/index.ts`, `src/types.ts`, `test/fixtures.ts` and the tests `intervals.test.ts`, `free-time.test.ts`. Delete `plan.ts`, `find-slots.ts`, `validate-plan.ts`, `lookup.ts` and their tests.
- Modify (contracts): delete `src/availability.ts` and `src/availability.test.ts`.
- Modify: `docs/provenance.md` (record the deletions)

**Interfaces:**
- Consumes: `@grooming/config` (Task 1).
- Produces: `@grooming/datetime`, `@grooming/contracts` (`common`, `errors`, `health`, `auth`) and `@grooming/api-client` with the same exports as BeautySpa, renamed.
- Produces: `@grooming/availability` exporting only `normalize`, `subtract`, `intersect`, `covers`, `weeklyToUtc`, `employeeFreeTime`, `resourceFreeTime`, `AvailabilityError` and the types those use. `types.ts` keeps only the types imported by those files; `EmployeeInput` loses `levelId`. The grooming planner is written in Plan 02. The availability contract is written in Plan 04. Both are rewritten because BeautySpa's planner is built around levels and parallel services, which the spec removes.

- [ ] **Step 1: Copy** — `git -C ~/Claude/beautySpa/BeautySpa archive 8a778d5 packages/datetime packages/contracts packages/api-client packages/availability | tar -x -C .`
- [ ] **Step 2: Trim** availability and contracts as listed. Trim `test/fixtures.ts` to what the kept tests import.
- [ ] **Step 3: Rename** per Global Constraints.
- [ ] **Step 4: Verify** — `pnpm install && pnpm turbo run lint typecheck test build --filter='./packages/*'` · Expected: exit 0. The copied test counts for `datetime`, `contracts` (minus availability), `api-client`, `intervals` and `free-time` are unchanged from BeautySpa. Report the counts.
- [ ] **Step 5: Verify no leftovers** — the global grep returns nothing.
- [ ] **Step 6: Commit** — `chore: copy platform packages from BeautySpa 8a778d5 and trim availability base`

---

### Task 3: API app copy on BeautySpa's schema

**Files:**
- Copy from `8a778d5`: `apps/api/**` (src, test, prisma including its three migrations and seed, scripts, configs, README)
- Modify: `apps/api/src/auth/session.service.ts` (`REFRESH_COOKIE = "gr_refresh"`), `apps/api/src/auth/token.service.ts` (`ACCESS_AUDIENCE = "grooming"`, issuer the same), `apps/api/src/auth/crypto/totp.ts` (`ISSUER = "Grooming"`), `apps/api/src/auth/staff/emails.ts` (product name in EN and ES), `apps/api/src/bootstrap.ts` (OpenAPI title `Grooming API`), `apps/api/README.md`, the root `.env.example` if the API adds keys
- Modify: `docs/provenance.md`

**Interfaces:**
- Consumes: `@grooming/contracts`, `@grooming/config`.
- Produces: the BeautySpa API surface under `/v1`, unchanged except for the renames: auth (OTP, staff login + TOTP + recovery, invites/reset, refresh rotation, RBAC guards and decorators), tenancy, audit, rate limit, redis, mail, config/env, problem+json filter, health, `create-owner` CLI. Plus the scripts `secrets:gen`, `db:migrate`, `db:deploy`, `db:seed`, `db:drift`, `test:int`.

This task keeps BeautySpa's schema on purpose. A green copy on the original
schema proves the rename broke nothing before Task 4 changes the data model.

- [ ] **Step 1: Copy** — `git -C ~/Claude/beautySpa/BeautySpa archive 8a778d5 apps/api | tar -x -C .`
- [ ] **Step 2: Rename** per Global Constraints. Update tests that assert cookie names, audience, issuer or email text so they assert the new values. No other test edits are allowed.
- [ ] **Step 3: Verify unit** — `pnpm install && pnpm turbo run lint typecheck test build --filter=@grooming/api` · Expected: exit 0, with the same unit test count as BeautySpa at `8a778d5`.
- [ ] **Step 4: Verify integration** — `pnpm --filter @grooming/api secrets:gen` (writes the gitignored `.env` values), `pnpm --filter @grooming/api db:deploy && pnpm --filter @grooming/api test:int && pnpm --filter @grooming/api db:drift` · Expected: all pass, with the same integration test count as BeautySpa.
- [ ] **Step 5: Verify no leftovers** — the global grep returns nothing.
- [ ] **Step 6: Commit** — `chore(api): copy API and auth from BeautySpa 8a778d5, renamed`

---

### Task 4: Grooming schema, squashed migration, minimal seed

**Files:**
- Replace: `apps/api/prisma/schema.prisma`
- Delete: `apps/api/prisma/migrations/2026111805*`, `apps/api/prisma/migrations/20261118064000_tenancy_restrict_fks`
- Create: `apps/api/prisma/migrations/<timestamp>_init/migration.sql`. This is one migration: the Prisma-generated DDL, then BeautySpa's hand-written constraint SQL and restrict-FK SQL adapted below. Keep the "Down" comment block style.
- Replace: `apps/api/prisma/seed.ts`
- Modify: any copied code or test that referenced `Level`, `ServiceLevelPrice` or `EmployeeProfile.levelId`, including `test/integration/schema-integrity.int.test.ts`, `test/integration/booking-constraints.int.test.ts` and `test/integration/helpers.ts`
- Create: `apps/api/test/integration/grooming-constraints.int.test.ts`
- Modify: `docs/provenance.md`. Create `docs/data/README.md`: a short page with the table list per area, linking the spec's data-model.md as the authority.

**Interfaces:**
- Consumes: Task 3's API and test harness.
- Produces: Prisma models for every table in data-model.md, with Prisma names in PascalCase mapped to the snake_case tables the spec names (`@@map`, as BeautySpa does). Later plans rely on these exact model names: `Pet`, `PetVaccine`, `Media`, `Service`, `ServicePrice`, `PetVisit`, `PetVisitService`, `AppointmentSegment`, `VisitStep`, `VisitObservation`, `VisitReport`, `PaymentRecord`.
- Produces enums exactly as the spec lists them: `Species` (`DOG`,`CAT`), `ServiceSpecies` (`DOG`,`CAT`,`ANY`), `SizeClass` (`S`,`M`,`L`,`XL`), `CoatType`, `Temperament`, `VaccineType`, `MediaKind`, `MediaStatus`, `Stage` (`BATH`,`DRY`,`GROOM`,`FINISH`), `SegmentStage` (`BATH`,`DRY`,`GROOM`,`FINISH`,`KENNEL`), `StepStage` (`RECEIVED`,`BATH`,`DRY`,`GROOM`,`FINISH`,`READY`), `StepStatus`, `PetVisitStatus` (`BOOKED`,`RECEIVED`,`IN_PROGRESS`,`READY`,`PICKED_UP`,`CANCELLED`,`NO_SHOW`), `AppointmentStatus` (`HELD`,`BOOKED`,`IN_SHOP`,`COMPLETED`,`CANCELLED`,`NO_SHOW`), `BookingMode` (`WAIT`,`DROP_OFF`), `Skill` (`BATHER`,`GROOMER`), `ResourceKind` (`STATION`,`KENNEL`), `ObservationKind`, `Severity`, `PaymentMethod`.
- `Location.settings` stays `Json`. Its keys and defaults are validated in Plan 03, not by the schema.

Schema decisions the implementer must follow (from data-model.md):
- Copied tables unchanged: `organization`, `location_hours`, `location_closure`, `staff_user`, `staff_recovery_code`, `staff_auth_token`, `staff_location`, `working_hours`, `time_off`, `refresh_token`, `notification_consent`, `notification_log`, `audit_log`, `resource`, `service_category`, `employee_service`. `customer` adds `emergency_phone_e164` (nullable).
- `employee_profile`: drop `level_id`, add `skills Skill[]`. `resource_type` adds `kind ResourceKind`.
- `appointment_segment`: `staff_user_id` and `service_id` nullable; add `pet_visit_id` and `stage SegmentStage`.
- `pet.weight_g Int?`, `pet.size_class SizeClass?`, `pet.allergies String[]`, `pet.temperament Temperament[]`, `pet.medical_notes_enc Bytes?` (same encryption column style as BeautySpa's `*_enc`).
- `service_price`: `@@unique([serviceId, sizeClass, coatType])`. In the migration, add a partial unique index for the `NULL`-coat row, because Postgres treats NULLs as distinct: `CREATE UNIQUE INDEX service_price_any_coat ON service_price (service_id, size_class) WHERE coat_type IS NULL;`
- `visit_step.client_ref` and `media.client_ref`: nullable, unique per organization (`@@unique([organizationId, clientRef])`).
- `visit_report.pet_visit_id` is the primary key.
- Every new table has `organization_id` with a restrict FK, following BeautySpa's tenancy restrict-FK migration.

Constraint SQL (replaces BeautySpa's employee constraint; the resource constraint and `segment_time_order` are copied):

```sql
ALTER TABLE appointment_segment ADD CONSTRAINT no_employee_overlap EXCLUDE USING gist (
  staff_user_id WITH =, tstzrange(starts_at, block_ends_at, '[)') WITH &&
) WHERE (occupies AND staff_user_id IS NOT NULL);
```

- [ ] **Step 1: Write the failing tests** in `grooming-constraints.int.test.ts`. Each test inserts rows with Prisma or raw SQL and asserts the outcome. Overlap violations raise Postgres `23P01`; unique violations raise `23505`.
  - `kennel segments on different kennels overlap freely` — two `KENNEL` segments, `staff_user_id` NULL, kennels K1 and K2, both 09:00–13:00 → both inserted.
  - `same kennel cannot be double-booked` — K1 09:00–13:00, then K1 12:00–15:00 → `23P01`.
  - `pickup shortens a kennel segment and frees it at that instant` — K1 09:00–13:00, update to `ends_at = block_ends_at = 11:00` → succeeds; then insert K1 11:00–14:00 → succeeds.
  - `person segments still cannot overlap` — same staff, BATH 09:00–10:00 and GROOM 09:30–10:30 → `23P01`.
  - `client_ref is unique per organization` — two `visit_step` rows in org A with `client_ref = 'r1'` → `23505`; one in org B with `'r1'` → succeeds. Repeat for `media`.
  - `one any-coat price row per service and size` — two `service_price` rows `(svc, M, NULL)` → `23505`; `(svc, M, CURLY)` alongside → succeeds.
- [ ] **Step 2: Run them to verify they fail** — `cd apps/api && pnpm exec dotenv -e ../../.env -- vitest run --config vitest.int.config.mts test/integration/grooming-constraints.int.test.ts` (`test:int -- <filter>` does not filter) · Expected: FAIL (the tables don't exist yet).
- [ ] **Step 3: Write the schema and the single migration.** Delete the old migrations, run `prisma migrate dev --create-only --name init` against an empty database, then append the hand-written SQL.
- [ ] **Step 4: Update copied code and tests** that referenced levels. The copied auth, tenancy, audit and rate-limit tests must still pass unchanged. Adapt `schema-integrity` and `booking-constraints` to the new model.
- [ ] **Step 5: Write `seed.ts`.** It creates one organization and one location (`America/New_York`) whose `settings` hold the spec defaults: `defaultBookingMode: "DROP_OFF"`, `maxQueueWaitMin: 90`, `pickupGraceMin: 60`, `sizeThresholdsLb: {S:20,M:50,L:90}`, `requireAfterPhoto: true`, `vaccinePolicy: "WARN"`, `requiredVaccines: {DOG:["RABIES"]}`, `etaNotifyThresholdMin: 30`, `dropOffWindows` Mon–Sat `08:00–11:00`. It also creates resource types tub/table/dryer (`STATION`) and kennel (`KENNEL`) with 3 tubs, 3 tables, 2 dryers and 10 kennels. It must be idempotent. The full catalog and sample data come in Plan 03.
- [ ] **Step 6: Verify** — reset the test DB, then `pnpm --filter @grooming/api db:deploy && pnpm --filter @grooming/api db:seed && pnpm --filter @grooming/api db:seed && pnpm --filter @grooming/api test:int && pnpm --filter @grooming/api db:drift && pnpm turbo run lint typecheck test build` · Expected: everything passes; running the seed twice leaves exactly 10 kennels; drift check reports no drift; `ls apps/api/prisma/migrations` shows one migration folder plus `migration_lock.toml`.
- [ ] **Step 7: Verify no leftovers** — the global grep returns nothing, and `git grep -n -i 'level' apps/api/src apps/api/prisma` returns nothing.
- [ ] **Step 8: Commit** — `feat(api): grooming schema with kennel-aware exclusion constraints, squashed init migration`

---

## Finish

Final `reviewer-opus` review of the whole branch. Then push, open a PR, wait
for CI to pass and merge to `main`. Update this file's row in
[README.md](README.md) to "merged" and write `docs/handoff.md`. Then write
Plan 02 in detail against the merged code.
