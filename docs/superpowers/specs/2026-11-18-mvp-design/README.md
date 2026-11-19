# Grooming MVP — Design

Status: draft for approval · Date: 2026-11-18

## Intent

A booking and shop-management SaaS for **pet grooming shops in New York**
(Latino-owned and not), sold to many shops. Its edge over grooming software
that focuses on shop operations: **full transparency for the pet owner** — what
was done to their pet, by whom, when it will be ready, and the complete
history — over WhatsApp, in English and Spanish.

Separate product and brand from BeautySpa (the owner's salon SaaS), built on
the same architecture and starting from copies of its proven pieces.

There is no pilot shop and no deadline. The MVP must be **demo-able and
sellable**: the live timeline and the photo report card are the demo.

## Goals (MVP)

1. Owners book grooming for one or more pets in **≤ 3 steps** (pets + services
   → time → phone code + confirm). Returning owners have pets prefilled.
2. Two booking modes, set per location with per-service override:
   **wait** (exact time, owner waits) and **drop-off** (owner picks a drop-off
   time, sees an estimated ready time). See [availability](availability.md).
3. Price and duration depend on the pet's **size class and coat type**.
4. Availability respects staff skills (bather / groomer), stations (tubs,
   tables, dryers) and **kennels** for pets waiting in the shop. Double booking
   of a person, station or kennel is impossible (database-enforced).
5. **Live timeline** per pet (Received → Bath → Dry → Groom → Ready) updated by
   the groomer from their phone, with a recalculated ETA and a WhatsApp
   "ready for pickup" message. See [tracking](tracking.md).
6. **Report card** per pet visit: before/after photos, each step with who did
   it, health observations, notes and recommendations.
7. **Pet profile and history**: species, breed, weight/size, coat, temperament,
   allergies, medical notes, vaccine records with card photo, vet contact,
   photos; every past visit with its report.
8. Reception: day board, check-in (weigh, before photo, vaccine check, kennel)
   and check-out (show report, record payment taken outside the app).
9. WhatsApp confirmations and reminders, email fallback. Bilingual EN/ES.
10. Installable PWA, mobile-first; the groomer screen works through spotty
    signal.

## Non-goals (MVP) — see [roadmap](roadmap.md)

Online payments, deposits, cancellation fees, tips, packages/memberships,
loyalty, digital consents, authorized-pickup list, product brand/lot tracking,
PDF export, waitlist, reviews, recurring "time for a bath" reminders, metrics
dashboard, native app and push, email/Google/Apple login for owners, pet taxi,
multi-shop onboarding and subscription billing, POS/inventory.

## Anti-goals (failure even if it "works")

- The timeline sits frozen because marking a step is a chore for a groomer
  with wet hands.
- A report card goes out without photos or with the wrong pet's photos.
- Booking feels heavier than texting the shop on WhatsApp.
- Reception finds the board slower than their paper sheet and stops using it.
- A groomer misses an allergy or medical warning that was in the profile.
- Any business rule lives only in the frontend.
- A WhatsApp number gets flagged for sending without opt-in.

## Constraints

- US / New York: USD, imperial units (lb), `America/New_York` (DST), NY SHIELD
  Act. Not HIPAA; pet medical notes are still encrypted.
- WhatsApp business-initiated messages need Meta verification and approved
  EN + ES templates; SMS needs A2P 10DLC (built, flag-off until approved).
- Code, API and docs in English; UI strings in English and Spanish.
- No cloud resources created without the owner's explicit approval.

## Approaches considered

**Relationship to BeautySpa**

| | Option | Trade-off |
|---|---|---|
| One platform | Spa and grooming as verticals of one backend | One thing to run, but roadmaps coupled while the spa is mid-build. |
| **Separate product (chosen)** | Own repo and brand, same architecture | Fast, no coupling; fixes must be ported by hand. |
| Shared core packages | Private packages used by both | Cleanest in theory; versioning overhead for one developer with no customers yet. Revisit when both are stable. |

**How to start the repo**

| | Option | Trade-off |
|---|---|---|
| **Fresh repo, copy chosen pieces (chosen)** | Copy foundation, availability, datetime, contracts, api-client, auth, CI from BeautySpa `8a778d5` | Clean start, only what fits; copying is reviewed by hand. |
| Fork whole spa repo | Strip what doesn't fit | Fastest day one; drags spa-only concepts (levels, mani‖pedi). |
| Wait for spa MVP | Copy a later snapshot | Most mature; stalls this project for weeks. |

**Stack and hosting.** The requested Supabase + RLS + Cloudflare Workers stack
was replaced by the spa's: NestJS + Prisma + Postgres + Redis/BullMQ, Next.js
web, Expo later. The API cannot run on Workers (BullMQ, Redis, Node Prisma).
Hosting: Vercel (web), Railway or Fly.io (api + worker), Neon (Postgres),
managed Redis, Cloudflare R2 (photos), Turnstile, Cloudflare DNS/WAF. Live
updates come from the API (SSE + Redis pub/sub), not Supabase Realtime.

## Pages

- [Architecture](architecture.md) — monorepo, what is copied from BeautySpa, realtime, photos
- [Data model](data-model.md) — pets, pricing matrix, visits, steps, reports
- [Availability](availability.md) — wait and drop-off modes, kennels, multi-pet
- [Tracking](tracking.md) — step state machine, groomer screen, offline queue, ETA, report card
- [Flows](flows.md) — booking, check-in/out, day board, notifications
- [API](api.md) — `/v1` endpoints added or changed vs. BeautySpa
- [Security & quality](security-quality.md) — deltas from BeautySpa, testing
- [Roadmap](roadmap.md) — phases 2 and 3, scaling, native app

## Decided by the owner

Pet grooming booking SaaS for many shops; US / New York, Latino and non-Latino
shops; separate product and brand from BeautySpa built from copies of its
pieces (fresh repo); BeautySpa's hosting; both booking modes (wait and
drop-off) depending on shop and service; the groomer marks steps from their own
phone; no pilot and no date yet, so the MVP is aimed at a sellable demo.

## Calls made by the designer (check these)

Marked inline with **(call)**. Main ones:

- **Owner login is phone + one-time code only** (as in BeautySpa); email,
  Google and Apple login move to phase 3. Owners never create a password.
- MVP scope cut (above) and phase split ([roadmap](roadmap.md)).
- Payments in the MVP are **recorded, not processed** (amount + method at
  check-out).
- "After" photo required to mark a pet Ready (per-location setting, default on).
- Expired/missing vaccines **warn** at booking and check-in; a per-location
  setting can make them **block** check-in.
- Size classes from weight with per-location thresholds (default S ≤ 20 lb,
  M ≤ 50, L ≤ 90, XL above).
- One segment per pet per stage; staff levels from BeautySpa are dropped.
- Drop-off: max wait before work starts, pickup grace time and kennel hold
  rules in [availability](availability.md).
- Owner's tracking page updates when the ETA moves ≥ 5 min; WhatsApp only for
  "ready" and ETA changes ≥ 30 min (max one per hour).
- Wait-mode multi-pet is pipelined (pet 2 starts as soon as someone is free);
  drop-off idle limit counts the initial queue wait.
- Kennel hold auto-extends while a pet is not picked up; reception is warned on
  collision.
- Returning owner re-adding a pet on a new device: "Is this Max?" match after
  the code step.
- Up to 4 pets per appointment, 6 services per pet.
- Package scope `@grooming/*` until the brand name exists.

## Left to the builder

Folder layout inside apps, component details within shadcn/ui, service-worker
and IndexedDB libraries, image compression library, logging library, visual
design within WCAG AA and the brand once named.
