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

- `GET /me` -> `MeView` (404 if the customer is soft-deleted). `MeView` is `CustomerView` plus
  `identities: [{ provider: "GOOGLE", email }]` (`[]` when no sign-in account is linked; the Google `sub` is never shown).
- `PATCH /me` `{ name?, email?, locale?, emergencyPhone? }` -> `MeView`. Audit `customer.update` with `actorType: CUSTOMER`.
- Link or unlink Google: `POST`/`DELETE /me/identities/google`, see [owner sign-in](owner-sign-in.md#profile-link-and-unlink).
- Staff customer views (`/staff/customers*`) do not include `identities`.
- Staff tokens get 403.
