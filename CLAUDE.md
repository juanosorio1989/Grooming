# Grooming

Project facts for this repo. Lab-wide rules live in the owner's global CLAUDE.md.

## Product

Booking and shop-management SaaS for pet grooming shops in New York, sold to
many shops. Edge: full transparency for the pet owner (live timeline, photo
report card, history) over WhatsApp, in English and Spanish. "Grooming" is a
placeholder brand. Separate product from BeautySpa.

## Stack

Node 22 (`.nvmrc`), pnpm 10, Turborepo 2, TypeScript strict
(`noUncheckedIndexedAccess`), NestJS + Prisma + Postgres 16, Redis 7, SeaweedFS (local S3; MinIO images are no longer published; production is R2)
for pet media, Mailpit for local mail. English only in code, docs and products.

## Local ports

Chosen to not collide with a running BeautySpa stack: postgres 5433, redis 6380,
mailpit 1026 (SMTP) / 8026 (UI), s3 (SeaweedFS) 9010. Compose
project name `grooming`. DBs `grooming` and `grooming_test`.

## Copy-from-BeautySpa rule

Pieces are copied from BeautySpa at commit `8a778d5` only via
`git -C ~/Claude/beautySpa/BeautySpa archive 8a778d5 <paths> | tar -x -C .`,
never from its working tree. Renames: `@beautyspa/*` to `@grooming/*`, `bs_` to
`gr_`, JWT `iss`/`aud` to `grooming`. Code and config must contain no leftover
BeautySpa names (`git grep -n -i -E 'beautyspa|bs_refresh|\bbs_'`); prose docs
may name it as the source. See `docs/provenance.md`.

## Where things are

- Spec: `docs/superpowers/specs/2026-11-18-mvp-design/`
- Plans: `docs/superpowers/plans/2026-11-18-mvp/`
- Docs index: `docs/README.md`
- Never commit `.env`; `.env.example` holds placeholders only.
