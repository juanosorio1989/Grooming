# Architecture

Same shape as BeautySpa (`~/Claude/beautySpa/BeautySpa`,
`docs/superpowers/specs/2026-11-17-mvp-design/architecture.md`). This page
lists only what is copied, what changes, and what is new.

## Monorepo (Turborepo + pnpm, TypeScript)

```
apps/
  web/        Next.js App Router: public site, booking, owner area, tracking page,
              staff panel (reception board, groomer screen, admin), PWA
  api/        NestJS REST /v1, OpenAPI; BullMQ worker entrypoint in the same app
  mobile/     reserved — README only (phase 3)
packages/
  contracts/     Zod schemas + types for every request/response
  api-client/    typed fetch client; pluggable TokenStore
  availability/  pure slot engine (no I/O) — extended, see availability.md
  datetime/      timezone/DST helpers
  pricing/       NEW pure: size class from weight, price/duration lookup in the matrix
  tracking/      NEW pure: step state machine and ETA estimate (used by api, web, mobile)
  i18n/          EN/ES catalogs
  config/        tsconfig, eslint, vitest presets
docker-compose.yml   postgres 16, redis 7, mailpit, minio (local S3 for photos)
```

Rule from BeautySpa kept: `packages/*` (except `config`) import no DOM,
Next.js, NestJS or Node-only APIs; enforced by eslint and a no-DOM typecheck.
No business logic in web.

## Copied from BeautySpa at commit `8a778d5`

Copy, rename `@beautyspa/*` → `@grooming/*`, `bs_` cookie/header prefixes →
`gr_`, `beautyspa` JWT `iss`/`aud` → `grooming`. Behavior unchanged unless this
spec says otherwise. Record the source commit in `docs/provenance.md`.

| Piece | Notes |
|---|---|
| Root tooling, `packages/config`, CI workflows, docker-compose, `.nvmrc` | add minio service |
| `packages/datetime`, `packages/contracts` (auth parts), `packages/api-client` | as is |
| `packages/availability` | then extended (availability.md); drop levels and the parallelizable-service block |
| `apps/api`: `auth`, `tenancy`, `audit`, `rate-limit`, `redis`, `mail`, `config`, `common`, `health`, `prisma` setup, `cli/create-owner` | `employee_profile.level_id` and `level` table removed |
| Prisma migrations | squashed into one fresh initial migration, keeping the hand-written exclusion constraints and the drift check |

## API modules

Copied: `auth`, `tenancy`, `audit`, `notifications`, `webhooks`.
Changed: `catalog` (pricing matrix, stages, species), `staff` (skills),
`availability`, `appointments` (multi-pet, drop-off).
New: `pets` (profile, vaccines, photos), `visits` (steps, observations, report
card), `media` (presigned uploads/downloads), `realtime` (SSE).

## Realtime (live timeline)

- When a step changes, the `visits` service publishes
  `{ visitId, appointmentId, step, status, eta }` on Redis channel
  `org:{orgId}:appt:{appointmentId}` and `org:{orgId}:board:{locationId}:{date}`.
- `GET /v1/track/:token/stream` (owner, signed link) and
  `GET /v1/staff/board/stream` (staff) are **Server-Sent Events** endpoints
  subscribed to those channels. Heartbeat every 25 s.
- Web falls back to polling every 30 s when SSE fails. **(call)** SSE over
  WebSockets: one-way updates, works through proxies, trivial on Railway/Fly.
- The api process must keep long-lived connections: no serverless for the API.

## Photos and files (`media`)

- Storage: Cloudflare R2 (S3 API) in production, minio locally. One private
  bucket `pet-media` (photos and vaccine cards), no public access, versioning
  on.
- Upload: client asks `POST /v1/media/uploads` `{ kind, petId|visitId, contentType, bytes }`
  → API checks role/ownership, returns a presigned PUT URL (5 min) and a
  `mediaId`; client uploads, then `POST /v1/media/:id/complete`. API verifies
  the object exists and its size/type (JPEG, PNG, WebP, HEIC; ≤ 10 MB).
- Clients compress before upload (longest side 1600 px, WebP/JPEG ~80%)
  **(call)**. HEIC from iPhone is converted client-side when the browser can,
  otherwise accepted as is.
- Download: API returns presigned GET URLs valid 10 min; never public URLs.
- Object keys: `org/{orgId}/pets/{petId}/{mediaId}`; no names or phones in keys.

## Authentication

As BeautySpa (approach B, in-house tokens):
- Owner (customer): phone + OTP via Twilio Verify (WhatsApp, SMS fallback).
- Staff: email + password + mandatory TOTP; staff refresh lifetime 12 h (one
  shift), so a groomer logs in once per shift on their phone.
- Staff who never log in (`can_login = false`) still get schedules; a groomer
  who marks steps must log in.

## Notifications

Router, providers and BullMQ reminder jobs copied from BeautySpa. New
templates in [flows](flows.md). Debounce of ETA messages in
[tracking](tracking.md).

## PWA

As BeautySpa, plus: the groomer screen caches today's assigned visits for
offline viewing and queues writes ([tracking](tracking.md)). No push in the
MVP.
