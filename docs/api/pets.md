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
| `POST /staff/pets/:id/merge` | OWNER, RECEPTION | `{ intoPetId }`; `:id` is the duplicate. `200 PetView` of the target. See [Merge](#merge). |

`PetAccessService.employeeCanSee(staffId, petId, now)` implements the EMPLOYEE scope.

## Merge

`POST /staff/pets/:id/merge` (`PetMergeService`, contract `PetMergeSchema`) merges the duplicate `:id` (source) into
`intoPetId` (target) in one transaction:

1. Both pet rows are locked with `SELECT ... FOR UPDATE` in id order (so A->B and B->A at once cannot deadlock), then
   re-read. Unknown or other-organization pet: `404 NOT_FOUND`. Same id, a deleted pet, different customers or different
   species: `409 PET_MERGE_INVALID` (the `detail` names the rule). A transaction Postgres aborts for a deadlock or
   serialization conflict is also `409 PET_MERGE_INVALID`, never 500.
2. `pet_visit.pet_id`, `media.pet_id` and `pet_vaccine.pet_id` move to the target. These are the only foreign keys to
   `pet.id`. For a vaccine type present on both pets one row survives: later `expiresOn`, then verified, then the
   target's; the others are deleted.
3. Null or empty target fields take the source value: `breedCode`, `birthDate`, `sex`, `neutered`, `coatType`,
   `medicalNotes` (ciphertext copied as is), `behaviorNotes`, `vetName`, `vetPhone`, `photoMediaId`. When the target has no
   weight, `weightG`, `weightMeasuredAt` and `sizeClass` come from the source together (or just `sizeClass` if the source
   has no weight either and the target has none). `temperament` and `allergies` are unioned; allergies dedupe
   case-insensitively and the target's spelling wins (`["Chicken"]` + `["chicken","Beef"]` gives `["Chicken","Beef"]`).
4. The source is soft-deleted (`deletedAt = now`) and disappears from lists.
5. Audit `pet.merge`, entity `pet`, `entityId` = target, `after = { sourcePetId, movedVisits, movedMedia, movedVaccines,
   droppedVaccines, filledFields }` (`filledFields` uses `PetView` names, including `temperament` / `allergies` when the
   union added values). No notes text is stored.

## Audit

`pet.create|update|delete|merge`, `pet_vaccine.create|update|delete|verify`; `actorType` is `CUSTOMER` or `STAFF`. Pet rows never
hold the notes text: `hasMedicalNotes` in the snapshot and `medicalNotesChanged` in `after`.
