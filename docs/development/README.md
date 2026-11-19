# Development

```bash
nvm use                 # Node 22
pnpm install
cp .env.example .env    # then fill MINIO_ROOT_USER / MINIO_ROOT_PASSWORD (local only)
docker compose up -d
pnpm turbo run lint typecheck test
```

| Service | Host port |
|---|---|
| postgres | 5433 |
| redis | 6380 |
| mailpit SMTP / UI | 1026 / 8026 |
| minio S3 / console | 9010 / 9011 |

`minio-init` creates the private, versioned bucket `pet-media`. Databases
`grooming` and `grooming_test` (user/password `grooming`, local only).
