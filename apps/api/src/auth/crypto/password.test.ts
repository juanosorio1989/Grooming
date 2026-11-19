import { describe, expect, it } from "vitest";
import { DUMMY_PASSWORD_HASH_INPUT, hashPassword, verifyPassword } from "./password.js";

describe("password hashing", () => {
  it("verifies the correct password and rejects a wrong one", async () => {
    const hash = await hashPassword("correct horse battery");
    expect(await verifyPassword(hash, "correct horse battery")).toBe(true);
    expect(await verifyPassword(hash, "wrong horse battery")).toBe(false);
  });

  it("uses argon2id with m=19456, t=2, p=1", async () => {
    expect(await hashPassword("correct horse battery")).toMatch(/^\$argon2id\$v=19\$m=19456,t=2,p=1\$/);
  });

  it("returns false instead of throwing on a malformed hash", async () => {
    expect(await verifyPassword("garbage", "x")).toBe(false);
    expect(await verifyPassword("", "x")).toBe(false);
  });

  it("exports a dummy input for timing equalization", async () => {
    expect(typeof DUMMY_PASSWORD_HASH_INPUT).toBe("string");
    expect(DUMMY_PASSWORD_HASH_INPUT.length).toBeGreaterThan(0);
    const dummy = await hashPassword(DUMMY_PASSWORD_HASH_INPUT);
    expect(await verifyPassword(dummy, "anything")).toBe(false);
  });
});
