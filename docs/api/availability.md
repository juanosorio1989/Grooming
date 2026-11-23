# Availability

`GET /v1/availability` returns bookable slots for one to seven local dates. It runs the engine in `packages/availability` (`findSlots`) for the default location: mode `ONLINE` for customers and anonymous visitors, mode `STAFF` for staff (see [Staff mode](#staff-mode)).

## Auth

`@OptionalCustomerOrStaffAuth("OWNER", "RECEPTION")`: no `Authorization` header means an anonymous visitor. When the header is sent, it must be a valid customer token or an OWNER or RECEPTION staff token for this organization: a bad or foreign token is 401, an EMPLOYEE token is 403. A customer token whose customer is soft-deleted (`DELETE /me`) is 401, even with inline pets only.

## Query

| Param | Rule |
| --- | --- |
| `from` | `YYYY-MM-DD`, a local date in the location time zone; year 2000 to 9998, else 400 on `from` |
| `to` | optional, defaults to `from`; same year range (2000 to 9998); `to >= from` and `to - from < 7` (`MAX_AVAILABILITY_DAYS`), else 400 on `to` |
| `pets` | URL-encoded JSON array of 1 to 4 entries, at most 4000 characters; a non-JSON value is 400 on `pets`. Required unless `excludeAppointmentId` is sent; sending both is 400 on `pets` |
| `excludeAppointmentId` | optional id. Reschedule, customer or staff token: see [Reschedule slots](#reschedule-slots) |
| `customerId` | optional id, staff only (a customer or anonymous request with it is 403). The customer whose saved pets are used; see [Staff mode](#staff-mode) |
| `override` | optional `"true"`/`"false"`, staff only (a customer or anonymous request with it, even `"false"`, is 403). Default false |

Express's default query parser has no nested objects, so `pets` is a JSON string. Unknown query keys are 400.

Each `pets` entry is one of:

- Saved pet: `{ petId, serviceIds, preferredGroomerId?, sizeClass?, coatType? }`. Needs a customer token (none is 401), or a staff token with `customerId`. The pet must belong to that customer and not be deleted (else 404 `NOT_FOUND`). Species comes from the pet. `sizeClass` and `coatType` come from the pet; the query values are used only when the stored value is null. A value still missing is 400 `VALIDATION_FAILED` on `pets.<i>.sizeClass` or `pets.<i>.coatType` (the owner picks a size in the booking flow when the pet has no weight).
- Inline pet: `{ ref: "new-1".."new-4", species: "DOG"|"CAT", sizeClass, coatType, serviceIds, preferredGroomerId? }`.

`serviceIds`: 1 to 6 ids. `preferredGroomerId`: an employee id or `"ANY"` (default). Pet entries are strict.

Example (one inline dog, spaces and quotes encoded):

```
GET /v1/availability?from=2026-12-01&to=2026-12-03&pets=%5B%7B%22ref%22%3A%22new-1%22%2C%22species%22%3A%22DOG%22%2C%22sizeClass%22%3A%22M%22%2C%22coatType%22%3A%22CURLY%22%2C%22serviceIds%22%3A%5B%220194b2a0-0000-7000-8000-000000000001%22%5D%7D%5D
```

which decodes to `pets=[{"ref":"new-1","species":"DOG","sizeClass":"M","coatType":"CURLY","serviceIds":["0194b2a0-0000-7000-8000-000000000001"]}]`.

## Behavior

- Booking mode: `DROP_OFF` if any requested service is `DROP_OFF` (its own `bookingMode`, or null and the location default is `DROP_OFF`), else `WAIT`.
- The context is loaded once for `[start of from, end of to + 1 day)` local time; the extra day covers kennel blocks past midnight. The engine runs once per date and slots are concatenated in date order.
- Unknown or inactive services are left to the engine (`UNKNOWN_SERVICE`).

## Reschedule slots

`excludeAppointmentId=<id>` (without `pets`) lists the slots an owner can move a booking to
(`POST /me/appointments/:id/reschedule`, see [Booking](booking.md#owner-appointments)):

- Needs a customer token: anonymous is 401 `UNAUTHORIZED` (a soft-deleted customer too). Staff: see
  [Staff mode](#staff-mode).
- The appointment must be that customer's, in this organization and `BOOKED`; anything else (unknown, another
  customer's, cancelled, a hold) is 404 `NOT_FOUND`.
- The pets come from the appointment (`PetRequestResolver.fromAppointment`: position order, size and coat snapshots,
  the same services, preferred groomer), so the slots carry each pet's `petId`.
- The appointment's own segments are not busy, so a slot that overlaps only its current time is listed.
- Sending `pets` too is 400 on `pets`. The cancel window is not checked here; the reschedule route checks it.
- Busy time: occupying segments, except those of an expired hold (`HELD` with `hold_expires_at <= now`).
- Pet entries go through the shared `PetRequestResolver` and slots through the slot codec (see [Booking](booking.md)).

## Staff mode

An OWNER or RECEPTION token runs the engine in mode `STAFF` with `override = q.override ?? false`:

- No minimum lead time (today's slots start at now rounded down to the grid), no booking horizon, and services or
  employees that are not bookable online are used.
- `override=true` also ignores employee working hours, location hours and drop-off windows (time off and busy segments
  still count).
- Staff requests are not rate limited (the per-IP counter is not consumed).
- Saved pets (`petId`) need `customerId`: without it 400 `VALIDATION_FAILED` on path `customerId`. Every pet must
  belong to that customer and not be deleted, else 404. An unknown or soft-deleted `customerId` is 404 `NOT_FOUND`
  (not 401: the token is valid, the customer is the missing resource), also with inline pets only.
- `excludeAppointmentId` may be any `BOOKED` appointment of the organization whose customer is not soft-deleted (anything else 404, as `PATCH /staff/appointments/:id`); its pets come from
  the appointment as for owners. Sending `customerId` with it is 400 on `customerId` (the appointment already names
  the customer; rejecting avoids a silent mismatch).

## Response

```
{ bookingMode: "WAIT"|"DROP_OFF",
  slots: [{ startsAt, readyAt, bookingMode,
            pets: [{ petId? | ref?, priceCents,
                     segments: [{ stage, serviceIds, employeeId, resourceId,
                                  startsAt, endsAt, blockEndsAt, durationMin, priceCents }] }] }] }
```

Instants are ISO 8601 UTC. `startsAt` is the first segment start in wait mode and the drop-off time in drop-off mode. Drop-off pets end with a `KENNEL` segment (`employeeId` null). Each pet carries back its `petId` or its `ref`.

## Errors

| Case | Status | `code` |
| --- | --- | --- |
| Bad query (`pets` missing without `excludeAppointmentId`, both sent, staff `petId` without `customerId`, staff `customerId` with `excludeAppointmentId`, not JSON or too long, more than 4 pets, range over 7 days, unknown key) | 400 | `VALIDATION_FAILED` with `errors[].path` |
| Saved pet or `excludeAppointmentId` without a token / bad token / token of a deleted customer | 401 | `UNAUTHORIZED` |
| EMPLOYEE token; `override` or `customerId` from a customer or anonymous request | 403 | `FORBIDDEN` |
| Saved pet of another customer, or deleted; `excludeAppointmentId` not a `BOOKED` appointment of the customer (staff: of the organization, with a customer that is not deleted); staff `customerId` unknown or deleted | 404 | `NOT_FOUND` |
| Engine `NO_PRICE_FOR_PET` | 400 | `NO_PRICE_FOR_PET` |
| Engine `STAGE_RESOURCE_MISMATCH` | 400 | `STAGE_RESOURCE_MISMATCH` |
| Any other engine code (`UNKNOWN_SERVICE`, `SPECIES_MISMATCH`, `DUPLICATE_PET`, ...) | 400 | `VALIDATION_FAILED`, `detail` = engine code |
| Over the rate limit | 429 | `RATE_LIMITED` |

## Rate limit

`availability:ip:<hashKeyPart(ip)>`: 120 requests per 600 s per client IP (fixed window). It is consumed after the guard, query validation, the staff-only param check (403) and the anonymous `excludeAppointmentId` check (401), before pets or the appointment are looked up or the engine runs. Staff requests skip it.

## Timing log

The slot search is timed: a debug line `{ dates, pets, ms }` per request (logger context `AvailabilityService`), a warning when it takes more than 1000 ms. Use it to size the limits later.
