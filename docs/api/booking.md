# Booking

The write path for holds, confirmations, reschedules and staff bookings (Plan 04b). Routes come in later tasks; this
page describes the shared core in `apps/api/src/booking/` that every booking write and `/availability` use, so the
plan a client gets is the plan the server re-checks.

## Write order

Validate outside the transaction (load the context, `validatePlan`; a rejection goes through `verdictError`) →
`prisma.$transaction` → `HoldReleaseService.releaseExpired(tx, now, orgId)` → writes. A `23P01` exclusion violation
is a lost race: the problem filter answers `409 SLOT_TAKEN` and logs the constraint name at `warn`.

## Pieces

| Piece | Job |
| --- | --- |
| `PetRequestResolver.resolve(entries, owner)` | Pet entries (saved `petId` or inline `ref`) → engine `PetRequest`s plus a label per engine pet id. `owner` null = anonymous (a `petId` is 401). A set `owner` must be an active customer (401). Same 400/404 rules as `/availability` |
| `PetRequestResolver.fromAppointment(id)` | Rebuilds the request of an appointment from its visits (position order, size and coat snapshots, services, preferred groomer or `"ANY"`). 404 if not in the organization; 409 `CONFLICT` if a visit has no saved pet yet |
| `slotFromView` / `toSlotView` (`slot-codec.ts`) | Slot view ↔ engine slot. The engine pet id is the `petId` or `ref`; a view pet missing from the labels is 400 |
| `verdictError(reason)` | `EMPLOYEE_UNAVAILABLE`, `RESOURCE_UNAVAILABLE`, `TOO_SOON` → 409 `SLOT_TAKEN`; any other rejection → 400 `VALIDATION_FAILED`, `detail` = reason |
| `engineError(err)` | Engine input errors → 400 (see [Availability](availability.md#errors)) |
| `PlanWriter.insert(tx, appointmentId, write)` | For an existing appointment: one `pet_visit` per pet (`position` = index, size/coat snapshots, `pending_pet` or `pet_id`, preferred groomer or null, `kennel_resource_id` from the KENNEL segment, quoted price), `pet_visit_service` rows from the price matrix (`lookupPrice`), and one `appointment_segment` per planned segment (`service_id` only when the segment has one service, `staff_user_id` = employee, times and snapshots from the plan) |
| `PlanWriter.replace(tx, appointmentId, write)` | Reschedule/move: deletes the segments, inserts the new ones for the visits matched by position, refreshes service snapshots (upsert), quoted price, kennel, `drop_off_at` and `estimated_ready_at`. Returns `before`/`after` `{ startsAt, readyAt }` for the audit |
| `HoldReleaseService.releaseExpired(tx, now, orgId?)` | HELD rows with `hold_expires_at <= now` (`FOR UPDATE SKIP LOCKED`, at most 500): `CANCELLED`, `cancel_reason` `HOLD_EXPIRED`, `cancelled_by` `SYSTEM`; segments `occupies = false`; visits `CANCELLED`. Returns the count |
| `HoldReleaseService.release(tx, id, reason, by)` | The same for one HELD appointment; false when it is not HELD |
| `assertActiveCustomer(db, orgId, customerId, lock?)` (`customers/active-customer.ts`) | 401 when the customer is missing, soft-deleted or in another organization. With `lock`, `FOR SHARE` or `FOR UPDATE` on the row |

## Busy segments

`AvailabilityContextLoader.load(range, { excludeAppointmentId? })` counts a segment as busy when it occupies, its
appointment is not `excludeAppointmentId`, and the appointment is not a `HELD` row whose hold has expired.
