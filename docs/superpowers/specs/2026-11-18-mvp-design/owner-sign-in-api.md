# Owner sign-in: API details

Contracts, edge cases, limits and audit for [owner sign-in](owner-sign-in.md).
All paths are under `/v1`. Everything here is a **(call)**.

## Contracts (`packages/contracts/src/auth.ts`)

| Schema | Shape |
|---|---|
| `GoogleNonceResponseSchema` | `{ nonce: string }` |
| `GoogleSignInRequestSchema` | `{ idToken: string (1..4096) }` |
| `GoogleSignInResponseSchema` | discriminated on `status`: `{ status: "SIGNED_IN", accessToken, accessTokenExpiresAt, refreshToken?, isNew: false }` \| `{ status: "PHONE_REQUIRED", linkTicket: string, givenName?: string, name?: string }` |
| `OtpVerifyRequestSchema` | adds `linkTicket?: string (1..128)` |
| `OtpVerifyResponseSchema` | adds `identityLinked?: boolean`, present only when `linkTicket` was sent |
| `LinkGoogleRequestSchema` | same as `GoogleSignInRequestSchema` |
| `GET /me` response | adds `identities: { provider: "GOOGLE", email: string }[]` |

`refreshToken` in the body follows the existing `TokenResponse` rule (native
clients only; the web uses the cookie). The name prefill uses `name` (full
name), falling back to `givenName`, because `customer.name` is a full name.

## Endpoints

| Method | Path | Result |
|---|---|---|
| POST | `/auth/google/nonce` | `200 { nonce }`; stores `sha256(nonce)` in Redis (10 min) and sets cookie `gr_gnonce` |
| POST | `/auth/google` | `200 SIGNED_IN` or `200 PHONE_REQUIRED` (sets cookie `gr_glink`); `401 UNAUTHORIZED` on any token, nonce or cookie failure, and when the linked customer is deleted |
| POST | `/auth/otp/verify` | copied; handles `linkTicket` (table below) |
| POST | `/me/identities/google` | `204` linked (or already linked to this customer); `409 IDENTITY_TAKEN` when this customer has another Google account **or** this Google account belongs to another customer, same body for both |
| DELETE | `/me/identities/google` | `204`, also when nothing is linked |

When `GOOGLE_OAUTH_CLIENT_IDS` is empty, `/auth/google*` and
`/me/identities/google` return `404`, and `/auth/otp/verify` ignores
`linkTicket` (no `identityLinked` in the response).

## Binding to the browser

The nonce and the ticket are bearer values, so each is also bound to the
browser that asked for it: the API sets an HttpOnly, `Secure`, `SameSite=Strict`
cookie (path `/v1/auth`, 10 min) holding a random binding value, stores it with
the nonce/ticket in Redis, and accepts the nonce/ticket only from a request that
carries the same cookie. This stops an attacker from slipping their own ticket
into a victim's code verify. The web keeps the ticket in memory only (never in
a URL or browser storage). Native clients (later) send the binding value in a
header instead of the cookie.

## Ticket on `/auth/otp/verify`

| Case | Result |
|---|---|
| Wrong code, any ticket | normal OTP error; the ticket is **not** consumed |
| Valid code, valid ticket, `sub` not linked anywhere | sign in; link; `identityLinked: true`; link notice |
| Valid code, `sub` already linked to this customer | sign in; `identityLinked: true`; no notice |
| Valid code, ticket expired, unknown, reused, wrong cookie, or from another organization | sign in by phone; `identityLinked: false` |
| Valid code, `sub` linked to another customer meanwhile, or this customer has another Google account | sign in by phone; `identityLinked: false` |

A valid code always consumes the ticket. Linking runs in the same transaction
that finds or creates the customer. The per-phone verify limit applies as
today.

## Identity rows

- `customer_identity.email` is refreshed from the token on every Google
  sign-in. `customer.email` is set from Google only when it is empty at link
  time.
- FK to `customer` is `onDelete: Restrict` (like `notification_consent`);
  `DELETE /me` removes the rows with an explicit `deleteMany` in its
  transaction, because customers are soft-deleted.

## Rate limits (in-house Redis limiter)

| Endpoint | Limit |
|---|---|
| `/auth/google/nonce` | 30 per IP per 10 min |
| `/auth/google` | 10 per IP per 10 min; 10 per `sha256(sub)` per 10 min after the token is verified |
| `/me/identities/google` (POST and DELETE) | 5 per customer per hour |

No Turnstile on `/auth/google*`: the Google ID token is the proof of a real
user. Turnstile stays on `/auth/otp/start`.

## Audit

| Event | Action | `after` |
|---|---|---|
| Google sign-in (found) | `auth.customer.login` | `{ method: "google" }` |
| Link (verify or Profile) | `auth.customer.identity_linked` | `{ provider: "GOOGLE" }` |
| Unlink | `auth.customer.identity_unlinked` | `{ provider: "GOOGLE" }` |

Never log the raw `sub`, the ID token, the nonce or the ticket.

## Security headers (owner pages)

- CSP: `script-src https://accounts.google.com/gsi/client`,
  `frame-src https://accounts.google.com/gsi/`,
  `connect-src https://accounts.google.com/gsi/`,
  `style-src https://accounts.google.com/gsi/style`.
- `Cross-Origin-Opener-Policy: same-origin-allow-popups` (the Google button's
  popup mode breaks under `same-origin`).

## Tests (integration, fake JWKS)

Bad signature, `aud`, `iss`, expiry, unverified email, missing/reused nonce or
missing cookie → 401; unknown `sub` → `PHONE_REQUIRED`; ticket + valid code
links; every row of the ticket table; email match never links; deleted
customer → 401; `409 IDENTITY_TAKEN` both cases with identical bodies; feature
off → 404 and `linkTicket` ignored; `DELETE /me` removes identities.
