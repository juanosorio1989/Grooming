# Plan 04a — Owner Google sign-in and `/availability`

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Pet owners sign in with Google (phone verified once per shop, 90-day
sessions), and the booking web can ask `/availability` for bookable slots for
up to 4 pets over a date range of at most 7 days.

**Architecture:** Google ID tokens are verified in the API with `jose` against
an injectable JWKS (Google's in production, a local RSA key in tests). Nonces and
link tickets live in Redis, bound to the browser by a short-lived HttpOnly
cookie. Linking only happens inside the OTP-verify transaction or from Profile,
and writes a `customer.identity_linked` outbox row that Plan 06 consumes.
`/availability` loads the location, catalog, staff and busy segments once per
request, maps them to `@grooming/availability` inputs with a pure mapper, and
runs `findSlots` per local date.

**Tech Stack:** NestJS 11, Prisma 6, Postgres 16, Redis 7 (ioredis), `jose` 5
(already a dependency), Zod + nestjs-zod, Vitest + supertest integration tests,
`@grooming/availability`, `@grooming/pricing`, `@grooming/datetime`.

**Spec:** `docs/superpowers/specs/2026-11-18-mvp-design/`. Read
`owner-sign-in.md` and `owner-sign-in-api.md` (Tasks 1–4), `data-model.md`
(`customer_identity`, `outbox_event`), `api.md` (Owner sign-in and Public
tables), `availability.md` (Tasks 5–6).

**Branch:** `feat/mvp-04a-signin-availability`

**Split from Plan 04 (2026-11-21, owner-approved).** Plan 04b (holds, booking writes,
reschedule/move, cancel, walk-in, sweeper, export/`DELETE /me`, staff-mode
availability with `excludeAppointmentId`) is written after this plan merges.

## Routing

Main session: Opus 5.5. It orchestrates and does not implement tasks.

| Task | What | Implementer | Reviewer | Why |
|---|---|---|---|---|
| 1 | Schema + migration (`customer_identity`, `outbox_event`), env, contracts, error codes, 90-day customer refresh | **implementer-opus** | reviewer-opus | schema/migration, auth config |
| 2 | Google token verifier, browser-bound nonce/ticket store, `POST /auth/google/nonce`, `POST /auth/google` | **implementer-opus** | reviewer-opus | auth |
| 3 | `linkTicket` on `/auth/otp/verify`, identity linking, outbox row | **implementer-opus** | reviewer-opus | auth + writes customer rows in the sign-in transaction |
| 4 | Profile link/unlink, `GET /me` identities | **implementer-opus** | reviewer-opus | auth |
| 5 | Availability context: pure DB-to-engine mapper and loader | implementer-sonnet | reviewer-opus | read-only, exact interfaces and mapping rules given |
| 6 | `GET /availability`: contracts, optional-customer guard policy, pets resolution, range cap, rate limit | **implementer-opus** | reviewer-opus | changes the global `AccessGuard` (auth) |

Final branch review: reviewer-opus. This is not a money branch. Task 3 writes
customer rows inside sign-in, so it gets its own Opus implementer and review, as
the pet merge did in Plan 03. If you want a second independent final review
anyway, say so before the merge.

## Global Constraints

- Paths under `/v1`. Every query filters by `organizationId = await tenancy.getOrgId()`. A row of another organization is `404 NOT_FOUND`.
- Request bodies are `.strict()` Zod objects. Errors are `application/problem+json` with `code` from `ErrorCode` (`packages/contracts/src/errors.ts`).
- `GOOGLE_OAUTH_CLIENT_IDS` empty (the default in dev and tests) = feature off: `/auth/google*` and `/me/identities/google` return `404 NOT_FOUND`, `/auth/otp/verify` ignores `linkTicket` and its response has no `identityLinked`.
- Never log or audit the raw Google `sub`, the ID token, the nonce, the ticket or the binding value. Redis keys hold only `sha256Hex(value)` (from `src/auth/crypto/tokens.ts`); rate-limit keys use `hashKeyPart(...)`.
- An email match never links or signs in anyone. Linking happens only in `/auth/otp/verify` with a valid code, or in `POST /me/identities/google` with a customer token.
- Cookies `gr_gnonce` (path `/v1`) and `gr_glink` (path `/v1/auth`): `httpOnly`, `sameSite: "strict"`, `secure: env.COOKIE_SECURE`, `domain: env.COOKIE_DOMAIN` when set, max age 10 min.
- Audit actions and `after` exactly as in `owner-sign-in-api.md` → Audit.
- Every task: `pnpm turbo run lint typecheck test build` and `pnpm --filter @grooming/api test:int` exit 0. `git grep -n -i -E 'beautyspa|bs_refresh|\bbs_' -- ':!*.md'` prints nothing. Docs change in the same commit: `docs/api/owner-sign-in.md` (Tasks 2–4) and `docs/api/availability.md` (Task 6), each linked from `docs/api/README.md`. One commit per task, plus fix commits after review.
- Code, comments, docs and commits in English.

## Review Focus

1. **A link ticket replayed from another browser** (ticket from browser A, `gr_glink` cookie of browser B or no cookie) → sign in by phone, `identityLinked: false`, no identity row. Test in Task 3.
2. **Two verifies race to link the same Google `sub` to two different customers** → exactly one identity row, the other verify succeeds by phone with `identityLinked: false`, no 500. Test in Task 3.
3. **A Google sign-in for a customer who was soft-deleted** → 401, no refresh token row created. Test in Task 2.
4. **`/availability` with a malformed or oversized `pets` value, or a range over 7 days** → 400 `VALIDATION_FAILED`, never 500. Test in Task 6.
5. **An owner's pet with no size class (no weight) and no `sizeClass` in the request** → 400 `VALIDATION_FAILED` on `pets.N.sizeClass`, not 500. Test in Task 6.

---

### Task 1: Schema, env, contracts, 90-day customer refresh

**Files:**
- Modify: `apps/api/prisma/schema.prisma` (enum `IdentityProvider`, models `CustomerIdentity`, `OutboxEvent`, back-relations on `Customer` and `Organization`)
- Create: `apps/api/prisma/migrations/<timestamp>_customer_identity_outbox/migration.sql` (generated)
- Modify: `apps/api/src/config/env.ts`, `apps/api/test/support/test-env.ts`, `.env.example`
- Modify: `apps/api/src/auth/refresh-token.service.ts:10-13`
- Modify: `packages/contracts/src/auth.ts`, `packages/contracts/src/customers.ts`, `packages/contracts/src/errors.ts`
- Test: `apps/api/test/integration/schema-integrity.int.test.ts`, `apps/api/test/env.test.ts`, `packages/contracts/src/auth.test.ts`, `apps/api/src/auth/token.service.test.ts` or a new `refresh-token.service.test.ts`
- Docs: `docs/data/README.md` (two new tables, one line each)

**Interfaces:**
- Produces (Prisma):
  ```prisma
  enum IdentityProvider { GOOGLE  @@map("identity_provider") }
  model CustomerIdentity {   // @@map("customer_identity")
    id, organizationId, customerId, provider IdentityProvider, subject String, email String, createdAt, updatedAt
    customer  Customer @relation(onDelete: Restrict); organization @relation(onDelete: Restrict)
    @@unique([organizationId, provider, subject])
    @@unique([organizationId, customerId, provider])
  }
  model OutboxEvent {        // @@map("outbox_event")
    id, organizationId, type String, payload Json, createdAt, processedAt DateTime? @db.Timestamptz(3)
    @@index([processedAt, createdAt]); @@index([organizationId])
  }
  ```
  Column names snake_case via `@map`, ids `uuid(7)`, timestamps `Timestamptz(3)`, matching the existing models.
- Produces (env): `GOOGLE_OAUTH_CLIENT_IDS: string[]` (comma-separated, trimmed, empty entries dropped; unset or blank → `[]`).
- Produces (contracts, `auth.ts`): `GoogleNonceResponseSchema`, `GoogleSignInRequestSchema` (`{ idToken: string 1..4096 }`, strict), `GoogleSignInResponseSchema` (discriminated union on `status`, shapes in `owner-sign-in-api.md`), `LinkGoogleRequestSchema = GoogleSignInRequestSchema`; `OtpVerifyRequestSchema` gains `linkTicket: z.string().min(1).max(128).optional()`; `OtpVerifyResponseSchema` gains `identityLinked: z.boolean().optional()`. Types exported as `z.infer`.
- Produces (contracts, `customers.ts`): `IdentityViewSchema = { provider: z.literal("GOOGLE"), email: z.string() }`, `MeViewSchema = CustomerViewSchema.extend({ identities: z.array(IdentityViewSchema) })`, type `MeView`.
- Produces: `ErrorCode` gains `"IDENTITY_TAKEN"` and `"NO_PRICE_FOR_PET"`.
- Produces: `REFRESH_TTL_MS.CUSTOMER = 90 * 24 * 3600_000`.

- [ ] **Step 1: Write the failing tests**
  - `env.test.ts`: `GOOGLE_OAUTH_CLIENT_IDS` unset → `[]`; `" a.apps , ,b.apps "` → `["a.apps","b.apps"]`.
  - `auth.test.ts`: `GoogleSignInResponseSchema` accepts `{status:"PHONE_REQUIRED", linkTicket:"x"}` and a `SIGNED_IN` body with `isNew`; rejects `{status:"SIGNED_IN"}` without `accessToken`; `GoogleSignInRequestSchema` rejects `idToken` of 4097 chars and unknown keys; `OtpVerifyRequestSchema` rejects `linkTicket` of 129 chars.
  - Refresh TTL: `REFRESH_TTL_MS.CUSTOMER === 7_776_000_000` and `REFRESH_TTL_MS.STAFF === 43_200_000`.
  - `schema-integrity.int.test.ts`: a second `customer_identity` with the same `(organizationId, GOOGLE, subject)` → `pgCode === "23505"`; a second GOOGLE row for the same customer → `23505`; deleting a customer that has an identity row → rejected (Restrict, `23503`); an `outbox_event` row inserts with `processedAt: null`.
- [ ] **Step 2: Run them and confirm they fail.** Run: `pnpm --filter @grooming/contracts test && pnpm --filter @grooming/api test && pnpm --filter @grooming/api test:int`. Expected: the new cases FAIL.
- [ ] **Step 3: Implement the schema, then run `pnpm --filter @grooming/api db:migrate --name customer_identity_outbox`.** Check the generated SQL: two unique indexes and two FKs with `ON DELETE RESTRICT` on `customer_identity`. The index `(processed_at, created_at)` goes on `outbox_event`.
- [ ] **Step 4: Implement env, contracts, error codes and the TTL change.** Add both variables to `.env.example` with empty values and a comment: `GOOGLE_OAUTH_CLIENT_IDS=` ("comma-separated OAuth client IDs; empty = Google sign-in off") and `NEXT_PUBLIC_GOOGLE_OAUTH_CLIENT_ID=` ("web client ID; empty hides the button"). `testEnv` leaves `GOOGLE_OAUTH_CLIENT_IDS` unset.
- [ ] **Step 5: Run every check.** Run: `pnpm turbo run lint typecheck test build && pnpm --filter @grooming/api test:int && pnpm --filter @grooming/api db:drift`. Expected: exit 0 and no drift.
- [ ] **Step 6: Commit** `feat(api): customer_identity and outbox_event tables, Google env, sign-in contracts, 90-day customer refresh`.

---

### Task 2: Google verifier, browser binding, nonce and sign-in endpoints

**Files:**
- Create: `apps/api/src/auth/google/google-jwks.ts`: `export const GOOGLE_JWKS = Symbol("GOOGLE_JWKS")`, `GOOGLE_JWKS_URL = "https://www.googleapis.com/oauth2/v3/certs"`, a factory returning `createRemoteJWKSet(new URL(GOOGLE_JWKS_URL))`
- Create: `apps/api/src/auth/google/google-id-token.ts`
- Create: `apps/api/src/auth/google/browser-binding.store.ts`
- Create: `apps/api/src/auth/google/google-auth.service.ts`, `apps/api/src/auth/google/google-auth.controller.ts`
- Modify: `apps/api/src/auth/auth.module.ts` (providers, controller)
- Create: `apps/api/test/integration/google.ts` (test JWKS + token signer)
- Test: `apps/api/test/integration/auth/google-signin.int.test.ts`
- Docs: `docs/api/owner-sign-in.md` (new), `docs/api/README.md`

**Interfaces:**
- Consumes: Task 1 contracts, `CustomerIdentity` model, `env.GOOGLE_OAUTH_CLIENT_IDS`; existing `SessionService.start`, `RateLimitService`, `AuditService.record`, `randomToken`/`sha256Hex` (`src/auth/crypto/tokens.ts`).
- Produces:
  ```ts
  // google-id-token.ts
  export interface GoogleClaims { sub: string; email: string; nonce: string; name: string | null; givenName: string | null }
  @Injectable() export class GoogleIdTokenVerifier {
    constructor(@Inject(GOOGLE_JWKS) jwks: JWTVerifyGetKey, @Inject(ENV) env: Env)
    /** 401 UNAUTHORIZED on any failure. */
    verify(idToken: string): Promise<GoogleClaims>
  }
  // browser-binding.store.ts
  export const NONCE_COOKIE = "gr_gnonce"; export const LINK_COOKIE = "gr_glink"; export const BINDING_TTL_SEC = 600;
  export interface LinkTicketData { orgId: string; sub: string; email: string; name: string | null }
  @Injectable() export class BrowserBindingStore {
    createNonce(res: Response): Promise<string>
    /** Single use: the Redis entry is deleted on every call. True only if it existed and its binding equals the cookie. */
    consumeNonce(nonce: string, req: Request, res: Response): Promise<boolean>
    createTicket(data: LinkTicketData, res: Response): Promise<string>
    /** Single use, same rule; null when missing, expired or the cookie does not match. */
    consumeTicket(ticket: string, req: Request, res: Response): Promise<LinkTicketData | null>
  }
  // google-auth.service.ts
  @Injectable() export class GoogleAuthService {
    /** 404 NOT_FOUND when GOOGLE_OAUTH_CLIENT_IDS is empty. */
    assertEnabled(): void
    get enabled(): boolean
    nonce(req: Request, res: Response): Promise<GoogleNonceResponse>
    signIn(idToken: string, req: Request, res: Response): Promise<GoogleSignInResponse>
  }
  ```
  Export `GoogleIdTokenVerifier`, `BrowserBindingStore` and `GoogleAuthService` from `AuthModule` (Tasks 3–4 use them).
- Produces (test helper `test/integration/google.ts`):
  ```ts
  export const TEST_GOOGLE_CLIENT_ID = "test-client.apps.googleusercontent.com";
  export interface TestGoogle { jwks: JWTVerifyGetKey; sign(claims: Partial<GoogleTokenClaims>, opts?: { key?: "other"; expiresInSec?: number }): Promise<string> }
  export async function createTestGoogle(): Promise<TestGoogle>   // RS256 key pair + createLocalJWKSet; "other" signs with a second key not in the JWKS
  ```
  The default claims are `iss: "https://accounts.google.com"`, `aud: TEST_GOOGLE_CLIENT_ID`, `sub: "g-sub-1"`, `email: "owner@gmail.com"`, `email_verified: true`, `name: "Ana Pérez"`, `given_name: "Ana"`, `exp: now + 3600`. Tests pass the nonce in `claims.nonce`. Integration apps override `GOOGLE_JWKS` with `jwks` and set env `GOOGLE_OAUTH_CLIENT_IDS: TEST_GOOGLE_CLIENT_ID`.

Rules (beyond the spec):
- `verify`: `jwtVerify(idToken, jwks, { issuer: ["https://accounts.google.com", "accounts.google.com"], audience: env.GOOGLE_OAUTH_CLIENT_IDS, algorithms: ["RS256"] })`. Then require `email_verified === true` and `email`, `sub` and `nonce` to be non-empty strings. Any `jose` error → `UnauthorizedException({ code: "UNAUTHORIZED" })`, logged without the token.
- Binding values and nonces/tickets are `randomToken()`. Redis keys: `gauth:nonce:<sha256Hex(nonce)>` → binding, `gauth:ticket:<sha256Hex(ticket)>` → JSON `{ binding, ...LinkTicketData }`, both `EX 600`, consumed with `GETDEL`. Compare bindings with `crypto.timingSafeEqual` on equal-length buffers. Consuming clears the matching cookie.
- `signIn` order: IP limit `gauth:signin:ip:<hash>` 10/600 s → `verify` → `consumeNonce(claims.nonce)` (false → 401) → sub limit `gauth:signin:sub:<hashKeyPart(sub)>` 10/600 s → look up the identity by `(orgId, GOOGLE, sub)` with `customer.deletedAt`. Found but the customer is deleted → 401. Found → update `identity.email` to the token's email, audit `auth.customer.login` `{ method: "google", isNew }`, then `sessions.start` → `SIGNED_IN`. Not found → `createTicket({ orgId, sub, email, name: claims.name ?? claims.givenName })` → `PHONE_REQUIRED` with `linkTicket`, plus `name`/`givenName` when present.
- `nonce`: IP limit `gauth:nonce:ip:<hash>` 30/600 s.

- [ ] **Step 1: Write the failing integration tests** in `google-signin.int.test.ts` (feature on unless the test says otherwise; each test gets a nonce from `/v1/auth/google/nonce` with a supertest agent so the cookie round-trips):
  - `nonce sets gr_gnonce (HttpOnly, SameSite=Strict, Path=/v1) and returns a nonce`
  - `unknown sub → 200 PHONE_REQUIRED with linkTicket, name "Ana Pérez", givenName "Ana", and a gr_glink cookie on Path=/v1/auth`
  - `linked sub → 200 SIGNED_IN with isNew false; identity email refreshed from the token; audit auth.customer.login after {method:"google",isNew:false}` (seed the identity directly)
  - `401 for each: signature by the other key, wrong aud, wrong iss, expired, email_verified false, nonce missing from token, nonce not issued, nonce reused (second sign-in with the same token), no gr_gnonce cookie, cookie from another agent`
  - `linked customer soft-deleted → 401 and no refresh_token row created` (Review Focus 3)
  - `an existing customer with the same email as the Google account → PHONE_REQUIRED, no identity row` (email never links)
  - `feature off → 404 on /auth/google/nonce and /auth/google`
  - `11th /auth/google from one IP in 10 min → 429 RATE_LIMITED`
  - `no audit row or log line contains the sub, the token or the nonce` (scan `audit_log.after::text` for `g-sub-1`)
- [ ] **Step 2: Run them.** Run: `pnpm --filter @grooming/api test:int -- google-signin`. Expected: FAIL (404s, since the routes don't exist yet).
- [ ] **Step 3: Implement** `google-jwks.ts`, `GoogleIdTokenVerifier`, `BrowserBindingStore`, `GoogleAuthService` and `GoogleAuthController` (`@Public()`, `POST auth/google/nonce` and `POST auth/google`, both `@HttpCode(200)`, `@Res({ passthrough: true })`). Wire them in `AuthModule` with `{ provide: GOOGLE_JWKS, useFactory: () => createRemoteJWKSet(new URL(GOOGLE_JWKS_URL)) }`.
- [ ] **Step 4: Run them.** Run: `pnpm --filter @grooming/api test:int -- google-signin`. Expected: PASS.
- [ ] **Step 5: Write `docs/api/owner-sign-in.md`** (endpoints, cookies, the feature flag, rate limits, link to the spec page) and add a line to `docs/api/README.md`.
- [ ] **Step 6: Run every check from Global Constraints, then commit** `feat(api): Google sign-in with browser-bound nonce and link ticket`.

---

### Task 3: `linkTicket` on `/auth/otp/verify`, identity linking, outbox

**Files:**
- Create: `apps/api/src/auth/google/identity-link.service.ts`
- Modify: `apps/api/src/auth/otp/otp.service.ts` (`verify`), `apps/api/src/auth/otp/otp.controller.ts` (pass `linkTicket`)
- Test: `apps/api/test/integration/auth/google-link-verify.int.test.ts`
- Docs: `docs/api/owner-sign-in.md`

**Interfaces:**
- Consumes: Task 2 `BrowserBindingStore.consumeTicket`, `GoogleAuthService.enabled`, `LinkTicketData`.
- Produces:
  ```ts
  export type LinkOutcome = "LINKED" | "ALREADY_LINKED" | "TAKEN";
  @Injectable() export class IdentityLinkService {
    /**
     * Runs inside the caller's transaction. Links (orgId, GOOGLE, sub) to customerId unless the sub belongs to another
     * customer or the customer has another Google account (TAKEN). LINKED: sets customer.email from Google only when it is
     * null, sets customer.name only when it is null, writes audit auth.customer.identity_linked {provider:"GOOGLE"} and,
     * when notify is true, the outbox row. ALREADY_LINKED: refreshes identity.email only.
     */
    linkInTx(tx: Prisma.TransactionClient, args: { orgId: string; customerId: string; sub: string; email: string;
      name: string | null; notify: boolean; actorIp: string | null }): Promise<LinkOutcome>
  }
  ```
  Outbox row: `type: "customer.identity_linked"`, `payload: { customerId, googleEmail: email, notifyEmail }`. `notifyEmail` is `customer.email` read inside the transaction **before** the link sets it (null when it was empty).
- The insert uses `tx.customerIdentity.createMany({ data: [row], skipDuplicates: true })`, and `count === 0` means the race was lost → `TAKEN`. A P2002 inside a Postgres transaction would abort the whole transaction, and this avoids that.

`verify` changes:
- Code check first (unchanged). A wrong code throws before the ticket is touched.
- When `linkTicket` is sent and the feature is on, call `consumeTicket` right after the code is valid, before the transaction (a valid code always consumes it). Ticket data is usable only if not null and `data.orgId === orgId`.
- The customer upsert and `linkInTx` run in one `prisma.$transaction`. `notify` is true only when the customer existed before this verify. A customer created in the same verify gets no notice and no outbox row.
- Response: `identityLinked` is present only when `linkTicket` was sent and the feature is on. It is `true` for `LINKED` and `ALREADY_LINKED`, `false` otherwise (unusable ticket or `TAKEN`).
- The deleted-customer check (401) and the per-phone verify limit stay as they are.

- [ ] **Step 1: Write the failing integration tests** in `google-link-verify.int.test.ts`. Get the ticket from `/auth/google` with an agent, then verify with the same agent and code `000000`:
  - `wrong code with a ticket → 400 OTP_INVALID; the same ticket still links on the next valid verify`
  - `valid code, new phone → signed in, identityLinked true, identity row created, customer.name "Ana Pérez", customer.email "owner@gmail.com", no outbox row (customer created in this verify)`
  - `valid code, existing customer with email "old@example.com" → identityLinked true; customer.email stays "old@example.com"; outbox row payload {customerId, googleEmail:"owner@gmail.com", notifyEmail:"old@example.com"}`
  - `existing customer with no email → outbox notifyEmail null and customer.email set to the Google email`
  - `existing customer with a name keeps it`
  - `sub already linked to this customer → identityLinked true, no new outbox row`
  - `expired ticket (delete the Redis key), reused ticket, no gr_glink cookie, cookie from another agent (Review Focus 1), ticket minted for another organization → signed in by phone, identityLinked false, no identity row`
  - `sub linked to another customer meanwhile → identityLinked false`; `customer already has another Google account → identityLinked false`
  - `two concurrent verifies (different phones, same sub, Promise.all) → both 200, exactly one identity row, exactly one identityLinked true` (Review Focus 2)
  - `feature off → linkTicket ignored, response has no identityLinked key`
  - `link writes audit auth.customer.identity_linked after {provider:"GOOGLE"}`
- [ ] **Step 2: Run them.** Run: `pnpm --filter @grooming/api test:int -- google-link-verify`. Expected: FAIL.
- [ ] **Step 3: Implement `IdentityLinkService` and the `verify` changes.**
- [ ] **Step 4: Run them, plus the existing OTP suite.** Run: `pnpm --filter @grooming/api test:int -- google-link-verify otp`. Expected: PASS.
- [ ] **Step 5: Docs.** Add the ticket table and the outbox row to `docs/api/owner-sign-in.md`.
- [ ] **Step 6: Run every check, then commit** `feat(api): link Google account on phone verify, identity_linked outbox row`.

---

### Task 4: Profile link/unlink and `GET /me` identities

**Files:**
- Create: `apps/api/src/auth/google/me-identities.controller.ts` (`@Controller("me/identities/google")`)
- Modify: `apps/api/src/auth/google/google-auth.service.ts` (`link`, `unlink`), `apps/api/src/auth/auth.module.ts`
- Modify: `apps/api/src/customers/customers.service.ts` (`getMe`, `patchMe` return `MeView`), `apps/api/src/customers/me.controller.ts`
- Test: `apps/api/test/integration/auth/google-profile.int.test.ts`, existing `test/integration/customers/*` (`/me` shape)
- Docs: `docs/api/owner-sign-in.md`, `docs/api/customers.md`

**Interfaces:**
- Consumes: `GoogleIdTokenVerifier.verify`, `BrowserBindingStore.consumeNonce`, `IdentityLinkService.linkInTx`, `MeView`.
- Produces: `GoogleAuthService.link(p: AccessClaims, idToken: string, req: Request, res: Response): Promise<void>` and `GoogleAuthService.unlink(p: AccessClaims, req: Request): Promise<void>`.

Rules:
- Both routes: `@CustomerAuth()`, `assertEnabled()` first (404). Rate limits are `gauth:link:<customerId>` and `gauth:unlink:<customerId>`, each 5 per 3600 s.
- `link`: verify → `consumeNonce` (false → 401) → `$transaction(linkInTx({ ..., notify: true }))`. `LINKED`/`ALREADY_LINKED` → 204. `TAKEN` → `409` with body `{ code: "IDENTITY_TAKEN" }` (thrown as `ConflictException({ code: "IDENTITY_TAKEN" })`), identical for both causes.
- `unlink`: `deleteMany({ organizationId, customerId, provider: "GOOGLE" })`. When `count > 0`, audit `auth.customer.identity_unlinked` `{ provider: "GOOGLE" }`. Always 204.
- `GET /me` and `PATCH /me` return `MeView` with `identities` (`[{ provider: "GOOGLE", email }]` or `[]`). Staff customer views do not change.

- [ ] **Step 1: Write the failing integration tests** in `google-profile.int.test.ts`:
  - `link with nonce cookie → 204; GET /me identities [{provider:"GOOGLE",email:"owner@gmail.com"}]; outbox row written`
  - `link without the gr_gnonce cookie → 401`
  - `link the same account again → 204, no second outbox row`
  - `409 IDENTITY_TAKEN when the sub belongs to another customer, and when this customer has another Google account; the two response bodies are deep-equal`
  - `unlink → 204 and audit identity_unlinked; unlink with nothing linked → 204 and no audit row`
  - `staff token → 403; no token → 401; feature off → 404 for POST and DELETE`
  - `6th POST in an hour → 429`
- [ ] **Step 2: Run them.** Run: `pnpm --filter @grooming/api test:int -- google-profile customers`. Expected: FAIL.
- [ ] **Step 3: Implement** the controller, the service methods and the `MeView` change.
- [ ] **Step 4: Run them again.** Run: `pnpm --filter @grooming/api test:int -- google-profile customers`. Expected: PASS.
- [ ] **Step 5: Update the docs and run every check, then commit** `feat(api): link and unlink Google from profile, identities on /me`.

---

### Task 5: Availability context (mapper + loader)

**Files:**
- Modify: `apps/api/package.json` (add `"@grooming/availability": "workspace:*"`, then `pnpm install`)
- Create: `apps/api/src/availability/context-mapper.ts` (pure), `apps/api/src/availability/context-mapper.test.ts`
- Create: `apps/api/src/availability/context-loader.ts`, `apps/api/src/availability/availability.module.ts` (registered in `app.module.ts`)
- Test: `apps/api/test/integration/availability/context-loader.int.test.ts`

**Interfaces:**
- Consumes: `LocationService.getDefault()`, `dbTimeToWall` (`src/common/wall-time.ts`), engine types from `@grooming/availability` (`Context`, `LocationInput`, `ServiceInput`, `EmployeeInput`, `ResourceInput`, `BusySegment`), `ServicePriceRow` from `@grooming/pricing`.
- Produces:
  ```ts
  // context-mapper.ts — Prisma row shapes are the `select`s the loader uses; export them as types.
  export interface ContextRows { location: DefaultLocation; hours: LocationHours[]; closures: LocationClosure[];
    services: ServiceRow[]; prices: ServicePrice[]; employees: EmployeeRow[]; resources: ResourceRow[]; busy: BusyRow[] }
  export function toEngineContext(rows: ContextRows, now: Date): Omit<Context, "mode" | "override">
  /** DROP_OFF if any requested service is DROP_OFF (own bookingMode, or null and the location default is DROP_OFF); else WAIT. */
  export function resolveBookingMode(services: { bookingMode: BookingMode | null }[], locationDefault: BookingMode): BookingMode
  // context-loader.ts
  @Injectable() export class AvailabilityContextLoader {
    /** One query per table for the whole UTC range [from, to). */
    load(range: { from: Date; to: Date }): Promise<{ rows: ContextRows; context: Omit<Context, "mode" | "override"> }>
  }
  ```

Mapping rules:
- `location`: `timezone`. From settings: `slotIntervalMin`, `minLeadMinutes`, `bookingHorizonDays`, `maxQueueWaitMin`, `pickupGraceMin`. `dropOffWindows` turns `{ "1": [{from,to}] }` into `WeeklyHours[]` with `weekday: Number(key)`. `hours` from `LocationHours` uses `dbTimeToWall(opens,false)` / `dbTimeToWall(closes,true)`. `closures` become `{ start: startsAt.getTime(), end: endsAt.getTime() }` and include only those overlapping the range.
- `services`: active only. `species` `"ANY"` passes through. `resourceTypeId`, `requiredSkill`, `bufferAfterMin`, `onlineBookable`, and `stage` must be one of the four work stages; a service row with another stage is skipped.
- `prices`: every `service_price` row of the active services.
- `employees`: active staff users with an `EmployeeProfile` and a `StaffLocation` row for the location. `serviceIds` come from `EmployeeService`. `workingHours` are this location's rows, mapped like the hours. `timeOff` rows have `locationId` null or this location and overlap the range. `bookableOnline` and `skills` come from the profile.
- `resources`: active, at this location. `kind` comes from the resource type.
- `busy`: `appointment_segment` rows with `occupies = true` whose appointment is at this location and that satisfy `startsAt < to AND blockEndsAt > from`. Map to `{ employeeId: staffUserId, resourceId, start: startsAt.getTime(), blockEnd: blockEndsAt.getTime() }`.
- `now: now.getTime()`.

- [ ] **Step 1: Write the failing unit tests** in `context-mapper.test.ts`:
  - `closes 00:00 maps to "24:00"`
  - `dropOffWindows {"1":[{from:"08:00",to:"11:00"}]} → [{weekday:1,start:"08:00",end:"11:00"}]`
  - `kennel busy row keeps employeeId null`
  - `resolveBookingMode: [{bookingMode:null}] with default DROP_OFF → DROP_OFF; [{WAIT},{null}] default WAIT → WAIT; [{WAIT},{DROP_OFF}] → DROP_OFF`
- [ ] **Step 2: Write the failing integration test** `context-loader.int.test.ts` on `seedFixture`:
  - `inactive service, inactive resource, inactive staff and a staff without StaffLocation are excluded`
  - `cancelled segment (occupies false) is not busy; a segment ending before the range is not busy`
  - `time off at another location is excluded`
- [ ] **Step 3: Run them.** Run: `pnpm --filter @grooming/api test -- context-mapper && pnpm --filter @grooming/api test:int -- context-loader`. Expected: FAIL.
- [ ] **Step 4: Implement** the mapper, the loader and the module.
- [ ] **Step 5: Run the same commands.** Expected: PASS.
- [ ] **Step 6: Run every check, then commit** `feat(api): availability context loader`.

---

### Task 6: `GET /availability`

**Files:**
- Create: `packages/contracts/src/availability.ts` (+ export from `index.ts`), `packages/contracts/src/availability.test.ts`
- Modify: `apps/api/src/auth/decorators.ts`, `apps/api/src/auth/access.guard.ts` (new policy)
- Create: `apps/api/src/availability/availability.service.ts`, `apps/api/src/availability/availability.controller.ts`
- Test: `apps/api/test/integration/availability/availability.int.test.ts`, `apps/api/test/integration/auth/guard.int.test.ts`
- Docs: `docs/api/availability.md` (new), `docs/api/README.md`

**Interfaces:**
- Consumes: Task 5 `AvailabilityContextLoader.load`, `resolveBookingMode`; `findSlots`, `AvailabilityError`, `MAX_PETS`, `MAX_SERVICES_PER_PET` from `@grooming/availability`; `localDayBoundsUtc(date, tz)` (epoch ms), `datesInRange`, `addDays` from `@grooming/datetime`; `SizeClassSchema`, `CoatTypeSchema` from `contracts/src/catalog.ts`.
- Produces (contracts):
  ```ts
  export const MAX_AVAILABILITY_DAYS = 7;
  const PetChoiceBase = { serviceIds: z.array(IdSchema).min(1).max(6), preferredGroomerId: z.union([IdSchema, z.literal("ANY")]).default("ANY") };
  export const AvailabilityPetSchema = z.union([
    z.object({ petId: IdSchema, sizeClass: SizeClassSchema.optional(), coatType: CoatTypeSchema.optional(), ...PetChoiceBase }).strict(),
    z.object({ ref: z.string().regex(/^new-[1-4]$/), species: z.enum(["DOG","CAT"]), sizeClass: SizeClassSchema, coatType: CoatTypeSchema, ...PetChoiceBase }).strict(),
  ]);
  /** Query string: from, to? (defaults to from), pets = URL-encoded JSON array (≤ 4000 chars), 1..4 entries. */
  export const AvailabilityQuerySchema = z.object({ from: IsoDateSchema, to: IsoDateSchema.optional(), pets: <string → JSON.parse → array of AvailabilityPetSchema 1..4> }).strict()
    // refine: to >= from and (to - from) < MAX_AVAILABILITY_DAYS, issue on path "to"
  export const SegmentViewSchema = z.object({ stage: z.enum(["BATH","DRY","GROOM","FINISH","KENNEL"]), serviceIds: z.array(IdSchema),
    employeeId: IdSchema.nullable(), resourceId: IdSchema.nullable(), startsAt: IsoInstantSchema, endsAt: IsoInstantSchema,
    blockEndsAt: IsoInstantSchema, durationMin: z.number().int().positive(), priceCents: MoneyCentsSchema });
  export const PetPlanViewSchema = z.object({ petId: IdSchema.optional(), ref: z.string().optional(), priceCents: MoneyCentsSchema, segments: z.array(SegmentViewSchema).min(1) });
  export const SlotViewSchema = z.object({ startsAt: IsoInstantSchema, readyAt: IsoInstantSchema, bookingMode: z.enum(["WAIT","DROP_OFF"]), pets: z.array(PetPlanViewSchema).min(1).max(4) });
  export const AvailabilityResponseSchema = z.object({ bookingMode: z.enum(["WAIT","DROP_OFF"]), slots: z.array(SlotViewSchema) });
  ```
  A JSON parse failure in `pets` is a Zod issue on path `pets` (`ctx.addIssue`), never a thrown `SyntaxError`.
- Produces (auth): `OptionalCustomerAuth()` sets policy `{ kind: "optional-customer" }`. The guard behaves like this: no `Authorization` header → allowed, `principal` undefined; a header present → verified like `customer` (invalid token or other organization → 401; a staff token → 403 for now, until Plan 04b adds staff mode); a valid customer token → `principal` set.
- Produces (service): `AvailabilityService.find(q: AvailabilityQuery, principal: AccessClaims | undefined, ip: string): Promise<AvailabilityResponse>`.

Rules:
- Rate limit `availability:ip:<hash>` is 120 per 600 s.
- `petId` entries need a principal (none → 401). The pet must belong to the principal and not be deleted (else 404 `NOT_FOUND`). `species` comes from the pet. `sizeClass`/`coatType` come from the pet, and the request values apply only when the stored value is null. If a value is still missing → 400 `VALIDATION_FAILED` with path `pets.<i>.sizeClass` / `pets.<i>.coatType`. The engine `petId` is the pet id, or the `ref` for inline pets, and the response puts it back in `petId` or `ref`.
- Booking mode: `resolveBookingMode` over all requested services. Unknown/inactive services are left to the engine (`UNKNOWN_SERVICE`).
- Range: dates `datesInRange(from, to)` in the location timezone. Load the context once for `[localDayBoundsUtc(from, tz).start, localDayBoundsUtc(addDays(to, 1), tz).end)`; the extra day covers kennel blocks past midnight. Then `findSlots({ ...context, mode: "ONLINE", date, bookingMode, pets })` per date, with slots concatenated in date order.
- `AvailabilityError` mapping: `NO_PRICE_FOR_PET` → 400 `NO_PRICE_FOR_PET`, `STAGE_RESOURCE_MISMATCH` → 400 `STAGE_RESOURCE_MISMATCH`, every other code → 400 `VALIDATION_FAILED` with `detail` = the engine code. Never 500.
- Ms → ISO with `new Date(ms).toISOString()`.

- [ ] **Step 1: Write the failing contract tests** in `availability.test.ts`:
  - `pets not JSON → issue on "pets"`
  - `5 pets → rejected`
  - `to 7 days after from → issue on "to"; to = from + 6 → ok`
  - `to before from → issue on "to"`
  - `ref "new-5" rejected`
  - `unknown key in a pet → rejected`
- [ ] **Step 2: Write the failing integration tests** in `availability.int.test.ts`, using `seedFixture` plus working hours and prices set up in the test, and a fixed `from` inside the horizon:
  - `anonymous, one inline dog, WAIT service → 200 bookingMode WAIT, slots on the 15-min grid, pets[0].ref "new-1", segment priceCents from the matrix`
  - `DROP_OFF service → bookingMode DROP_OFF; every slot start inside the drop-off window; each pet has a KENNEL segment`
  - `customer token + own petId → 200 with pets[0].petId`
  - `petId without a token → 401; another customer's pet → 404; a deleted pet → 404`
  - `own pet with sizeClass null and no sizeClass in the query → 400 VALIDATION_FAILED path "pets.0.sizeClass"` (Review Focus 5); `with sizeClass "M" → 200`
  - `pets="{oops" → 400; pets of 4001 chars → 400; to = from + 7 → 400` (Review Focus 4)
  - `service with no price row for the pet's size → 400 NO_PRICE_FOR_PET`
  - `a busy segment on the only groomer removes the overlapping start times`
  - `staff token → 403; malformed bearer → 401`
  - `121st request from one IP in 10 min → 429`
- [ ] **Step 3: Write the failing guard test** in `guard.int.test.ts`: an `@OptionalCustomerAuth()` test route returns the principal with a customer token and `null` without one.
- [ ] **Step 4: Run them.** Run: `pnpm --filter @grooming/contracts test -- availability && pnpm --filter @grooming/api test:int -- availability guard`. Expected: FAIL.
- [ ] **Step 5: Implement** the contracts, the policy, the service and the controller (`@Controller("availability")`, `@Get()`, `@OptionalCustomerAuth()`, query through `ZodValidationPipe(AvailabilityQuerySchema)`).
- [ ] **Step 6: Run the same commands.** Expected: PASS.
- [ ] **Step 7: Write `docs/api/availability.md`** (query format with an example URL, the 7-day cap, pets rules, error mapping, rate limit), add a line to `docs/api/README.md`, run every check, then commit `feat(api): GET /availability for owners and anonymous visitors`.

---

## Moved to Plan 04b

- Staff-mode availability (`mode: "STAFF"`, override) and `excludeAppointmentId`.
- Holds and the hold-time carry-overs in `docs/handoff.md`: integer-ms DTOs, grid-checking later segments, kennel past midnight, excluding the hold's own segments, concurrent last-kennel test, `pet_visit.pet_id` on confirm, rejecting deleted pets/customers.
- `DELETE /me` removing identity rows and the customer's unprocessed outbox rows, and export listing linked identities (`owner-sign-in-api.md`).
- Expired holds still count as busy in `/availability` until the 04b sweeper releases them.

Web-side items (CSP/COOP for owner pages, One Tap, `disableAutoSelect` on logout) are Plan 07.
