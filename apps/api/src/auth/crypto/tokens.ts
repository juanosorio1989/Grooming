import { createHash, randomBytes } from "node:crypto";

/** 32 random bytes, base64url (43 chars, no padding). */
export function randomToken(): string {
  return randomBytes(32).toString("base64url");
}

export function sha256Hex(s: string): string {
  return createHash("sha256").update(s, "utf8").digest("hex");
}
