# Availability engine

Starts from BeautySpa's `packages/availability` (pure function, server
authoritative, re-validated on write, exclusion constraints as final guard).
Free-time computation, slot grid, lead time, horizon, STAFF mode, overrides and
DST handling are **unchanged**. This page lists the changes.

## Inputs (changed)

```ts
findSlots({
  location,     // + dropOffWindows, maxQueueWaitMin, pickupGraceMin
  request: {
    mode: 'WAIT' | 'DROP_OFF',
    pets: [{ petId, sizeClass, coatType, species,
             services: [serviceId], preferredGroomerId | 'ANY' }],   // ≤ 4 pets, ≤ 6 services each
    date | range,
  },
  services, prices,      // stage, resource type, required skill; service_price rows
  employees,             // skills, qualified services, hours, time off
  resources,             // stations and kennels by type
  busy, mode: 'ONLINE' | 'STAFF', now,
}) -> Slot[]

Slot = { start, readyAt, mode, pets: [{ petId, priceCents, segments: [...] }] }
```

The request's `mode` is resolved by the API before calling: if any chosen
service is `DROP_OFF` (own setting or location default), the whole appointment
is drop-off **(call)**.

## Per pet: segments from stages

For each pet, group its services by stage in the fixed order
`BATH → DRY → GROOM → FINISH`; each non-empty stage is one segment.
Duration = sum of the stage's services from the price matrix for the pet's size
class and coat; buffer = max of their buffers. Person must have the stage's
required skill and be qualified for every service in it. `preferredGroomerId`
applies to `GROOM` and `FINISH` segments only; bath/dry are assigned like
"Any". Segments of one pet never overlap and keep stage order.

Remove from BeautySpa: levels and the parallelizable-services block.

## Wait mode

For candidate start `t`, the first pet's first segment starts at `t`. Pets are
placed in the owner's order; each segment starts at the **earliest grid time
at or after its pet's previous segment end** (or `t` for a pet's first
segment) where a qualified person and station are free — so with one bather
and one groomer, pet 2 is bathed while pet 1 is groomed (pipelined)
**(call)**. Within one pet, idle time between segments is at most 15 min
(the owner is waiting) **(call)**; otherwise that `t` yields no plan. Same
backtracking, symmetry reduction and node budget as BeautySpa. `readyAt` =
latest segment end. No kennel.

## Drop-off mode

The owner chooses a **drop-off time**; the shop does the work later that day.

1. Candidate drop-off times `d`: slot grid inside the location's
   `dropOffWindows` for that day (and lead time / horizon rules as usual).
2. For each pet, build its chain of segments: segment 1 may start at any grid
   time from `d + 10 min` (intake, **call**); segment n+1 at or after segment
   n's end. **Total idle time per pet** — from `d + 10 min` to segment 1's
   start plus every gap between segments — is at most `maxQueueWaitMin`
   **(call)**. Search earliest-first; first feasible chain wins.
3. Pets of one appointment are planned in order; later pets see earlier pets'
   segments as busy.
4. **Kennel**: each pet needs one free kennel over
   `[d, lastSegmentEnd + pickupGraceMin)`. Kennel segment stored with
   `stage = KENNEL`. No free kennel → no slot. Pets of one appointment may
   share a kennel only if staff assigns it at check-in (MVP books one each)
   **(call)**.
   **Overstay (call):** while a `READY` pet is not picked up, a worker every
   5 min extends its kennel segment (`ends_at` and `block_ends_at`) to
   now + 15 min. If the extension would collide with another booking, it is
   not written; the board shows a red "kennel conflict" on both pets so
   reception reassigns one at that pet's check-in.
5. `readyAt` = latest segment end across pets. The owner sees
   "Drop off 9:00 · ready around 1:30 pm" (rounded up to 15 min).
6. Return one plan per drop-off time; the slot list is drop-off times only.

The planned segments are a **feasibility plan**, not a promise of exact times.
Staff reorder them on the board ([flows](flows.md)); moves re-run the check for
the changed segments and the constraints guard races.

## Write-time validation and holds

As BeautySpa: `POST /holds` re-validates the exact plan in a transaction and
inserts segments (including kennel segments) as `HELD`; same hold minutes,
sweeper and `SLOT_TAKEN` mapping.

## Price shown

Online, price per pet from the matrix; if the pet's coat/size row is missing,
the service is hidden for that pet. If the pet has no weight yet, the owner
picks a size class in the booking flow. Final price can change at check-in when
the weight puts the pet in another class or for matting (reception edits
`price_cents_final` with a reason; audited).

## Required tests (add to BeautySpa's)

- Price/duration lookup: exact coat row, `NULL` coat fallback, missing row.
- Stage grouping and order; skill and qualification per stage; preferred
  groomer only on GROOM/FINISH.
- Wait mode: two pets with two free bathers start together; with one bather
  and one groomer, pet 2's bath runs during pet 1's groom (pipelined); a
  pet idle > 15 min between its own segments → no slot at that `t`.
- Drop-off: initial wait + gaps within `maxQueueWaitMin` → slot; one minute
  more → no slot; no free kennel → no slot; kennel freed by pickup grace boundary.
- Drop-off windows respected; DST day still correct.
- Two concurrent holds on the last kennel → one `SLOT_TAKEN`.
