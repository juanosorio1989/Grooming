# @grooming/tracking

Pure helpers for visit/appointment statuses and the grooming step state machine. Depends only on `@grooming/datetime`.

## Exports

- Types: `Ms`, `WorkStage`, `StepStage`, `StepStatus`, `Step`, `PetVisitStatus`, `AppointmentStatus`, `StepAction`, `StepContext`, `TrackingErrorCode`
- `WORK_STAGE_ORDER` (`BATH → DRY → GROOM → FINISH`)
- `canTransitionVisit`, `canTransitionAppointment`, `appointmentStatusAfterVisits`
- `buildInitialSteps`, `visitStatusFromSteps`, `applyStepAction` (pure, never mutates), `validateSteps`
- `effectiveOccurredAt`, `OCCURRED_AT_MAX_AGE_MS` (12 h), `OCCURRED_AT_MAX_SKEW_MS` (2 min)

## Action rules

- All actions: RECEIVED must be DONE and READY not DONE, else `STEP_CONFLICT`; `at` is clamped to the latest timestamp already recorded.
- START: target must be PENDING; an earlier PENDING work step gives `STEP_ORDER`; the open step becomes DONE.
- SKIP: target PENDING or IN_PROGRESS becomes SKIPPED; order is not enforced.
- READY: closes the open step; a PENDING work step gives `STEP_ORDER`; a missing required after photo gives `AFTER_PHOTO_REQUIRED`.

## Error codes

`STEP_CONFLICT`, `STEP_ORDER` and `AFTER_PHOTO_REQUIRED` map to API codes of the same name.
`INVALID_TIMELINE` maps to 422 on reception corrections.
