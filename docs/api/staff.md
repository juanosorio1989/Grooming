# Employees, working hours and time off

All paths under `/v1/staff`. Schemas live in `packages/contracts/src/staff.ts`. A row of another organization is 404.
`POST /employees/:id/invite` and `POST /employees/:id/reset-2fa` belong to the auth area (see the auth docs).

## Employees

`EmployeeView = { id, displayName, role, email, locale, active, canLogin, skills, bookableOnline, bio, serviceIds }`.

| Method and path | Who | Notes |
| --- | --- | --- |
| `GET /employees?includeInactive=` | OWNER, RECEPTION, EMPLOYEE | All staff roles. EMPLOYEE sees only active people and no `email` |
| `GET /employees/:id` | OWNER, RECEPTION, EMPLOYEE | EMPLOYEE gets no `email` |
| `POST /employees` | OWNER | `{ displayName (1..60), role (default EMPLOYEE), email?, locale, skills (unique), bookableOnline (default true), bio? }` -> 201. Creates the staff user (`canLogin: false`; accepting the invite sets it), the profile and the default-location link. Duplicate email in the org is `409 CONFLICT`. Audit `employee.create` |
| `PATCH /employees/:id` | OWNER | Any subset of the create fields plus `active`. A role change or `active: false` revokes the person's refresh tokens in the same transaction. Demoting or deactivating the last active owner who can sign in (`canLogin`) is `409 CONFLICT`. Removing a skill that an assigned service needs is 400. Audit `employee.update` |
| `PUT /employees/:id/services` | OWNER | `{ serviceIds }` replaces the assignments. Each id must be an active service of the org and its `requiredSkill` must be in the person's skills, else 400. Audit `employee_services.replace` |
| `GET /employees/:id/working-hours` | OWNER, RECEPTION, EMPLOYEE (own only, else 403) | `{ weekday, start, end }[]` for the default location, ordered by weekday then start |
| `PUT /employees/:id/working-hours` | OWNER | Replaces all rows (max 21). `weekday` 0 (Sunday) to 6; `start < end`; `end` may be `"24:00"`; overlapping ranges on one weekday are 400 (touching is fine). Audit `working_hours.replace` |

## Time off

`TimeOff = { id, staffUserId, startsAt, endsAt, kind (VACATION|BLOCK), note? (max 200) }`, instants in ISO 8601. Rows apply
to all locations.

| Method and path | Who | Notes |
| --- | --- | --- |
| `GET /time-off?staffUserId=&from=&to=` | OWNER, RECEPTION, EMPLOYEE | Returns rows overlapping `[from, to)`. EMPLOYEE sees only their own; another `staffUserId` is 403 |
| `POST /time-off` | OWNER, RECEPTION | `endsAt` must be after `startsAt` (400) -> 201. Audit `time_off.create` |
| `PATCH /time-off/:id` | OWNER, RECEPTION | Any subset except `staffUserId`; the merged range is re-checked. Audit `time_off.update` |
| `DELETE /time-off/:id` | OWNER, RECEPTION | 204. Audit `time_off.delete` |
