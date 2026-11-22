# Owner sign-in (Google)

Owners can sign in with Google once their Google account is linked to their
customer record. Design and rules: [owner sign-in spec](../superpowers/specs/2026-11-18-mvp-design/owner-sign-in.md)
and its [API details](../superpowers/specs/2026-11-18-mvp-design/owner-sign-in-api.md).
Schemas live in `packages/contracts/src/auth.ts`. Code: `apps/api/src/auth/google/`.

## Feature flag

`GOOGLE_OAUTH_CLIENT_IDS` (comma-separated OAuth client IDs; the token `aud`
must be one of them). Empty (the default in dev and tests) turns the feature
off: both endpoints below return `404 NOT_FOUND`.

## Endpoints

| Method and path | Auth | Notes |
| --- | --- | --- |
| `POST /auth/google/nonce` | public | `200 { nonce }`. Single use, 10 min, bound to this browser by the `gr_gnonce` cookie. A newer nonce replaces the older cookie |
| `POST /auth/google` | public | Body `{ idToken (1..4096) }` (strict). Verifies the Google ID token (RS256 against Google's JWKS, issuer `accounts.google.com`, audience, expiry, `email_verified`, `nonce`), then consumes the nonce, which must carry the matching `gr_gnonce` cookie. Linked account: `200 { status: "SIGNED_IN", accessToken, accessTokenExpiresAt, refreshToken?, isNew }` with the same refresh transport as `/auth/otp/verify`. Unlinked: `200 { status: "PHONE_REQUIRED", linkTicket, name?, givenName? }` and the `gr_glink` cookie; the web then runs the phone code flow with the ticket. `401 UNAUTHORIZED` on any token, nonce or cookie failure, and when the linked customer is deleted |

An email match never links or signs in anyone. A failed token check does not
consume the nonce; a nonce or ticket lookup always deletes it.

## Cookies

Both hold a random binding value (never the nonce or ticket). `HttpOnly`,
`SameSite=Strict`, `Secure` per `COOKIE_SECURE`, `Domain` per `COOKIE_DOMAIN`,
max age 10 min, cleared when consumed.

| Cookie | Path | Read by |
| --- | --- | --- |
| `gr_gnonce` | `/v1` | `/auth/google` (and later `/me/identities/google`) |
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

Over the limit: `429 RATE_LIMITED`.

## Audit

A sign-in of a linked account records `auth.customer.login` with
`after: { method: "google", isNew }`. The Google `sub`, the ID token, the nonce,
the ticket and the binding value are never logged or audited.
