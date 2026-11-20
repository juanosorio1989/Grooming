# @grooming/tracking

Pure helpers for visit/appointment statuses and the grooming step state machine. Depends only on `@grooming/datetime`.

## Exports

- Types: `Ms`, `WorkStage`, `StepStage`, `StepStatus`, `Step`, `PetVisitStatus`, `AppointmentStatus`, `StepAction`, `StepContext`, `TrackingErrorCode`; `WORK_STAGE_ORDER` (`BATH → DRY → GROOM → FINISH`)
- `canTransitionVisit`, `canTransitionAppointment`, `appointmentStatusAfterVisits`; `buildInitialSteps`, `visitStatusFromSteps`, `applyStepAction` (pure, never mutates), `validateSteps`
- `estimateReady`, `ownerPageEtaChanged`, `shouldNotifyEtaChange`, `PlannedStage`, `IN_PROGRESS_MIN_REMAINING_MIN` (5), `OWNER_PAGE_ETA_STEP_MIN` (5), `ETA_NOTIFY_MIN_INTERVAL_MIN` (60)
- `effectiveOccurredAt`, `OCCURRED_AT_MAX_AGE_MS` (12 h), `OCCURRED_AT_MAX_SKEW_MS` (2 min)

`appointmentStatusAfterVisits` may move BOOKED straight to COMPLETED (BOOKED → IN_SHOP → COMPLETED in one call); the API writes the returned status directly (not through `canTransitionAppointment`).

## Action rules

- All actions: RECEIVED must be DONE and READY not DONE, else `STEP_CONFLICT`; `at` is clamped to the latest timestamp already recorded (skip-aheads, SKIPPED with no `startedAt`, are ignored).
- START: target must be PENDING; an earlier PENDING work step gives `STEP_ORDER`; the open step becomes DONE.
- SKIP: target PENDING or IN_PROGRESS becomes SKIPPED; order is not enforced.
- READY: closes the open step; a PENDING work step gives `STEP_ORDER`; a missing required after photo gives `AFTER_PHOTO_REQUIRED`.
- Error codes: `STEP_CONFLICT`, `STEP_ORDER`, `AFTER_PHOTO_REQUIRED` map to API codes of the same name; `INVALID_TIMELINE` maps to 422 on reception corrections.

## ETA

- `estimateReady` returns READY's `finishedAt` when done; otherwise it walks the planned stages in `WORK_STAGE_ORDER`, skipping DONE and SKIPPED ones (a missing step is PENDING).
- IN_PROGRESS ends at `max(startedAt + duration, now + 5 min)`; PENDING starts at `max(plannedStart, previous end, now)`. An IN_PROGRESS stage missing from the plan counts as 0 min.
- The result is the last end, or `now` when no stage remains.
- `ownerPageEtaChanged(prev, next)`: true when `prev` is null or the ETA moved by 5 min or more.
- `shouldNotifyEtaChange`: true when `|next - baselineEta| >= thresholdMin` and (never notified or 60 min since `lastNotifiedAt`).
- Baseline rule: the caller passes `baselineEta` as the last notified ETA, or the booked `estimated_ready_at` when none was sent.
