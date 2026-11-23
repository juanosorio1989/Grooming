# Plan 04b — Booking writes

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Owners hold a slot (new pets included), confirm it after sign-in, list,
cancel and reschedule their bookings. Reception books, moves, cancels and marks
no-shows in staff mode, and takes walk-ins. Expired holds are released by a sweeper.
Owners can export their data and delete their account, including pets and linked identities.

**Architecture:** A new `booking` module holds the write path. `/availability`,
holds, reschedule and staff writes share one pet resolver and one slot codec, so the
plan a client gets is the plan the server re-checks. Every write follows the same
steps: load the context, run `validatePlan` (outside the transaction), then open a
transaction that releases expired holds, inserts segments and lets the exclusion
constraints catch races (`23P01` → `409 SLOT_TAKEN`). Changes to bookings write
`appointment.*` outbox rows in the same transaction, and Plan 06 sends the messages.

**Tech Stack:** NestJS 11, Prisma 6, Postgres 16 (gist exclusion constraints), Zod +
nestjs-zod, Vitest + supertest, `@grooming/availability` (`findSlots`, `validatePlan`),
`@grooming/pricing` (`lookupPrice`, `sizeClassFromWeight`), `@grooming/datetime`.

**Spec:** `docs/superpowers/specs/2026-11-18-mvp-design/`. Read `availability.md`
(write-time validation, holds, staff mode), `flows.md` (online booking, duplicate pet
question), `data-model.md` (appointments and visits, exclusion constraints),
`api.md` (Public, Owner, Staff tables), `security-quality.md` (export/delete),
`owner-sign-in-api.md` (`DELETE /me` and identities). The parts inherited from
BeautySpa are in `git -C ~/Claude/beautySpa/BeautySpa show 8a778d5:docs/superpowers/specs/2026-11-17-mvp-design/flows.md`
(hold lifecycle, cancel/reschedule, walk-in) and `.../availability.md` (staff mode).

**Branch:** `feat/mvp-04b-booking-writes`

## Routing

Main session: Opus 5.5. It orchestrates and does not implement tasks.

| Task | What | Implementer | Reviewer | Why |
|---|---|---|---|---|
| 1 | Schema (`pet_visit.position`, `coat_type_at_booking`, `pending_pet`), contracts, error codes, `23P01` → 409, sweeper env | **implementer-opus** | reviewer-opus | schema/migration |
| 2 | Booking core: shared pet resolver, slot codec, plan writer, hold release, loader exclusions | **implementer-opus** | reviewer-opus | writes production booking rows |
| 3 | `POST/GET/DELETE /holds`, hold sweeper, last-kennel race | **implementer-opus** | reviewer-opus | production data, concurrency |
| 4 | `POST /appointments` (confirm): new pets, duplicate-pet choice, outbox | **implementer-opus** | reviewer-opus | creates customers' pets and bookings |
| 5 | Owner appointments: list, detail, cancel, reschedule, `excludeAppointmentId` | **implementer-opus** | reviewer-opus | production data |
| 6 | Staff-mode `/availability` (new guard policy, override) | **implementer-opus** | reviewer-opus | changes `AccessGuard` (auth) |
| 7 | Staff booking, move, cancel/no-show, walk-in, staff appointment read | **implementer-opus** | reviewer-opus | production data |
| 8 | `GET /me/export`, `DELETE /me` (pets, identities, outbox, audit scrub) | **implementer-opus** | reviewer-opus | destroys production data irreversibly |
| 9 | 04a test debt, `/availability` timing log, `FIXTURE_SETTINGS` move | implementer-sonnet | reviewer-opus | tests and logging only, every case named |

Final branch review: **two independent reviewer-opus reviews** (fresh context, no
shared conclusions), because this branch writes and deletes production data.

## Decisions made while writing this plan (owner may override at review)

- **The hold request carries the exact slot** as `/availability` returned it plus the
  pet entries. The server re-checks it with `validatePlan` and never searches again.
- **New pets live in `pet_visit.pending_pet`** (jsonb) while the hold is anonymous.
  The confirm step creates the pet, sets `pet_id` and clears `pending_pet`.
- **The booking snapshot includes the coat type** (`coat_type_at_booking`), so
  reschedule and move rebuild the exact same pet request from the appointment.
  Reschedule cannot change pets or services; for that, the owner cancels and books again.
- **Reschedule and move delete the old segments** and insert new ones in one
  transaction. Before/after times go to the audit log. BeautySpa instead keeps the old
  rows with `occupies = false`; deleting them keeps every segment query simple.
- **Verdict mapping:** `EMPLOYEE_UNAVAILABLE`, `RESOURCE_UNAVAILABLE` and `TOO_SOON` →
  `409 SLOT_TAKEN` (the UI refreshes slots). Every other rejection → `400
  VALIDATION_FAILED` with `detail` set to the reason.
- **Walk-in:** status `BOOKED`, source `WALK_IN`. Check-in comes in Plan 05 (weigh,
  vaccines, kennel). A walk-in needs an existing customer (reception creates one with
  `POST /staff/customers`).
- **Per-segment drag on the board** goes to Plan 05 with the board API. This plan
  moves whole appointments.
- **No grid check on segments after the first** (drop-off intake and back-to-back
  segments start off-grid by design).
- **Kennels stay inside the local day.** A drop-off whose pickup grace would pass
  local midnight gets no slot, even with override. Recorded as a known limit.
- **Media files on `DELETE /me`:** there is no S3 client before Plan 05, so the
  transaction deletes the pet photo and vaccine-card `media` rows and writes one
  `media.purge` outbox row with their object keys. Plan 05's worker deletes the files.
- **Notifications:** outbox rows `appointment.booked`, `appointment.changed`,
  `appointment.cancelled` with payload `{ appointmentId }`. Plan 06 consumes them.
  Consent at booking stays in Plan 06.
- **`/availability` CPU:** log the search time per request (warn above 1000 ms) and
  keep the limits. Revisit with real numbers in Plan 09.
- **Link-notice `notify` inside the verify transaction** moves to Plan 06, which
  consumes that notice.

## Global Constraints

- Paths under `/v1`. Every query filters by `organizationId = await tenancy.getOrgId()`; another organization's row is `404 NOT_FOUND`.
- Request bodies are `.strict()` Zod objects; errors are `application/problem+json` with `code` from `ErrorCode`.
- A customer token whose customer is soft-deleted → `401 UNAUTHORIZED` on every route of this plan (`assertActiveCustomer`, Task 2).
- Write order: validate outside the transaction → `prisma.$transaction` → row locks (customer → pets → appointment) → `releaseExpired` → writes. Any `23P01` from Postgres → `409 SLOT_TAKEN` (global mapping, Task 1); `40P01`, `40001` and `P2034` → `409 CONFLICT` (final review fix). Never 500 for a race.
- Status rules: `occupies` is `false` for every segment of a `CANCELLED` or `NO_SHOW` appointment, set in the same transaction. Pet visits follow: `CANCELLED` / `NO_SHOW`.
- Audit actions: `appointment.create`, `appointment.reschedule`, `appointment.move`, `appointment.cancel`, `appointment.no_show`, `customer.delete`. `after` holds ids, statuses, times and `override`, never names or phones.
- Every task: `pnpm turbo run lint typecheck test build` and `pnpm --filter @grooming/api test:int` exit 0; `git grep -n -i -E 'beautyspa|bs_refresh|\bbs_' -- ':!*.md'` prints nothing. Docs change in the same commit: `docs/api/booking.md` (new, Tasks 3–7, linked from `docs/api/README.md`), `docs/api/availability.md` (Tasks 5, 6, 9), `docs/api/customers.md` (Task 8), `docs/data/README.md` (Task 1). One commit per task, plus fix commits after review.
- Code, comments, docs and commits in English.

## Review Focus

1. **Two holds race for the last free kennel** → exactly one `201`, the other `409 SLOT_TAKEN`, one kennel segment in the DB. Test in Task 3.
2. **Confirm after the hold expired but before the sweeper ran** → `409 HOLD_EXPIRED`, the hold is released (`CANCELLED`, `occupies = false`), and the same slot can be held again. Test in Task 4.
3. **A saved pet deleted or merged between hold and confirm** → `409 PET_UNAVAILABLE`, appointment still `HELD`, nothing booked. Test in Task 4.
4. **Reschedule to a time that overlaps only its own old segments** → `200`; **reschedule onto a time someone else took meanwhile** → `409 SLOT_TAKEN` and the old segments are untouched. Test in Task 5.
5. **`DELETE /me` racing a confirm or a Profile Google link** → afterwards no `BOOKED` appointment, new pet or identity row belongs to the deleted customer. Test in Task 8.

---

### Task 1: Schema, contracts, error mapping, sweeper env

**Files:**
- Modify: `apps/api/prisma/schema.prisma` (`PetVisit`), migration `<timestamp>_booking_writes` (generated, then edited for the backfill and CHECK)
- Create: `packages/contracts/src/booking.ts` (+ export from `index.ts`), `packages/contracts/src/booking.test.ts`
- Modify: `packages/contracts/src/availability.ts` (export the two pet members, add query fields), `packages/contracts/src/errors.ts`
- Modify: `apps/api/src/common/problem.filter.ts` (Prisma `23P01` → 409 `SLOT_TAKEN`)
- Modify: `apps/api/src/config/env.ts`, `apps/api/test/support/test-env.ts`, `.env.example`
- Test: `schema-integrity.int.test.ts`, `apps/api/test/env.test.ts`, a new `apps/api/src/common/problem.filter.test.ts`
- Docs: `docs/data/README.md`

**Interfaces:**
- Produces (Prisma, `PetVisit`): `position Int @db.SmallInt` (0-based order of pets in the appointment, `@@unique([appointmentId, position])`); `coatTypeAtBooking CoatType @map("coat_type_at_booking")`; `pendingPet Json? @map("pending_pet")`. Raw SQL CHECK `pet_visit_pet_or_pending CHECK (pet_id IS NOT NULL OR pending_pet IS NOT NULL)`. Migration: add `position` and `coat_type_at_booking` nullable, backfill (`position` by `row_number() over (partition by appointment_id order by id) - 1`, coat from `pet.coat_type`, else `'SMOOTH'`), then `SET NOT NULL`.
- Produces (contracts, `availability.ts`): `AvailabilitySavedPetSchema`, `AvailabilityNewPetSchema` (the two union members, exported); `AvailabilityQuerySchema` gains `excludeAppointmentId: IdSchema.optional()`, `customerId: IdSchema.optional()`, `override: z.enum(["true","false"]).transform(v => v === "true").optional()`, and `pets` becomes optional. Refine: `pets` is required unless `excludeAppointmentId` is set, and the two are never sent together (issue on `pets`).
- Produces (contracts, `booking.ts`):
  ```ts
  export const NewPetDetailsSchema = { name: z.string().trim().min(1).max(40), breed: z.string().trim().min(1).max(60),
    breedCode: z.string().trim().min(1).max(60).nullish(), weightG: z.number().int().min(1).max(150_000).nullish() };
  export const HoldPetSchema = z.union([AvailabilitySavedPetSchema, AvailabilityNewPetSchema.extend(NewPetDetailsSchema).strict()]);
  export const HoldRequestSchema = z.object({ pets: z.array(HoldPetSchema).min(1).max(4), slot: SlotViewSchema,
    replaceHoldId: IdSchema.optional() }).strict();   // refine: slot.pets[i] label (petId or ref) equals pets[i] label, issue on "slot"
  export const HoldResponseSchema = z.object({ holdId: IdSchema, expiresAt: IsoInstantSchema });
  export const PetMatchSchema = z.object({ petId: IdSchema, name: z.string(), breed: z.string(), weightG: z.number().int().nullable() });
  export const HoldViewSchema = z.object({ holdId, expiresAt, bookingMode, startsAt, readyAt,
    pets: z.array(z.object({ visitId: IdSchema, petId: IdSchema.nullable(), ref: z.string().nullable(), name: z.string(),
      priceCents: MoneyCentsSchema, matches: z.array(PetMatchSchema) })) });
  export const AppointmentCreateSchema = z.object({ holdId: IdSchema, notes: z.string().trim().max(500).optional(),
    usePets: z.record(z.string().regex(/^new-[1-4]$/), IdSchema).optional() }).strict();
  export const AppointmentStatusSchema = z.enum(["HELD","BOOKED","IN_SHOP","COMPLETED","CANCELLED","NO_SHOW"]);
  export const AppointmentViewSchema = z.object({ id, status: AppointmentStatusSchema, source: z.enum(["ONLINE","RECEPTION","WALK_IN"]),
    bookingMode, startsAt: IsoInstantSchema, dropOffAt: IsoInstantSchema.nullable(), estimatedReadyAt: IsoInstantSchema.nullable(),
    notes: z.string().nullable(), cancelledAt: IsoInstantSchema.nullable(),
    pets: z.array(z.object({ visitId, petId: IdSchema, petName: z.string(), status: z.string(), priceCentsQuoted: MoneyCentsSchema,
      services: z.array(z.object({ serviceId, priceCents, durationMin })),
      segments: z.array(z.object({ id, stage, employeeId: IdSchema.nullable(), resourceId: IdSchema.nullable(), startsAt, endsAt })) })) });
  export const StaffAppointmentViewSchema = AppointmentViewSchema.extend({ customerId: IdSchema, createdByStaffId: IdSchema.nullable(), cancelReason: z.string().nullable() });
  export const MeAppointmentsQuerySchema = z.object({ scope: z.enum(["upcoming","past"]).default("upcoming") }).strict();
  export const RescheduleSchema = z.object({ slot: SlotViewSchema }).strict();
  export const StaffMoveSchema = z.object({ slot: SlotViewSchema, override: z.boolean().default(false) }).strict();
  export const StaffBookingSchema = z.object({ customerId: IdSchema, pets: z.array(HoldPetSchema).min(1).max(4), slot: SlotViewSchema,
    override: z.boolean().default(false), notes: z.string().trim().max(500).optional() }).strict();   // same label refine as HoldRequest
  export const WalkInSchema = z.object({ customerId: IdSchema, pets: z.array(HoldPetSchema).min(1).max(4), override: z.boolean().default(false) }).strict();
  export const StaffStatusSchema = z.object({ action: z.enum(["CANCEL","NO_SHOW"]), reason: z.string().trim().max(200).optional() }).strict();
  ```
  `startsAt` of an appointment = `dropOffAt` in drop-off mode, else the earliest work segment start. Every schema exports its `z.infer` type.
- Produces: `ErrorCode` gains `"PET_UNAVAILABLE"`.
- Produces (env): `HOLD_SWEEPER_INTERVAL_MS: number` (int ≥ 0, default `60000`, `0` = off). `testEnv` sets `0`.
- Produces (filter): a Prisma error whose SQLSTATE is `23P01` (P-code missing, `code: "23P01"` in the message, as `pgCode` in `test/integration/helpers.ts` documents) → `409` `{ code: "SLOT_TAKEN" }`. Put the SQLSTATE extraction in `apps/api/src/common/pg-error.ts` (`pgSqlState(err): string | undefined`) and use it from the filter.

- [ ] **Step 1: Write the failing tests**
  - `booking.test.ts`: `HoldRequestSchema` rejects slot labels in a different order than `pets` (issue path `slot`); rejects a new pet without `name`; accepts a saved pet entry; `usePets` key `new-5` rejected; `StaffStatusSchema` rejects `action: "COMPLETE"`.
  - `availability.test.ts`: no `pets` and no `excludeAppointmentId` → issue on `pets`; both → issue on `pets`; `override=true` → `true`.
  - `env.test.ts`: `HOLD_SWEEPER_INTERVAL_MS` unset → `60000`; `"0"` → `0`; `"-1"` → throws naming the variable.
  - `problem.filter.test.ts`: a `PrismaClientUnknownRequestError` with message containing `code: "23P01"` → status 409, body `code: "SLOT_TAKEN"`.
  - `schema-integrity.int.test.ts`: a `pet_visit` with `pet_id` null and `pending_pet` null → `23514`; two visits with the same `(appointment_id, position)` → `23505`.
- [ ] **Step 2: Run them.** Run: `pnpm --filter @grooming/contracts test && pnpm --filter @grooming/api test && pnpm --filter @grooming/api test:int -- schema-integrity`. Expected: the new cases FAIL.
- [ ] **Step 3: Implement the schema and run `pnpm --filter @grooming/api db:migrate --name booking_writes`**, then edit the generated SQL for the backfill and the CHECK as described, and re-apply (`db:reset` on the dev DB if needed). Update `createPetVisit` in `test/integration/helpers.ts` to set `position` and `coatTypeAtBooking`.
- [ ] **Step 4: Implement contracts, error code, env, `pg-error.ts` and the filter mapping.** `.env.example`: `HOLD_SWEEPER_INTERVAL_MS=60000` with comment "release expired holds every N ms; 0 = off".
- [ ] **Step 5: Run every check** (Global Constraints) plus `pnpm --filter @grooming/api db:drift`. Expected: exit 0, no drift.
- [ ] **Step 6: Commit** `feat(api): booking schema (visit position, coat snapshot, pending pet), booking contracts, 23P01 → SLOT_TAKEN`.

---

### Task 2: Booking core

**Files:**
- Create: `apps/api/src/booking/pet-requests.ts`, `apps/api/src/booking/slot-codec.ts` (pure), `apps/api/src/booking/slot-codec.test.ts`
- Create: `apps/api/src/booking/plan-writer.ts`, `apps/api/src/booking/hold-release.service.ts`, `apps/api/src/booking/booking.module.ts` (registered in `app.module.ts`)
- Create: `apps/api/src/customers/active-customer.ts`
- Modify: `apps/api/src/availability/availability.service.ts` (use the resolver and codec; behavior unchanged), `apps/api/src/availability/context-loader.ts`
- Test: `apps/api/test/integration/booking/plan-writer.int.test.ts`, `apps/api/test/integration/availability/context-loader.int.test.ts`, existing `availability.int.test.ts` stays green

**Interfaces:**
- Consumes: Task 1 schema and contracts; `validatePlan`, `findSlots`, `AvailabilityError`; `lookupPrice` from `@grooming/pricing`.
- Produces:
  ```ts
  // active-customer.ts
  /** 401 UNAUTHORIZED when the customer is missing or soft-deleted. With tx and lock, takes `FOR SHARE` (`FOR UPDATE` for "update") on the row. */
  export async function assertActiveCustomer(db: PrismaService | Prisma.TransactionClient, orgId: string, customerId: string,
    lock?: "share" | "update"): Promise<void>
  // pet-requests.ts
  export type PetLabel = { petId: string } | { ref: string };
  export interface ResolvedPets { pets: PetRequest[]; labels: Map<string, PetLabel>; customerId: string | null }
  @Injectable() export class PetRequestResolver {
    /** Moved from AvailabilityService.resolvePets. owner: the customer whose saved pets may be used (null = anonymous: petId → 401).
     *  Calls assertActiveCustomer when owner is set. Same 400/404 rules as /availability today. */
    resolve(entries: (AvailabilityQuery["pets"][number] | HoldPet)[], owner: string | null): Promise<ResolvedPets>
    /** Rebuilds the request of an existing appointment from its visits (position order): petId, species from the pet,
     *  sizeClassAtBooking, coatTypeAtBooking, services from pet_visit_service, preferredGroomerId ?? "ANY". 404 if not found. */
    fromAppointment(appointmentId: string): Promise<ResolvedPets>
  }
  // slot-codec.ts
  export function slotFromView(view: SlotView, labels: Map<string, PetLabel>): Slot   // engine petId = petId or ref
  export function toSlotView(slot: Slot, labels: Map<string, PetLabel>): SlotView     // moved from availability.service
  export function engineError(err: AvailabilityError): BadRequestException             // moved
  /** EMPLOYEE_UNAVAILABLE | RESOURCE_UNAVAILABLE | TOO_SOON → ConflictException SLOT_TAKEN; else 400 VALIDATION_FAILED, detail = reason. */
  export function verdictError(reason: PlanRejection): HttpException
  // context-loader.ts — new optional argument
  load(range: { from: Date; to: Date }, opts?: { excludeAppointmentId?: string }): Promise<...>
  // plan-writer.ts
  export interface PlanWrite { orgId: string; locationId: string; slot: Slot; pets: PetRequest[];
    petIds: (string | null)[]; pendingPets: (PendingPet | null)[]; prices: ServicePriceRow[] }
  export type PendingPet = { ref: string; name: string; breed: string; breedCode: string | null; weightG: number | null };
  @Injectable() export class PlanWriter {
    /** Inserts pet_visit (+ position, snapshots, kennelResourceId = the pet's KENNEL segment resource), pet_visit_service and
     *  appointment_segment rows for a new appointment that already exists. */
    insert(tx: Prisma.TransactionClient, appointmentId: string, w: PlanWrite): Promise<void>
    /** Reschedule/move: deletes the appointment's segments, inserts the slot's segments for the existing visits (matched by
     *  position), refreshes pet_visit_service snapshots, priceCentsQuoted, kennelResourceId, appointment.dropOffAt and
     *  estimatedReadyAt. Returns before/after times for the audit. */
    replace(tx: Prisma.TransactionClient, appointmentId: string, w: Omit<PlanWrite, "petIds" | "pendingPets">):
      Promise<{ before: { startsAt: string; readyAt: string | null }; after: { startsAt: string; readyAt: string } }>
  }
  // hold-release.service.ts
  @Injectable() export class HoldReleaseService {
    /** HELD appointments with holdExpiresAt <= now (optionally one org): status CANCELLED, cancelledAt now,
     *  cancelReason "HOLD_EXPIRED", cancelledBy SYSTEM; their segments occupies=false; their visits CANCELLED.
     *  Picks rows with FOR UPDATE SKIP LOCKED, at most 500 per call. Returns the count. */
    releaseExpired(tx: Prisma.TransactionClient, now: Date, orgId?: string): Promise<number>
    /** Same changes for one HELD appointment, with the given reason and actor. False when it was not HELD. */
    release(tx: Prisma.TransactionClient, appointmentId: string, reason: "HOLD_EXPIRED" | "HOLD_RELEASED", by: "SYSTEM" | "CUSTOMER"): Promise<boolean>
  }
  ```
- Segment rows: `serviceId` = the single service id when the segment has exactly one service, else null. `staffUserId` = `employeeId`. Times from the engine ms. `pet_visit_service` rows come from `lookupPrice(prices, serviceId, sizeClass, coatType)` per service. `preferredGroomerId` is null for `"ANY"`.
- Loader busy rule: a segment is busy when `occupies` is true, its appointment is not `excludeAppointmentId`, and the appointment is not (`HELD` with `holdExpiresAt <= now`).

- [ ] **Step 1: Write the failing unit tests** in `slot-codec.test.ts`:
  - `slotFromView(toSlotView(slot)) deep-equals slot` for a two-pet drop-off slot with a kennel segment
  - `slotFromView maps a ref label to the engine petId "new-1"`
  - `verdictError: TOO_SOON → 409 SLOT_TAKEN; MALFORMED_PLAN → 400 VALIDATION_FAILED with detail "MALFORMED_PLAN"`
- [ ] **Step 2: Write the failing integration tests:**
  - `plan-writer.int.test.ts`: `insert` for a two-pet drop-off plan writes 2 visits with positions 0 and 1, the kennel resource on each visit, one KENNEL segment per pet with `staffUserId` null, and `pet_visit_service` prices from the matrix; `insert` with a pending pet stores `pending_pet` and `pet_id` null; `replace` leaves no old segment and returns the old and new `startsAt`.
  - `HoldReleaseService`: `releaseExpired` releases only expired `HELD` rows (a `BOOKED` row and an unexpired hold are untouched) and sets their segments' `occupies` to false; with `orgId` it skips other orgs.
  - `context-loader.int.test.ts`: an expired `HELD` appointment's segments are not busy; with `excludeAppointmentId` that appointment's segments are not busy.
  - `assertActiveCustomer`: soft-deleted → 401.
- [ ] **Step 3: Run them.** Run: `pnpm --filter @grooming/api test -- slot-codec && pnpm --filter @grooming/api test:int -- plan-writer context-loader`. Expected: FAIL.
- [ ] **Step 4: Implement.** Move code out of `AvailabilityService`; it calls `resolver.resolve(q.pets, principal?.sub ?? null)`. That also closes the 04a carry-over: a soft-deleted customer's token now gets 401 on `/availability`.
- [ ] **Step 5: Run the same commands plus `pnpm --filter @grooming/api test:int -- availability`.** Expected: PASS, and the 04a availability suite is unchanged except for one new test: `deleted customer token with petId → 401`.
- [ ] **Step 6: Run every check, then commit** `feat(api): booking core (pet resolver, slot codec, plan writer, hold release)`.

---

### Task 3: Holds and the sweeper

**Files:**
- Create: `apps/api/src/booking/holds.service.ts`, `apps/api/src/booking/holds.controller.ts`, `apps/api/src/booking/hold-sweeper.ts`
- Test: `apps/api/test/integration/booking/holds.int.test.ts`, `apps/api/test/integration/booking/hold-sweeper.int.test.ts`
- Docs: `docs/api/booking.md` (new), `docs/api/README.md`

**Interfaces:**
- Consumes: Task 2 everything; `LocationService.getDefault()` (`settings.holdMinutes`), `RateLimitService`.
- Produces:
  ```ts
  @Injectable() export class HoldsService {
    create(body: HoldRequest, principal: AccessClaims | undefined, ip: string): Promise<HoldResponse>
    view(holdId: string, principal: AccessClaims | undefined): Promise<HoldView>
    cancel(holdId: string, principal: AccessClaims | undefined): Promise<void>
    /** Shared with Task 4: loads a HELD appointment the principal may use. 404 when missing, not HELD, or owned by another customer. */
    loadUsable(tx: Prisma.TransactionClient, holdId: string, principal: AccessClaims | undefined): Promise<HeldAppointment>
  }
  @Injectable() export class HoldSweeper implements OnApplicationBootstrap, OnApplicationShutdown { /* setInterval(env.HOLD_SWEEPER_INTERVAL_MS).unref(); 0 = never starts */
    sweepOnce(now?: Date): Promise<number> }
  ```
- Routes (`@OptionalCustomerAuth()`): `POST /holds` → 201 `HoldResponse`; `GET /holds/:id` → `HoldView`; `DELETE /holds/:id` → 204.

Rules:
- Rate limit `holds:ip:<hashKeyPart(ip)>` 20 per 600 s on `POST`.
- `create`: `resolver.resolve(body.pets, principal?.sub ?? null)`. A new pet with `weightG` whose derived size class (`sizeClassFromWeight` with `settings.sizeThresholdsLb`) differs from `sizeClass` → 400 `VALIDATION_FAILED`, path `pets.<i>.sizeClass`. Booking mode from `resolveBookingMode`, then `slot.bookingMode` must match (else 400). Load the context for the slot's local day plus one day, with `excludeAppointmentId: replaceHoldId`. Run `validatePlan({ ...context, mode: "ONLINE", bookingMode, pets }, slot)`; a rejection goes through `verdictError`. Transaction: `releaseExpired(tx, now, orgId)` → if `replaceHoldId`, `loadUsable` then `release(..., "HOLD_RELEASED", "CUSTOMER")` → insert the appointment (`HELD`, source `ONLINE`, `customerId` = principal or null, `holdExpiresAt = now + holdMinutes`, `dropOffAt` = slot start in drop-off mode, `estimatedReadyAt` = `readyAt`) → `planWriter.insert`. No audit and no outbox for holds.
- `loadUsable`: a hold with `customerId` set is usable only by that customer's token; an anonymous hold by anyone holding the id.
- `view`: an expired hold → 409 `HOLD_EXPIRED`. `matches` are filled only for pending pets and only with a customer token: that customer's non-deleted pets with the same species and a name equal ignoring case and surrounding spaces.
- `cancel`: `release(..., "HOLD_RELEASED", "CUSTOMER")`; not `HELD` → 404.

- [ ] **Step 1: Write the failing integration tests** in `holds.int.test.ts` (setup as `availability.int.test.ts`: fetch a slot from `/v1/availability`, then hold it):
  - `anonymous hold with one new pet → 201; appointment HELD, customerId null, holdExpiresAt = now + 5 min (±5 s); visit pending_pet has the name; segments occupy`
  - `customer hold with a saved pet → appointment customerId set`
  - `the same slot held twice → second 409 SLOT_TAKEN`
  - `slot with a tampered segment price → 400 VALIDATION_FAILED detail MALFORMED_PLAN`
  - `slot with a malformed startsAt ("2026-13-01T…") → 400 VALIDATION_FAILED`
  - `slot whose start is now in the past (TOO_SOON) → 409 SLOT_TAKEN`
  - `new pet with weightG 9000 (S) and sizeClass "L" → 400 path pets.0.sizeClass`
  - `replaceHoldId: the old hold is CANCELLED with reason HOLD_RELEASED and the new hold may overlap its time`
  - `an expired overlapping hold does not block a new hold` (set `holdExpiresAt` in the past directly)
  - `two concurrent holds on the last free kennel (one kennel left, Promise.all) → one 201, one 409; one KENNEL segment` (Review Focus 1)
  - `GET /holds/:id with a customer token lists the matching "max" pet for a pending "Max "; anonymous gets matches []; another customer's hold → 404; expired → 409 HOLD_EXPIRED`
  - `DELETE /holds/:id → 204 and segments no longer occupy; again → 404`
  - `21st POST from one IP in 10 min → 429`
  - `staff token on POST /holds → 403`
- [ ] **Step 2: Write the failing test** `hold-sweeper.int.test.ts`: `sweepOnce releases two expired holds in two orgs and leaves a fresh hold`; `with HOLD_SWEEPER_INTERVAL_MS 0 no interval is registered` (spy on `setInterval`).
- [ ] **Step 3: Run them.** Run: `pnpm --filter @grooming/api test:int -- holds hold-sweeper`. Expected: FAIL.
- [ ] **Step 4: Implement** the service, the controller (body through `ZodValidationPipe(HoldRequestSchema)`) and the sweeper (errors logged, never thrown out of the interval).
- [ ] **Step 5: Run the same command.** Expected: PASS.
- [ ] **Step 6: Write `docs/api/booking.md`** (hold request with an example body, ownership, expiry, `replaceHoldId`, error table, sweeper), link it from `docs/api/README.md`, run every check, commit `feat(api): slot holds with new pets, hold sweeper`.

---

### Task 4: Confirm (`POST /appointments`)

**Files:**
- Create: `apps/api/src/booking/appointments.service.ts`, `apps/api/src/booking/appointments.controller.ts`, `apps/api/src/booking/appointment-view.ts` (pure mapper)
- Modify: `apps/api/src/pets/pets.service.ts` (extract `createInTx`), `apps/api/src/pets/pets.module.ts` (export `PetsService` if needed)
- Test: `apps/api/test/integration/booking/confirm.int.test.ts`
- Docs: `docs/api/booking.md`

**Interfaces:**
- Consumes: `HoldsService.loadUsable`, `HoldReleaseService.release`, `assertActiveCustomer`.
- Produces:
  ```ts
  // pets.service.ts — same rules as create (size derivation, MAX_PETS_PER_CUSTOMER, audit pet.create), inside the caller's tx.
  createInTx(tx: Prisma.TransactionClient, actor: PetActor, customerId: string, body: PetInput, ip: string | null): Promise<{ id: string }>
  // appointment-view.ts
  export function toAppointmentView(row: AppointmentWithVisits): AppointmentView
  export function toStaffAppointmentView(row: AppointmentWithVisits): StaffAppointmentView
  export const APPOINTMENT_VIEW_INCLUDE: Prisma.AppointmentInclude   // visits (position order) + pet name + services + segments (startsAt order)
  // appointments.service.ts
  confirm(p: AccessClaims, body: AppointmentCreate, ip: string | null): Promise<AppointmentView>
  ```
- Route: `POST /appointments`, `@CustomerAuth()`, 201.

Rules, in this order:
1. Check expiry in its own transaction: when the hold is `HELD` and `holdExpiresAt <= now`, `release(..., "HOLD_EXPIRED", "SYSTEM")`, commit, then throw 409 `HOLD_EXPIRED`.
2. Main transaction: `assertActiveCustomer(tx, orgId, p.sub, "share")` → `loadUsable` with `SELECT … FOR UPDATE` on the appointment (re-check `HELD` and not expired) → for each visit with `pet_id`: the pet is the customer's and not deleted, else 409 `PET_UNAVAILABLE` (the transaction rolls back and the hold stays `HELD`).
3. Pending pets: `usePets[ref]` must be one of that pet's `matches` (same rule as `HoldsService.view`), else 400 `VALIDATION_FAILED` path `usePets.<ref>`. Without a choice, call `createInTx` with `{ name, species, breed, breedCode, weightG, sizeClass, coatType }` (from the pending pet and the visit snapshot). Set `pet_id` and `pending_pet = null`.
4. Appointment: `customerId = p.sub`, `status BOOKED`, `holdExpiresAt null`, `notes`. Write audit `appointment.create` `{ source: "ONLINE", status: "BOOKED", petVisitIds }` and outbox `appointment.booked` `{ appointmentId }`.
5. The response is `toAppointmentView`.

- [ ] **Step 1: Write the failing integration tests** in `confirm.int.test.ts`:
  - `anonymous hold + customer token → 201 BOOKED; a new pet created for the customer with sizeClass from the snapshot; visit pet_id set, pending_pet null; outbox appointment.booked; audit appointment.create`
  - `usePets maps new-1 to the matching existing pet → no new pet; visit uses it`
  - `usePets pointing to a pet with a different name → 400 path usePets.new-1`
  - `hold owned by another customer → 404; already BOOKED → 404`
  - `expired hold → 409 HOLD_EXPIRED; appointment CANCELLED reason HOLD_EXPIRED; holding the same slot again → 201` (Review Focus 2)
  - `saved pet soft-deleted after the hold → 409 PET_UNAVAILABLE; appointment still HELD` (Review Focus 3); same for a pet merged into another (`deletedAt` set by merge)
  - `soft-deleted customer token → 401`
  - `customer already at MAX_PETS_PER_CUSTOMER → 400, appointment still HELD`
  - `two concurrent confirms of the same hold → one 201, one 404`
- [ ] **Step 2: Run them.** Run: `pnpm --filter @grooming/api test:int -- confirm`. Expected: FAIL.
- [ ] **Step 3: Implement** `createInTx` (`create` calls it), the view mapper, the service and the controller.
- [ ] **Step 4: Run them plus the pets suite.** Run: `pnpm --filter @grooming/api test:int -- confirm pets`. Expected: PASS.
- [ ] **Step 5: Update docs, run every check, commit** `feat(api): confirm a hold into a booking, create pending pets`.

---

### Task 5: Owner appointments — list, detail, cancel, reschedule

**Files:**
- Create: `apps/api/src/booking/me-appointments.controller.ts` (`@Controller("me/appointments")`)
- Modify: `apps/api/src/booking/appointments.service.ts`, `apps/api/src/availability/availability.service.ts` (`excludeAppointmentId`)
- Test: `apps/api/test/integration/booking/me-appointments.int.test.ts`, `availability.int.test.ts`
- Docs: `docs/api/booking.md`, `docs/api/availability.md`

**Interfaces:**
- Consumes: `PetRequestResolver.fromAppointment`, `PlanWriter.replace`, `slotFromView`, `verdictError`, `toAppointmentView`.
- Produces (service):
  ```ts
  listMine(p: AccessClaims, q: MeAppointmentsQuery): Promise<AppointmentView[]>
  getMine(p: AccessClaims, id: string): Promise<AppointmentView>
  cancelMine(p: AccessClaims, id: string, ip: string | null): Promise<AppointmentView>
  rescheduleMine(p: AccessClaims, id: string, body: Reschedule, ip: string | null): Promise<AppointmentView>
  /** Shared with Task 7: cancels in tx (status, cancelledAt, cancelReason, cancelledBy, occupies=false, visits CANCELLED,
   *  manageVersion+1, outbox appointment.cancelled, audit appointment.cancel). */
  cancelInTx(tx, appt, by: { actorType: "CUSTOMER" | "STAFF"; actorId: string; reason: string | null; ip: string | null }): Promise<void>
  /** Shared with Task 7: validate outside tx, then in tx lock FOR UPDATE, re-check status BOOKED, releaseExpired, PlanWriter.replace,
   *  manageVersion+1, outbox appointment.changed, audit (action given). */
  replaceSlot(id: string, view: SlotView, opts: { mode: "ONLINE" | "STAFF"; override: boolean; action: "appointment.reschedule" | "appointment.move";
    actorType: "CUSTOMER" | "STAFF"; actorId: string; ip: string | null }): Promise<AppointmentView>
  ```
- Routes (`@CustomerAuth()`): `GET /me/appointments?scope=upcoming|past`, `GET /me/appointments/:id`, `POST /me/appointments/:id/cancel`, `POST /me/appointments/:id/reschedule`.

Rules:
- `upcoming` = status `BOOKED` or `IN_SHOP` and `startsAt >= now - 12 h`, ascending. `past` = everything else except `HELD`, descending, at most 50. Another customer's appointment → 404.
- Cancel window: allowed only while `now <= startsAt - cancelWindowHours`; otherwise 409 `OUTSIDE_CANCEL_WINDOW`. Only `BOOKED` (anything else → 409 `CONFLICT`). The reschedule rule is the same.
- Reschedule: pets come from `fromAppointment(id)`, mode `ONLINE`, the context is loaded with `excludeAppointmentId: id`, then `validatePlan`, then `replaceSlot` with `appointment.reschedule`.
- `/availability` with `excludeAppointmentId` and a customer token: the appointment must be that customer's and `BOOKED` (else 404); pets come from `fromAppointment`; anonymous → 401.

- [ ] **Step 1: Write the failing integration tests:**
  - `list upcoming shows a BOOKED appointment with pets, services and segments; past shows a CANCELLED one; HELD never listed`
  - `cancel 3 days ahead (window 24 h) → 200 CANCELLED; segments occupies false; visits CANCELLED; manageVersion +1; outbox appointment.cancelled`
  - `cancel 2 h ahead → 409 OUTSIDE_CANCEL_WINDOW`; `cancel twice → 409 CONFLICT`; `another customer's → 404`
  - `availability?excludeAppointmentId lists a slot overlapping the appointment's own time; reschedule to it → 200, new segment times, old segments gone, outbox appointment.changed, audit before/after startsAt` (Review Focus 4)
  - `reschedule onto a time held meanwhile by another customer → 409 SLOT_TAKEN and the original segments still exist unchanged` (Review Focus 4)
  - `availability with excludeAppointmentId and pets → 400; anonymous → 401; another customer's appointment → 404`
- [ ] **Step 2: Run them.** Run: `pnpm --filter @grooming/api test:int -- me-appointments availability`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run the same command.** Expected: PASS.
- [ ] **Step 5: Update docs, run every check, commit** `feat(api): owner appointments list, cancel and reschedule`.

---

### Task 6: Staff-mode `/availability`

**Files:**
- Modify: `apps/api/src/auth/decorators.ts`, `apps/api/src/auth/access.guard.ts`
- Modify: `apps/api/src/availability/availability.controller.ts`, `apps/api/src/availability/availability.service.ts`
- Test: `apps/api/test/integration/auth/guard.int.test.ts`, `apps/api/test/integration/availability/availability-staff.int.test.ts`
- Docs: `docs/api/availability.md`

**Interfaces:**
- Produces (auth): policy `{ kind: "optional-customer-or-staff"; staffRoles: readonly StaffRole[] }` and the decorator `OptionalCustomerOrStaffAuth(...staffRoles: StaffRole[])`. With no header the request passes anonymously. With a customer token it behaves like `optional-customer`. With a staff token the role must be in `staffRoles` (else 403).
- Produces (service): `find(q, principal, ip)` keeps its signature and picks the mode from the principal.

Rules:
- `/availability` uses `@OptionalCustomerOrStaffAuth("OWNER", "RECEPTION")`. An EMPLOYEE token → 403.
- Staff principal → `mode: "STAFF"`, `override: q.override ?? false`, and the request skips the per-IP rate limit. A customer or anonymous request with `override` → 403 `FORBIDDEN`.
- Staff `petId` entries need `customerId`, otherwise 400 `VALIDATION_FAILED` on path `customerId`. Every pet must belong to that customer and not be deleted, else 404. A deleted or unknown customer → 404. `resolver.resolve(entries, q.customerId ?? null)` (for staff, `assertActiveCustomer` failing becomes 404, not 401).
- Staff `excludeAppointmentId` may be any `BOOKED` appointment of the org.

- [ ] **Step 1: Write the failing tests:**
  - `guard.int.test.ts`: a test route with `@OptionalCustomerOrStaffAuth("OWNER")`: RECEPTION token → 403, OWNER → principal, customer → principal, none → null.
  - `availability-staff.int.test.ts`: `RECEPTION, today, time already past the lead time → slots start from now rounded down to the grid (STAFF ignores minLeadMinutes)`; `a date beyond bookingHorizonDays → slots`; `a service with onlineBookable false → slots`; `override=true → slots outside working hours`; `override with a customer token → 403`; `EMPLOYEE → 403`; `petId without customerId → 400 path customerId`; `petId of another customer → 404`.
- [ ] **Step 2: Run them.** Run: `pnpm --filter @grooming/api test:int -- guard availability-staff`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run them plus the whole availability suite.** Run: `pnpm --filter @grooming/api test:int -- guard availability`. Expected: PASS.
- [ ] **Step 5: Update docs, run every check, commit** `feat(api): staff-mode availability with override`.

---

### Task 7: Staff booking, move, status, walk-in

**Files:**
- Create: `apps/api/src/booking/staff-appointments.service.ts`, `apps/api/src/booking/staff-appointments.controller.ts`
- Test: `apps/api/test/integration/booking/staff-appointments.int.test.ts`
- Docs: `docs/api/booking.md`

**Interfaces:**
- Consumes: `PetRequestResolver.resolve`, `PlanWriter.insert`, `PetsService.createInTx`, `AppointmentsService.cancelInTx`, `AppointmentsService.replaceSlot`, `toStaffAppointmentView`, `findSlots`, `validatePlan`.
- Produces (routes):

| Method | Path | Roles | Body → result |
|---|---|---|---|
| POST | `/staff/appointments` | OWNER, RECEPTION | `StaffBooking` → 201 `StaffAppointmentView` |
| GET | `/staff/appointments/:id` | OWNER, RECEPTION; EMPLOYEE only with a segment of theirs in it (else 404) | `StaffAppointmentView` |
| PATCH | `/staff/appointments/:id` | OWNER, RECEPTION | `StaffMove` → `StaffAppointmentView` |
| POST | `/staff/appointments/:id/status` | OWNER, RECEPTION | `StaffStatus` → `StaffAppointmentView` |
| POST | `/staff/walk-in` | OWNER, RECEPTION | `WalkIn` → 201 `StaffAppointmentView` |

Rules:
- Booking: the customer exists and is not deleted (404). `resolve(body.pets, body.customerId)`, then the new-pet weight/size check from Task 3, then `validatePlan` in `STAFF` mode with `override`. Transaction: `assertActiveCustomer(tx, …, "share")` → `releaseExpired` → create pending pets right away with `createInTx` (staff actor) → appointment `BOOKED`, source `RECEPTION`, `createdByStaffId` → `planWriter.insert` with the real pet ids → audit `appointment.create` `{ source, override }` → outbox `appointment.booked`.
- Move: `replaceSlot(id, slot, { mode: "STAFF", override, action: "appointment.move", actorType: "STAFF" })`. No cancel window for staff.
- Status `CANCEL`: from `BOOKED` → `cancelInTx` with `reason`. Status `NO_SHOW`: from `BOOKED` and `now >= startsAt` → status and visits `NO_SHOW`, `occupies=false`, audit `appointment.no_show`, no outbox. Any other state → 409 `CONFLICT`; a no-show before the start → 409 `CONFLICT`.
- Walk-in: today's local date, `findSlots` in `STAFF` mode with `override`. Take the first slot. When there is none, or its `start > now + slotIntervalMin`, → 409 `SLOT_TAKEN` with `detail: "NO_SLOT_NOW"`. Otherwise write it like a staff booking with source `WALK_IN`. A `23P01` during the write → 409 as usual.

- [ ] **Step 1: Write the failing integration tests:**
  - `RECEPTION books a saved pet + a new pet for a customer → 201 BOOKED source RECEPTION; the new pet exists; createdByStaffId set; outbox appointment.booked`
  - `override=true outside working hours → 201 and audit after.override true; the same slot without override → 409 SLOT_TAKEN (EMPLOYEE_UNAVAILABLE)`
  - `deleted customer → 404; EMPLOYEE → 403`
  - `move to a free time → 200, audit appointment.move; move onto a busy time → 409, segments unchanged`
  - `status CANCEL → CANCELLED with cancelReason; NO_SHOW before start → 409; NO_SHOW after start (seed past segments directly) → NO_SHOW, occupies false`
  - `walk-in with a free groomer now → 201 WALK_IN starting within one slot interval; with every groomer busy for the next hour → 409 detail NO_SLOT_NOW`
  - `GET as EMPLOYEE with a segment → 200; without → 404`
- [ ] **Step 2: Run them.** Run: `pnpm --filter @grooming/api test:int -- staff-appointments`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run the same command.** Expected: PASS.
- [ ] **Step 5: Update docs, run every check, commit** `feat(api): staff booking, move, cancel/no-show and walk-in`.

---

### Task 8: Export and `DELETE /me`

**Files:**
- Create: `apps/api/src/customers/account.service.ts`
- Modify: `apps/api/src/customers/me.controller.ts` (`GET /me/export`, `DELETE /me`), `apps/api/src/customers/customers.module.ts`
- Modify: `apps/api/src/auth/google/identity-link.service.ts` (`linkInTx` locks the customer with `assertActiveCustomer(tx, …, "share")` first; deleted → `TAKEN`), `apps/api/src/pets/pets.service.ts` (`createInTx` takes the same share lock)
- Create: `packages/contracts/src/account.ts` (`MeExportSchema`)
- Test: `apps/api/test/integration/customers/account.int.test.ts`
- Docs: `docs/api/customers.md`

**Interfaces:**
- Produces:
  ```ts
  export const MeExportSchema = z.object({ exportedAt, customer: CustomerViewSchema,
    identities: z.array(IdentityViewSchema.extend({ linkedAt: IsoInstantSchema })),
    consents: z.array(z.object({ channel, granted: z.boolean(), source: z.string(), changedAt })),
    pets: z.array(PetViewSchema.extend({ vaccines: z.array(VaccineViewSchema) })),
    appointments: z.array(AppointmentViewSchema),
    media: z.array(z.object({ id: IdSchema, kind: z.string(), petId: IdSchema, createdAt })) });  // download links arrive in Plan 05
  @Injectable() export class AccountService {
    export(p: AccessClaims): Promise<MeExport>
    delete(p: AccessClaims, ip: string | null): Promise<void>
  }
  ```
- Routes (`@CustomerAuth()`): `GET /me/export` (rate limit `me:export:<customerId>` 5 per 3600 s), `DELETE /me` → 204.

`DELETE /me`, all in one transaction:
1. `assertActiveCustomer(tx, orgId, sub, "update")`.
2. Future `HELD`/`BOOKED` appointments → `cancelInTx` with `reason "ACCOUNT_DELETED"`, actor CUSTOMER.
3. Pets: media rows of kind `PET_PHOTO`/`VACCINE_CARD` for these pets. When there are any, write one outbox `media.purge` `{ objectKeys }`, then null `pet.photoMediaId`, delete the vaccines, and delete those media rows. Every pet: `deletedAt = now`, `name = "Deleted pet"`, `breed = "-"`, `breedCode`, `birthDate`, `medicalNotesEnc`, `behaviorNotes`, `vetName`, `vetPhoneE164` null, `allergies = []`, `temperament = []`.
4. `customerIdentity.deleteMany({ customerId })`. `outboxEvent.deleteMany` for unprocessed rows whose `payload->>'customerId'` is this customer.
5. Customer: `name`, `email`, `emergencyPhoneE164`, `privateNotesEnc` null, `phoneE164 = "deleted:" + id`, `deletedAt = now`. Consents stay (evidence).
6. Revoke refresh tokens: `refreshToken.updateMany({ subjectType: "CUSTOMER", subjectId, revokedAt: null }, { revokedAt: now })`.
7. Audit scrub: `UPDATE audit_log SET before = before - '{name,phone,email,emergencyPhone}'::text[], after = after - '{…}'::text[] WHERE organization_id = $1 AND entity = 'customer' AND entity_id = $2`. Use the exact keys `auditShape` in `customers.service.ts` writes. Then write audit `customer.delete` `{ petsDeleted, appointmentsCancelled }`.

Visit rows stay for the shop, detached through the anonymized pet.

- [ ] **Step 1: Write the failing integration tests** in `account.int.test.ts`:
  - `export lists the customer, a linked identity with linkedAt, consents, pets with vaccines, appointments and media rows; 6th export in an hour → 429`
  - `DELETE /me → 204; customer anonymized and deletedAt set; the same token → 401 on GET /me; refresh token revoked`
  - `pets soft-deleted and anonymized; vaccines and PET_PHOTO media rows gone; one media.purge outbox row with their keys; a BEFORE media row of a past visit stays`
  - `a future BOOKED appointment → CANCELLED reason ACCOUNT_DELETED, occupies false; a COMPLETED one unchanged`
  - `identity rows deleted; an unprocessed customer.identity_linked outbox row deleted; a processed one kept`
  - `audit rows for customer.update of this customer no longer contain name, phone or email`
  - `DELETE /me racing POST /appointments (Promise.all) → afterwards no BOOKED appointment and no new pet belongs to the deleted customer`; `racing POST /me/identities/google → no identity row remains` (Review Focus 5)
- [ ] **Step 2: Run them.** Run: `pnpm --filter @grooming/api test:int -- account`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run them plus the Google profile and confirm suites.** Run: `pnpm --filter @grooming/api test:int -- account google-profile confirm`. Expected: PASS.
- [ ] **Step 5: Update docs, run every check, commit** `feat(api): owner data export and account deletion with pets and identities`.

---

### Task 9: 04a test debt and the availability timing log

**Files:**
- Create: `apps/api/test/support/fixture-settings.ts` (move `FIXTURE_SETTINGS` here; `helpers.ts` re-exports it)
- Modify: `apps/api/src/availability/availability.service.ts` (timing log)
- Test: `apps/api/test/integration/auth/google-link-verify.int.test.ts`, `google-profile.int.test.ts`, `availability.int.test.ts`, `context-loader.int.test.ts`
- Docs: `docs/api/availability.md` (one line on the log)

Rules:
- Timing: `const t0 = performance.now()` before the date loop. After it, `logger.log` at debug level `{ dates, pets, ms }`, and `logger.warn` when `ms > 1000`. Use the Nest `Logger` with context `AvailabilityService`.

- [ ] **Step 1: Add these tests** (they should pass against the current code; a failure is a bug to report, not to fix here):
  - `linkInTx returns TAKEN when createMany inserts 0 rows` (insert the identity for another customer between ticket and verify)
  - `verify with a ticket for a new phone → isNew true and identityLinked true`
  - `deleted customer + valid ticket → 401, ticket consumed, no identity row`
  - `Profile link outbox payload equals {customerId, googleEmail, notifyEmail}`
  - `busy segment with endsAt < from < blockEndsAt is busy` (loader)
  - `/availability with a service pair on one stage with different resource types → 400 STAGE_RESOURCE_MISMATCH`
  - `/availability own pet with coatType null and no coatType → 400 path pets.0.coatType`
- [ ] **Step 2: Move `FIXTURE_SETTINGS`** and point the imports at the new file.
- [ ] **Step 3: Add the timing log.**
- [ ] **Step 4: Run every check.** Expected: exit 0. If a new test fails, stop and report it as BLOCKED with the output.
- [ ] **Step 5: Commit** `test(api): 04a test debt, availability timing log`.

---

## After the last task

- Update `docs/handoff.md` (done, next = Plan 05, the new carry-overs below) and the plans README row (04b → done on branch).
- Carry-over into the handoff:
  - **Plan 05:** the `media.purge` outbox worker; per-segment drag on the board; check-in re-planning when the size class changes; EMPLOYEE pet scope with per-pet cancel.
  - **Plan 06:** consume `appointment.booked/changed/cancelled`; link-notice `notify` inside the verify transaction; consent capture at booking.
  - **Plan 09:** revisit `/availability` limits with the timing logs.
  - **Known limit:** kennels never pass local midnight.
- Unchanged carry-overs (org provisioning settings, role-change guard, deactivation warning, vaccine re-stamp, settings cache TTL, availability hardening) stay in the handoff.
