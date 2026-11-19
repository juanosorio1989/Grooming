import { randomBytes } from "node:crypto";
import { base32Encode } from "./base32.js";
import { sha256Hex } from "./tokens.js";

/** `n` distinct codes, each 80 random bits as lowercase base32 in `xxxx-xxxx-xxxx-xxxx` form. */
export function generateRecoveryCodes(n = 10): string[] {
  const codes = new Set<string>();
  while (codes.size < n) {
    const raw = base32Encode(randomBytes(10)).toLowerCase();
    codes.add(raw.match(/.{4}/g)!.join("-"));
  }
  return [...codes];
}

export function normalizeRecoveryCode(input: string): string {
  return input.toLowerCase().replace(/[\s-]/g, "");
}

export function hashRecoveryCode(input: string): string {
  return sha256Hex(normalizeRecoveryCode(input));
}
