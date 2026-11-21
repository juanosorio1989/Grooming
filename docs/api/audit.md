# Audit

`GET /v1/staff/audit` (OWNER only) reads `audit_log` for the organization.

Query (strict; unknown keys are 400):

| Param | Meaning |
| --- | --- |
| `entity` | Filter by entity name (e.g. `service`) |
| `entityId` | Filter by entity id (text; may be a composite key) |
| `limit` | 1..100, default 50 |
| `before` | ISO instant; only rows with `at` strictly before it |

Response: `{ items: AuditItem[]; nextBefore: string | null }`, ordered `at desc, id desc`.
`AuditItem = { id, at, actorType, actorId, action, entity, entityId, before, after }`; `ip` is never returned.
`nextBefore` is the last returned item's `at` when more rows exist; pass it as `before` for the next page.
Rows sharing the exact same millisecond as the page boundary may be skipped, since the cursor is an instant.

Writers use `AuditService.record` (see `apps/api/src/audit/audit.service.ts`); never put secrets in `before`/`after`.
