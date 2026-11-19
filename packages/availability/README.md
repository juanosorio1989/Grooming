# @grooming/availability

Pure slot-search domain logic for grooming visits (no DOM, Node or framework APIs).
Time is UTC epoch ms, intervals are half-open `[start, end)`. `findSlots` returns the
bookable slots for one local date; Task 6 adds `validatePlan`.

## Inputs

`FindSlotsInput` = `Context` (location, services, prices, employees, resources, busy,
`mode` ONLINE|STAFF, `now`, `override`) + `SlotRequest` (`bookingMode` WAIT|DROP_OFF,
`pets`, max 4 pets and 6 services each) + `date` (one local date). Kennel busy rows
have `employeeId: null`.

## Outputs

`Slot { start, readyAt, bookingMode, pets: PetPlan[] }`; each `PetPlan` holds
`PlannedSegment`s in stage order (BATH, DRY, GROOM, FINISH), then KENNEL in drop-off.

## Search rules (`search.ts`)

- Order: pets in request order, segments in stage order, one pet finished before the next; later pets see earlier pets as busy.
- Start candidates: a segment may start exactly at its lower bound (even off the grid), later starts are grid times; wait mode pins the first pet's first segment to `t`.
- Lower bounds: wait `t` for each pet's first segment; drop-off `d + DROP_OFF_INTAKE_MIN` (10); otherwise the previous segment's end.
- Idle limits: wait, each gap within a pet ≤ `WAIT_MAX_GAP_MIN` (15); drop-off, initial wait + gaps per pet ≤ `maxQueueWaitMin`.
- Rule B (`blockEndFor`): `blockEnd = end + buffer`, unless the same employee starts the pet's next segment at `end` and the station is kept (or there is none).
- Kennel (drop-off): first kennel by name free over `[d, lastEnd + pickupGraceMin)`, one per pet, appended as a `KENNEL` segment; none → no plan.
- Budget: `MAX_NODES_PER_START` (5000) placement attempts per start; beyond it that start yields no slot. First feasible plan wins.
- Slot times: wait, every grid time ≥ earliest start; drop-off, grid times inside `dropOffWindows` (half-open), except STAFF + override.

## Error codes (`AvailabilityError.code`)

`NO_PETS`, `TOO_MANY_PETS`, `DUPLICATE_PET`, `NO_SERVICES`, `TOO_MANY_SERVICES`,
`DUPLICATE_SERVICE`, `UNKNOWN_SERVICE`, `UNKNOWN_EMPLOYEE`, `SPECIES_MISMATCH`,
`NO_PRICE_FOR_PET`, `STAGE_RESOURCE_MISMATCH`.

## Files

- `intervals.ts`: normalize, subtract, intersect, covers.
- `free-time.ts`: employee and resource free time for a local day.
- `prepare.ts`: per-call precompute, earliest start, horizon, pet/service limits.
- `resolve.ts`: groups each pet's services into stage segments with prices and ordered candidates.
- `search.ts`: `blockEndFor`, backtracking `planWait` / `planDropOff`.
- `find-slots.ts`: `findSlots` (request checks, candidate times, one plan per time).
- `types.ts`, `errors.ts`: shared types and error codes.
