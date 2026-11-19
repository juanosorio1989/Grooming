import { describe, expect, it } from "vitest";
import { generateRecoveryCodes, hashRecoveryCode, normalizeRecoveryCode } from "./recovery-codes.js";
import { sha256Hex } from "./tokens.js";

describe("recovery codes", () => {
  it("generates 10 distinct codes by default in xxxx-xxxx-xxxx-xxxx form", () => {
    const codes = generateRecoveryCodes();
    expect(codes).toHaveLength(10);
    expect(new Set(codes).size).toBe(10);
    for (const c of codes) expect(c).toMatch(/^[a-z2-7]{4}(-[a-z2-7]{4}){3}$/);
  });

  it("honours n", () => {
    expect(generateRecoveryCodes(3)).toHaveLength(3);
  });

  it("normalizes case, whitespace and dashes", () => {
    expect(normalizeRecoveryCode(" ABCD-efgh ijkl-MNOP ")).toBe("abcdefghijklmnop");
    expect(hashRecoveryCode(" ABCD-efgh ijkl-MNOP ")).toBe(hashRecoveryCode("abcdefghijklmnop"));
    expect(hashRecoveryCode("abcdefghijklmnop")).toBe(sha256Hex("abcdefghijklmnop"));
  });
});
