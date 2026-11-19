import { execFileSync } from "node:child_process";
import { resolve } from "node:path";

/**
 * Vitest globalSetup: applies every pending migration (including the raw-SQL
 * booking constraints) to the test database once per run. Tests then truncate
 * all tables before each case (see helpers.ts).
 *
 * `prisma migrate deploy` is used instead of `prisma migrate reset`: it never
 * drops data, and Prisma refuses `migrate reset` when run by an AI agent
 * without explicit user consent. If a migration was edited locally, reset the
 * test database by hand: `DATABASE_URL=$DATABASE_URL_TEST pnpm exec prisma migrate reset`.
 */
export default function setup(): void {
  const url = testDatabaseUrl();
  execFileSync("pnpm", ["exec", "prisma", "migrate", "deploy"], {
    cwd: resolve(__dirname, "../.."),
    env: { ...process.env, DATABASE_URL: url },
    stdio: "inherit",
  });
}

/**
 * DATABASE_URL_TEST, refusing any URL that could point at real data: the
 * database name must contain "test" as a whole `_`-separated word and the URL
 * must differ from DATABASE_URL.
 */
export function testDatabaseUrl(): string {
  const url = process.env.DATABASE_URL_TEST;
  if (!url) throw new Error("DATABASE_URL_TEST is required for integration tests");
  const dbName = new URL(url).pathname.replace(/^\//, "");
  if (!/(^|_)test(_|$)/.test(dbName)) {
    throw new Error(`Refusing to use database "${dbName}": name must contain "test" (e.g. app_test)`);
  }
  if (process.env.DATABASE_URL && sameDatabase(url, process.env.DATABASE_URL)) {
    throw new Error("Refusing to use DATABASE_URL_TEST: it points at the same database as DATABASE_URL");
  }
  return url;
}

function sameDatabase(a: string, b: string): boolean {
  const ua = new URL(a);
  const ub = new URL(b);
  return ua.host === ub.host && ua.pathname === ub.pathname;
}

/**
 * REDIS_URL_TEST, refusing DB index 0 (no path or `/0`) and the database that
 * REDIS_URL points at: tests call FLUSHDB on it.
 */
export function testRedisUrl(): string {
  const url = process.env.REDIS_URL_TEST;
  if (!url) throw new Error("REDIS_URL_TEST is required for integration tests");
  const db = redisDb(url);
  if (db === "0") throw new Error("Refusing to use REDIS_URL_TEST on DB index 0: use e.g. redis://localhost:6379/1");
  const main = process.env.REDIS_URL;
  if (main && (main === url || (new URL(main).host === new URL(url).host && redisDb(main) === db))) {
    throw new Error("Refusing to use REDIS_URL_TEST: it points at the same database as REDIS_URL");
  }
  return url;
}

function redisDb(url: string): string {
  return new URL(url).pathname.replace(/^\//, "") || "0";
}
