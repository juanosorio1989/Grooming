import { createPrivateKey } from "node:crypto";
import { describe, expect, it } from "vitest";
import { addMissingSecrets, defaultGenerators } from "../scripts/secrets.js";

const gens = {
  JWT_PRIVATE_KEY_B64: () => "jwtvalue",
  DATA_ENCRYPTION_KEY: () => "deckvalue",
};

describe("addMissingSecrets", () => {
  it("fills empty and absent keys without touching other lines", () => {
    const { text, added } = addMissingSecrets("A=1\nJWT_PRIVATE_KEY_B64=\n", gens);
    expect(added).toEqual(["JWT_PRIVATE_KEY_B64", "DATA_ENCRYPTION_KEY"]);
    const lines = text.split("\n");
    expect(lines[0]).toBe("A=1");
    expect(lines[1]).toBe("JWT_PRIVATE_KEY_B64=jwtvalue");
    expect(lines).toContain("DATA_ENCRYPTION_KEY=deckvalue");
    expect(lines.filter((l) => l.startsWith("JWT_PRIVATE_KEY_B64="))).toHaveLength(1);
    expect(text.endsWith("\n")).toBe(true);
  });

  it("is idempotent", () => {
    const first = addMissingSecrets("A=1\nJWT_PRIVATE_KEY_B64=\n", gens);
    const second = addMissingSecrets(first.text, gens);
    expect(second.added).toEqual([]);
    expect(second.text).toBe(first.text);
  });

  it("keeps existing non-empty values and ignores commented keys", () => {
    const input = "# DATA_ENCRYPTION_KEY=old\nJWT_PRIVATE_KEY_B64=keep\nB=2";
    const { text, added } = addMissingSecrets(input, gens);
    expect(added).toEqual(["DATA_ENCRYPTION_KEY"]);
    expect(text).toBe("# DATA_ENCRYPTION_KEY=old\nJWT_PRIVATE_KEY_B64=keep\nB=2\nDATA_ENCRYPTION_KEY=deckvalue\n");
  });
});

describe("defaultGenerators", () => {
  it("DATA_ENCRYPTION_KEY decodes to 32 bytes", () => {
    expect(Buffer.from(defaultGenerators().DATA_ENCRYPTION_KEY!(), "base64")).toHaveLength(32);
  });

  it("JWT_PRIVATE_KEY_B64 is a PKCS#8 DER Ed25519 key", () => {
    const v = defaultGenerators().JWT_PRIVATE_KEY_B64!();
    const key = createPrivateKey({ key: Buffer.from(v, "base64"), format: "der", type: "pkcs8" });
    expect(key.asymmetricKeyType).toBe("ed25519");
  });
});

describe("defaultGenerators: local S3 keys", () => {
  // SeaweedFS's identity JSON is built by an unquoted heredoc: values must be alphanumeric.
  it.each(["S3_ACCESS_KEY_ID", "S3_SECRET_ACCESS_KEY"])("%s is alphanumeric and long enough", (key) => {
    const make = defaultGenerators()[key];
    expect(make).toBeDefined();
    const v = make!();
    expect(v).toMatch(/^[A-Za-z0-9]+$/);
    expect(v.length).toBeGreaterThanOrEqual(key === "S3_ACCESS_KEY_ID" ? 20 : 40);
    expect(make!()).not.toBe(v);
  });

  it("never overwrites existing S3 values", () => {
    const input = "S3_ACCESS_KEY_ID=keepid\nS3_SECRET_ACCESS_KEY=keepsecret\n";
    const { text, added } = addMissingSecrets(input, defaultGenerators());
    expect(added).not.toContain("S3_ACCESS_KEY_ID");
    expect(added).not.toContain("S3_SECRET_ACCESS_KEY");
    expect(text).toContain("S3_ACCESS_KEY_ID=keepid\n");
    expect(text).toContain("S3_SECRET_ACCESS_KEY=keepsecret\n");
  });
});

describe("addMissingSecrets with the real generators", () => {
  it("fills empty S3 lines with alphanumeric keys of 20 and 40 chars", () => {
    const { text, added } = addMissingSecrets("S3_ACCESS_KEY_ID=\nS3_SECRET_ACCESS_KEY=\n", {
      S3_ACCESS_KEY_ID: defaultGenerators().S3_ACCESS_KEY_ID!,
      S3_SECRET_ACCESS_KEY: defaultGenerators().S3_SECRET_ACCESS_KEY!,
    });
    expect(added).toEqual(["S3_ACCESS_KEY_ID", "S3_SECRET_ACCESS_KEY"]);
    expect(text).toMatch(/^S3_ACCESS_KEY_ID=[A-Za-z0-9]{20}\nS3_SECRET_ACCESS_KEY=[A-Za-z0-9]{40}\n$/);
  });
});
