# @grooming/availability

Pure slot-search domain logic for grooming visits (no DOM, Node or framework APIs).
Time is UTC epoch ms, intervals are half-open `[start, end)`. Tasks 5 and 6 add
`findSlots` and `validatePlan` and extend this page.

## Inputs

`FindSlotsInput` = `Context` (location, services, prices, employees, resources, busy,
`mode` ONLINE|STAFF, `now`, `override`) + `SlotRequest` (`bookingMode` WAIT|DROP_OFF,
`pets`, max 4 pets and 6 services each) + `date` (one local date). Kennel busy rows
have `employeeId: null`.

## Outputs

`Slot { start, readyAt, bookingMode, pets: PetPlan[] }`; each `PetPlan` holds
`PlannedSegment`s in stage order (BATH, DRY, GROOM, FINISH), then KENNEL in drop-off.

## Error codes (`AvailabilityError.code`)

`NO_PETS`, `TOO_MANY_PETS`, `DUPLICATE_PET`, `NO_SERVICES`, `TOO_MANY_SERVICES`,
`DUPLICATE_SERVICE`, `UNKNOWN_SERVICE`, `UNKNOWN_EMPLOYEE`, `SPECIES_MISMATCH`,
`NO_PRICE_FOR_PET`, `STAGE_RESOURCE_MISMATCH`.

## Files

- `intervals.ts`: normalize, subtract, intersect, covers.
- `free-time.ts`: employee and resource free time for a local day.
- `prepare.ts`: per-call precompute, earliest start, horizon, pet/service limits.
- `resolve.ts`: groups each pet's services into stage segments with prices and ordered candidates.
- `types.ts`, `errors.ts`: shared types and error codes.
