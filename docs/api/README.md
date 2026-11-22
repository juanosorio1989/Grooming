# API modules

One page per area. All paths are under `/v1`.

Referencing ids in a body: one unknown referenced id is 404; invalid entries inside a list are 400.

- [Audit](audit.md) - OWNER-only audit log reader
- [Settings](settings.md) - location settings, weekly hours, closures
- [Resources](resources.md) - resource types (stations, kennels) and resources
- [Catalog](catalog.md) - service categories, services (stage/resource rule) and the size x coat price matrix
- [Staff](staff.md) - employees (profile, skills, services), working hours, time off
- [Owner sign-in](owner-sign-in.md) - Google sign-in for owners (nonce, ID token check, link ticket on phone verify, link outbox row), feature flag, cookies
- [Customers](customers.md) - staff customer search/create/edit and the owner `/me` profile
- [Pets](pets.md) - pets and vaccines for owners and staff, EMPLOYEE "today" scope, encrypted medical notes, duplicate merge
- [Public](public.md) - unauthenticated locations, services, employees and breeds for the booking web
- [Availability](availability.md) - `GET /availability` online slots for anonymous visitors (inline pets) and owners (saved pets), 7-day cap, engine error mapping, rate limit
