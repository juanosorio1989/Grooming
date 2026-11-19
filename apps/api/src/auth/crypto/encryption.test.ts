import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { Encryptor } from "./encryption.js";

const key = () => randomBytes(32).toString("base64");

describe("Encryptor", () => {
  const enc = new Encryptor({ keyId: "k1", keyB64: key() });

  it("round-trips plaintext", () => {
    expect(enc.decrypt(enc.encrypt("JBSWY3DPEHPK3PXP"))).toBe("JBSWY3DPEHPK3PXP");
  });

  it("uses the <keyId>.<iv>.<ciphertext+tag> format with a 12-byte IV", () => {
    const parts = enc.encrypt("JBSWY3DPEHPK3PXP").split(".");
    expect(parts).toHaveLength(3);
    expect(parts[0]).toBe("k1");
    expect(Buffer.from(parts[1]!, "base64url")).toHaveLength(12);
    expect(Buffer.from(parts[2]!, "base64url")).toHaveLength(16 + 16);
  });

  it("produces different payloads for the same plaintext", () => {
    expect(enc.encrypt("JBSWY3DPEHPK3PXP")).not.toBe(enc.encrypt("JBSWY3DPEHPK3PXP"));
  });

  it("throws Decryption failed when the ciphertext is tampered with", () => {
    const [id, iv, ct] = enc.encrypt("JBSWY3DPEHPK3PXP").split(".") as [string, string, string];
    const flipped = (ct[0] === "A" ? "B" : "A") + ct.slice(1);
    expect(() => enc.decrypt(`${id}.${iv}.${flipped}`)).toThrow("Decryption failed");
  });

  it("throws Decryption failed under a different key with the same id", () => {
    const other = new Encryptor({ keyId: "k1", keyB64: key() });
    expect(() => other.decrypt(enc.encrypt("x"))).toThrow("Decryption failed");
  });

  it("throws Decryption failed on malformed payloads", () => {
    expect(() => enc.decrypt("k1.onlytwo")).toThrow("Decryption failed");
    expect(() => enc.decrypt("k1.AAAA.AAAA")).toThrow("Decryption failed");
  });

  it("throws Unknown encryption key id for another key id", () => {
    const k2 = new Encryptor({ keyId: "k2", keyB64: key() });
    expect(() => enc.decrypt(k2.encrypt("JBSWY3DPEHPK3PXP"))).toThrow("Unknown encryption key id");
  });

  it("rejects keys that are not 32 bytes", () => {
    expect(() => new Encryptor({ keyId: "k1", keyB64: randomBytes(16).toString("base64") })).toThrow();
  });

  it("rejects key ids containing a dot", () => {
    expect(() => new Encryptor({ keyId: "k.1", keyB64: key() })).toThrow();
  });
});
