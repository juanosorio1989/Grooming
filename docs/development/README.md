# Development

```bash
nvm use                 # Node 22
pnpm install
pnpm --filter @grooming/api secrets:gen  # creates and fills .env
docker compose up -d
pnpm turbo run lint typecheck test
pnpm --filter @grooming/api db:deploy
pnpm --filter @grooming/api db:seed
pnpm --filter @grooming/api db:drift   # schema vs migrations drift check (needs DATABASE_URL_TEST)
pnpm --filter @grooming/api test:int
```

`secrets:gen` copies `.env.example` to `.env` when `.env` is missing, then
fills every empty `JWT_PRIVATE_KEY_B64`, `DATA_ENCRYPTION_KEY`,
`S3_ACCESS_KEY_ID` and `S3_SECRET_ACCESS_KEY`. The S3 keys are alphanumeric
only, because the SeaweedFS identity JSON is built by an unquoted heredoc. It
never overwrites a value that is already set and prints key names only, never
values.

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
`:?` interpolation rejects empty values; run `secrets:gen` first. Databases
`grooming` and `grooming_test` (user/password `grooming`, local only).

## What the seed creates

`db:seed` fills the dev database with a demo shop (see `docs/data/README.md`,
Seed): catalog and prices, 6 staff, 4 customers with 6 pets, 3 completed visits
with reports. Staff have no passwords and cannot log in (`can_login` false);
the owner is `owner@demo.dev`; run `create-owner` to set up a real login.

## First owner

After `pnpm --filter @grooming/api db:seed`, create the first OWNER of the
default organization (`DEFAULT_ORG_SLUG`):

```bash
pnpm --filter @grooming/api create-owner --email owner@demo.dev --locale en
```

`owner@demo.dev` is the seeded OWNER, so this resets it (prints `Owner reset`).
Any other email creates an additional OWNER (prints `Owner created`).

It prints `Owner created` (or `Owner reset`, see above) and `Invite link (valid 72 h): ...`. Open the link
to set a password and enroll TOTP. Running it again for the same email prints
`Owner reset`: it clears that OWNER's password, TOTP, recovery codes and
sessions and prints a new link (older links stop working). `--locale` is
optional: a new OWNER defaults to `en`; a reset keeps the stored locale unless
you pass `--locale`. It refuses an email that belongs to a non-owner. The link
is a one-time credential: do not paste it into chats or tickets.

With `EMAIL_PROVIDER=console` (development), invite and password reset emails
are not sent; the API logs them (recipient, subject and text with the link).
API docs (Swagger UI): http://localhost:3001/v1/docs
