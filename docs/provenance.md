# Provenance

Source repo: BeautySpa (`~/Claude/beautySpa/BeautySpa`), commit `8a778d5`,
copied with `git archive`.

| Path | Status |
|---|---|
| `package.json` | renamed (`grooming`, `@grooming/config`) |
| `pnpm-workspace.yaml`, `turbo.json`, `.nvmrc`, `.npmrc`, `.gitignore` | as is |
| `eslint.config.mjs` | renamed |
| `packages/config/**` | renamed (`@grooming/config`) |
| `apps/mobile/README.md` | changed (spec link) |
| `.env.example` | changed (names, ports, S3 and S3 keys) |
| `docker-compose.yml` | changed (name, ports, s3 (SeaweedFS, replaces MinIO: images no longer published), s3-init) |
| `docker/postgres/init.sql` | renamed (`grooming_test`) |
| `.github/workflows/ci.yml` | renamed (grooming DB names) |
| `pnpm-lock.yaml` | generated (new lockfile), not copied |
| `packages/datetime/**` | renamed (`@grooming/datetime`) |
| `packages/contracts/**` | renamed; `src/availability.ts` and its test deleted (availability contract is written in Plan 04); export removed from `index.ts`; CSRF header `AUTH_HEADERS.csrf` renamed `x-beautyspa-csrf` → `x-grooming-csrf` |
| `packages/api-client/**` | renamed (`@grooming/api-client`; CSRF header `x-beautyspa-csrf` → `x-grooming-csrf`) |
| `packages/availability/**` | renamed; kept `intervals`, `free-time`, `errors` and their tests. Deleted `plan.ts`, `find-slots.ts`, `validate-plan.ts`, `lookup.ts` and their tests (levels and parallel services are removed from the product; the planner is rewritten in Plan 02). `types.ts` trimmed (no `ServiceInput`, `levelId`, planner types); `test/fixtures.ts` trimmed to what the kept tests import |
| `apps/api/**` | renamed (`@grooming/*`; cookie `bs_refresh` → `gr_refresh`; CSRF header `x-beautyspa-csrf` → `x-grooming-csrf`, also in CORS allowed headers; JWT issuer `beautyspa-api` → `grooming-api`, audiences `beautyspa` / `beautyspa-mfa` → `grooming` / `grooming-mfa`; TOTP issuer, staff emails EN+ES and OpenAPI title `BeautySpa` → `Grooming`; timing-equalization dummy password string renamed). Tests changed only to assert those new values (plus the `@grooming/contracts` import rename). Schema, three migrations and seed kept (salon schema, replaced in Task 4; only the `schema.prisma` header comment and the seed run-command comment changed) |
| `docs/development/README.md` | "First owner" section adapted from the source repo (linked from `apps/api/README.md`) |
| `apps/api/scripts/secrets.ts` | changed: `secrets:gen` also fills empty local `S3_ACCESS_KEY_ID` (20) / `S3_SECRET_ACCESS_KEY` (40), alphanumeric; three tests added in `test/secrets.test.ts` |
| `.env.example` | changed again (comments: `secrets:gen` fills the local S3 keys) |
