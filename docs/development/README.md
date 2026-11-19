# Development

```bash
nvm use                 # Node 22
pnpm install
cp .env.example .env    # then fill S3_ACCESS_KEY_ID / S3_SECRET_ACCESS_KEY (local only)
docker compose up -d
pnpm turbo run lint typecheck test
```

| Service | Host port |
|---|---|
| postgres | 5433 |
| redis | 6380 |
| mailpit SMTP / UI | 1026 / 8026 |
| s3 (SeaweedFS S3 API) | 9010 |

Local object storage is SeaweedFS (`chrislusf/seaweedfs:3.97`), because MinIO
images are no longer published. Production stays Cloudflare R2; the API only
speaks S3. The one-shot `s3-init` creates the private bucket `pet-media`. Bucket
versioning is not enabled by `s3-init` and applies to the production R2 bucket
only. The S3 access key and secret come from `.env` (one source of truth for
compose and the API). Every `docker compose` command fails until
`S3_ACCESS_KEY_ID` and `S3_SECRET_ACCESS_KEY` are filled in `.env`, because the
`:?` interpolation rejects empty values. Databases `grooming` and `grooming_test` (user/password `grooming`, local only).
