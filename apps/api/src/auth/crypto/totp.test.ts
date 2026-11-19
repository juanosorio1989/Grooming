import { describe, expect, it } from "vitest";
import { base32Encode } from "./base32.js";
import { generateTotpSecret, otpauthUrl, totpCode, verifyTotp } from "./totp.js";

const RFC_SECRET = base32Encode(Buffer.from("12345678901234567890"));

describe("totpCode", () => {
  it("uses the RFC 6238 test secret", () => {
    expect(RFC_SECRET).toBe("GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ");
  });

  it.each([
    [59, "94287082"],
    [1111111109, "07081804"],
    [1111111111, "14050471"],
    [1234567890, "89005924"],
    [2000000000, "69279037"],
  ])("matches the RFC 6238 SHA-1 vector at t=%i", (seconds, expected) => {
    expect(totpCode(RFC_SECRET, seconds * 1000, 8)).toBe(expected);
  });

  it("defaults to 6 digits", () => {
    expect(totpCode(RFC_SECRET, 59_000)).toBe("287082");
  });
});

describe("verifyTotp", () => {
  const T = 1_700_000_000_000;

  it("accepts the previous step and returns its counter", () => {
    const secret = generateTotpSecret();
    expect(verifyTotp(secret, totpCode(secret, T - 30_000), T)).toBe(Math.floor(T / 30_000) - 1);
  });

  it("returns the current counter for the current code", () => {
    const secret = generateTotpSecret();
    expect(verifyTotp(secret, totpCode(secret, T), T)).toBe(Math.floor(T / 30_000));
  });

  it("rejects a code two steps old", () => {
    const secret = generateTotpSecret();
    const old = totpCode(secret, T - 60_000);
    const inWindow = [-1, 0, 1].map((d) => totpCode(secret, T + d * 30_000));
    const result = verifyTotp(secret, old, T);
    if (inWindow.includes(old)) expect(result).not.toBeNull();
    else expect(result).toBeNull();
  });

  it("rejects 000000 unless it really matches", () => {
    const secret = generateTotpSecret();
    const inWindow = [-1, 0, 1].map((d) => totpCode(secret, T + d * 30_000));
    const result = verifyTotp(secret, "000000", T);
    if (inWindow.includes("000000")) expect(result).not.toBeNull();
    else expect(result).toBeNull();
  });

  it("rejects malformed codes", () => {
    const secret = generateTotpSecret();
    expect(verifyTotp(secret, "", T)).toBeNull();
    expect(verifyTotp(secret, "12345", T)).toBeNull();
    expect(verifyTotp(secret, "abcdef", T)).toBeNull();
  });
});

describe("generateTotpSecret", () => {
  it("returns 20 random bytes in base32", () => {
    const a = generateTotpSecret();
    expect(a).toMatch(/^[A-Z2-7]{32}$/);
    expect(generateTotpSecret()).not.toBe(a);
  });
});

describe("otpauthUrl", () => {
  it("builds the provisioning URI", () => {
    expect(otpauthUrl("JBSWY3DPEHPK3PXP", "ana+x@example.com")).toBe(
      "otpauth://totp/Grooming:ana%2Bx%40example.com?secret=JBSWY3DPEHPK3PXP&issuer=Grooming&algorithm=SHA1&digits=6&period=30",
    );
  });
});
