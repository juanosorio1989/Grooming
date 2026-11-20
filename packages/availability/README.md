# @grooming/availability

Pure slot-search domain logic for grooming visits (no DOM, Node or framework APIs). Time is UTC epoch ms,
intervals are half-open `[start, end)`. `findSlots` lists bookable slots for one local date; `validatePlan` re-checks one exact slot.
Input: `FindSlotsInput` = `Context` (location, services, prices, employees, resources, busy, `mode` ONLINE|STAFF,
`now`, `override`) + `SlotRequest` (`bookingMode` WAIT|DROP_OFF, `pets` max 4, 6 services each) + `date`.
Kennel busy rows have `employeeId: null`. Output: `Slot { start, readyAt, bookingMode, pets: PetPlan[] }`, each
`PetPlan` with `PlannedSegment`s in stage order (BATH, DRY, GROOM, FINISH), then KENNEL in drop-off.
## Search rules (`search.ts`)

- Pets in request order, segments in stage order, one pet finished before the next; later pets see earlier pets as busy.
- A segment may start exactly at its lower bound (even off the grid), later starts are grid times; wait pins the first pet's first segment to `t`.
- Lower bounds: wait `t`; drop-off `d + DROP_OFF_INTAKE_MIN` (10); otherwise the previous segment's end.
- Idle: wait, gap within a pet ≤ `WAIT_MAX_GAP_MIN` (15); drop-off, initial wait + gaps per pet ≤ `maxQueueWaitMin`.
- Rule B (`blockEndFor`): `blockEnd = end + buffer`, unless the same employee starts the pet's next segment at `end` and the station is kept (or none).
- Kennel (drop-off): first feasible kennel by name, backtracking; free over `[d, lastEnd + pickupGraceMin)`, one per pet, as a `KENNEL` segment.
- Budget `MAX_NODES_PER_START` (5000) per start; beyond it no slot. Drop-off times: grid times inside `dropOffWindows`, except STAFF + override.
- Node count: one per (employee, station-or-none) attempt whose employee passed the free/clash check, plus one per kennel attempt; symmetric (skipped) candidates cost nothing.
## validatePlan (`validate-plan.ts`)

`validatePlan(input: Context & SlotRequest, slot)` returns `{ ok: true }` or `{ ok: false, reason }`; it does not
search. Checks in order, first failure wins: structure, qualification, date, shape, Rule B buffers, resources, free time.
Reasons: `NOT_QUALIFIED`, `EMPLOYEE_UNAVAILABLE`, `RESOURCE_UNAVAILABLE`, `TOO_SOON`, `BEYOND_HORIZON`, `NOT_BOOKABLE_ONLINE`,
`OUTSIDE_DROP_OFF_WINDOW`, `MALFORMED_PLAN`. API: all but `MALFORMED_PLAN` map to `SLOT_TAKEN`/409, `MALFORMED_PLAN` to 422 (final in Plan 04).
## Errors and files

`AvailabilityError.code`: `NO_PETS`, `TOO_MANY_PETS`, `DUPLICATE_PET`, `NO_SERVICES`, `TOO_MANY_SERVICES`, `DUPLICATE_SERVICE`,
`UNKNOWN_SERVICE`, `UNKNOWN_EMPLOYEE`, `SPECIES_MISMATCH`, `NO_PRICE_FOR_PET`, `STAGE_RESOURCE_MISMATCH`.
Files: `intervals`, `free-time`, `prepare` (precompute, earliest start, horizon), `resolve` (stage segments, prices, candidates),
`search`, `find-slots`, `validate-plan`, `types`, `errors`.
