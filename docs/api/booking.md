# Booking

The write path for holds, confirmations, reschedules and staff bookings (Plan 04b). Holds, confirm and owner
appointments, staff bookings and walk-ins are served. Routes live in `BookingApiModule`; the shared core in `BookingModule`
(`apps/api/src/booking/`) is used by every booking write and `/availability`, so the plan a client gets is the plan
the server re-checks.

## Holds

`@OptionalCustomerAuth()`: anonymous visitors and customer tokens; a staff token is 403, a bad token 401, and a
token whose customer is soft-deleted 401.

| Route | Result |
| --- | --- |
| `POST /holds` | 201 `{ holdId, expiresAt }` |
| `GET /holds/:id` | 200 `HoldView` (`holdId`, `expiresAt`, `bookingMode`, `startsAt`, `readyAt`, `pets[]` with `visitId`, `petId` or `ref`, `name`, `priceCents`, `matches`) |
| `DELETE /holds/:id` | 204; the hold is `CANCELLED` (`HOLD_RELEASED`, by `CUSTOMER`) and its segments stop occupying |

The request carries the pets and the slot exactly as `/availability` returned it (`slot.pets` in the same order as
`pets`, matched by `petId` or `ref`). A new pet adds the details needed to save it on confirm:

```json
{
  "pets": [{ "ref": "new-1", "species": "DOG", "sizeClass": "M", "coatType": "CURLY",
             "serviceIds": ["<bath id>"], "name": "Max", "breed": "Poodle", "weightG": 19000 }],
  "slot": { "startsAt": "…", "readyAt": "…", "bookingMode": "DROP_OFF", "pets": [{ "ref": "new-1", "…": "…" }] },
  "replaceHoldId": "<optional: a hold of mine to release>"
}
```

Create steps: rate limit `holds:ip:<hash>` 20 per 600 s → pets resolved as in `/availability` (a soft-deleted
customer is 401 here, before any 400) → a new pet with `weightG` must have the size class its weight gives
(`settings.sizeThresholdsLb`) → the context for the slot's local
day plus one (excluding `replaceHoldId`) → the booking mode must match the services → `validatePlan` (online mode).
Then one transaction: with a customer token, lock the customer `FOR UPDATE` (401 if deleted meanwhile;
customer first, the branch lock order) → lock `replaceHoldId` `FOR UPDATE` → release expired holds of the organization → release `replaceHoldId` (rules below) → insert the
appointment (`HELD`, source `ONLINE`, `customer_id` = token or null, `hold_expires_at` = now + `holdMinutes`,
`drop_off_at` = slot start in drop-off mode, `estimated_ready_at` = slot `readyAt`) → `PlanWriter.insert`. A new pet
is stored in `pet_visit.pending_pet` (`ref`, `species`, `name`, `breed`, `breedCode`, `weightG`). When a hold is
released (expired or replaced/deleted), `pending_pet` is cut to `{ ref, species }`: only `HELD` holds are ever read
back. No audit and no outbox rows for holds.

- **Ownership:** a hold with a customer is usable only with that customer's token; an anonymous hold by anyone who
  has its id. Anything else, another organization's hold, or a hold that is not `HELD` is 404.
- **Expiry:** `GET` of an expired hold is 409 `HOLD_EXPIRED`. An expired hold never blocks a new one: the loader
  ignores it and the create transaction releases it first (`HOLD_EXPIRED`, by `SYSTEM`).
- **`replaceHoldId`:** picking another time keeps one hold per visitor. The old hold's own segments do not block the
  new slot (it is looked up before the context loads, and only the visitor's own `HELD` hold is left out of the busy
  segments); it is released (`HOLD_RELEASED`, by `CUSTOMER`) in the same transaction. An id that does not exist in
  this organization, or belongs to another customer, is 404. The visitor's own `CANCELLED` appointment (expired and
  released, or already released) is ignored and the new hold is created: the client cannot know it expired. Any other
  status (`BOOKED`, `IN_SHOP`, `COMPLETED`, `NO_SHOW`) is 404: a live booking is never replaced.
- **Matches:** with a customer token, each pending pet lists that customer's saved pets that may be the same animal:
  not deleted, same species, name equal ignoring case and surrounding spaces (`pet-matches.ts`, reused by confirm).
  Anonymous: `matches` is `[]`.

| Error | When |
| --- | --- |
| 400 `VALIDATION_FAILED` | Body shape (strict); size class not matching `weightG` (`pets.<i>.sizeClass`); booking mode mismatch (`slot.bookingMode`); a slot more than 400 days from now (`slot.startsAt`); a plan rejection other than the three below (`detail` = reason, e.g. `MALFORMED_PLAN`) |
| 400 `NO_PRICE_FOR_PET` and other engine codes | As in [Availability](availability.md#errors) |
| 401 `UNAUTHORIZED` | `petId` without a token; soft-deleted customer |
| 403 | Staff token |
| 404 `NOT_FOUND` | Unknown, foreign, not `HELD` or not usable hold (`replaceHoldId`: unknown, another customer's, or not `HELD`/`CANCELLED`); another customer's or a deleted saved pet |
| 409 `SLOT_TAKEN` | `EMPLOYEE_UNAVAILABLE`, `RESOURCE_UNAVAILABLE`, `TOO_SOON`, or a lost race (`23P01`) |
| 409 `HOLD_EXPIRED` | `GET` of an expired hold |
| 429 `RATE_LIMITED` | 21st `POST` from one IP in 10 min |

### Hold sweeper

`HoldSweeper` runs `HoldReleaseService.releaseExpired` for every organization every `HOLD_SWEEPER_INTERVAL_MS`
(default 60000; `0` = off, as in tests, which call `sweepOnce`). One transaction per tick, at most 500 holds; ticks do
not overlap, errors are logged with their stack and never thrown, and the timer is unref'd and cleared on shutdown.

## Confirm

`POST /appointments` with `@CustomerAuth()` (no token 401, staff token 403, soft-deleted customer 401) turns a hold
into a booking of the signed-in customer and answers 201 `AppointmentView`.

```json
{ "holdId": "<hold id>", "notes": "optional, up to 500 chars", "usePets": { "new-1": "<saved pet id>" } }
```

Steps, in this order:

1. **Expiry**, in its own transaction: when the hold is usable (ownership rule above, else 404) and
   `hold_expires_at <= now`, it is released (`HOLD_EXPIRED`, by `SYSTEM`) and committed, then 409 `HOLD_EXPIRED`.
   The slot is free again at once.
2. **Main transaction:** lock the customer `FOR UPDATE` (401 if deleted) → lock the hold `FOR UPDATE` and re-check
   it (`HELD`, usable, not expired: a hold that expired since step 1 is 409 `HOLD_EXPIRED`, not 404) → lock the pets
   (below) → release expired holds. A concurrent confirm of the same hold waits here and then gets 404. Every saved pet of the hold must still be the customer's and not deleted, else 409
   `PET_UNAVAILABLE` and the hold stays `HELD`. The saved pets and the `usePets` choices are locked `FOR SHARE` in one
   id-ordered statement (the order `PetMergeService` uses), so a concurrent merge cannot deadlock with a confirm. The customer lock is `FOR UPDATE`, not `FOR SHARE`, because
   saving a pet locks the customer `FOR UPDATE` and two confirms upgrading a shared lock would deadlock.
3. **Pending pets:** `usePets[ref]` must be one of that pet's matches (the same rule as `GET /holds/:id`) and not a
   pet already in the booking, and every key must be a `ref` of the hold; else 400 `VALIDATION_FAILED` with path
   `usePets.<ref>`. A pending pet without a choice is saved with `PetsService.createInTx` (name, species, breed,
   breed code, weight, and the visit's size and coat snapshots; the pet cap applies: 409 `CONFLICT` and the hold
   stays `HELD`). The visit gets `pet_id` and `pending_pet = null`.
4. **Booking:** `customer_id` = token, `status` `BOOKED`, `hold_expires_at` null, `notes`. Audit
   `appointment.create` (`after`: `{ source: "ONLINE", status: "BOOKED", petVisitIds }`), plus `pet.create` for each
   saved pet; outbox `appointment.booked` `{ appointmentId }`.

`AppointmentView` (`appointment-view.ts`): `id`, `status`, `source`, `bookingMode`, `startsAt` (`dropOffAt` in
drop-off mode, else the earliest work segment start), `dropOffAt`, `estimatedReadyAt`, `notes`, `cancelledAt`, and
`pets[]` in position order with `visitId`, `petId`, `petName`, `status`, `priceCentsQuoted`, `services[]`
(`serviceId`, `priceCents`, `durationMin`) and `segments[]` in start order (`id`, `stage`, `employeeId`,
`resourceId`, `startsAt`, `endsAt`). The staff view adds `customerId`, `createdByStaffId` and `cancelReason`.

| Error | When |
| --- | --- |
| 400 `VALIDATION_FAILED` | Body shape (strict; `usePets` keys `new-1`..`new-4`); a `usePets` entry that is not a match, is already in the booking, or names no new pet of the hold (`usePets.<ref>`) |
| 401 `UNAUTHORIZED` | No token; soft-deleted customer |
| 403 | Staff token |
| 404 `NOT_FOUND` | Unknown, foreign, not `HELD` (already booked) or another customer's hold |
| 409 `HOLD_EXPIRED` | The hold expired (it is released) |
| 409 `PET_UNAVAILABLE` | A saved pet of the hold was deleted or moved to another customer |
| 409 `CONFLICT` | Saving a new pet would pass the 20-pet cap |

A staff merge moves the hold's visit to the target pet, so a hold whose pet was merged is confirmed with the target.

## Owner appointments

`@CustomerAuth()` on `/me/appointments` (no token 401, staff token 403, soft-deleted customer 401 on every route).
Only the customer's own bookings in this organization are visible: another customer's, another organization's, a
live hold or a released hold is 404 `NOT_FOUND`. Bookings are told apart from holds by `hold_expires_at`: confirm
clears it, staff bookings never set it, and every hold (live or released) has one.

| Route | Result |
| --- | --- |
| `GET /me/appointments?scope=upcoming` (default) | 200 `AppointmentView[]`: `BOOKED` or `IN_SHOP` with `startsAt >= now - 12 h`, ascending |
| `GET /me/appointments?scope=past` | 200 `AppointmentView[]`: every other booking, descending by `startsAt`, at most 50 |
| `GET /me/appointments/:id` | 200 `AppointmentView` |
| `POST /me/appointments/:id/cancel` | 200 `AppointmentView` (status `CANCELLED`) |
| `POST /me/appointments/:id/reschedule` | 200 `AppointmentView` with the new times; body `{ "slot": <slot from /availability> }` (strict) |

`startsAt` everywhere (list order, the 12 h rule, the cancel window, the audit) is the one the view shows
(`appointmentStartsAt` in `appointment-view.ts`). Only occupying segments count when there are any, so the old rows
a `CANCELLED` visit keeps after a reschedule never set the start; a fully cancelled appointment uses all its segments.

**Change rule (cancel and reschedule):** only `BOOKED` (else 409 `CONFLICT`), and only while
`now <= startsAt - settings.cancelWindowHours` (else 409 `OUTSIDE_CANCEL_WINDOW`).

**Cancel:** one transaction: lock the appointment `FOR UPDATE` → release expired holds → load it (404) → change rule
→ `cancelInTx`. `cancelInTx(tx, appt, by)` (shared with staff cancel and account deletion; the caller loads the row
org-scoped and locks it): conditional update from `BOOKED` (409 `CONFLICT` otherwise) to `CANCELLED` with
`cancelled_at`, `cancel_reason` (`by.reason`; null for the owner), `cancelled_by` (`CUSTOMER` or `STAFF`),
`manage_version + 1`; every segment `occupies = false`; every visit `CANCELLED`; outbox `appointment.cancelled`
`{ appointmentId }`; audit `appointment.cancel` (`before { status }`, `after { status, cancelledBy }`; the free-text
reason stays in `cancel_reason`, never in the audit). The slot is free
at once.

**Reschedule:** the owner first asks `GET /availability?from=…&excludeAppointmentId=<id>` (see
[Availability](availability.md#reschedule-slots)) and sends one of those slots back. Ownership and the change rule are
checked, then `replaceSlot(id, slot, { mode: "ONLINE", override: false, action: "appointment.reschedule", … })`.
Pets and services cannot change; to change them the owner cancels and books again.

`replaceSlot` (shared with the staff move): status first (not in the organization 404, not `BOOKED` 409 `CONFLICT`,
before any slot check); then validated outside the transaction: pets rebuilt with
`fromAppointment` (404; 409 `CONFLICT` for a pet not saved yet) → the slot must list those pets in the same order
(400 `slot.pets`; an unknown pet is 400 `slot.pets.<i>`) → a slot more than 400 days away is 400 `slot.startsAt` → the
context for the slot's local day plus one, without the appointment's own segments → the booking mode must match
(400 `slot.bookingMode`) → `validatePlan` (`verdictError`). Then one transaction: lock the appointment `FOR UPDATE`
→ release expired holds → re-check `BOOKED` (409 `CONFLICT`) → `PlanWriter.replace` (old segments deleted, new ones
inserted) → `booking_mode` from the slot, `manage_version + 1` → outbox `appointment.changed` `{ appointmentId }` →
audit `appointment.reschedule` or `appointment.move` with `before { startsAt, readyAt }` and
`after { startsAt, readyAt, override }`. A time someone else took meanwhile is 409 `SLOT_TAKEN`, either from
`validatePlan` or from the exclusion constraint (`23P01`); in both cases the transaction rolls back and the old
segments stay as they were.

| Error | When |
| --- | --- |
| 400 `VALIDATION_FAILED` | Bad `scope`, bad id, body shape; slot pets not the appointment's (`slot.pets`); booking mode mismatch; slot out of range; a plan rejection other than the three `SLOT_TAKEN` ones |
| 401 `UNAUTHORIZED` | No token; soft-deleted customer |
| 403 | Staff token |
| 404 `NOT_FOUND` | Unknown, another customer's or another organization's appointment; a hold |
| 409 `CONFLICT` | Not `BOOKED` (already cancelled, in the shop, completed, no-show) |
| 409 `OUTSIDE_CANCEL_WINDOW` | Less than `cancelWindowHours` before `startsAt` |
| 409 `SLOT_TAKEN` | Reschedule onto a time that is no longer free |

## Staff appointments

`@StaffAuth`: OWNER and RECEPTION for every write; `GET` also lets an EMPLOYEE in, but only for an appointment with a
segment assigned to them (else 404). Holds (live or released) are never visible: like the owner routes, a row with
`hold_expires_at` set or status `HELD` is 404. Staff and walk-in bookings never set `hold_expires_at`.

| Route | Body (strict) | Result |
| --- | --- | --- |
| `POST /staff/appointments` | `{ customerId, pets, slot, override?, notes? }` (`pets` as in holds; `slot` from staff `/availability` with the same `override`) | 201 `StaffAppointmentView` |
| `GET /staff/appointments/:id` | | 200 `StaffAppointmentView` |
| `PATCH /staff/appointments/:id` | `{ slot, override? }` (`slot` from staff `/availability?excludeAppointmentId=<id>`) | 200 `StaffAppointmentView` |
| `POST /staff/appointments/:id/status` | `{ action: "CANCEL" \| "NO_SHOW", reason? }` | 200 `StaffAppointmentView` |
| `POST /staff/walk-in` | `{ customerId, pets, override? }` | 201 `StaffAppointmentView` |

`StaffAppointmentView` is the owner view plus `customerId`, `createdByStaffId` and `cancelReason`.

**Book:** validated outside the transaction: the customer must exist in the organization and not be deleted (404)
→ `resolve(pets, customerId)` → the new-pet weight/size check (`assertNewPetSizes`, 400 `pets.<i>.sizeClass`) → slot
(400 out of range or bad booking mode) → `validatePlan` in `STAFF` mode with `override` (`verdictError`). Staff mode
skips the lead time, horizon and online-bookable checks; `override` also ignores working hours, location hours and
drop-off windows. Then one transaction: customer `FOR UPDATE` (deleted meanwhile 404) → saved pets `FOR SHARE`
(deleted or merged meanwhile 409 `PET_UNAVAILABLE`) → release expired holds → new pets created with `createInTx` (staff
actor, `pet.create` audit) → appointment `BOOKED`, source `RECEPTION`, `created_by_staff_id` = caller →
`PlanWriter.insert` with the saved pet ids → audit `appointment.create` (`after { source, status, override,
customerId, petIds, startsAt, readyAt }`; never notes, names or phones) → outbox `appointment.booked`. A `23P01` rolls
everything back, new pets included, and is 409 `SLOT_TAKEN`.

**Walk-in:** the same checks and write, source `WALK_IN`, on the first `findSlots` slot of today (local date) in
`STAFF` mode with `override`. The engine's earliest staff start is now rounded down to the slot grid; the slot is
taken only when `start <= now + slotIntervalMin`. No slot, or a later one, is 409 `SLOT_TAKEN` with
`detail: "NO_SLOT_NOW"`.

**Move:** an appointment whose customer is soft-deleted is 404; otherwise `replaceSlot(id, slot, { mode: "STAFF",
override, action: "appointment.move", actorType: "STAFF" })` (see above). No cancel window for staff.

**Status:** one transaction: lock the appointment `FOR UPDATE` → release expired holds → load it (404) → must be
`BOOKED` (else 409 `CONFLICT`). `CANCEL` → `cancelInTx` with `reason` in `cancel_reason`, `cancelled_by` `STAFF`.
`NO_SHOW` needs `now >= startsAt` (`appointmentStartsAt`; earlier is 409 `CONFLICT`): status `NO_SHOW`,
`manage_version + 1`, every segment `occupies = false`, every visit not already `CANCELLED` becomes `NO_SHOW`, audit
`appointment.no_show` (`before { status }`, `after { status, startsAt }`), no outbox.

| Error | When |
| --- | --- |
| 400 `VALIDATION_FAILED` | Body shape; slot pets not matching `pets`; new pet size vs weight; booking mode; slot out of range; a plan rejection other than the `SLOT_TAKEN` ones |
| 403 | Customer token; EMPLOYEE on a write |
| 404 `NOT_FOUND` | Unknown or deleted customer; unknown appointment, a hold, another organization's; EMPLOYEE without a segment in it (GET); move of a deleted customer's appointment |
| 409 `CONFLICT` | Status change or move of an appointment that is not `BOOKED`; `NO_SHOW` before the start |
| 409 `PET_UNAVAILABLE` | A saved pet was deleted or merged between the check and the write |
| 409 `SLOT_TAKEN` | The time is no longer free (`validatePlan` or `23P01`); walk-in with nothing starting now (`detail: "NO_SLOT_NOW"`) |

## Write order

Validate outside the transaction (load the context, `validatePlan`; a rejection goes through `verdictError`) →
`prisma.$transaction` → row locks (customer → pets → appointment; confirm: customer → hold → pets, serialized by the customer lock) → `HoldReleaseService.releaseExpired(tx, now,
orgId)` → writes. `releaseExpired` locks rows the caller does not own (expired holds, `SKIP LOCKED`), so it always
comes after the caller's own row locks: taking it first would invert the branch lock order against `DELETE /me`
(customer → pets → appointments) and could deadlock.

A `23P01` exclusion violation is a lost race: the problem filter answers `409 SLOT_TAKEN` and logs the constraint name
at `warn`. A transaction Postgres aborts for a deadlock (`40P01`), a serialization failure (`40001`) or a Prisma write
conflict (`P2034`) is also a lost race, never a 500: `409 CONFLICT`, logged at `warn` (`isTxConflict` in
`common/pg-error.ts`). Two writes that meet on the segments of an expired hold one of them is releasing can still
deadlock on the exclusion constraint; one wins (200) and the other gets this 409.

## Pieces

| Piece | Job |
| --- | --- |
| `PetRequestResolver.resolve(entries, owner)` | Pet entries (saved `petId` or inline `ref`) → engine `PetRequest`s plus a label per engine pet id. `owner` null = anonymous (a `petId` is 401). A set `owner` must be an active customer (401). Same 400/404 rules as `/availability` |
| `assertNewPetSizes(entries, thresholds)` (`pet-requests.ts`) | A new pet's stated `sizeClass` must match its `weightG` (location `sizeThresholdsLb`): 400 `pets.<i>.sizeClass`. Holds and staff bookings |
| `PetRequestResolver.fromAppointment(id)` | Rebuilds the request of an appointment from its visits (position order, `CANCELLED` visits skipped, size and coat snapshots, services, preferred groomer or `"ANY"`). 404 if not in the organization; 409 `CONFLICT` if a visit has no saved pet yet |
| `slotFromView` / `toSlotView` (`slot-codec.ts`) | Slot view ↔ engine slot. The engine pet id is the `petId` or `ref`; a view pet missing from the labels is 400 |
| `verdictError(reason)` | `EMPLOYEE_UNAVAILABLE`, `RESOURCE_UNAVAILABLE`, `TOO_SOON` → 409 `SLOT_TAKEN`; any other rejection → 400 `VALIDATION_FAILED`, `detail` = reason |
| `engineError(err)` | Engine input errors → 400 (see [Availability](availability.md#errors)) |
| `PlanWriter.insert(tx, appointmentId, write)` | For an existing appointment: one `pet_visit` per pet (`position` = index, size/coat snapshots, `pending_pet` or `pet_id`, preferred groomer or null, `kennel_resource_id` from the KENNEL segment, quoted price), `pet_visit_service` rows from the price matrix (`lookupPrice`), and one `appointment_segment` per planned segment (`service_id` only when the segment has one service, `staff_user_id` = employee, times and snapshots from the plan) |
| `PlanWriter.replace(tx, appointmentId, write)` | Reschedule/move: deletes the segments of the live visits (not `CANCELLED`, position order: the same list `fromAppointment` returns, matched by index), inserts the new ones, refreshes service snapshots (upsert; never deletes, so the slot must keep the same services), quoted price, kennel, `drop_off_at` and `estimated_ready_at`. Returns `before`/`after` `{ startsAt, readyAt }` for the audit |
| `HoldReleaseService.releaseExpired(tx, now, orgId?)` | HELD rows with `hold_expires_at <= now` (`FOR UPDATE SKIP LOCKED`, at most 500): `CANCELLED`, `cancel_reason` `HOLD_EXPIRED`, `cancelled_by` `SYSTEM`; segments `occupies = false`; visits `CANCELLED`; `pending_pet` cut to `{ ref, species }`. Called after the caller's row locks. Returns the count |
| `HoldReleaseService.release(tx, id, reason, by)` | The same for one HELD appointment; false when it is not HELD |
| `HoldsService.loadUsable(tx, holdId, principal, { lock? })` | A `HELD` appointment of this organization the principal may use (ownership rule above), else 404. Does not check expiry. With `lock`, `FOR UPDATE` on the row first (confirm). Always used before `release`, which has no organization filter |
| `toAppointmentView` / `toStaffAppointmentView` / `APPOINTMENT_VIEW_INCLUDE` (`appointment-view.ts`) | Pure mapper from an appointment loaded with `APPOINTMENT_VIEW_INCLUDE` (visits by position with pet name, services, segments by start) to the owner or staff view. Throws on a visit without a saved pet (holds have their own view) |
| `PetsService.createInTx(tx, actor, customerId, body, ip)` | `POST /me/pets` inside the caller's transaction: customer lock, size rule, 20-pet cap (409), `pet.create` audit. Returns `{ id }` |
| `AppointmentsService.cancelInTx(tx, appt, by)` / `replaceSlot(id, slot, opts)` | Cancel and new times for a `BOOKED` appointment (see [Owner appointments](#owner-appointments)); shared with staff writes and account deletion |
| `appointmentStartsAt(appt, segments)` (`appointment-view.ts`) | `dropOffAt` in drop-off mode, else the earliest work segment start among occupying segments (all segments when none occupies): the one start rule for views, lists, the cancel window and audits |
| `assertActiveCustomer(db, orgId, customerId, lock?)` (`customers/active-customer.ts`) | 401 when the customer is missing, soft-deleted or in another organization. With `lock`, `FOR SHARE` or `FOR UPDATE` on the row |

## Busy segments

`AvailabilityContextLoader.load(range, { excludeAppointmentId? })` counts a segment as busy when it occupies, its
appointment is not `excludeAppointmentId`, and the appointment is not a `HELD` row whose hold has expired.
