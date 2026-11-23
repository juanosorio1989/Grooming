# Customers

Paths under `/v1`. Contracts: `packages/contracts/src/customers.ts`.

`CustomerView`: `id, name (null until entered), phone, email, locale, emergencyPhone, createdAt`.
Staff responses add `privateNotes` (decrypted with `Encryptor`, AES-256-GCM in `customer.private_notes_enc`)
for OWNER and RECEPTION only; EMPLOYEE responses omit the field. Soft-deleted customers (`deletedAt`) are hidden.

## Staff

| Route | Roles | Notes |
|---|---|---|
| `GET /staff/customers?q=` | OWNER, RECEPTION, EMPLOYEE | `q` matches name (case-insensitive contains) or phone digits (contains). Max 50, ordered by name. EMPLOYEE sees only customers with a segment assigned to them within 30 days back or ahead. |
| `POST /staff/customers` | OWNER, RECEPTION | `{ name, phone, locale, email?, emergencyPhone? }` -> 201, `createdVia: RECEPTION` (the schema's staff-created value). Phone already in the org -> `409 CONFLICT`, `detail` = existing customer id. Audit `customer.create`. |
| `GET /staff/customers/:id` | OWNER, RECEPTION, EMPLOYEE | EMPLOYEE under the same scope as search (404 otherwise). |
| `PATCH /staff/customers/:id` | OWNER, RECEPTION | `name, email, locale, emergencyPhone, privateNotes` (null clears email, emergencyPhone and privateNotes). Phone is not editable (400). Audit `customer.update`; notes are never in the audit row, only `privateNotesChanged`. |

## Owner (`CustomerAuth`)

- `GET /me` -> `MeView`. `MeView` is `CustomerView` plus
  `identities: [{ provider: "GOOGLE", email }]` (`[]` when no sign-in account is linked; the Google `sub` is never shown).
- `PATCH /me` `{ name?, email?, locale?, emergencyPhone? }` -> `MeView`. Audit `customer.update` with `actorType: CUSTOMER`.
- Link or unlink Google: `POST`/`DELETE /me/identities/google`, see [owner sign-in](owner-sign-in.md#profile-link-and-unlink).
- Staff customer views (`/staff/customers*`) do not include `identities`.
- `GET /me/export` -> `MeExport`, see below.
- `DELETE /me` -> 204, see below.
- A soft-deleted customer's token (it outlives `DELETE /me` until it expires) gets `401 UNAUTHORIZED`
  on `/me`, `/me/export`, `DELETE /me` and `/me/appointments*`.
- Staff tokens get 403.

## Export (`GET /me/export`)

Contract: `MeExportSchema` in `packages/contracts/src/account.ts`. Deleted customer 401 first, then
rate limit `me:export:<customerId>` 5 per hour (`429 RATE_LIMITED`).

`{ exportedAt, customer: CustomerView, identities: [{ provider, email, linkedAt }], consents: [{ channel,
granted, source, changedAt }], pets: (PetView & { deletedAt })[] (every pet of the customer, removed ones too,
with vaccines and decrypted medical notes; `deletedAt` is null for a live pet and the ISO instant of removal
otherwise, because visits and media can still point to a removed pet),
appointments: AppointmentView[] (bookings only, never holds), media: [{ id, kind, petId, createdAt }] }`.
Media covers every pet of the customer (also removed ones) and has no download links yet (Plan 05).
Never includes staff-only private notes or the Google `sub`.

## Account deletion (`DELETE /me`)

Irreversible, one transaction (`apps/api/src/customers/account.service.ts`). Lock order: customer
`FOR UPDATE`, then pets, then appointments (the order every booking write follows).

1. Not-yet-started appointments (`appointmentStartsAt` after now): `HELD` ones are released
   (`HOLD_RELEASED`, by `CUSTOMER`, no outbox row); `BOOKED` ones are cancelled like any cancel
   (reason `ACCOUNT_DELETED`, `occupies = false`, visits `CANCELLED`), with no `appointment.cancelled`
   outbox row (nobody is left to notify). `IN_SHOP`, started and finished appointments are untouched.
   On every appointment of the customer `notes` is cleared and `pending_pet` keeps only `ref` and
   `species` (`name`, `breed`, `breedCode`, `weightG` removed; the column stays non-null for the CHECK).
2. Pets: the `PET_PHOTO` and `VACCINE_CARD` media rows are deleted (after nulling `photoMediaId` and
   deleting the vaccines), with one outbox `media.purge { objectKeys }` when there were any; the
   Plan 05 worker deletes the files. `BEFORE`, `AFTER` and `STEP` media stay. Before the vaccines go,
   the keys `name`, `breed`, `breedCode`, `birthDate`, `behaviorNotes`, `vetName`, `vetPhone`,
   `allergies`, `temperament`, `medicalNotes` are stripped from the audit rows with `entity = pet`
   for these pets (`pet.create|update|delete|merge`) and `entity = pet_vaccine` for their vaccines
   (also vaccines deleted earlier, found by the `petId` in the snapshot). Every pet becomes
   `name "Deleted pet"`, `breed "-"`, with breed code, birth date, medical and behavior notes, vet
   name and phone cleared and empty allergies and temperament; live pets get `deletedAt`.
3. Identities deleted; unprocessed outbox rows whose `payload.customerId` is this customer, or whose
   `payload.appointmentId` is one of their appointments, deleted. Processed rows stay.
4. Customer: `name`, `email`, `emergencyPhone`, private notes cleared, `phone = "deleted:<id>"`
   (keeps the per-organization phone index unique), `deletedAt` set. Consents stay as evidence.
   A `cancel_reason` staff typed on one of the customer's appointments stays: it is the shop's own
   record (it is never in the audit and the customer never sees it).
5. Customer refresh tokens revoked.
6. The keys `name`, `phone`, `email`, `emergencyPhone` are stripped from `before`/`after` of every
   audit row with `entity = customer` for this customer; then audit `customer.delete`
   `{ petsDeleted, appointmentsCancelled }`.

Visits and visit media stay for the shop, linked to the anonymized pet. A Google link racing the
delete either finishes first (and its identity is deleted) or sees the deleted customer (`409`/`404`).
`POST /holds` and `POST /appointments` also lock the customer first, so a hold or booking racing the
delete either lands first (and is released or cancelled) or gets `401`.
