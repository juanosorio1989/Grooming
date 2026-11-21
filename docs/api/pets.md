# Pets and vaccines

Paths under `/v1`. Contracts: `packages/contracts/src/pets.ts`. Code: `apps/api/src/pets/`.

`PetView`: `id, customerId, name, species, breed, breedCode, birthDate, sex, neutered, weightG, weightMeasuredAt,
sizeClass, coatType, temperament[], allergies[], medicalNotes, behaviorNotes, vetName, vetPhone, photoMediaId, vaccines[]`.
`medicalNotes` is stored encrypted (`pet.medical_notes_enc`, AES-256-GCM via `Encryptor`) and returned decrypted.
`VaccineView`: `id, type, expiresOn, cardMediaId, verified, verifiedAt`.

## Size rule

When `weightG` is set, `sizeClass` is derived with `sizeClassFromWeight(weightG, settings.sizeThresholdsLb)` and a sent
`sizeClass` is ignored; `weightMeasuredAt` is set to now. When `weightG` is null or absent, the sent `sizeClass` is stored
as is (the owner picked S/M/L/XL).

## Owner (`CustomerAuth`)

Only own, non-deleted pets; anything else is `404`.

- `GET|POST /me/pets` (max 20 pets per customer, the 21st is `409 CONFLICT`)
- `GET|PATCH|DELETE /me/pets/:id` (DELETE soft-deletes, 204)
- `GET|POST /me/pets/:id/vaccines`, `PATCH|DELETE /me/pets/:id/vaccines/:vid`. An owner PATCH on a verified vaccine
  clears `verifiedAt` / `verifiedByStaffId`.

## Staff

| Route | Roles | Notes |
|---|---|---|
| `GET /staff/pets?customerId=&q=` | OWNER, RECEPTION, EMPLOYEE | `q` matches name or breed. EMPLOYEE: only pets with a non-cancelled segment assigned to them within the location's local day. |
| `POST /staff/pets` | OWNER, RECEPTION | `{ customerId, ...PetInput }`; unknown customer 404; 20-pet cap applies. |
| `GET /staff/pets/:id` | OWNER, RECEPTION, EMPLOYEE | EMPLOYEE outside the "today" scope gets 404 (not 403). |
| `PATCH /staff/pets/:id` | OWNER, RECEPTION | Partial `PetInput`. |
| `GET /staff/pets/:id/vaccines` | OWNER, RECEPTION, EMPLOYEE | Same scope as the pet. |
| `POST /staff/pets/:id/vaccines`, `PATCH|DELETE .../vaccines/:vid` | OWNER, RECEPTION | |
| `POST /staff/pets/:id/vaccines/:vid/verify` | OWNER, RECEPTION | Sets `verifiedAt = now`, `verifiedByStaffId`. |

`PetAccessService.employeeCanSee(staffId, petId, now)` implements the EMPLOYEE scope.

## Audit

`pet.create|update|delete`, `pet_vaccine.create|update|delete|verify`; `actorType` is `CUSTOMER` or `STAFF`. Pet rows never
hold the notes text: `hasMedicalNotes` in the snapshot and `medicalNotesChanged` in `after`.
