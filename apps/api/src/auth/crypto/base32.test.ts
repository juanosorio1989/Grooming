import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { base32Decode, base32Encode } from "./base32.js";

describe("base32", () => {
  it("encodes RFC 4648 uppercase without padding", () => {
    expect(base32Encode(Buffer.from("12345678901234567890"))).toBe("GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ");
    expect(base32Encode(Buffer.from("f"))).toBe("MY");
    expect(base32Encode(Buffer.from("foobar"))).toBe("MZXW6YTBOI");
    expect(base32Encode(new Uint8Array())).toBe("");
  });

  it("round-trips random 20-byte buffers", () => {
    for (let i = 0; i < 50; i++) {
      const bytes = randomBytes(20);
      expect(Buffer.from(base32Decode(base32Encode(bytes)))).toEqual(bytes);
    }
  });

  it("decodes case-insensitively and ignores padding and spaces", () => {
    expect(base32Decode("gezdgnbv")).toEqual(base32Decode("GEZDGNBV"));
    expect(Buffer.from(base32Decode("mzxw 6==="))).toEqual(Buffer.from("foo"));
  });

  it("throws on invalid characters", () => {
    expect(() => base32Decode("GEZ1")).toThrow();
    expect(() => base32Decode("GEZ8")).toThrow();
  });
});
