import { describe, it, expect } from "vitest";
import {
  EmailSchema,
  NewPasswordSchema,
  OtpCodeSchema,
  OtpStartRequestSchema,
  MfaEnrollConfirmResponseSchema,
  AccessClaimsSchema,
  AUTH_HEADERS,
  ErrorCode,
  GoogleNonceResponseSchema,
  GoogleSignInRequestSchema,
  GoogleSignInResponseSchema,
  LinkGoogleRequestSchema,
  OtpVerifyRequestSchema,
  OtpVerifyResponseSchema,
  MeViewSchema,
} from "./index";

const id = "5b0f1c1e-3b7a-4a55-9c1a-2d6a8f0e1a11";
const tokens = { accessToken: "a", accessTokenExpiresAt: "2026-11-18T10:00:00Z" };

describe("EmailSchema", () => {
  it("trims and lowercases", () => expect(EmailSchema.parse(" Ana@Salon.COM ")).toBe("ana@salon.com"));
  it("rejects invalid", () => expect(EmailSchema.safeParse("not-an-email").success).toBe(false));
});

describe("NewPasswordSchema", () => {
  it("rejects 11 chars", () => expect(NewPasswordSchema.safeParse("a".repeat(11)).success).toBe(false));
  it("accepts 12 chars", () => expect(NewPasswordSchema.safeParse("a".repeat(12)).success).toBe(true));
  it("rejects 129 chars", () => expect(NewPasswordSchema.safeParse("a".repeat(129)).success).toBe(false));
});

describe("OtpCodeSchema", () => {
  it("accepts 6 digits", () => expect(OtpCodeSchema.safeParse("123456").success).toBe(true));
  it.each(["12345", "1234567", "12a456"])("rejects %s", (v) =>
    expect(OtpCodeSchema.safeParse(v).success).toBe(false),
  );
});

describe("OtpStartRequestSchema", () => {
  it("rejects non-E.164 phone", () =>
    expect(OtpStartRequestSchema.safeParse({ phone: "305 555 0100", locale: "en" }).success).toBe(false));
  it("rejects unknown locale", () =>
    expect(OtpStartRequestSchema.safeParse({ phone: "+13055550100", locale: "fr" }).success).toBe(false));
  it("accepts valid", () =>
    expect(OtpStartRequestSchema.safeParse({ phone: "+13055550100", locale: "es" }).success).toBe(true));
});

describe("MfaEnrollConfirmResponseSchema", () => {
  it("accepts 10 recovery codes", () =>
    expect(
      MfaEnrollConfirmResponseSchema.safeParse({ ...tokens, recoveryCodes: Array(10).fill("x") }).success,
    ).toBe(true));
  it("rejects 9 recovery codes", () =>
    expect(
      MfaEnrollConfirmResponseSchema.safeParse({ ...tokens, recoveryCodes: Array(9).fill("x") }).success,
    ).toBe(false));
});

describe("AccessClaimsSchema", () => {
  it("accepts CUSTOMER role", () =>
    expect(AccessClaimsSchema.safeParse({ sub: id, typ: "customer", org: id, role: "CUSTOMER" }).success).toBe(true));
  it("rejects ADMIN role", () =>
    expect(AccessClaimsSchema.safeParse({ sub: id, typ: "staff", org: id, role: "ADMIN" }).success).toBe(false));
});

describe("ErrorCode and headers", () => {
  it("has new auth codes", () => {
    expect(ErrorCode.options).toContain("MFA_INVALID");
    expect(ErrorCode.options).toContain("LINK_INVALID");
  });
  it("exposes header names", () => {
    expect(AUTH_HEADERS.tokenTransport).toBe("x-token-transport");
    expect(AUTH_HEADERS.csrf).toBe("x-grooming-csrf");
  });
});

describe("Google sign-in contracts", () => {
  it("nonce response is { nonce }", () =>
    expect(GoogleNonceResponseSchema.safeParse({ nonce: "n" }).success).toBe(true));

  it("accepts PHONE_REQUIRED with a link ticket", () =>
    expect(GoogleSignInResponseSchema.safeParse({ status: "PHONE_REQUIRED", linkTicket: "x" }).success).toBe(true));
  it("accepts PHONE_REQUIRED with name prefill", () =>
    expect(
      GoogleSignInResponseSchema.safeParse({ status: "PHONE_REQUIRED", linkTicket: "x", givenName: "Ana", name: "Ana Diaz" })
        .success,
    ).toBe(true));
  it("accepts SIGNED_IN with tokens and isNew", () =>
    expect(GoogleSignInResponseSchema.safeParse({ status: "SIGNED_IN", ...tokens, isNew: false }).success).toBe(true));
  it("rejects SIGNED_IN without accessToken", () =>
    expect(GoogleSignInResponseSchema.safeParse({ status: "SIGNED_IN" }).success).toBe(false));
  it("rejects SIGNED_IN without isNew", () =>
    expect(GoogleSignInResponseSchema.safeParse({ status: "SIGNED_IN", ...tokens }).success).toBe(false));
  it("rejects PHONE_REQUIRED without linkTicket", () =>
    expect(GoogleSignInResponseSchema.safeParse({ status: "PHONE_REQUIRED" }).success).toBe(false));

  it("sign-in request accepts a 4096-char idToken", () =>
    expect(GoogleSignInRequestSchema.safeParse({ idToken: "a".repeat(4096) }).success).toBe(true));
  it("sign-in request rejects a 4097-char idToken", () =>
    expect(GoogleSignInRequestSchema.safeParse({ idToken: "a".repeat(4097) }).success).toBe(false));
  it("sign-in request rejects an empty idToken", () =>
    expect(GoogleSignInRequestSchema.safeParse({ idToken: "" }).success).toBe(false));
  it("sign-in request rejects unknown keys", () =>
    expect(GoogleSignInRequestSchema.safeParse({ idToken: "t", extra: 1 }).success).toBe(false));
  it("link request has the sign-in request shape", () => {
    expect(LinkGoogleRequestSchema.safeParse({ idToken: "t" }).success).toBe(true);
    expect(LinkGoogleRequestSchema.safeParse({ idToken: "t", extra: 1 }).success).toBe(false);
  });
});

describe("OTP verify with a link ticket", () => {
  const verify = { phone: "+13055550100", code: "123456" };
  it("accepts a 128-char linkTicket", () =>
    expect(OtpVerifyRequestSchema.safeParse({ ...verify, linkTicket: "a".repeat(128) }).success).toBe(true));
  it("rejects a 129-char linkTicket", () =>
    expect(OtpVerifyRequestSchema.safeParse({ ...verify, linkTicket: "a".repeat(129) }).success).toBe(false));
  it("rejects an empty linkTicket", () =>
    expect(OtpVerifyRequestSchema.safeParse({ ...verify, linkTicket: "" }).success).toBe(false));
  it("rejects unknown keys (a misspelled linkticket is not dropped)", () =>
    expect(OtpVerifyRequestSchema.safeParse({ ...verify, linkticket: "t" }).success).toBe(false));
  it("response accepts identityLinked", () =>
    expect(OtpVerifyResponseSchema.parse({ ...tokens, isNew: true, identityLinked: false }).identityLinked).toBe(false));
});

describe("MeViewSchema", () => {
  const me = {
    id,
    name: "Ana",
    phone: "+13055550100",
    email: null,
    locale: "es",
    emergencyPhone: null,
    createdAt: "2026-11-18T10:00:00Z",
  };
  it("accepts GOOGLE identities", () =>
    expect(MeViewSchema.safeParse({ ...me, identities: [{ provider: "GOOGLE", email: "a@b.co" }] }).success).toBe(true));
  it("rejects other providers", () =>
    expect(MeViewSchema.safeParse({ ...me, identities: [{ provider: "APPLE", email: "a@b.co" }] }).success).toBe(false));
  it("requires identities", () => expect(MeViewSchema.safeParse(me).success).toBe(false));
});

describe("Plan 04a error codes", () => {
  it("has IDENTITY_TAKEN and NO_PRICE_FOR_PET", () => {
    expect(ErrorCode.options).toContain("IDENTITY_TAKEN");
    expect(ErrorCode.options).toContain("NO_PRICE_FOR_PET");
  });
});
