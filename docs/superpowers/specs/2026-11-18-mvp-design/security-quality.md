# Security, privacy, quality — changes from BeautySpa

Everything in BeautySpa's `security-quality.md` applies (OWASP baseline,
helmet, CORS, Zod, in-house Redis rate limiter, Twilio signature checks,
secrets script, audit log, consent history, export/delete, i18n, WCAG AA,
testing levels, Sentry). Additions:

## Security

- Turnstile on `POST /auth/otp/start` and `POST /holds` for anonymous web
  clients (verified server-side; skipped for authenticated customers and in
  test) **(call)**.
- Media: presigned URLs only (PUT 5 min, GET 10 min); content-type and size
  verified on `complete`; EXIF location stripped client-side before upload and
  re-checked server-side (reject if GPS tags remain) **(call)**.
- Media rate limits: 60 uploads per staff user per hour; 20 per customer per
  day.
- Tracking tokens: HMAC-signed, scoped to one appointment, read-only.
- Audit additions: step changes made on behalf, timestamp corrections, price
  adjustments, vaccine verifications, report edits, check-in/out, payments.
- Cloudflare WAF and rate limiting in front of web and API.

## Privacy

- `DELETE /me` also deletes pet photos and vaccine cards from storage and
  anonymizes pets; visit rows stay for the shop's records, detached.
- Export includes pets, vaccines, visit history and media download links.
- Backups: Neon point-in-time restore; R2 bucket versioning on.

## Testing additions

| Level | Scope |
|---|---|
| Unit | `pricing` (size class, matrix lookup), `tracking` (step rules, ETA), availability drop-off and multi-pet |
| Integration | kennel constraint race; idempotent step writes on `client_ref`; READY without AFTER photo → `AFTER_PHOTO_REQUIRED`; media upload/complete against the local S3 (SeaweedFS); SSE receives a step change |
| E2E (Playwright, mobile viewport) | online booking with a new pet (drop-off); check-in → groomer marks steps → owner tracking page updates → ready message (fake provider) → check-out; groomer goes offline, marks two steps, comes back online, steps sync |

## Seeds

One organization and location, ~15 grooming services with EN/ES names and full
S/M/L/XL × coat price matrix, 2 bathers, 2 groomers, 3 tubs, 3 tables,
2 dryers, 10 kennels, sample owners with dogs and a cat, past visits with
reports.
