# Availability

`GET /v1/availability` returns bookable online slots for one to seven local dates. It runs the engine in `packages/availability` (`findSlots`, mode `ONLINE`) for the default location.

## Auth

`@OptionalCustomerAuth()`: no `Authorization` header means an anonymous visitor. When the header is sent, it must be a valid customer token for this organization: a bad or foreign token is 401, a staff token is 403 (staff mode comes in Plan 04b). A token whose customer is soft-deleted (`DELETE /me`) is 401, even with inline pets only.

## Query

| Param | Rule |
| --- | --- |
| `from` | `YYYY-MM-DD`, a local date in the location time zone; year 2000 to 9998, else 400 on `from` |
| `to` | optional, defaults to `from`; same year range (2000 to 9998); `to >= from` and `to - from < 7` (`MAX_AVAILABILITY_DAYS`), else 400 on `to` |
| `pets` | URL-encoded JSON array of 1 to 4 entries, at most 4000 characters; a non-JSON value is 400 on `pets`. Required unless `excludeAppointmentId` is sent; sending both is 400 on `pets` |
| `excludeAppointmentId` | optional id (reschedule: the pets come from that appointment). Not served yet: 400 on `excludeAppointmentId`, "not supported yet" |
| `customerId`, `override` | optional, staff only (`override` is `"true"`/`"false"`). Parsed but not used yet |

Express's default query parser has no nested objects, so `pets` is a JSON string. Unknown query keys are 400.

Each `pets` entry is one of:

- Saved pet: `{ petId, serviceIds, preferredGroomerId?, sizeClass?, coatType? }`. Needs a customer token (none is 401). The pet must belong to that customer and not be deleted (else 404 `NOT_FOUND`). Species comes from the pet. `sizeClass` and `coatType` come from the pet; the query values are used only when the stored value is null. A value still missing is 400 `VALIDATION_FAILED` on `pets.<i>.sizeClass` or `pets.<i>.coatType` (the owner picks a size in the booking flow when the pet has no weight).
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
- Busy time: occupying segments, except those of an expired hold (`HELD` with `hold_expires_at <= now`).
- Pet entries go through the shared `PetRequestResolver` and slots through the slot codec (see [Booking](booking.md)).

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
| Bad query (`pets` missing, not JSON or too long, more than 4 pets, range over 7 days, unknown key, `excludeAppointmentId`) | 400 | `VALIDATION_FAILED` with `errors[].path` |
| Saved pet without a token / bad token / token of a deleted customer | 401 | `UNAUTHORIZED` |
| Staff token | 403 | `FORBIDDEN` |
| Saved pet of another customer, or deleted | 404 | `NOT_FOUND` |
| Engine `NO_PRICE_FOR_PET` | 400 | `NO_PRICE_FOR_PET` |
| Engine `STAGE_RESOURCE_MISMATCH` | 400 | `STAGE_RESOURCE_MISMATCH` |
| Any other engine code (`UNKNOWN_SERVICE`, `SPECIES_MISMATCH`, `DUPLICATE_PET`, ...) | 400 | `VALIDATION_FAILED`, `detail` = engine code |
| Over the rate limit | 429 | `RATE_LIMITED` |

## Rate limit

`availability:ip:<hashKeyPart(ip)>`: 120 requests per 600 s per client IP (fixed window). It is consumed after the guard, query validation and the `pets`/`excludeAppointmentId` check, before pets are looked up or the engine runs.
