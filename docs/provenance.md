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
| `packages/contracts/**` | renamed; `src/availability.ts` and its test deleted (availability contract is written in Plan 04); export removed from `index.ts` |
| `packages/api-client/**` | renamed (`@grooming/api-client`, `gr_` prefix) |
| `packages/availability/**` | renamed; kept `intervals`, `free-time`, `errors` and their tests. Deleted `plan.ts`, `find-slots.ts`, `validate-plan.ts`, `lookup.ts` and their tests (levels and parallel services are removed from the product; the planner is rewritten in Plan 02). `types.ts` trimmed (no `ServiceInput`, `levelId`, planner types); `test/fixtures.ts` trimmed to what the kept tests import |
