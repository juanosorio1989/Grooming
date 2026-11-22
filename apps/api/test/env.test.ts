import { generateKeyPairSync, randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { loadEnv } from "../src/config/env.js";
import { testEnv } from "./support/test-env.js";

const jwtKey = generateKeyPairSync("ed25519").privateKey.export({ format: "der", type: "pkcs8" }).toString("base64");

const base: Record<string, string> = {
  NODE_ENV: "development",
  DATABASE_URL: "postgresql://u:p@localhost:5432/db",
  REDIS_URL: "redis://localhost:6379",
  WEB_ORIGIN: "http://localhost:3000",
  DEFAULT_ORG_SLUG: "demo-salon",
  JWT_PRIVATE_KEY_B64: jwtKey,
  DATA_ENCRYPTION_KEY: randomBytes(32).toString("base64"),
};

function errorOf(fn: () => unknown): string {
  try {
    fn();
  } catch (err) {
    return (err as Error).message;
  }
  throw new Error("expected loadEnv to throw");
}

describe("loadEnv", () => {
  it("accepts all required keys and applies defaults", () => {
    const env = loadEnv(base);
    expect(env.COOKIE_SECURE).toBe(false);
    expect(env.JWT_KEY_ID).toBe("k1");
    expect(env.DATA_ENCRYPTION_KEY_ID).toBe("k1");
    expect(env.OTP_PROVIDER).toBe("console");
    expect(env.EMAIL_PROVIDER).toBe("console");
    expect(env.TRUST_PROXY).toBe(false);
  });

  it("parses COOKIE_SECURE", () => {
    expect(loadEnv({ ...base, COOKIE_SECURE: "true" }).COOKIE_SECURE).toBe(true);
  });

  it("TRUST_PROXY \"false\" is false", () => {
    expect(loadEnv({ ...base, TRUST_PROXY: "false" }).TRUST_PROXY).toBe(false);
  });

  it("TRUST_PROXY as a hop count is a number", () => {
    expect(loadEnv({ ...base, TRUST_PROXY: "1" }).TRUST_PROXY).toBe(1);
    expect(loadEnv({ ...base, TRUST_PROXY: "2" }).TRUST_PROXY).toBe(2);
  });

  it("TRUST_PROXY as a list of IPs/CIDRs is a trimmed string array", () => {
    expect(loadEnv({ ...base, TRUST_PROXY: "10.0.0.0/8, 127.0.0.1" }).TRUST_PROXY).toEqual(["10.0.0.0/8", "127.0.0.1"]);
    expect(loadEnv({ ...base, TRUST_PROXY: "10.0.0.0/8,127.0.0.1" }).TRUST_PROXY).toEqual(["10.0.0.0/8", "127.0.0.1"]);
  });

  it.each(["", "  "])("TRUST_PROXY blank %j is false", (value) => {
    expect(loadEnv({ ...base, TRUST_PROXY: value }).TRUST_PROXY).toBe(false);
  });

  it.each(["true", "0", "-1", "1.5", "loopback", "10.0.0.0/8,", "not-an-ip", "0.0.0.0/0", "::/0", "10.0.0.0/8, 0.0.0.0/0"])(
    "TRUST_PROXY %j is rejected and named",
    (value) => {
      expect(() => loadEnv({ ...base, TRUST_PROXY: value })).toThrow(/TRUST_PROXY/);
    },
  );

  it("production with default providers names OTP_PROVIDER and EMAIL_PROVIDER", () => {
    const msg = errorOf(() => loadEnv({ ...base, NODE_ENV: "production" }));
    expect(msg).toMatch(/OTP_PROVIDER/);
    expect(msg).toMatch(/EMAIL_PROVIDER/);
  });

  it("production with twilio and resend passes and defaults COOKIE_SECURE to true", () => {
    const env = loadEnv({
      ...base,
      NODE_ENV: "production",
      OTP_PROVIDER: "twilio",
      TWILIO_ACCOUNT_SID: "AC1",
      TWILIO_AUTH_TOKEN: "t",
      TWILIO_VERIFY_SERVICE_SID: "VA1",
      EMAIL_PROVIDER: "resend",
      RESEND_API_KEY: "re_1",
      EMAIL_FROM: "Salon <hi@example.com>",
    });
    expect(env.COOKIE_SECURE).toBe(true);
  });

  it("twilio without credentials names the Twilio keys", () => {
    const msg = errorOf(() => loadEnv({ ...base, OTP_PROVIDER: "twilio" }));
    expect(msg).toMatch(/TWILIO_ACCOUNT_SID/);
    expect(msg).toMatch(/TWILIO_AUTH_TOKEN/);
    expect(msg).toMatch(/TWILIO_VERIFY_SERVICE_SID/);
  });

  it("resend without key names RESEND_API_KEY and EMAIL_FROM", () => {
    const msg = errorOf(() => loadEnv({ ...base, EMAIL_PROVIDER: "resend" }));
    expect(msg).toMatch(/RESEND_API_KEY/);
    expect(msg).toMatch(/EMAIL_FROM/);
  });

  it("fake OTP outside test names OTP_PROVIDER", () => {
    expect(() => loadEnv({ ...base, OTP_PROVIDER: "fake" })).toThrow(/OTP_PROVIDER/);
  });

  it("fake OTP in test passes", () => {
    expect(loadEnv({ ...base, NODE_ENV: "test", OTP_PROVIDER: "fake" }).OTP_PROVIDER).toBe("fake");
  });

  it("a 16-byte DATA_ENCRYPTION_KEY names it", () => {
    expect(() => loadEnv({ ...base, DATA_ENCRYPTION_KEY: randomBytes(16).toString("base64") })).toThrow(
      /DATA_ENCRYPTION_KEY/,
    );
  });

  it("a non-Ed25519 JWT key names JWT_PRIVATE_KEY_B64", () => {
    const rsa = generateKeyPairSync("rsa", { modulusLength: 2048 })
      .privateKey.export({ format: "der", type: "pkcs8" })
      .toString("base64");
    expect(() => loadEnv({ ...base, JWT_PRIVATE_KEY_B64: rsa })).toThrow(/JWT_PRIVATE_KEY_B64/);
  });

  it("GOOGLE_OAUTH_CLIENT_IDS unset is an empty list", () => {
    expect(loadEnv(base).GOOGLE_OAUTH_CLIENT_IDS).toEqual([]);
  });

  it.each(["", "  ", " , ,"])("GOOGLE_OAUTH_CLIENT_IDS blank %j is an empty list", (value) => {
    expect(loadEnv({ ...base, GOOGLE_OAUTH_CLIENT_IDS: value }).GOOGLE_OAUTH_CLIENT_IDS).toEqual([]);
  });

  it("GOOGLE_OAUTH_CLIENT_IDS is split on commas, trimmed, empty entries dropped", () => {
    expect(loadEnv({ ...base, GOOGLE_OAUTH_CLIENT_IDS: " a.apps , ,b.apps " }).GOOGLE_OAUTH_CLIENT_IDS).toEqual([
      "a.apps",
      "b.apps",
    ]);
  });

  it("testEnv keeps Google sign-in off even when the process env sets client IDs", () => {
    const saved = process.env.GOOGLE_OAUTH_CLIENT_IDS;
    process.env.GOOGLE_OAUTH_CLIENT_IDS = "from-process.apps";
    try {
      expect(testEnv().GOOGLE_OAUTH_CLIENT_IDS).toEqual([]);
      expect(testEnv({ GOOGLE_OAUTH_CLIENT_IDS: "x.apps" }).GOOGLE_OAUTH_CLIENT_IDS).toEqual(["x.apps"]);
    } finally {
      if (saved === undefined) delete process.env.GOOGLE_OAUTH_CLIENT_IDS;
      else process.env.GOOGLE_OAUTH_CLIENT_IDS = saved;
    }
  });

  it("OTP_CHANNELS unset defaults to sms only", () => {
    expect(loadEnv(base).OTP_CHANNELS).toEqual(["sms"]);
  });

  it.each([
    ["whatsapp,sms", ["whatsapp", "sms"]],
    [" sms , whatsapp ", ["sms", "whatsapp"]],
  ])("OTP_CHANNELS %j keeps its order", (value, expected) => {
    expect(loadEnv({ ...base, OTP_CHANNELS: value }).OTP_CHANNELS).toEqual(expected);
  });

  it.each([",", " , ", "sms,,whatsapp", "email", "sms,sms", "SMS"])("OTP_CHANNELS %j is rejected and named", (value) => {
    expect(errorOf(() => loadEnv({ ...base, OTP_CHANNELS: value }))).toBe("Invalid environment: OTP_CHANNELS");
  });

  it("empty values count as missing", () => {
    const msg = errorOf(() => loadEnv({ ...base, JWT_PRIVATE_KEY_B64: "", DEFAULT_ORG_SLUG: "" }));
    expect(msg).toMatch(/JWT_PRIVATE_KEY_B64/);
    expect(msg).toMatch(/DEFAULT_ORG_SLUG/);
  });

  it("never includes secret values in the error message", () => {
    const msg = errorOf(() => loadEnv({ ...base, NODE_ENV: "production", DATA_ENCRYPTION_KEY: "short" }));
    expect(msg).not.toContain(base.JWT_PRIVATE_KEY_B64);
    expect(msg).not.toContain("short");
  });

  it("HOLD_SWEEPER_INTERVAL_MS defaults to 60000, accepts 0 (off) and rejects negatives by name", () => {
    expect(loadEnv(base).HOLD_SWEEPER_INTERVAL_MS).toBe(60000);
    expect(loadEnv({ ...base, HOLD_SWEEPER_INTERVAL_MS: "0" }).HOLD_SWEEPER_INTERVAL_MS).toBe(0);
    expect(loadEnv({ ...base, HOLD_SWEEPER_INTERVAL_MS: "1500" }).HOLD_SWEEPER_INTERVAL_MS).toBe(1500);
    expect(errorOf(() => loadEnv({ ...base, HOLD_SWEEPER_INTERVAL_MS: "-1" }))).toBe("Invalid environment: HOLD_SWEEPER_INTERVAL_MS");
    expect(errorOf(() => loadEnv({ ...base, HOLD_SWEEPER_INTERVAL_MS: "1.5" }))).toBe("Invalid environment: HOLD_SWEEPER_INTERVAL_MS");
    // Above the setInterval limit Node fires every 1 ms.
    expect(errorOf(() => loadEnv({ ...base, HOLD_SWEEPER_INTERVAL_MS: "2147483648" }))).toBe("Invalid environment: HOLD_SWEEPER_INTERVAL_MS");
  });

  it("testEnv turns the hold sweeper off", () => {
    expect(testEnv().HOLD_SWEEPER_INTERVAL_MS).toBe(0);
  });
});
