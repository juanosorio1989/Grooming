# Booking

The write path for holds, confirmations, reschedules and staff bookings (Plan 04b). Holds are served now; confirm,
owner and staff writes come in later tasks. Routes live in `BookingApiModule`; the shared core in `BookingModule`
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

Create steps: rate limit `holds:ip:<hash>` 20 per 600 s → a new pet with `weightG` must have the size class its
weight gives (`settings.sizeThresholdsLb`) → pets resolved as in `/availability` → the context for the slot's local
day plus one (excluding `replaceHoldId`) → the booking mode must match the services → `validatePlan` (online mode).
Then one transaction: release expired holds of the organization → load and release `replaceHoldId` → insert the
appointment (`HELD`, source `ONLINE`, `customer_id` = token or null, `hold_expires_at` = now + `holdMinutes`,
`drop_off_at` = slot start in drop-off mode, `estimated_ready_at` = slot `readyAt`) → `PlanWriter.insert`. A new pet
is stored in `pet_visit.pending_pet` (`ref`, `species`, `name`, `breed`, `breedCode`, `weightG`). No audit and no
outbox rows for holds.

- **Ownership:** a hold with a customer is usable only with that customer's token; an anonymous hold by anyone who
  has its id. Anything else, another organization's hold, or a hold that is not `HELD` is 404.
- **Expiry:** `GET` of an expired hold is 409 `HOLD_EXPIRED`. An expired hold never blocks a new one: the loader
  ignores it and the create transaction releases it first (`HOLD_EXPIRED`, by `SYSTEM`).
- **`replaceHoldId`:** picking another time keeps one hold per visitor. The old hold's own segments do not block the
  new slot; it is released (`HOLD_RELEASED`, by `CUSTOMER`) in the same transaction. Same ownership rule (404). An
  old hold that has already expired was just released by the same transaction, so it is 404 too: the client retries
  without `replaceHoldId`.
- **Matches:** with a customer token, each pending pet lists that customer's saved pets that may be the same animal:
  not deleted, same species, name equal ignoring case and surrounding spaces (`pet-matches.ts`, reused by confirm).
  Anonymous: `matches` is `[]`.

| Error | When |
| --- | --- |
| 400 `VALIDATION_FAILED` | Body shape (strict); size class not matching `weightG` (`pets.<i>.sizeClass`); booking mode mismatch (`slot.bookingMode`); a slot more than 400 days from now (`slot.startsAt`); a plan rejection other than the three below (`detail` = reason, e.g. `MALFORMED_PLAN`) |
| 400 `NO_PRICE_FOR_PET` and other engine codes | As in [Availability](availability.md#errors) |
| 401 `UNAUTHORIZED` | `petId` without a token; soft-deleted customer |
| 403 | Staff token |
| 404 `NOT_FOUND` | Unknown, foreign, not `HELD` or not usable hold; another customer's or a deleted saved pet |
| 409 `SLOT_TAKEN` | `EMPLOYEE_UNAVAILABLE`, `RESOURCE_UNAVAILABLE`, `TOO_SOON`, or a lost race (`23P01`) |
| 409 `HOLD_EXPIRED` | `GET` of an expired hold |
| 429 `RATE_LIMITED` | 21st `POST` from one IP in 10 min |

### Hold sweeper

`HoldSweeper` runs `HoldReleaseService.releaseExpired` for every organization every `HOLD_SWEEPER_INTERVAL_MS`
(default 60000; `0` = off, as in tests, which call `sweepOnce`). One transaction per tick, at most 500 holds; ticks do
not overlap, errors are logged and never thrown, and the timer is unref'd and cleared on shutdown.

## Write order

Validate outside the transaction (load the context, `validatePlan`; a rejection goes through `verdictError`) →
`prisma.$transaction` → `HoldReleaseService.releaseExpired(tx, now, orgId)` → writes. A `23P01` exclusion violation
is a lost race: the problem filter answers `409 SLOT_TAKEN` and logs the constraint name at `warn`.

## Pieces

| Piece | Job |
| --- | --- |
| `PetRequestResolver.resolve(entries, owner)` | Pet entries (saved `petId` or inline `ref`) → engine `PetRequest`s plus a label per engine pet id. `owner` null = anonymous (a `petId` is 401). A set `owner` must be an active customer (401). Same 400/404 rules as `/availability` |
| `PetRequestResolver.fromAppointment(id)` | Rebuilds the request of an appointment from its visits (position order, `CANCELLED` visits skipped, size and coat snapshots, services, preferred groomer or `"ANY"`). 404 if not in the organization; 409 `CONFLICT` if a visit has no saved pet yet |
| `slotFromView` / `toSlotView` (`slot-codec.ts`) | Slot view ↔ engine slot. The engine pet id is the `petId` or `ref`; a view pet missing from the labels is 400 |
| `verdictError(reason)` | `EMPLOYEE_UNAVAILABLE`, `RESOURCE_UNAVAILABLE`, `TOO_SOON` → 409 `SLOT_TAKEN`; any other rejection → 400 `VALIDATION_FAILED`, `detail` = reason |
| `engineError(err)` | Engine input errors → 400 (see [Availability](availability.md#errors)) |
| `PlanWriter.insert(tx, appointmentId, write)` | For an existing appointment: one `pet_visit` per pet (`position` = index, size/coat snapshots, `pending_pet` or `pet_id`, preferred groomer or null, `kennel_resource_id` from the KENNEL segment, quoted price), `pet_visit_service` rows from the price matrix (`lookupPrice`), and one `appointment_segment` per planned segment (`service_id` only when the segment has one service, `staff_user_id` = employee, times and snapshots from the plan) |
| `PlanWriter.replace(tx, appointmentId, write)` | Reschedule/move: deletes the segments, inserts the new ones for the visits matched by position, refreshes service snapshots (upsert; never deletes, so the slot must keep the same services), quoted price, kennel, `drop_off_at` and `estimated_ready_at`. Returns `before`/`after` `{ startsAt, readyAt }` for the audit |
| `HoldReleaseService.releaseExpired(tx, now, orgId?)` | HELD rows with `hold_expires_at <= now` (`FOR UPDATE SKIP LOCKED`, at most 500): `CANCELLED`, `cancel_reason` `HOLD_EXPIRED`, `cancelled_by` `SYSTEM`; segments `occupies = false`; visits `CANCELLED`. Returns the count |
| `HoldReleaseService.release(tx, id, reason, by)` | The same for one HELD appointment; false when it is not HELD |
| `HoldsService.loadUsable(tx, holdId, principal)` | A `HELD` appointment of this organization the principal may use (ownership rule above), else 404. Does not check expiry. Always used before `release`, which has no organization filter |
| `assertActiveCustomer(db, orgId, customerId, lock?)` (`customers/active-customer.ts`) | 401 when the customer is missing, soft-deleted or in another organization. With `lock`, `FOR SHARE` or `FOR UPDATE` on the row |

## Busy segments

`AvailabilityContextLoader.load(range, { excludeAppointmentId? })` counts a segment as busy when it occupies, its
appointment is not `excludeAppointmentId`, and the appointment is not a `HELD` row whose hold has expired.
