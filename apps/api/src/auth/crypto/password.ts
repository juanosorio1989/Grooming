import { hash, verify, type Algorithm, type Options } from "@node-rs/argon2";

// `Algorithm` is an ambient const enum with no runtime export, so it cannot be referenced under SWC/CJS.
// 2 === Algorithm.Argon2id in @node-rs/argon2 v2; password.test.ts asserts the `$argon2id$` prefix.
const ARGON2ID = 2 as Algorithm;

/** OWASP minimum for argon2id: m=19 MiB, t=2, p=1. */
const OPTIONS: Options = { algorithm: ARGON2ID, memoryCost: 19456, timeCost: 2, parallelism: 1 };

/**
 * Hash this once at startup and verify against it when the user does not exist,
 * so a missing account costs the same time as a wrong password.
 */
export const DUMMY_PASSWORD_HASH_INPUT = "grooming-dummy-password-for-timing-equalization";

export function hashPassword(pw: string): Promise<string> {
  return hash(pw, OPTIONS);
}

/** Returns false (never throws) for a wrong password or a malformed hash. */
export async function verifyPassword(hashed: string, pw: string): Promise<boolean> {
  try {
    return await verify(hashed, pw);
  } catch {
    return false;
  }
}
