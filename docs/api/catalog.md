# Categories, services and price matrix

All paths under `/v1/staff`. Schemas live in `packages/contracts/src/catalog.ts`. Mutations are OWNER only; GETs also
allow RECEPTION and EMPLOYEE. A row of another organization is 404.

## Categories

| Method and path | Notes |
| --- | --- |
| `GET /categories` | `{ id, name, sort }[]` ordered by `sort` |
| `POST /categories` | `{ name: { en, es }, sort? >= 0 }` -> 201; audit `category.create` |
| `PATCH /categories/:id` | any subset; audit `category.update` |
| `DELETE /categories/:id` | hard delete, 204; services keep `categoryId = null`; audit `category.delete` |

## Services

| Method and path | Notes |
| --- | --- |
| `GET /services?includeInactive=` | `ServiceView[]` (service fields plus `id`, `active`, `prices`); inactive hidden by default |
| `GET /services/:id` | one `ServiceView` |
| `POST /services` | `{ categoryId?, name, description?, species, stage, isMain, resourceTypeId?, requiredSkill, bookingMode?, bufferAfterMin 0..120, onlineBookable }` -> 201; audit `service.create` |
| `PATCH /services/:id` | any subset plus `active`; audit `service.update` |
| `DELETE /services/:id` | sets `active = false`, 204; audit `service.deactivate` |

`resourceTypeId` must reference a `STATION` type of the organization (a `KENNEL` type is 400, unknown id 404).

### Stage rule

Two active services conflict when they have the same `stage`, compatible species (equal, or either is `ANY`) and a
different `resourceTypeId` (null counts as a value). Create and PATCH (when the result is active, so reactivation is
checked too) that would conflict return `409 STAGE_RESOURCE_MISMATCH`; `detail` names the other service id. The check
is `checkStageRule` in `apps/api/src/catalog/stage-rule.ts`, run inside the write transaction.

## Price matrix

| Method and path | Notes |
| --- | --- |
| `GET /services/:id/prices` | `{ sizeClass, coatType \| null, durationMin 1..480, priceCents 0..1_000_000 }[]` |
| `PUT /services/:id/prices` | replaces all rows in one transaction; at most 28 rows, `(sizeClass, coatType)` unique (400 otherwise, old rows stay); `[]` clears; audit `service_price.replace` with `before`/`after` = `{ rows }` |

`coatType: null` is the any-coat row, used when no exact coat row exists.
