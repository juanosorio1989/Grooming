# Data model (PostgreSQL 16 + Prisma)

Conventions, tenancy columns (`organization_id`, `location_id`), soft deletes,
encryption (`*_enc`, AES-256-GCM) and the tables below marked *copied* follow
BeautySpa's `data-model.md`. Weights are stored in **grams** (integer), shown
in lb.

## Copied unchanged

`organization`, `location_hours`, `location_closure`, `staff_user`,
`staff_recovery_code`, `staff_auth_token`, `staff_location`, `working_hours`,
`time_off`, `refresh_token`, `notification_consent`, `notification_log`,
`audit_log`, `resource_type`, `resource`.

`customer` is copied (the pet owner; `name` = owner name) with one addition:
`emergency_phone_e164` (nullable).

## Changed

| Table | Change |
|---|---|
| `location.settings` | adds `defaultBookingMode` (`WAIT`/`DROP_OFF`), `dropOffWindows` (per weekday, list of `{from,to}` local times), `maxQueueWaitMin` (90), `pickupGraceMin` (60), `sizeThresholdsLb` (`{S:20,M:50,L:90}`), `requireAfterPhoto` (true), `vaccinePolicy` (`WARN`/`BLOCK_CHECKIN`), `requiredVaccines` (per species, e.g. dog: `[RABIES]`), `etaNotifyThresholdMin` (30) |
| `employee_profile` | drop `level_id`; add `skills` (`BATHER`, `GROOMER`, both allowed) |
| `resource_type` | adds `kind`: `STATION` (tub, table, dryer) or `KENNEL` |
| `level`, `service_level_price` | removed |

## Pets

| Table | Key columns |
|---|---|
| `pet` | `organization_id`, `customer_id`, `name`, `species` (`DOG`, `CAT`), `breed` (text + optional `breed_code` from a seeded list), `birth_date` (nullable, month precision ok), `sex`, `neutered`, `weight_g`, `weight_measured_at`, `size_class` (derived on write, stored), `coat_type` (`SMOOTH`, `DOUBLE`, `CURLY`, `WIRE`, `LONG`, `HAIRLESS`), `temperament` (`CALM`, `NERVOUS`, `REACTIVE`, `NEEDS_MUZZLE`) multi, `allergies` text[], `medical_notes_enc`, `behavior_notes`, `vet_name`, `vet_phone_e164`, `photo_media_id`, `deleted_at` |
| `pet_vaccine` | `organization_id`, `pet_id`, `type` (`RABIES`, `DHPP`, `BORDETELLA`, `FVRCP`, `OTHER`), `expires_on` date, `card_media_id` (nullable), `verified_by_staff_id`, `verified_at` (nullable — owner-entered until staff verifies) |
| `media` | `organization_id`, `kind` (`PET_PHOTO`, `VACCINE_CARD`, `BEFORE`, `AFTER`, `STEP`), `object_key`, `content_type`, `bytes`, `pet_id`, `visit_id` (nullable), `uploaded_by_type`/`_id`, `status` (`PENDING`, `READY`), `client_ref` (idempotency key from offline queue, unique per org) |

Allergies and temperament are plain columns because every groomer screen shows
them; free-text medical notes are encrypted **(call)**.

## Catalog

| Table | Key columns |
|---|---|
| `service_category` | copied |
| `service` | `organization_id`, `category_id`, `name`/`description` jsonb, `species` (`DOG`,`CAT`,`ANY`), `stage` (`BATH`, `DRY`, `GROOM`, `FINISH`), `is_main` (a main service vs. an add-on), `resource_type_id` (nullable), `required_skill` (`BATHER`/`GROOMER`), `booking_mode` (nullable = location default), `buffer_after_min`, `online_bookable`, `active` |
| `service_price` | `service_id`, `size_class` (`S`,`M`,`L`,`XL`), `coat_type` (nullable = any coat), `duration_min`, `price_cents`. Unique `(service_id, size_class, coat_type)`. Lookup: exact coat row, else the `NULL` coat row, else service not offered for that pet. |
| `employee_service` | copied — what each person may do |

**Stage rule:** all services of one pet in the same stage become one segment;
they must share the same `resource_type_id` (or none) and the assigned person
must be qualified for all of them. Admin validation enforces the shared
resource type per stage **(call)**.

## Appointments and visits

| Table | Key columns |
|---|---|
| `appointment` | copied columns + `booking_mode`, `drop_off_at` (nullable), `estimated_ready_at`, `checked_in_at`, `completed_at`. Status: `HELD`, `BOOKED`, `IN_SHOP`, `COMPLETED`, `CANCELLED`, `NO_SHOW`. |
| `pet_visit` | `organization_id`, `appointment_id`, `pet_id`, `status` (see [tracking](tracking.md)), `size_class_at_booking`, `size_class_at_checkin`, `weight_g_at_checkin`, `preferred_groomer_id` (nullable), `kennel_resource_id` (nullable), `eta_at`, `eta_notified_at`, `ready_at`, `picked_up_at`, `picked_up_by_name`, `price_cents_quoted`, `price_cents_final`, `report_published_at` |
| `pet_visit_service` | `pet_visit_id`, `service_id`, `price_cents`, `duration_min` (snapshots) |
| `appointment_segment` | copied; adds `pet_visit_id`, `stage` (`BATH`/`DRY`/`GROOM`/`FINISH`/`KENNEL`); `staff_user_id` becomes **nullable** (kennel segments have no person) |
| `visit_step` | `organization_id`, `pet_visit_id`, `stage` (`RECEIVED`, `BATH`, `DRY`, `GROOM`, `FINISH`, `READY`), `sort`, `status` (`PENDING`, `IN_PROGRESS`, `DONE`, `SKIPPED`), `started_at`, `finished_at`, `performed_by_staff_id`, `recorded_by_staff_id` (differs when reception marks it), `client_ref` |
| `visit_observation` | `pet_visit_id`, `kind` (`MATTING`, `FLEAS`, `TICKS`, `SKIN_IRRITATION`, `EAR_ISSUE`, `NAIL_ISSUE`, `LUMP`, `OTHER`), `severity` (`LOW`/`MEDIUM`/`HIGH`), `note`, `media_id` (nullable), `recorded_by_staff_id` |
| `visit_report` | `pet_visit_id` (PK), `summary_note`, `recommendations` (text), `next_visit_weeks` (nullable), `published_at` |
| `payment_record` | `appointment_id`, `amount_cents`, `method` (`CASH`, `CARD_EXTERNAL`, `ZELLE`, `VENMO`, `OTHER`), `recorded_by_staff_id`, `recorded_at` — no card data, nothing processed **(call)** |

### Exclusion constraints (raw SQL, as BeautySpa)

```sql
ALTER TABLE appointment_segment ADD CONSTRAINT no_employee_overlap EXCLUDE USING gist (
  staff_user_id WITH =, tstzrange(starts_at, block_ends_at, '[)') WITH &&
) WHERE (occupies AND staff_user_id IS NOT NULL);

ALTER TABLE appointment_segment ADD CONSTRAINT no_resource_overlap EXCLUDE USING gist (
  resource_id WITH =, tstzrange(starts_at, block_ends_at, '[)') WITH &&
) WHERE (occupies AND resource_id IS NOT NULL);

ALTER TABLE appointment_segment ADD CONSTRAINT segment_staff_matches_stage CHECK ((stage = 'KENNEL') = (staff_user_id IS NULL) AND (stage <> 'KENNEL' OR resource_id IS NOT NULL));
```

`segment_staff_matches_stage`: kennel segments have no person and must have a kennel resource; every other stage must have a person.
Kennel segments store `duration_min` = hold length and `price_cents` = 0.

Kennel segments are ordinary segments with `stage = KENNEL`, a kennel
`resource_id` and no staff, so the resource constraint guards kennels too.
`segment_time_order` CHECK copied. `occupies` rules copied, plus: when a pet is
marked picked up, its kennel segment's `ends_at` and `block_ends_at` are both
set to now (frees the kennel early, keeps `segment_time_order` valid) in the
same transaction; overstay extension in [availability](availability.md).
`appointment_segment.service_id` becomes nullable: merged stage and kennel
segments list their services through `pet_visit_service`.

## Relationships

```
organization 1─* location 1─* resource (stations, kennels)
customer 1─* pet 1─* pet_vaccine
appointment 1─* pet_visit 1─* pet_visit_service *─1 service 1─* service_price
pet_visit 1─* appointment_segment   pet_visit 1─* visit_step
pet_visit 1─* visit_observation     pet_visit 1─1 visit_report
pet/visit 1─* media                 appointment 1─* payment_record
```
