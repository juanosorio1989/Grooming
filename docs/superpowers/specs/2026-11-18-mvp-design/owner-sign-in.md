# Owner sign-in

Added 2026-11-20. Replaces the earlier designer call "owner login is phone +
code only; Google in phase 3". The owner asked for Google (Gmail) sign-in for
pet owners and faster sign-in in general, and left the design to the designer.
Everything below is a **(call)** unless it says otherwise.

## Intent

Signing in must never be the reason an owner gives up on a booking ("booking
feels heavier than texting the shop" is an anti-goal). Many owners already have
a Google account on their phone, so one tap is faster than typing a phone number
and waiting for a code.

The phone number stays the owner's identity in a shop. WhatsApp updates (the
product's edge) go to it, reception finds owners by it, and `customer` is unique
per `(organization_id, phone_e164)`.

## Goals

- "Continue with Google" on booking step 3 and on the owner-area sign-in screen,
  plus Google One Tap where the browser supports it.
- After the first time, a returning owner signs in with one tap and no code.
- Returning owners on the same device do not sign in at all for 90 days.
- Typing the code gets faster: autofill on iOS and Android.

## Non-goals (MVP)

Apple, email (magic link or password) and passkeys. See the
[roadmap](roadmap.md). Staff sign-in does not change.

## Anti-goals

- Two `customer` rows for one person: one from Google, one from the phone.
- WhatsApp messages sent to a number the owner never proved is theirs.
- Someone takes over another owner's pets and history by typing that owner's
  phone number, or by using an email that matches theirs.

## Approaches

| | Option | Trade-off |
|---|---|---|
| **A (chosen)** | Google sign-in, and the phone is verified once (the first Google sign-in in a shop) | First time costs the same as today (one code), every time after is one tap. No duplicates, and WhatsApp only goes to proven numbers. |
| B | Google sign-in alone; the phone is typed but never verified | Fastest first time. But WhatsApp would go to unproven numbers (Meta flags, TCPA), and a typed phone cannot be matched to an existing owner without allowing takeover, so returning owners would get duplicate accounts. |
| C | Read the phone from the Google account | Google rarely holds a verified phone. The People API phone scope is sensitive and needs Google's app verification. Most owners would still need a code. |

## How it works

### Google sign-in

1. The web loads Google Identity Services (button + One Tap) with the
   platform's OAuth **client ID** (public; no client secret is used).
2. Before showing the button, the web gets a nonce:
   `POST /v1/auth/google/nonce` → `{ nonce }`. The nonce is random, stored in
   Redis for 10 min and single-use.
3. Google returns an ID token. The web sends `POST /v1/auth/google`
   `{ idToken }`.
4. The API verifies the token with `google-auth-library`: signature, `aud` =
   client ID, `iss`, expiry, `email_verified = true`, and a `nonce` that it then
   consumes. Any failure → `401 UNAUTHORIZED`.
5. The API looks up `customer_identity` by `(organization_id, GOOGLE, sub)`:
   - **Found** (and the customer is not deleted): it issues customer tokens
     exactly like an OTP verify does (access token + refresh cookie). Done.
   - **Not found**: it returns `200 { status: "PHONE_REQUIRED", linkTicket,
     givenName? }`. `linkTicket` is random, stored in Redis for 10 min with
     `{ orgId, sub, email, givenName }`, and single-use.
6. The web asks for the phone and runs the normal code flow, passing the
   ticket: `POST /v1/auth/otp/start` (unchanged, Turnstile still applies), then
   `POST /v1/auth/otp/verify { phone, code, linkTicket? }`.
7. On a valid code with a valid ticket, in one transaction the API finds or
   creates the `customer` for that phone (as today), creates the
   `customer_identity` row, sets `customer.email` from Google only if it is
   empty, and writes an audit row `customer.identity_link`. On booking step 3,
   the owner name field is prefilled from `givenName` when `customer.name` is
   empty.

The ticket is consumed even if linking fails, and only one Google account can
be linked per customer (see below), so a stolen ticket is worth one attempt for
10 minutes and still needs the phone's code.

### Rules

- Linking happens **only** through a verified phone code. An email match never
  links or signs in anyone: `customer.email` is typed by the owner and nobody
  verified it.
- One Google account per customer, and one customer per Google account in each
  shop: unique `(organization_id, provider, subject)` and unique
  `(organization_id, customer_id, provider)`. If the customer already has a
  different Google account linked, the code still counts: verify signs them in
  by phone as usual and its response carries `identityLinked: false` (otherwise
  `true` when a ticket was sent), and the web says the other Google account
  stays linked. `POST /me/identities/google` in the same case returns
  `409 IDENTITY_TAKEN`.
- An owner signed in by phone can link Google from Profile:
  `POST /v1/me/identities/google { idToken }` (same verification, no ticket).
  `DELETE /v1/me/identities/google` unlinks it. Both are audited.
- `DELETE /me` deletes the customer's identity rows. Export lists the linked
  provider and email.
- Each shop is a separate organization, so the same Google account signs in to
  each shop separately, and the first time in each shop needs a code.

### Faster in general

- **Customer refresh lifetime goes from 30 to 90 days** (still absolute per
  sign-in, rotated on every refresh; `REFRESH_TTL_MS.CUSTOMER`). Staff stays
  12 h.
- Code input: `inputmode="numeric"`, `autocomplete="one-time-code"` (iOS
  offers the code from SMS). SMS fallback messages end with the WebOTP line
  (`@<web host> #<code>`) when Twilio Verify allows a custom SMS template, so
  Android Chrome can fill the code. WhatsApp codes use Twilio Verify's own
  template, including its copy-code button.
- Unchanged: signed WhatsApp/email links open tracking and "manage booking"
  without signing in.

### Configuration

- `GOOGLE_OAUTH_CLIENT_ID` (API and web). When it is empty, the feature is off:
  the button is hidden and `/auth/google*` and `/me/identities/google` return
  `404`. Local dev and tests run with it empty, except the tests that set it.
- The OAuth client is created in Google Cloud Console by the owner (it is a
  cloud resource; never created by an agent). Authorized JavaScript origins:
  the web origins (local `http://localhost:3000`, then production).
- CSP adds `https://accounts.google.com` (script, frame, connect) on the
  owner pages.
- Many shops later: Google needs every origin listed. When shops get their own
  subdomains, either list each origin when a shop is onboarded or move sign-in
  to one shared auth origin. This is decided in the multi-shop phase.

## Where it is built

- **API (Plan 04, booking):** `customer_identity` table and migration,
  `/auth/google/nonce`, `/auth/google`, `linkTicket` on OTP verify,
  `/me/identities/google`, 90-day customer refresh, export/delete. Tests use a
  local RSA key and a fake JWKS in place of Google's.
- **Web (Plan 07, owner):** Google button and One Tap on step 3 and on the
  owner-area sign-in, the `PHONE_REQUIRED` path, name prefill, code input
  autofill, Profile link/unlink.

## Left to the builder

Button placement and copy within the mockups' style (Google's brand rules apply
to the button), the One Tap trigger rules (for example, not on top of the
countdown), and error wording in EN/ES.
