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

Writers use `AuditService.record` (see `apps/api/src/audit/audit.service.ts`); never put secrets in `before`/`after`.
