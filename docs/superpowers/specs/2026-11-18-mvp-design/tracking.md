# Tracking: steps, groomer screen, ETA, report card

The product's core promise. Logic lives in `packages/tracking` (pure) and the
API's `visits` module.

## State machines

**Appointment**

```
HELD → BOOKED → IN_SHOP → COMPLETED
  │       ├──→ CANCELLED
  │       └──→ NO_SHOW
  └──→ CANCELLED (hold expired)
```

`IN_SHOP` when the first pet is received; `COMPLETED` when every non-cancelled
pet is picked up.

**Pet visit**

```
BOOKED → RECEIVED → IN_PROGRESS → READY → PICKED_UP
   └→ CANCELLED / NO_SHOW (with the appointment, or one pet removed by staff)
```

**Steps.** At check-in the API creates `visit_step` rows: `RECEIVED` (done at
check-in), one per stage that has a segment, then `READY`.

Rules (enforced in `packages/tracking`, re-checked by the API):
- Only one step per pet `IN_PROGRESS` at a time.
- Starting a step finishes the previous in-progress step (one tap).
- A step may be `SKIPPED` (with reason) by groomer or reception.
- Steps start in order; reception may correct order/timestamps (audited).
- Marking `READY` finishes the open step; requires an `AFTER` photo when
  `requireAfterPhoto`, and every stage step `DONE` or `SKIPPED`.
- `performed_by` = the person who tapped, or the person reception selects when
  marking on someone's behalf (`recorded_by` keeps the actual actor).

## Groomer screen (phone, PWA)

```
┌ Today · Ana ─────────────┐
│ 🐶 Max (Poodle, M)        │
│ ⚠ Allergy: oatmeal        │
│ [ ▶ Start DRY ]           │
│ 📷 Before ✓   + Note      │
├───────────────────────────┤
│ 🐶 Luna · kennel 4        │
│ [ ▶ Start BATH ]          │
└───────────────────────────┘
```

- Lists the pets with a segment assigned to the signed-in person today, in
  planned order; allergies, temperament and medical flags always visible.
- One big button per pet = next step. Camera opens inline for BEFORE (at bath
  start, if reception did not take one), AFTER (at Ready) and optional step
  photos.
- Observations: one-tap chips (matting, fleas, ticks, skin, ears, nails, lump)
  with severity, optional note or photo.
- 44 px+ targets, high contrast, works one-handed.

## Offline queue

- Every write (step change, observation, note, photo) gets a client UUID
  `client_ref` and `occurredAt` from the device; stored in IndexedDB and sent
  in order when online. Photos stay in IndexedDB until their upload completes.
- The API is idempotent on `client_ref`; it accepts `occurredAt` if within the
  last 12 h and not in the future (+2 min skew), else uses server time.
- Conflicts (e.g. reception already marked the step): server state wins; the
  queued item returns `409 STEP_CONFLICT` and the app drops it and refreshes.
- UI shows "3 changes pending" while offline; never an error modal.

## ETA

`packages/tracking.estimateReady(visit, segments, steps, now)`:
for each remaining stage in order, `start = max(planned start, previous
estimated end, now)` and `end = start + duration`; an in-progress step ends at
`max(started_at + duration, now + 5 min)`. ETA = last end. Pure estimate; it
does not move DB segments.

- Recomputed on every step change and every 5 min by a worker for visits
  `IN_PROGRESS`/`RECEIVED`.
- Owner's page updates live when ETA moves ≥ 5 min.
- WhatsApp "running late, new time ~X" when ETA moves ≥ `etaNotifyThresholdMin`
  (30) from the last notified value, at most once per hour per visit **(call)**.
- `READY` → WhatsApp "Max is ready for pickup" with the tracking link.

## Owner tracking page

Reached from the WhatsApp/email link (signed, no login; same HMAC mechanism as
BeautySpa's manage link, `exp` = end of the appointment day + 7 days) or from
the logged-in owner area.

```
Max · Bath & cut
● Received   9:05  (Carla)
● Bath       9:20  (Carla)
◐ Dry        now
○ Groom
○ Ready      ~1:30 pm
```

Live via SSE (fallback polling). Staff names shown as display names only.

## Report card

Created when the pet is marked `READY`; published automatically at `READY`
(report link in the ready message). Contents: before/after photos, each step
with who and when, observations, groomer's summary note, recommendations and
"next visit in N weeks" (optional). Staff may edit summary/recommendations for
24 h after publish (audited). Visible in the pet's history forever (until the
owner deletes the account).
