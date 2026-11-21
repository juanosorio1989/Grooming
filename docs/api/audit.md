# Audit

`GET /v1/staff/audit` (OWNER only) reads `audit_log` for the organization.

Query (strict; unknown keys are 400):

| Param | Meaning |
| --- | --- |
| `entity` | Filter by entity name (e.g. `service`) |
| `entityId` | Filter by entity id (text; may be a composite key) |
| `limit` | 1..100, default 50 |
| `before` | Opaque cursor `<ISO at>_<id>` from a previous `nextBefore` (400 otherwise) |

Response: `{ items: AuditItem[]; nextBefore: string | null }`, ordered `at desc, id desc`.
`AuditItem = { id, at, actorType, actorId, action, entity, entityId, before, after }`; `ip` is never returned.
`nextBefore` is a keyset cursor over (`at`, `id`) of the last returned item when more rows exist; pass it as `before` for the next page. Rows with identical `at` are neither repeated nor skipped.

Entity strings written today: `service_category`, `service`, `resource_type`, `resource`, `settings`, `location_hours`,
`closure`, `staff_user`, `time_off`, `customer`, `pet`, `pet_vaccine`, plus `refresh_token_family` (auth).
Actions:

- catalog: `category.create|update|delete`, `service.create|update|deactivate`, `service_price.replace`
- resources: `resource_type.create|update|delete`, `resource.create|update|deactivate`
- settings: `settings.update`, `location_hours.replace`, `closure.create|delete`
- staff (entity `staff_user` unless noted): `employee.create|update`, `employee_services.replace`, `working_hours.replace`,
  `time_off.create|update|delete` (entity `time_off`), `staff.invite`, `staff.owner_cli`
- customers: `customer.create|update`
- pets: `pet.create|update|delete|merge`, `pet_vaccine.create|update|delete|verify`
- auth: `auth.staff.login|login_failed|invite_accepted|mfa_enrolled|password_reset|recovery_used`, `auth.customer.login`, `auth.refresh_reuse`

Writers use `AuditService.record` (see `apps/api/src/audit/audit.service.ts`); never put secrets in `before`/`after`.
