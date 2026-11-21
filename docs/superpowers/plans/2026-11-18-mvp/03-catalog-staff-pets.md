# Plan 03 — Catalog, Staff and Pets API

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [x]`) syntax for tracking.

**Goal:** The data the booking engine needs, editable through the API:
location settings and hours, stations and kennels, services with the
size × coat price matrix, staff with skills, services, schedules and time off,
customers, pets and vaccines (owner and staff sides), public reads (locations,
services, employees, breeds), the audit log reader, and full development seeds.

**Architecture:** One NestJS module per area under `apps/api/src/<area>/`
(controller + service, Prisma through `PrismaService`, org from
`TenancyService`, RBAC with the existing `@StaffAuth` / `@CustomerAuth` /
`@Public` decorators, every mutation writes `AuditService.record` in the same
transaction). Request and response shapes are Zod schemas in
`packages/contracts/src/<area>.ts`, used through `createZodDto` like the auth
controllers. No schema migration in this plan.

**Tech Stack:** NestJS 10, Prisma 6, Postgres 16, Zod + nestjs-zod, Vitest +
supertest integration tests (`apps/api/test/integration/`), `@grooming/pricing`
(size class), `@grooming/datetime` (wall times, local day bounds).

**Spec:** `docs/superpowers/specs/2026-11-18-mvp-design/` — read `data-model.md`
(catalog, pets, `location.settings`, stage rule), `api.md` (Public, Owner,
Staff tables, RBAC additions), `flows.md` (booking step 1, owner area,
check-in), `security-quality.md` (Seeds). BeautySpa's staff/public/client
endpoint list (`git -C ~/Claude/beautySpa/BeautySpa show
8a778d5:docs/superpowers/specs/2026-11-17-mvp-design/api.md`) is the source for
the "copied" rows; BeautySpa has no code for them at `8a778d5`, so they are
written here.

**Branch:** `feat/mvp-03-catalog`

## Routing

Main session: Opus 5.5. It orchestrates and does not implement tasks.

| Task | What | Implementer | Reviewer | Why |
|---|---|---|---|---|
| 1 | Shared plumbing (default location, wall-time mapping, error codes, test token helper), audit reader, carry-over cleanup | implementer-sonnet | reviewer-opus | small, exact interfaces and test list |
| 2 | Settings, location hours, closures; thresholds change re-derives pet size class | implementer-sonnet | reviewer-opus | schema values copied from the spec |
| 3 | Resource types and resources (stations, kennels) | implementer-sonnet | reviewer-opus | plain CRUD with listed rules |
| 4 | Categories, services (stage/resource rule), price matrix | implementer-sonnet | reviewer-opus | rules and validation listed |
| 5 | Employees: profile, skills, services, working hours, time off | implementer-sonnet | reviewer-opus | listed rules; reuses existing session revocation |
| 6 | Staff customers and owner `/me` | implementer-sonnet | reviewer-opus | small CRUD |
| 7 | Pets and vaccines (owner + staff), EMPLOYEE scope, encrypted medical notes | implementer-sonnet | reviewer-opus | rules listed; reuses `Encryptor` |
| 8 | Pet merge | **implementer-opus** | reviewer-opus | rewrites production rows across five tables in one transaction |
| 9 | Public reads incl. breeds | implementer-sonnet | reviewer-opus | read-only, fields listed |
| 10 | Full development seeds | implementer-sonnet | reviewer-opus | data volume given in the spec |

Final branch review: reviewer-opus. Not a money branch; one final review (Task 8
gets its own Opus implementer and review).

## Global Constraints

- Paths under `/v1` (global prefix already set in `bootstrap.ts`). Staff routes `/staff/...`, owner routes `/me/...`, public `/public/...`.
- Every query filters by `organizationId = await tenancy.getOrgId()`. A row of another organization is `404 NOT_FOUND`, never 403.
- `:id` params are validated with `ZodValidationPipe(IdSchema)` (400 on non-UUID), as in `staff-admin.controller.ts`.
- Request bodies are `.strict()` Zod objects (unknown keys → 400 `VALIDATION_FAILED`).
- Translatable text uses `LocalizedTextSchema` (`{ en, es }`, both required, non-empty) from `packages/contracts/src/common.ts`.
- Money: integer cents `>= 0`. Durations: integer minutes. Weight: integer grams (`> 0`), shown in lb by clients.
- Enum string values match the Prisma schema exactly (`SizeClass`, `CoatType`, `Species`, `ServiceSpecies`, `Stage`, `Skill`, `ResourceKind`, `BookingMode`, `Temperament`, `PetSex`, `VaccineType`, `StaffRole`, `TimeOffKind`).
- Wall times in the API are `"HH:MM"` 24 h; an end time may be `"24:00"`, stored as `00:00` (the schema comment on `LocationHours.closes` / `WorkingHours.endTime`). Start < end, no overnight ranges.
- Deletes: rows referenced by bookings are deactivated (`active = false`) or soft-deleted (`deletedAt`), never hard-deleted. Lists hide inactive rows unless `?includeInactive=true` (staff only).
- Audit: every mutation writes one row with action `<entity>.<verb>` (names given per task), `actorType`/`actorId` from the principal, `entityId`, `before`/`after` as plain objects, `ip` from `requestMeta(req).ip`. Never put decrypted medical notes, tokens or password hashes in `before`/`after`; for pets write `medicalNotesChanged: true|false` instead.
- New error codes go into `ErrorCode` in `packages/contracts/src/errors.ts` (Task 1 adds them all).
- Every task: `pnpm turbo run lint typecheck test build` and `pnpm --filter @grooming/api test:int` exit 0; `git grep -n -i -E 'beautyspa|bs_refresh|\bbs_' -- ':!*.md'` prints nothing; docs change in the same commit (each task adds its page under `docs/api/` and a line in `docs/api/README.md`); one commit per task, plus fix commits after review.
- Code, comments, docs and commits in English.

## Review Focus

1. **A price row with `durationMin: 0` or a duplicate `(sizeClass, coatType)` in one PUT** → 400, nothing written (the planner would plan a zero-minute segment). Test in Task 4.
2. **The owner changes size thresholds** → every pet with a weight gets the new size class in the same transaction; a threshold set that is not whole lb or not strictly increasing is 400. Test in Task 2.
3. **An EMPLOYEE reads a pet they have no segment with today** → 404 (not 403, so existence is not leaked); with a segment today → 200 including medical notes. Test in Task 7.
4. **A customer reads or edits another customer's pet** (guessing an id) → 404. Test in Task 7.
5. **The last active OWNER demotes or deactivates themselves** → 409 `CONFLICT`; the shop must never be left without an owner. Test in Task 5.

---

### Task 1: Shared plumbing, audit reader, carry-over cleanup

**Files:**
- Create: `apps/api/src/location/location.service.ts`, `apps/api/src/location/location.module.ts` (global module exporting `LocationService`)
- Create: `apps/api/src/common/wall-time.ts`, test `apps/api/src/common/wall-time.test.ts`
- Create: `apps/api/src/audit/audit.controller.ts`; Modify: `apps/api/src/audit/audit.module.ts`, `apps/api/src/app.module.ts`
- Create: `packages/contracts/src/audit.ts`; Modify: `packages/contracts/src/errors.ts`, `packages/contracts/src/index.ts`
- Create: `apps/api/test/integration/tokens.ts`; Test: `apps/api/test/integration/audit/audit.int.test.ts`
- Cleanup (carry-over from `docs/handoff.md`): `apps/api/src/bootstrap.ts` (CORS header from `AUTH_HEADERS.csrf`), `apps/api/test/integration/helpers.ts` (`pgCode` asserts `meta.target` where the caller passes a constraint name; kennel segments `priceCents: 0`), `apps/api/test/integration/schema-integrity.int.test.ts` (assert the `service_price_any_coat` `indexdef`), `turbo.json` (`test:int` `passThroughEnv` adds `REDIS_URL_TEST`, `DEFAULT_ORG_SLUG`), `apps/api/test/secrets.test.ts` (real generators on empty S3 lines)
- Docs: create `docs/api/README.md` (index: one line per area page) and `docs/api/audit.md`; add `- [API modules](api/README.md)` to `docs/README.md`

**Interfaces:**
- Produces:
  - `LocationService.getDefault(): Promise<{ id: string; timezone: string; settings: LocationSettings }>` — the organization's oldest location (`orderBy createdAt asc`), settings parsed with `LocationSettingsSchema` (Task 2 defines the schema; until then Task 1 returns `settings` as `unknown` typed `Prisma.JsonValue`, and Task 2 changes the type). Cached per process like `TenancyService`, with `invalidate(): void` called after settings writes.
  - `wallToDbTime(t: WallTime): Date` (`"24:00"` → `1970-01-01T00:00:00Z`; `"08:30"` → `1970-01-01T08:30:00Z`) and `dbTimeToWall(d: Date, isEnd: boolean): WallTime` (`00:00` with `isEnd` → `"24:00"`). `WallTimeSchema` (regex `^([01]\d|2[0-3]):[0-5]\d$|^24:00$`) and `WallRangeSchema = { from, to }` with `from < to` and `from !== "24:00"`, in `packages/contracts/src/common.ts`.
  - `ErrorCode` adds `STAGE_RESOURCE_MISMATCH`, `IN_USE`, `PET_MERGE_INVALID`.
  - Test helper `apps/api/test/integration/tokens.ts`: `staffToken(app: INestApplication, opts: { sub: string; org: string; role: StaffRole }): Promise<string>` and `customerToken(app, opts: { sub: string; org: string }): Promise<string>`, both through `TokenService.issueAccess`.
  - `GET /v1/staff/audit?entity=&entityId=&limit=&before=` (OWNER) → `{ items: AuditItem[]; nextBefore: string | null }`; `AuditItem = { id, at, actorType, actorId, action, entity, entityId, before, after }` (no `ip`). `limit` 1..100, default 50; `before` is an ISO instant; order `at desc, id desc`.

- [x] **Step 1: Write failing tests**
  - `wall-time.test.ts`: `wallToDbTime("24:00")` equals `new Date("1970-01-01T00:00:00Z")`; `dbTimeToWall(new Date("1970-01-01T00:00:00Z"), true) === "24:00"` and with `false` `=== "00:00"`; round-trip `"08:30"`; `WallTimeSchema` rejects `"24:01"`, `"7:00"`, `"12:60"`; `WallRangeSchema` rejects `{from:"10:00",to:"10:00"}` and `{from:"24:00",to:"24:00"}`.
  - `audit.int.test.ts`: OWNER gets items newest first; `entity=service&entityId=<id>` filters; `limit=1` returns `nextBefore` and the next page continues without repeats; RECEPTION → 403; no token → 401; items never contain `ip`.
  - `schema-integrity.int.test.ts`: the `pg_indexes.indexdef` of `service_price_any_coat` contains `UNIQUE`, `(service_id, size_class)` and `WHERE (coat_type IS NULL)`.
  - `secrets.test.ts`: `secrets:gen` run through its real generator functions on input `"S3_ACCESS_KEY_ID=\nS3_SECRET_ACCESS_KEY=\n"` fills both (20 and 40 alphanumeric chars).
- [x] **Step 2: Run** `pnpm --filter @grooming/api test && pnpm --filter @grooming/api test:int` — new tests FAIL.
- [x] **Step 3: Implement** the interfaces above and the cleanup items. `AuditController` uses `@StaffAuth("OWNER")`. `pgCode(err, constraint?)`: when `constraint` is given and the error is P2002, also check `meta.target` contains it (array or string), else return `undefined`; update existing callers that check a specific unique to pass it.
- [x] **Step 4: Run** the Step 2 command plus `pnpm turbo run lint typecheck test build` — all PASS.
- [x] **Step 5: Commit** `feat(api): default location, wall times, audit reader; plan 02 carry-over cleanup`.

---

### Task 2: Settings, location hours, closures

**Files:**
- Create: `packages/contracts/src/settings.ts`; Modify: `packages/contracts/src/index.ts`
- Create: `apps/api/src/settings/{settings.module.ts,settings.controller.ts,settings.service.ts}`; Modify: `apps/api/src/app.module.ts`, `apps/api/src/location/location.service.ts` (typed settings)
- Test: `packages/contracts/src/settings.test.ts`, `apps/api/test/integration/settings/settings.int.test.ts`
- Docs: `docs/api/settings.md`

**Interfaces:**
- Consumes: `LocationService`, `wallToDbTime`/`dbTimeToWall`, `WallRangeSchema` (Task 1); `sizeClassFromWeight` from `@grooming/pricing`.
- Produces:
  - `LocationSettingsSchema` (all required) with these fields and bounds: `slotIntervalMin` one of `5,10,15,20,30,60`; `holdMinutes` int 1..30; `cancelWindowHours` int 0..168; `bookingHorizonDays` int 1..365; `minLeadMinutes` int 0..1440; `defaultBookingMode` `WAIT|DROP_OFF`; `dropOffWindows` record with keys `"0".."6"` (all optional) → array (max 4) of `WallRangeSchema`, sorted and non-overlapping; `maxQueueWaitMin` int 0..480; `pickupGraceMin` int 0..480; `sizeThresholdsLb` `{ S, M, L }` positive **integers**, `S < M < L`, `L <= 300`; `requireAfterPhoto` boolean; `vaccinePolicy` `WARN|BLOCK_CHECKIN`; `requiredVaccines` `{ DOG?: VaccineType[]; CAT?: VaccineType[] }` with unique items; `etaNotifyThresholdMin` int 5..240. Type `LocationSettings`.
  - `LocationSettingsPatchSchema` = deep-partial of the top level only (each top-level key optional; a given key replaces that whole value).
  - `LocationHoursSchema = { weekday: 0..6, opens: WallTime, closes: WallTime }` (opens < closes); PUT body is an array (max 14) whose ranges per weekday do not overlap.
  - `ClosureSchema = { startsAt: IsoInstant, endsAt: IsoInstant, reason?: string (max 200) }`, `startsAt < endsAt`.
  - Endpoints (all OWNER, except GET settings also RECEPTION):
    - `GET /staff/settings` → `{ location: { id, name, address, phone, timezone }, settings: LocationSettings, hours: LocationHours[] }`
    - `PATCH /staff/settings` `{ location?: { name?, address?, phone? }, settings?: LocationSettingsPatch }` → same shape as GET. Audit `settings.update` (before/after of changed keys only).
    - `PUT /staff/settings/hours` `LocationHours[]` → `LocationHours[]` (replaces all). Audit `location_hours.replace`.
    - `GET /staff/closures?from=&to=` (OWNER, RECEPTION), `POST /staff/closures` → `201 { id, ...Closure }`, `DELETE /staff/closures/:id` → 204. Audit `closure.create` / `closure.delete`.

- [x] **Step 1: Write failing tests**
  - `settings.test.ts`: the seed's `LOCATION_SETTINGS` object (copy it as a literal) parses; `sizeThresholdsLb {S:20.5,...}` fails; `{S:50,M:50,L:90}` fails; overlapping `dropOffWindows["1"]` fails; `slotIntervalMin: 7` fails; `requiredVaccines {DOG:["RABIES","RABIES"]}` fails.
  - `settings.int.test.ts`: GET as OWNER and RECEPTION; PATCH as RECEPTION → 403; PATCH `settings.sizeThresholdsLb {S:10,M:40,L:80}` → 200, and a pet with `weightG: 19_000` (fixture pet, M before) now has `sizeClass` `"L"` in the DB, a pet without weight keeps its `sizeClass`; PATCH with `{S:40,M:30,L:80}` → 400 and nothing changes; PATCH writes one `settings.update` audit row; PUT hours with `closes:"24:00"` → stored `00:00`, read back `"24:00"`; PUT hours with two overlapping Monday ranges → 400; closure with `endsAt <= startsAt` → 400; DELETE closure of another org → 404.
- [x] **Step 2: Run** `pnpm --filter @grooming/contracts test && pnpm --filter @grooming/api test:int -- settings` — FAIL.
- [x] **Step 3: Implement.** The threshold re-derive runs inside the PATCH transaction: load `{ id, weightG }` of non-deleted pets with `weightG not null` in the org, compute `sizeClassFromWeight(weightG, newThresholds)`, update only rows whose class changes. Call `LocationService.invalidate()` after commit.
- [x] **Step 4: Run** Step 2 command and the global checks — PASS.
- [x] **Step 5: Commit** `feat(api): location settings, hours and closures`.

---

### Task 3: Resource types and resources

**Files:**
- Create: `packages/contracts/src/resources.ts`; `apps/api/src/resources/{resources.module.ts,resource-types.controller.ts,resources.controller.ts,resources.service.ts}`
- Test: `apps/api/test/integration/resources/resources.int.test.ts`
- Docs: `docs/api/resources.md`

**Interfaces:**
- Produces (all OWNER; GETs also RECEPTION and EMPLOYEE):
  - `ResourceTypeSchema = { name: LocalizedText, kind: "STATION" | "KENNEL" }`; `GET /staff/resource-types` → `{ id, name, kind, resourceCount }[]`; `POST` → 201; `PATCH /:id` (`name` only; `kind` is immutable → 400 if sent); `DELETE /:id` → 204, or `409 IN_USE` when any resource or service references it. Audit `resource_type.create|update|delete`.
  - `ResourceSchema = { resourceTypeId: Id, name: string (1..60) }`; `GET /staff/resources?kind=&includeInactive=` → `{ id, name, resourceTypeId, kind, active }[]` ordered by type then name; `POST` → 201 (location = default location); `PATCH /:id` `{ name?, active? }`; `DELETE /:id` → sets `active=false`, 204. Name unique per location among active resources → `409 CONFLICT`. Audit `resource.create|update|deactivate`.

- [x] **Step 1: Write failing tests** — create type + two resources; list filtered by `kind=KENNEL`; PATCH `kind` → 400; delete a type with resources → 409 `IN_USE`; delete an unused type → 204; deactivated resource hidden from the default list and shown with `includeInactive=true`; duplicate active name → 409; EMPLOYEE POST → 403; resource of another org → 404.
- [x] **Step 2: Run** `pnpm --filter @grooming/api test:int -- resources` — FAIL.
- [x] **Step 3: Implement.**
- [x] **Step 4: Run** Step 2 command and global checks — PASS.
- [x] **Step 5: Commit** `feat(api): resource types and resources`.

---

### Task 4: Categories, services, price matrix

**Files:**
- Create: `packages/contracts/src/catalog.ts`; `apps/api/src/catalog/{catalog.module.ts,categories.controller.ts,services.controller.ts,catalog.service.ts,stage-rule.ts}`
- Test: `apps/api/src/catalog/stage-rule.test.ts`, `apps/api/test/integration/catalog/catalog.int.test.ts`
- Docs: `docs/api/catalog.md`

**Interfaces:**
- Produces:
  - `CategorySchema = { name: LocalizedText, sort?: int >= 0 }`; `GET|POST /staff/categories`, `PATCH|DELETE /staff/categories/:id` (OWNER; GET all staff). DELETE hard-deletes (services keep `categoryId = null` via `SetNull`). Audit `category.create|update|delete`.
  - `ServiceSchema = { categoryId?: Id | null, name: LocalizedText, description?: LocalizedText | null, species: ServiceSpecies, stage: Stage, isMain: boolean, resourceTypeId?: Id | null, requiredSkill: Skill, bookingMode?: BookingMode | null, bufferAfterMin: int 0..120, onlineBookable: boolean }`; PATCH takes any subset plus `active?`.
  - `ServicePriceRowSchema = { sizeClass, coatType: CoatType | null, durationMin: int 1..480, priceCents: int 0..1_000_000 }`; `PriceMatrixSchema` = array (max 4 × 7 = 28) with unique `(sizeClass, coatType)`.
  - `GET /staff/services?includeInactive=` → `ServiceView[]` where `ServiceView = ServiceSchema & { id, active, prices: ServicePriceRow[] }`; `GET /staff/services/:id`; `POST /staff/services` → 201; `PATCH /staff/services/:id`; `DELETE /staff/services/:id` → `active=false`, 204. Audit `service.create|update|deactivate`.
  - `GET /staff/services/:id/prices`, `PUT /staff/services/:id/prices` `PriceMatrix` → replaces all rows in one transaction. Audit `service_price.replace` (before/after = row arrays).
  - `checkStageRule(candidate: StageRuleService, others: StageRuleService[]): string | null` in `stage-rule.ts`, where `StageRuleService = { id, stage, species, resourceTypeId: string | null }` — returns the id of the first **active** other service that conflicts, else null. Two services conflict when they have the same `stage`, compatible species (equal, or either is `ANY`) and different `resourceTypeId` (null counts as a value). Create/PATCH that would make the candidate conflict → `409 STAGE_RESOURCE_MISMATCH` with `detail` naming the other service id.
  - `resourceTypeId` must reference a `STATION` type of this org (a `KENNEL` type → 400).

- [x] **Step 1: Write failing tests**
  - `stage-rule.test.ts`: same stage + DOG/DOG + different types → conflict; DOG vs CAT → none; DOG vs ANY → conflict; different stages → none; null vs type → conflict; null vs null → none; inactive other → none.
  - `catalog.int.test.ts`: create service + PUT matrix with 8 rows → GET returns them; PUT with `durationMin: 0` → 400 and the old rows remain; PUT with duplicate `(M, null)` → 400; PUT `[]` clears the matrix; second BATH DOG service on a different resource type → 409 `STAGE_RESOURCE_MISMATCH`; a KENNEL `resourceTypeId` → 400; deactivate → hidden from the default list; RECEPTION POST → 403; EMPLOYEE GET → 200; each mutation writes its audit row.
- [x] **Step 2: Run** `pnpm --filter @grooming/api test && pnpm --filter @grooming/api test:int -- catalog` — FAIL.
- [x] **Step 3: Implement.** Run `checkStageRule` against the org's active services excluding the candidate itself, inside the write transaction.
- [x] **Step 4: Run** Step 2 command and global checks — PASS.
- [x] **Step 5: Commit** `feat(api): categories, services and price matrix`.

---

### Task 5: Employees, schedules, time off

**Files:**
- Create: `packages/contracts/src/staff.ts`; `apps/api/src/staff/{staff.module.ts,employees.controller.ts,employees.service.ts,time-off.controller.ts,time-off.service.ts}`
- Test: `apps/api/test/integration/staff/employees.int.test.ts`, `apps/api/test/integration/staff/time-off.int.test.ts`
- Docs: `docs/api/staff.md`

**Interfaces:**
- Consumes: `RefreshTokenService.revokeAllFor(subject, tx)` (exported by `AuthModule`), `LocationService`, wall-time helpers.
- Produces (OWNER unless noted). Routes live on the existing `staff/employees` path next to `StaffAdminController` (different sub-paths, no clash):
  - `EmployeeCreateSchema = { displayName: string 1..60, role: StaffRole (default "EMPLOYEE"), email?: Email | null, locale: Locale, skills: Skill[] (unique), bookableOnline: boolean (default true), bio?: LocalizedText | null }`. `POST /staff/employees` creates `staff_user` (`canLogin: false`; the existing invite sets it), `employee_profile`, and `staff_location` for the default location → `201 EmployeeView`. Email unique per org → `409 CONFLICT`.
  - `EmployeeView = { id, displayName, role, email, locale, active, canLogin, skills, bookableOnline, bio, serviceIds: string[] }`. `GET /staff/employees?includeInactive=` (all staff roles; EMPLOYEE sees only active ones without `email`), `GET /staff/employees/:id`.
  - `PATCH /staff/employees/:id` any subset of create fields plus `active?`. A role change or `active:false` revokes that person's sessions (`revokeAllFor({ type: "STAFF", id })`) in the same transaction. Demoting or deactivating the **last active OWNER** → `409 CONFLICT`. Audit `employee.create|update`.
  - `PUT /staff/employees/:id/services` `{ serviceIds: Id[] }` → replaces `employee_service`; every id must be an active service of the org (else 400); a service whose `requiredSkill` is not in the person's `skills` → 400. Audit `employee_services.replace`.
  - `GET|PUT /staff/employees/:id/working-hours` body/response `{ weekday, start: WallTime, end: WallTime }[]` (max 21) for the default location; overlapping ranges on one weekday → 400. EMPLOYEE may GET their own. Audit `working_hours.replace`.
  - `TimeOffSchema = { staffUserId: Id, startsAt: IsoInstant, endsAt: IsoInstant, kind: TimeOffKind, note?: string max 200 }`; `GET /staff/time-off?staffUserId=&from=&to=` (OWNER, RECEPTION; EMPLOYEE only own — other `staffUserId` → 403), `POST` (OWNER, RECEPTION) → 201, `PATCH|DELETE /staff/time-off/:id` (OWNER, RECEPTION). Audit `time_off.create|update|delete`.

- [x] **Step 1: Write failing tests**
  - `employees.int.test.ts`: create a groomer → profile, staff_location, `canLogin false`; duplicate email → 409; PUT services with a GROOMER service for a BATHER-only person → 400; PUT working hours with `end:"24:00"` round-trips; overlapping Monday ranges → 400; role change revokes the person's refresh tokens (a refresh token created before the change is rejected on `POST /v1/auth/refresh`); the only OWNER PATCHes self `role:"RECEPTION"` → 409, and `active:false` → 409; with a second active OWNER it succeeds; EMPLOYEE GET list has no `email`; RECEPTION POST → 403.
  - `time-off.int.test.ts`: RECEPTION creates for staffB; EMPLOYEE lists own → 200, lists staffB's → 403; `endsAt <= startsAt` → 400; other-org id → 404.
- [x] **Step 2: Run** `pnpm --filter @grooming/api test:int -- staff` — FAIL.
- [x] **Step 3: Implement.**
- [x] **Step 4: Run** Step 2 command and global checks — PASS.
- [x] **Step 5: Commit** `feat(api): employees, working hours and time off`.

---

### Task 6: Staff customers and owner `/me`

**Files:**
- Create: `packages/contracts/src/customers.ts`; `apps/api/src/customers/{customers.module.ts,staff-customers.controller.ts,me.controller.ts,customers.service.ts}`
- Test: `apps/api/test/integration/customers/customers.int.test.ts`
- Docs: `docs/api/customers.md`

**Interfaces:**
- Produces:
  - `CustomerView = { id, name, phone, email, locale, emergencyPhone, createdAt }` (staff also get `privateNotes` decrypted with `Encryptor`, OWNER/RECEPTION only).
  - `GET /staff/customers?q=` (OWNER, RECEPTION; EMPLOYEE only customers with a segment assigned to them in the last 30 or next 30 days) — `q` matches name (case-insensitive contains) or phone digits (contains), max 50 results, ordered by name.
  - `POST /staff/customers` (OWNER, RECEPTION) `{ name, phone: PhoneE164, locale, email?, emergencyPhone? }` → 201, `createdVia: "STAFF"`; existing phone in the org → `409 CONFLICT` with `detail` = existing id. Audit `customer.create`.
  - `GET|PATCH /staff/customers/:id` (PATCH OWNER, RECEPTION; fields `name, email, locale, emergencyPhone, privateNotes`). Phone is not editable here. Audit `customer.update` (private notes as `privateNotesChanged`).
  - `GET /me`, `PATCH /me` (`CustomerAuth`) `{ name?, email?, locale?, emergencyPhone? }` → `CustomerView` without private notes. Audit `customer.update` with `actorType: "CUSTOMER"`. (Plan 04 adds `identities`, Plan 06 adds consents.)

- [x] **Step 1: Write failing tests** — search by `"ana"` and by `"0100"` finds the fixture customer; EMPLOYEE search without a nearby segment → `[]`, with one → found; duplicate phone → 409 with the existing id; PATCH `privateNotes` stores `*_enc` (column value is not the plain text) and GET returns the plain text to OWNER; `/me` PATCH changes `locale`; `/me` with a staff token → 403; GET `/me` for a customer whose `deletedAt` is set → 404.
- [x] **Step 2: Run** `pnpm --filter @grooming/api test:int -- customers` — FAIL.
- [x] **Step 3: Implement.**
- [x] **Step 4: Run** Step 2 command and global checks — PASS.
- [x] **Step 5: Commit** `feat(api): staff customers and owner profile`.

---

### Task 7: Pets and vaccines

**Files:**
- Create: `packages/contracts/src/pets.ts`; `apps/api/src/pets/{pets.module.ts,me-pets.controller.ts,staff-pets.controller.ts,pets.service.ts,pet-access.service.ts}`
- Test: `apps/api/test/integration/pets/me-pets.int.test.ts`, `apps/api/test/integration/pets/staff-pets.int.test.ts`
- Docs: `docs/api/pets.md`

**Interfaces:**
- Consumes: `LocationService` (thresholds, timezone), `sizeClassFromWeight`, `Encryptor`, `localDayBoundsUtc` / `todayIn`.
- Produces:
  - `PetInputSchema = { name: 1..40, species: Species, breed: 1..60, breedCode?: string | null, birthDate?: IsoDate | null, sex?: PetSex | null, neutered?: boolean | null, weightG?: int 1..150_000 | null, sizeClass?: SizeClass | null, coatType?: CoatType | null, temperament?: Temperament[] (unique), allergies?: string[] (max 20, each 1..60), medicalNotes?: string max 2000 | null, behaviorNotes?: string max 1000 | null, vetName?: max 80 | null, vetPhone?: PhoneE164 | null }`. Size rule: when `weightG` is set, `sizeClass` is derived (`sizeClassFromWeight(weightG, settings.sizeThresholdsLb)`) and a sent `sizeClass` is ignored; when `weightG` is null, the sent `sizeClass` is stored as is (owner picked S/M/L/XL). Setting `weightG` also sets `weightMeasuredAt = now`.
  - `PetView = PetInput-like fields (medicalNotes decrypted) + { id, customerId, sizeClass, weightMeasuredAt, photoMediaId, vaccines: VaccineView[] }`.
  - `VaccineInputSchema = { type: VaccineType, expiresOn: IsoDate }`; `VaccineView = { id, type, expiresOn, cardMediaId, verified: boolean, verifiedAt }`.
  - Owner (`CustomerAuth`, only own non-deleted pets; others → 404): `GET|POST /me/pets` (max 20 pets per customer → `409 CONFLICT`), `GET|PATCH|DELETE /me/pets/:id` (DELETE soft-deletes), `GET|POST /me/pets/:id/vaccines`, `PATCH|DELETE /me/pets/:id/vaccines/:vid`. An owner PATCH on a verified vaccine clears `verifiedAt`/`verifiedByStaffId`. Audit `pet.create|update|delete`, `pet_vaccine.create|update|delete` with `actorType: "CUSTOMER"`.
  - Staff: `GET /staff/pets?customerId=&q=` (OWNER, RECEPTION: any; EMPLOYEE: only pets with a segment assigned to them today), `POST /staff/pets` `{ customerId, ...PetInput }` (OWNER, RECEPTION), `GET /staff/pets/:id` (EMPLOYEE: same scope, else 404), `PATCH /staff/pets/:id` (OWNER, RECEPTION), `GET|POST /staff/pets/:id/vaccines`, `PATCH|DELETE .../vaccines/:vid` (OWNER, RECEPTION), `POST /staff/pets/:id/vaccines/:vid/verify` (OWNER, RECEPTION) → sets `verifiedAt = now`, `verifiedByStaffId`. Audit `pet_vaccine.verify` plus the create/update/delete names above.
  - `PetAccessService.employeeCanSee(staffId: string, petId: string, now: Date): Promise<boolean>` — true when an `appointment_segment` with `staffUserId = staffId` whose `petVisit.petId = petId` starts within the location's local day of `now` (`localDayBoundsUtc(todayIn(tz, now), tz)`) and the appointment status is not `CANCELLED`.

- [x] **Step 1: Write failing tests**
  - `me-pets.int.test.ts`: create with `weightG: 19_000` → `sizeClass "M"` (default thresholds); create with no weight and `sizeClass "XL"` → stored XL; create with both → derived wins; GET another customer's pet → 404; PATCH it → 404; 21st pet → 409; DELETE hides it from the list; `medicalNotes` round-trip and the DB column `medical_notes_enc` is not the plain text; owner edits a verified vaccine → `verified false`; audit rows have `medicalNotesChanged` and never the notes text.
  - `staff-pets.int.test.ts`: RECEPTION creates for the fixture customer; EMPLOYEE (staffA) without a segment today → list `[]`, GET → 404; after inserting a segment for staffA starting `now` on a visit of that pet → GET 200 with decrypted `medicalNotes`; a segment yesterday does not count; a `CANCELLED` appointment does not count; verify sets `verified true` and `pet_vaccine.verify` audit; EMPLOYEE PATCH → 403.
- [x] **Step 2: Run** `pnpm --filter @grooming/api test:int -- pets` — FAIL.
- [x] **Step 3: Implement.** Segments for the "today" tests are inserted directly with Prisma at `new Date()` (the fixed-date `bookSegment` helper cannot express "today").
- [x] **Step 4: Run** Step 2 command and global checks — PASS.
- [x] **Step 5: Commit** `feat(api): pets and vaccines for owners and staff`.

---

### Task 8: Pet merge (Opus)

**Files:**
- Create: `apps/api/src/pets/pet-merge.service.ts`; Modify: `apps/api/src/pets/staff-pets.controller.ts`, `packages/contracts/src/pets.ts`
- Test: `apps/api/test/integration/pets/pet-merge.int.test.ts`
- Docs: `docs/api/pets.md` (merge section)

**Interfaces:**
- Consumes: Task 7 views and module.
- Produces: `POST /staff/pets/:id/merge` (OWNER, RECEPTION) `{ intoPetId: Id }` → `200 PetView` of the target. `:id` is the source (the duplicate).

Rules (all in one transaction, `SERIALIZABLE` or row locks with `SELECT ... FOR UPDATE` on both pets, in id order to avoid deadlocks):
1. Both pets exist in the org, are not deleted, are different, belong to the **same customer** and the same species; otherwise `409 PET_MERGE_INVALID` (detail says which rule).
2. Move to the target: `pet_visit.pet_id`, `media.pet_id`, `pet_vaccine.pet_id`. Vaccines: when both have the same `type`, keep the one with the later `expiresOn` (a verified one wins a tie) and delete the other.
3. Fill target fields that are null/empty from the source (`breedCode`, `birthDate`, `sex`, `neutered`, `weightG`+`weightMeasuredAt`+`sizeClass` when the target has no weight, `coatType`, `medicalNotesEnc`, `behaviorNotes`, `vetName`, `vetPhoneE164`, `photoMediaId`); union `temperament` and `allergies` (dedupe, case-insensitive for allergies, target spelling wins).
4. Soft-delete the source (`deletedAt = now`).
5. Audit `pet.merge`, entity `pet`, `entityId` = target id, `after = { sourcePetId, movedVisits, movedMedia, movedVaccines, droppedVaccines, filledFields: string[] }`.

- [x] **Step 1: Write failing tests** — merge moves one visit, one media row and a non-duplicate vaccine; duplicate RABIES keeps the later expiry; target null `coatType` filled from source, target non-null `name` untouched; allergies `["Chicken"]` + `["chicken","Beef"]` → `["Chicken","Beef"]`; source is soft-deleted and gone from `/staff/pets`; different customers → 409 `PET_MERGE_INVALID`; same id → 409; DOG into CAT → 409; EMPLOYEE → 403; two concurrent merges of A→B and B→A: exactly one succeeds, the other gets 409, and no visit is lost (count of visits across both pets unchanged).
- [x] **Step 2: Run** `pnpm --filter @grooming/api test:int -- pet-merge` — FAIL.
- [x] **Step 3: Implement.**
- [x] **Step 4: Run** Step 2 command and global checks — PASS.
- [x] **Step 5: Commit** `feat(api): merge duplicate pets`.

---

### Task 9: Public reads and breeds

**Files:**
- Create: `packages/contracts/src/public.ts`; `apps/api/src/public/{public.module.ts,public.controller.ts,public.service.ts,breeds.json}`
- Test: `apps/api/test/integration/public/public.int.test.ts`, `apps/api/src/public/breeds.test.ts`
- Docs: `docs/api/public.md`

**Interfaces:**
- Produces (all `@Public()`):
  - `GET /public/locations` → `[{ id, name, address, phone, timezone, defaultBookingMode, hours: LocationHours[] }]` (never the full settings).
  - `GET /public/services` → active, `onlineBookable` services: `[{ id, categoryId, name, description, species, stage, isMain, bookingMode, prices: ServicePriceRow[] }]` plus `categories: [{ id, name, sort }]` → response `{ categories, services }`, services sorted by category sort, then `isMain desc`, then `name.en`.
  - `GET /public/employees` → active staff with an `employee_profile`, `bookableOnline = true` and at least one skill: `[{ id, displayName, bio, photoUrl, skills, serviceIds }]` (no email, role or schedule).
  - `GET /public/breeds?species=` → `[{ code, species, en, es, defaultCoat: CoatType | null }]` from `breeds.json` (~40 dog breeds, ~12 cat breeds; `code` kebab-case, unique), sorted by `en`; header `Cache-Control: public, max-age=86400`.

- [x] **Step 1: Write failing tests**
  - `breeds.test.ts`: codes unique and kebab-case; every `species` is `DOG|CAT`; every `defaultCoat` is a `CoatType` or null; at least 40 DOG and 12 CAT; includes `poodle`, `golden-retriever`, `shih-tzu`, `domestic-shorthair`.
  - `public.int.test.ts`: an inactive service and a non-online service are absent; prices are included; an employee with `bookableOnline:false` is absent and no response contains `email`; `?species=CAT` returns only cats; the cache header is set; no token needed.
- [x] **Step 2: Run** `pnpm --filter @grooming/api test && pnpm --filter @grooming/api test:int -- public` — FAIL.
- [x] **Step 3: Implement.** `breeds.json` is imported with `resolveJsonModule` (add to `apps/api/tsconfig.json` if missing) and copied by `nest build` (`assets` in `nest-cli.json` or a TS import, whichever the build already supports; verify `pnpm --filter @grooming/api build` output contains it).
- [x] **Step 4: Run** Step 2 command and global checks — PASS.
- [x] **Step 5: Commit** `feat(api): public locations, services, employees and breeds`.

---

### Task 10: Full development seeds

**Files:**
- Modify: `apps/api/prisma/seed.ts` (split data into `apps/api/prisma/seed-data/{services.ts,staff.ts,customers.ts}`; `seed.ts` keeps the orchestration)
- Test: `apps/api/test/integration/seed.int.test.ts`
- Docs: `docs/data/README.md` (Seed section), `docs/development/README.md` (what the seed creates, demo logins)

**Interfaces:**
- Consumes: `LocationSettingsSchema` (seed settings must parse), `PriceMatrixSchema`, `sizeClassFromWeight`.
- Produces: `export async function runSeed(prisma: PrismaClient): Promise<SeedSummary>` (exported so the test calls it; `main()` calls it). `SeedSummary = { services, priceRows, staff, customers, pets, visits, reports }`.

Seed content (from `security-quality.md` "Seeds"), idempotent by natural keys like today:
- Categories: Baths, Grooming, Add-ons (EN/ES).
- ~15 services with EN/ES names: DOG main: Bath & brush (BATH, tub), Full groom (GROOM, table), Puppy groom (GROOM, table), De-shedding treatment (BATH, tub); DOG add-ons: Nail trim (FINISH, none), Teeth brushing (FINISH, none), Ear cleaning (FINISH, none), Paw balm (FINISH, none), Flea shampoo (BATH, tub), Blueberry facial (BATH, tub), Blow dry (DRY, dryer), Bandana & cologne (FINISH, none); CAT main: Cat bath (BATH, tub), Lion cut (GROOM, table); CAT add-on: Nail trim (FINISH, none). Every service passes `checkStageRule` against the rest.
- Price matrix: every service has rows for S/M/L/XL with `coatType null`; main DOG services also have `DOUBLE` and `CURLY` rows priced 15% higher (rounded to $1) and 15 min longer. Prices in whole dollars, durations multiples of 5.
- Staff: owner `owner@demo.dev` (OWNER, can log in only after `pnpm --filter @grooming/api create-owner` as today — the seed does not set passwords), 1 receptionist, 2 bathers, 2 groomers (one with both skills); `employee_service` per skill; working hours Mon–Sat 08:00–17:00 with one 12:00–12:30 break for bathers.
- Customers: 4 owners (2 `es`, 2 `en`) with 5 dogs of different sizes/coats and 1 cat; one dog with allergies and `NEEDS_MUZZLE`; vaccines (one expired).
- Past visits: 3 `COMPLETED` appointments in the last 30 days with pet visits, segments, all steps `DONE`, one observation, and a published `visit_report`.

- [x] **Step 1: Write failing test** `seed.int.test.ts`: `runSeed` on an empty test DB returns `services >= 15`, `staff 6`, `customers 4`, `pets 6`, `reports 3`; every service has a NULL-coat row for each of S/M/L/XL; running it twice gives the same counts; the stored location settings parse with `LocationSettingsSchema`.
- [x] **Step 2: Run** `pnpm --filter @grooming/api test:int -- seed` — FAIL.
- [x] **Step 3: Implement.** Then run `pnpm --filter @grooming/api db:seed` against the dev DB twice; both print `seed ok` with the same counts.
- [x] **Step 4: Run** Step 2 command and global checks — PASS.
- [x] **Step 5: Commit** `feat(api): full development seed`.

---

## After the last task

- Final branch review (reviewer-opus) against this plan and the spec pages listed above.
- Update `docs/superpowers/plans/2026-11-18-mvp/README.md` (Plan 03 `merged`, Plan 04 `to write`), `docs/handoff.md` (done, carry-over for Plan 04+), then push, PR, merge to `main`.
