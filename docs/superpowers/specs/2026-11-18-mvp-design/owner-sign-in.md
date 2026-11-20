# Owner sign-in

Added 2026-11-20. Replaces the earlier designer call "owner login is phone +
code only; Google in phase 3". The owner asked for Google (Gmail) sign-in for
pet owners and faster sign-in in general, and left the design to the designer.
Everything below is a **(call)** unless it says otherwise. Endpoint contracts,
edge cases and limits are in [owner sign-in: API details](owner-sign-in-api.md).

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
  phone number, by using an email that matches theirs, or by getting a Google
  account linked to it without the owner knowing.

## Approaches

| | Option | Trade-off |
|---|---|---|
| **A (chosen)** | Google sign-in, and the phone is verified once (the first Google sign-in in a shop) | First time costs the same as today (one code), every time after is one tap. No duplicates, and WhatsApp only goes to proven numbers. |
| B | Google sign-in alone; the phone is typed but never verified | Fastest first time. But WhatsApp would go to unproven numbers (Meta flags, TCPA), and a typed phone cannot be matched to an existing owner without allowing takeover, so returning owners would get duplicate accounts. |
| C | Read the phone from the Google account | Google rarely holds a verified phone. The People API phone scope is sensitive and needs Google's app verification. Most owners would still need a code. |

## How it works

1. The web loads Google Identity Services (button + One Tap) with the
   platform's OAuth **client ID** (public; no client secret is used).
2. Before showing the button, the web gets a nonce from the API
   (`POST /auth/google/nonce`). The nonce is single-use, lives 10 min, and is
   bound to this browser by a short-lived HttpOnly cookie.
3. Google returns an ID token; the web sends it to `POST /auth/google`. The API
   verifies it (signature, audience, issuer, expiry, `email_verified`, nonce).
4. The API looks up `customer_identity` by `(organization_id, GOOGLE, sub)`:
   - **Found**: the owner is signed in exactly as after a phone code (access
     token + refresh cookie). Done: one tap.
   - **Not found**: the response says `PHONE_REQUIRED` and carries a
     single-use `linkTicket` (10 min, also cookie-bound) and the Google name.
5. The web asks for the phone and runs the normal code flow, sending the ticket
   with the code (`POST /auth/otp/verify`).
6. On a valid code, the owner is signed in as today (the `customer` for that
   phone is found or created) and the Google account is linked to it. The owner
   name is prefilled from Google when `customer.name` is empty. The owner gets
   a notice that a Google account was linked (below).

### Rules

- Linking happens **only** through a verified phone code (or, from Profile,
  while signed in). An email match never links or signs in anyone:
  `customer.email` is typed by the owner and nobody verified it.
- One Google account per customer, and one customer per Google account in each
  shop.
- Each shop is a separate organization, so the same Google account signs in to
  each shop separately, and the first time in each shop needs a code.
- Profile shows the linked Google email and lets the owner link (while signed
  in) or unlink it.
- **Link notice:** on every link, the owner gets a WhatsApp message (when
  WhatsApp consent is on) and an email to `customer.email` (when it was set
  before this link), in their language: "Google account x@gmail.com was linked
  to your account. Not you? Open your profile to unlink it." It is a security
  message about their own account, so it goes out even without marketing
  consent, but only on channels they opted into. This limits phone-code
  phishing ("read me the code we sent you") and recycled phone numbers.
- `DELETE /me` removes the identity rows; export lists the linked provider and
  email.

### Faster in general

- **Customer refresh lifetime goes from 30 to 90 days** (still absolute per
  sign-in, rotated on every refresh; `REFRESH_TTL_MS.CUSTOMER`). Staff stays
  12 h.
- Code input: `inputmode="numeric"`, `autocomplete="one-time-code"` (iOS
  offers the code from SMS).
- Android SMS autofill (WebOTP) is **Twilio Verify console configuration done
  by the owner**, not code: a custom SMS template whose last line is
  `@<web host> #<code>`, with the host exactly equal to the web origin's host
  (Twilio may need to approve the template). WhatsApp codes use Twilio Verify's
  own template with its copy-code button.
- Unchanged: signed WhatsApp/email links open tracking and "manage booking"
  without signing in.

## Configuration

- API: `GOOGLE_OAUTH_CLIENT_IDS` (comma-separated, optional; empty means off) in
  `apps/api/src/config/env.ts` and `.env.example`. A list, because the native
  apps later get their own iOS and Android client IDs and `aud` must accept
  each. Web: `NEXT_PUBLIC_GOOGLE_OAUTH_CLIENT_ID` (the web client ID; empty
  hides the button).
- Off means: no button, and the Google endpoints return `404`. Local dev and
  tests run with it empty, except the tests that set it.
- The OAuth client and its consent screen are created in Google Cloud Console
  **by the owner** (a cloud resource; never created by an agent). The consent
  screen needs an app name, a support email and a privacy-policy URL; the
  privacy notice must say the Google email is stored. Authorized JavaScript
  origins: `http://localhost:3000`, then production.
- Many shops later: Google needs every origin listed. When shops get their own
  subdomains, either list each origin when a shop is onboarded or move sign-in
  to one shared auth origin. Decided in the multi-shop phase.

## Where it is built

- **API (Plan 04, booking):** `customer_identity` table and migration, the
  endpoints and contracts in [API details](owner-sign-in-api.md), 90-day
  customer refresh, link notice job, export/delete. Tests use a local RSA key
  and a fake JWKS in place of Google's.
- **Web (Plan 07, owner):** Google button and One Tap on step 3 and on the
  owner-area sign-in, the `PHONE_REQUIRED` path, name prefill, code input
  autofill, Profile link/unlink. On logout the web calls
  `google.accounts.id.disableAutoSelect()`, so One Tap does not sign the owner
  straight back in on a shared device.
- **Templates (Plan 06):** the link notice in EN/ES (WhatsApp template +
  email).

## Left to the builder

Button placement and copy within the mockups' style (Google's brand rules apply
to the button), the One Tap trigger rules (for example, not on top of the hold
countdown), and error wording in EN/ES.
