#!/usr/bin/env bash
# Fails (exit 2) when prisma/schema.prisma and prisma/migrations disagree.
#
# Prisma replays prisma/migrations into a shadow database and WIPES it first,
# so the shadow must not be the integration-test database. It defaults to
# DATABASE_URL_TEST with "_shadow" appended to the database name (created on
# first use); override with SHADOW_DATABASE_URL.
#
# The raw-SQL booking constraints (btree_gist, no_employee_overlap,
# no_resource_overlap, segment_time_order) are invisible to the Prisma schema;
# `migrate diff` does not report them as drift (verified with Prisma 6.19), so
# no filtering is needed. The integration test asserts they exist.
set -euo pipefail
cd "$(dirname "$0")/.."

if [[ -z "${SHADOW_DATABASE_URL:-}" ]]; then
  if [[ -z "${DATABASE_URL_TEST:-}" ]]; then
    echo "check-drift: set DATABASE_URL_TEST or SHADOW_DATABASE_URL" >&2
    exit 1
  fi
  SHADOW_DATABASE_URL="$(node -e 'const u = new URL(process.argv[1]); u.pathname += "_shadow"; console.log(u.toString())' "$DATABASE_URL_TEST")"
  shadow_db="$(node -e 'console.log(new URL(process.argv[1]).pathname.slice(1))' "$SHADOW_DATABASE_URL")"
  # CREATE DATABASE has no IF NOT EXISTS; "already exists" is fine.
  out="$(echo "CREATE DATABASE \"$shadow_db\";" | pnpm exec prisma db execute --url "$DATABASE_URL_TEST" --stdin 2>&1)" \
    || grep -q "already exists" <<<"$out" \
    || { echo "check-drift: could not create shadow database $shadow_db" >&2; echo "$out" >&2; exit 1; }
fi

# The shadow database is wiped: refuse anything that does not look disposable.
shadow_name="$(node -e 'console.log(new URL(process.argv[1]).pathname.slice(1))' "$SHADOW_DATABASE_URL")"
if [[ "$shadow_name" != *shadow* && "$shadow_name" != *test* ]]; then
  echo "check-drift: refusing shadow database \"$shadow_name\" (name must contain \"shadow\" or \"test\")" >&2
  exit 1
fi
if [[ -n "${DATABASE_URL:-}" && "$SHADOW_DATABASE_URL" == "$DATABASE_URL" ]]; then
  echo "check-drift: refusing shadow database equal to DATABASE_URL" >&2
  exit 1
fi

set +e
pnpm exec prisma migrate diff \
  --from-migrations prisma/migrations \
  --to-schema-datamodel prisma/schema.prisma \
  --shadow-database-url "$SHADOW_DATABASE_URL" \
  --exit-code
status=$?
set -e

case "$status" in
  0) echo "check-drift: no drift" ;;
  2) echo "check-drift: schema.prisma and migrations differ (see diff above)" >&2 ;;
  *) echo "check-drift: prisma migrate diff failed (exit $status)" >&2 ;;
esac
exit "$status"
