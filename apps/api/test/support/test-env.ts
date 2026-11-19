import { generateKeyPairSync, randomBytes } from "node:crypto";
import { loadEnv, type Env } from "../../src/config/env.js";

// Generated once per process: throwaway keys, never real secrets.
const JWT_PRIVATE_KEY_B64 = generateKeyPairSync("ed25519")
  .privateKey.export({ format: "der", type: "pkcs8" })
  .toString("base64");
const DATA_ENCRYPTION_KEY = randomBytes(32).toString("base64");

/** A valid test `Env` (fake OTP, console email, org `test-salon` as in `seedFixture`). */
export function testEnv(overrides: Record<string, string> = {}): Env {
  return loadEnv({
    NODE_ENV: "test",
    DATABASE_URL: process.env.DATABASE_URL_TEST ?? "postgresql://u:p@localhost:5432/db_test",
    REDIS_URL: process.env.REDIS_URL_TEST ?? "redis://localhost:6379/1",
    WEB_ORIGIN: "http://localhost:3000",
    DEFAULT_ORG_SLUG: "test-salon",
    JWT_PRIVATE_KEY_B64,
    DATA_ENCRYPTION_KEY,
    OTP_PROVIDER: "fake",
    EMAIL_PROVIDER: "console",
    ...overrides,
  });
}
