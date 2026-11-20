# API `/v1` — changes from BeautySpa

Conventions, errors (`application/problem+json`), auth endpoints, manage link,
webhooks and RBAC mechanics are copied from BeautySpa's `api.md`. Roles:
`OWNER` (shop owner/admin), `RECEPTION`, `EMPLOYEE` (bather/groomer),
`CUSTOMER` (pet owner).

New error codes: `STEP_CONFLICT`, `STEP_ORDER`, `AFTER_PHOTO_REQUIRED`,
`VACCINES_REQUIRED`, `NO_PRICE_FOR_PET`, `MEDIA_INVALID`, `IDENTITY_TAKEN`.

## Owner sign-in

Contracts, edge cases, limits and audit in
[owner sign-in: API details](owner-sign-in-api.md).

| Method | Path | Notes |
|---|---|---|
| POST | `/auth/google/nonce` | → `{ nonce }`, browser-bound cookie |
| POST | `/auth/google` | `{ idToken }` → `SIGNED_IN` (tokens) or `PHONE_REQUIRED` (`linkTicket`) |
| POST | `/auth/otp/verify` | copied; optional `linkTicket`, response `identityLinked` |
| POST | `/me/identities/google` | `{ idToken }` links; `409 IDENTITY_TAKEN` |
| DELETE | `/me/identities/google` | unlinks, `204` |
| GET | `/me` | copied; adds `identities` |

## Public

| Method | Path | Notes |
|---|---|---|
| GET | `/public/services` | + `species`, `stage`, `is_main`, price matrix rows |
| GET | `/public/employees` | groomers bookable as "preferred" |
| GET | `/public/breeds` | seeded list (EN/ES) for autocomplete |
| GET | `/availability` | `mode` resolved server-side; body-style query `pets[]` (petId or inline `{species,sizeClass,coatType}`, services, preferredGroomerId); `excludeAppointmentId?` → `Slot[]` |
| POST | `/holds` | `{ slot, newPets? }` → `{ holdId, expiresAt }` |
| GET | `/track/:token` | appointment + pet visits + steps + ETA + published reports |
| GET | `/track/:token/stream` | SSE |

## Owner (customer token)

| Method | Path | Notes |
|---|---|---|
| CRUD | `/me/pets` | profile; DELETE soft-deletes |
| CRUD | `/me/pets/:id/vaccines` | owner-entered, unverified |
| GET | `/me/pets/:id/history` | visits with steps, observations, reports, media URLs |
| POST | `/appointments` | `{ holdId, notes? }` |
| (copied) | `/me`, `/me/appointments…`, `/me/export`, `DELETE /me` | export/delete include pets and media |

## Media

| Method | Path | Roles |
|---|---|---|
| POST | `/media/uploads` | customer (own pets: `PET_PHOTO`, `VACCINE_CARD`); staff (any kind for their org) |
| POST | `/media/:id/complete` | uploader |
| GET | `/media/:id/url` | anyone allowed to see the pet/visit → presigned GET |

## Staff

| Method | Path | Roles |
|---|---|---|
| GET | `/staff/board?date=&locationId=` | all (EMPLOYEE: own segments' pets) |
| GET | `/staff/board/stream` | SSE, same scope |
| GET | `/staff/my-visits?date=` | EMPLOYEE screen |
| POST | `/staff/appointments/:id/check-in` | OWNER, RECEPTION — per pet: weight, kennel, vaccine verifications, price adjust |
| POST | `/staff/visits/:id/steps` | all (EMPLOYEE: pets they have a segment for) — `{ action: START\|SKIP\|READY, stage?, reason?, performedBy?, clientRef, occurredAt }` |
| POST | `/staff/visits/:id/observations` | all (same scope) — `{ kind, severity, note?, mediaId?, clientRef }` |
| PATCH | `/staff/visits/:id/report` | all (same scope), 24 h after publish |
| POST | `/staff/appointments/:id/check-out` | OWNER, RECEPTION — payments, picked-up-by per pet |
| CRUD | `/staff/pets`, `/staff/pets/:id/vaccines` (verify) | OWNER, RECEPTION; EMPLOYEE read for own visits |
| CRUD | `/staff/services/:id/prices`, `/staff/resources` (stations, kennels) | OWNER |
| (copied) | agenda, customers, appointments, walk-in, status, catalog, employees, time-off, settings, audit | as BeautySpa |

## RBAC additions

| Capability | OWNER | RECEPTION | EMPLOYEE | CUSTOMER |
|---|---|---|---|---|
| Pet profile incl. medical notes | ✓ | ✓ | pets with own segments today | own |
| Mark steps / observations | ✓ | ✓ (on behalf) | own pets | – |
| Check-in / check-out / payments | ✓ | ✓ | – | – |
| Price matrix, stations, kennels | ✓ | – | – | – |
