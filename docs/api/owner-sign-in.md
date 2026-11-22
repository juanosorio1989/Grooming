# Owner sign-in (Google)

Owners can sign in with Google once their Google account is linked to their
customer record. Design and rules: [owner sign-in spec](../superpowers/specs/2026-11-18-mvp-design/owner-sign-in.md)
and its [API details](../superpowers/specs/2026-11-18-mvp-design/owner-sign-in-api.md).
Schemas live in `packages/contracts/src/auth.ts`. Code: `apps/api/src/auth/google/`.

## Feature flag

`GOOGLE_OAUTH_CLIENT_IDS` (comma-separated OAuth client IDs; the token `aud`
must be one of them). Empty (the default in dev and tests) turns the feature
off: every endpoint below (sign-in and Profile) returns `404 NOT_FOUND`, and `/auth/otp/verify`
ignores `linkTicket` and leaves `identityLinked` out of its response.

## Endpoints

| Method and path | Auth | Notes |
| --- | --- | --- |
| `POST /auth/google/nonce` | public | `200 { nonce }`. Single use, 10 min, bound to this browser by the `gr_gnonce` cookie. A newer nonce replaces the older cookie |
| `POST /auth/google` | public | Body `{ idToken (1..4096) }` (strict). Verifies the Google ID token (RS256 against Google's JWKS, issuer `accounts.google.com`, audience, expiry, `email_verified`, `nonce`), then consumes the nonce, which must carry the matching `gr_gnonce` cookie. Linked account: `200 { status: "SIGNED_IN", accessToken, accessTokenExpiresAt, refreshToken?, isNew }` with the same refresh transport as `/auth/otp/verify`. Unlinked: `200 { status: "PHONE_REQUIRED", linkTicket, name?, givenName? }` and the `gr_glink` cookie; the web then runs the phone code flow with the ticket. `401 UNAUTHORIZED` on any token, nonce or cookie failure, and when the linked customer is deleted |

An email match never links or signs in anyone. A failed token check does not
consume the nonce; a nonce or ticket lookup always deletes it.

## Profile (link and unlink)

A signed-in owner can link or unlink a Google account from their profile. Code:
`apps/api/src/auth/google/me-identities.controller.ts` and
`GoogleAuthService.link` / `unlink`.

| Method and path | Auth | Notes |
| --- | --- | --- |
| `POST /me/identities/google` | customer | Body `{ idToken (1..4096) }` (strict). Get a nonce from `POST /auth/google/nonce` first: the token's `nonce` must match and the request must carry the same browser's `gr_gnonce` cookie, else `401 UNAUTHORIZED`. `204` when linked, or already linked to this customer (the identity email is refreshed, no new audit or outbox row). `409 IDENTITY_TAKEN` when this Google account belongs to another customer **or** this customer already has another Google account; the body is the same for both, so it does not reveal which |
| `DELETE /me/identities/google` | customer | Removes this customer's Google identity. Always `204`, also when nothing is linked |

Staff tokens get `403`, no token `401`. A Profile link that creates a new link
writes the `customer.identity_linked` outbox row; re-linking the same account writes none. `GET /me`
and `PATCH /me` list linked accounts in `identities` (see
[customers](customers.md)).

## Code channels

`POST /auth/otp/start` sends the code over the channels in `OTP_CHANNELS`, in
order (comma-separated `whatsapp`, `sms`; default `sms`, so WhatsApp is never
called until its sender is active in Twilio Verify). A failing channel falls
back to the next, except: a `400` from `sms` is `400 VALIDATION_FAILED` on
`phone`, and a provider rate limit on any channel is `429 RATE_LIMITED`. When
every channel fails: `503`. The response `{ channel }` names the channel that
sent the code. Code: `apps/api/src/auth/otp/otp.service.ts`.

## Ticket on `/auth/otp/verify`

`POST /auth/otp/verify` takes an optional `linkTicket` (1..128; the body is
strict, so a misspelled key is `400 VALIDATION_FAILED`). The response carries
`identityLinked` only when a ticket was sent and the feature is on.

| Case | Result |
| --- | --- |
| Wrong code, any ticket | normal OTP error; the ticket is **not** consumed |
| Valid code, valid ticket, `sub` not linked anywhere | sign in; link; `identityLinked: true`; outbox row if the customer existed before this verify |
| Valid code, `sub` already linked to this customer | sign in; identity email refreshed; `identityLinked: true`; no outbox row |
| Valid code, ticket expired, unknown, reused, wrong or missing `gr_glink` cookie, or from another organization | sign in by phone; `identityLinked: false` |
| Valid code, `sub` linked to another customer meanwhile, or this customer has another Google account | sign in by phone; `identityLinked: false` |

A valid code always consumes the ticket. The customer find-or-create and the
link run in one transaction (`IdentityLinkService.linkInTx` in
`apps/api/src/auth/google/identity-link.service.ts`). The identity insert is
`ON CONFLICT DO NOTHING`, so a verify that loses a race to link the same `sub`
still signs in by phone instead of failing. On a link, `customer.email` and
`customer.name` are set from Google only when they are empty. The
deleted-customer `401` and the per-phone verify limit apply as before.

## Link notice (outbox)

A link to a customer who existed before this verify, and every Profile link,
writes one `outbox_event` row in the same transaction:

| Field | Value |
| --- | --- |
| `type` | `customer.identity_linked` |
| `payload.customerId` | the customer |
| `payload.googleEmail` | the Google account email (message body only) |
| `payload.notifyEmail` | `customer.email` read before the link sets it; `null` when it was empty |

A customer created in the same verify gets no row. Plan 06 adds the worker that
sends the notice; until then rows accumulate.

## Cookies

Both hold a random binding value (never the nonce or ticket). `HttpOnly`,
`SameSite=Strict`, `Secure` per `COOKIE_SECURE`, `Domain` per `COOKIE_DOMAIN`,
max age 10 min, cleared when consumed.

| Cookie | Path | Read by |
| --- | --- | --- |
| `gr_gnonce` | `/v1` | `/auth/google` and `POST /me/identities/google` |
| `gr_glink` | `/v1/auth` | `/auth/otp/verify` |

Redis: `gauth:nonce:<sha256(nonce)>` holds the binding;
`gauth:ticket:<sha256(ticket)>` holds `{ binding, orgId, sub, email, name }`.
Both expire after 600 s and are read with `GETDEL`.

## Rate limits

| Key | Limit |
| --- | --- |
| `/auth/google/nonce` per IP | 30 per 10 min |
| `/auth/google` per IP | 10 per 10 min (checked before the token) |
| `/auth/google` per `hashKeyPart(sub)` | 10 per 10 min (after the token and nonce check) |
| `POST /me/identities/google` per customer (`gauth:link:<customerId>`) | 5 per hour (checked before the token) |
| `DELETE /me/identities/google` per customer (`gauth:unlink:<customerId>`) | 5 per hour |

Over the limit: `429 RATE_LIMITED`.

## Audit

A sign-in of a linked account records `auth.customer.login` with
`after: { method: "google", isNew }`. A link records
`auth.customer.identity_linked` with `after: { provider: "GOOGLE" }` (verify or
Profile). An unlink that removed a row records `auth.customer.identity_unlinked`
with `after: { provider: "GOOGLE" }`; an unlink with nothing linked records
nothing. The Google `sub`, the ID token, the nonce,
the ticket and the binding value are never logged or audited.
