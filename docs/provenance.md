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
