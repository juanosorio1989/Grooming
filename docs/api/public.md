# Public reads

Unauthenticated (`@Public()`), under `/v1/public`. Used by the owner booking web. They expose only the fields listed here: never email, role, schedules or the full location settings.

| Route | Response |
| --- | --- |
| `GET /public/locations` | `[{ id, name, address, phone, timezone, defaultBookingMode, hours: [{ weekday, opens, closes }] }]` (`closes` may be `"24:00"`) |
| `GET /public/services` | `{ categories: [{ id, name, sort }], services: [{ id, categoryId, name, description, species, stage, isMain, bookingMode, prices }] }`. Only `active` and `onlineBookable` services that have at least one price row, sorted by category sort, then main services first, then `name.en`. |
| `GET /public/employees` | `[{ id, displayName, bio, photoUrl, skills, serviceIds }]`: active staff with a profile, `bookableOnline = true` and at least one skill |
| `GET /public/breeds?species=DOG\|CAT` | `[{ code, species, en, es, defaultCoat }]` from `apps/api/src/public/breeds.json`, sorted by `en`; `Cache-Control: public, max-age=86400`. An unknown `species` is 400. |

`breeds.json` is imported as a module, so it is bundled into `dist` by the build. `code` is unique kebab-case; `defaultCoat` is a `CoatType` or `null` (mixed breeds).
