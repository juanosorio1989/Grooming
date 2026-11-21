# Resource types and resources

All paths under `/v1/staff`. Schemas live in `packages/contracts/src/resources.ts`. Mutations are OWNER only;
GETs also allow RECEPTION and EMPLOYEE. A row of another organization is 404.

## Resource types

| Method and path | Notes |
| --- | --- |
| `GET /resource-types` | `{ id, name, kind, resourceCount }[]` (`kind` is `STATION` or `KENNEL`) |
| `POST /resource-types` | `{ name: { en, es }, kind }` -> 201; audit `resource_type.create` |
| `PATCH /resource-types/:id` | `{ name }` only; `kind` is immutable (sending it is 400); audit `resource_type.update` |
| `DELETE /resource-types/:id` | 204; `409 IN_USE` when any resource or service references it; audit `resource_type.delete` |

## Resources

| Method and path | Notes |
| --- | --- |
| `GET /resources?kind=&includeInactive=` | `{ id, name, resourceTypeId, kind, active }[]`, ordered by type then name; inactive rows hidden unless `includeInactive=true` |
| `POST /resources` | `{ resourceTypeId, name (1..60) }` -> 201, in the default location; audit `resource.create` |
| `PATCH /resources/:id` | `{ name?, active? }`; audit `resource.update` |
| `DELETE /resources/:id` | Sets `active = false`, 204; audit `resource.deactivate` |

An active resource name is unique per location (case-insensitive), otherwise `409 CONFLICT`. The check also runs
when renaming and when reactivating. It is an application check inside the transaction, not a database index.
