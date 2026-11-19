import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

const ALGORITHM = "aes-256-gcm";
const IV_BYTES = 12;
const TAG_BYTES = 16;

/**
 * AES-256-GCM field encryption.
 * Payload: `<keyId>.<base64url iv>.<base64url ciphertext || 16-byte tag>`.
 */
export class Encryptor {
  private readonly keyId: string;
  private readonly key: Buffer;

  constructor(opts: { keyId: string; keyB64: string }) {
    if (!opts.keyId || opts.keyId.includes(".")) throw new Error("Invalid encryption key id");
    const key = Buffer.from(opts.keyB64, "base64");
    if (key.length !== 32) throw new Error("Encryption key must be 32 bytes");
    this.keyId = opts.keyId;
    this.key = key;
  }

  encrypt(plaintext: string): string {
    const iv = randomBytes(IV_BYTES);
    const cipher = createCipheriv(ALGORITHM, this.key, iv, { authTagLength: TAG_BYTES });
    const ct = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final(), cipher.getAuthTag()]);
    return `${this.keyId}.${iv.toString("base64url")}.${ct.toString("base64url")}`;
  }

  decrypt(payload: string): string {
    const parts = payload.split(".");
    if (parts.length === 3 && parts[0] !== this.keyId) throw new Error("Unknown encryption key id");
    if (parts.length !== 3) throw new Error("Decryption failed");
    try {
      const iv = Buffer.from(parts[1]!, "base64url");
      const data = Buffer.from(parts[2]!, "base64url");
      if (iv.length !== IV_BYTES || data.length < TAG_BYTES) throw new Error("bad length");
      const decipher = createDecipheriv(ALGORITHM, this.key, iv, { authTagLength: TAG_BYTES });
      decipher.setAuthTag(data.subarray(data.length - TAG_BYTES));
      return Buffer.concat([decipher.update(data.subarray(0, data.length - TAG_BYTES)), decipher.final()]).toString(
        "utf8",
      );
    } catch {
      throw new Error("Decryption failed");
    }
  }
}
