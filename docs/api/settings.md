# Settings, hours and closures

All paths under `/v1/staff`. Schemas live in `packages/contracts/src/settings.ts`.

| Method and path | Roles | Notes |
| --- | --- | --- |
| `GET /settings` | OWNER, RECEPTION | `{ location: { id, name, address, phone, timezone }, settings, hours }` |
| `PATCH /settings` | OWNER | `{ location?: { name?, address?, phone? }, settings?: LocationSettingsPatch }`; returns the GET shape |
| `PUT /settings/hours` | OWNER | Array (max 14) of `{ weekday 0..6, opens, closes }`; replaces all hours; returns the list |
| `GET /closures?from=&to=` | OWNER, RECEPTION | Closures overlapping the range (ISO instants, both optional) |
| `POST /closures` | OWNER | `{ startsAt, endsAt, reason? }` (`startsAt < endsAt`) -> 201 `{ id, ... }` |
| `DELETE /closures/:id` | OWNER | 204; a closure of another organization is 404 |

Settings (all keys required in storage): `slotIntervalMin` (5, 10, 15, 20, 30, 60), `holdMinutes` 1..30,
`cancelWindowHours` 0..168, `bookingHorizonDays` 1..365, `minLeadMinutes` 0..1440, `defaultBookingMode`
(`WAIT|DROP_OFF`), `dropOffWindows` (weekday key `"0".."6"` -> up to 4 sorted, non-overlapping wall ranges),
`maxQueueWaitMin` 0..480, `pickupGraceMin` 0..480, `sizeThresholdsLb` (`{ S, M, L }` integers, `S < M < L`,
`L <= 300`), `requireAfterPhoto`, `vaccinePolicy` (`WARN|BLOCK_CHECKIN`), `requiredVaccines`
(`{ DOG?, CAT? }`, unique vaccine types), `etaNotifyThresholdMin` 5..240.

- PATCH replaces each given top-level key as a whole. Unknown keys are 400.
- Changing `sizeThresholdsLb` re-derives `sizeClass` of every non-deleted pet with a weight, in the same
  transaction; pets without weight keep their class.
- Hours: wall times are `"HH:MM"`; `closes` may be `"24:00"` (stored as `00:00`, read back as `"24:00"`).
  Ranges of one weekday must not overlap.
- Audit (`AuditService`): `settings.update` (before/after of changed keys only; nothing is written for a no-op
  PATCH), `location_hours.replace`, `closure.create`, `closure.delete`.
- `LocationService.getDefault()` returns typed settings and is invalidated after each PATCH.
