import { createPrivateKey } from "node:crypto";
import { isIP } from "node:net";
import { z } from "zod";

/** Nest injection token for the validated `Env` (provided by the global `ConfigModule`). */
export const ENV = Symbol("ENV");

const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/;

const bool = z.enum(["true", "false"]).transform((v) => v === "true");

/** Base64 of a PKCS#8 DER Ed25519 private key. */
const ed25519KeyB64 = z.string().refine((v) => {
  if (!BASE64.test(v)) return false;
  try {
    const key = createPrivateKey({ key: Buffer.from(v, "base64"), format: "der", type: "pkcs8" });
    return key.asymmetricKeyType === "ed25519";
  } catch {
    return false;
  }
}, "must be a base64 PKCS#8 DER Ed25519 private key");

/** One IPv4/IPv6 address, optionally with a CIDR prefix length. */
function isIpOrCidr(v: string): boolean {
  const [addr, prefix, ...rest] = v.split("/");
  if (rest.length > 0 || !addr) return false;
  const family = isIP(addr);
  if (family === 0) return false;
  if (prefix === undefined) return true;
  if (!/^\d{1,3}$/.test(prefix)) return false;
  // A /0 prefix matches every address: same as trusting everything.
  const bits = Number(prefix);
  return bits >= 1 && bits <= (family === 4 ? 32 : 128);
}

/**
 * Express `trust proxy`: `"false"` (or blank) → false, a positive integer → hop count,
 * else a comma-separated list of IPs/CIDRs. `"true"` is rejected: it trusts the
 * client-controlled left-most `X-Forwarded-For` entry and defeats per-IP limits.
 */
const trustProxy = z.string().transform((v, ctx): false | number | string[] => {
  const s = v.trim();
  if (s === "false" || s === "") return false;
  if (/^\d+$/.test(s)) {
    const n = Number(s);
    if (n >= 1 && Number.isSafeInteger(n)) return n;
  } else {
    const list = s.split(",").map((p) => p.trim());
    if (list.every(isIpOrCidr)) return list;
  }
  ctx.addIssue({
    code: z.ZodIssueCode.custom,
    message: 'must be "false", a positive hop count (1 on Railway/Fly), or a comma-separated list of IPs/CIDRs',
  });
  return z.NEVER;
});

/** Comma-separated list: entries trimmed, empty entries dropped. */
const csvList = z.string().transform((v) =>
  v
    .split(",")
    .map((p) => p.trim())
    .filter((p) => p !== ""),
);

/**
 * Ordered OTP channels: comma-separated `whatsapp` / `sms` (exact, lowercase),
 * entries trimmed. Empty entries, unknown values and repeats are rejected.
 */
const otpChannels = z.string().transform((v, ctx): ("whatsapp" | "sms")[] => {
  const list = v.split(",").map((p) => p.trim());
  const valid = list.every((p): p is "whatsapp" | "sms" => p === "whatsapp" || p === "sms");
  if (valid && new Set(list).size === list.length) return list;
  ctx.addIssue({
    code: z.ZodIssueCode.custom,
    message: "must be an ordered, comma-separated list of distinct whatsapp, sms",
  });
  return z.NEVER;
});

/** Base64 of exactly 32 bytes (AES-256 key). */
const key32B64 = z
  .string()
  .refine((v) => BASE64.test(v) && Buffer.from(v, "base64").length === 32, "must be base64 of 32 bytes");

const EnvSchema = z
  .object({
    NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
    PORT: z.coerce.number().int().default(3001),
    DATABASE_URL: z.string().url(),
    REDIS_URL: z.string().url(),
    WEB_ORIGIN: z.string().url(),
    DEFAULT_ORG_SLUG: z.string().min(1),
    JWT_PRIVATE_KEY_B64: ed25519KeyB64,
    JWT_KEY_ID: z.string().min(1).default("k1"),
    DATA_ENCRYPTION_KEY: key32B64,
    DATA_ENCRYPTION_KEY_ID: z.string().min(1).default("k1"),
    OTP_PROVIDER: z.enum(["twilio", "console", "fake"]).default("console"),
    /** Ordered OTP channels for `/auth/otp/start`. Default sms only: WhatsApp needs an active Twilio Verify sender. */
    OTP_CHANNELS: otpChannels.default("sms"),
    TWILIO_ACCOUNT_SID: z.string().optional(),
    TWILIO_AUTH_TOKEN: z.string().optional(),
    TWILIO_VERIFY_SERVICE_SID: z.string().optional(),
    EMAIL_PROVIDER: z.enum(["console", "resend"]).default("console"),
    RESEND_API_KEY: z.string().optional(),
    EMAIL_FROM: z.string().optional(),
    COOKIE_SECURE: bool.optional(),
    COOKIE_DOMAIN: z.string().optional(),
    TRUST_PROXY: trustProxy.default("false"),
    /** Google OAuth client IDs accepted as ID token `aud`. Empty = Google sign-in off. */
    GOOGLE_OAUTH_CLIENT_IDS: csvList.default(""),
  })
  .superRefine((e, ctx) => {
    const require = (key: keyof typeof e, message: string) => {
      if (e[key] === undefined) ctx.addIssue({ code: z.ZodIssueCode.custom, path: [key], message });
    };
    if (e.OTP_PROVIDER === "fake" && e.NODE_ENV !== "test") {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["OTP_PROVIDER"], message: "fake is only allowed in test" });
    }
    if (e.NODE_ENV === "production") {
      if (e.OTP_PROVIDER !== "twilio") {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["OTP_PROVIDER"], message: "production requires twilio" });
      }
      if (e.EMAIL_PROVIDER !== "resend") {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["EMAIL_PROVIDER"], message: "production requires resend" });
      }
    }
    if (e.OTP_PROVIDER === "twilio") {
      require("TWILIO_ACCOUNT_SID", "required when OTP_PROVIDER=twilio");
      require("TWILIO_AUTH_TOKEN", "required when OTP_PROVIDER=twilio");
      require("TWILIO_VERIFY_SERVICE_SID", "required when OTP_PROVIDER=twilio");
    }
    if (e.EMAIL_PROVIDER === "resend") {
      require("RESEND_API_KEY", "required when EMAIL_PROVIDER=resend");
      require("EMAIL_FROM", "required when EMAIL_PROVIDER=resend");
    }
  })
  .transform((e) => ({ ...e, COOKIE_SECURE: e.COOKIE_SECURE ?? e.NODE_ENV === "production" }));

export type Env = z.output<typeof EnvSchema>;

/**
 * Validates the environment. Empty values (`KEY=` in `.env`) count as unset.
 * The error lists only the offending key names, never their values.
 */
export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  const cleaned = Object.fromEntries(Object.entries(source).filter(([, v]) => v !== undefined && v.trim() !== ""));
  const result = EnvSchema.safeParse(cleaned);
  if (!result.success) {
    const keys = [...new Set(result.error.issues.map((i) => i.path.join(".")))];
    throw new Error(`Invalid environment: ${keys.join(", ")}`);
  }
  return result.data;
}
