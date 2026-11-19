import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { base32Decode, base32Encode } from "./base32.js";

const PERIOD_SECONDS = 30;
const ISSUER = "Grooming";

/** 20 random bytes (160 bits, RFC 4226 recommendation), base32-encoded. */
export function generateTotpSecret(): string {
  return base32Encode(randomBytes(20));
}

function hotp(key: Uint8Array, counter: number, digits: number): string {
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(counter));
  const mac = createHmac("sha1", key).update(msg).digest();
  const offset = mac[mac.length - 1]! & 0x0f;
  const binary = mac.readUInt32BE(offset) & 0x7fffffff;
  return (binary % 10 ** digits).toString().padStart(digits, "0");
}

function stepAt(timeMs: number): number {
  return Math.floor(timeMs / 1000 / PERIOD_SECONDS);
}

/** RFC 6238 TOTP, HMAC-SHA1, 30 s period. */
export function totpCode(secretB32: string, timeMs: number, digits = 6): string {
  return hotp(base32Decode(secretB32), stepAt(timeMs), digits);
}

/**
 * Checks `code` against steps `current - window .. current + window`.
 * Returns the matched step counter (for replay protection) or null. All steps are compared in constant time.
 */
export function verifyTotp(secretB32: string, code: string, timeMs: number, window = 1): number | null {
  const digits = 6;
  if (!/^\d{6}$/.test(code)) return null;
  const key = base32Decode(secretB32);
  const given = Buffer.from(code);
  const current = stepAt(timeMs);
  let matched: number | null = null;
  for (let step = current - window; step <= current + window; step++) {
    if (step < 0) continue;
    const expected = Buffer.from(hotp(key, step, digits));
    if (timingSafeEqual(expected, given) && matched === null) matched = step;
  }
  return matched;
}

export function otpauthUrl(secretB32: string, accountEmail: string): string {
  return (
    `otpauth://totp/${ISSUER}:${encodeURIComponent(accountEmail)}` +
    `?secret=${secretB32}&issuer=${ISSUER}&algorithm=SHA1&digits=6&period=${PERIOD_SECONDS}`
  );
}
