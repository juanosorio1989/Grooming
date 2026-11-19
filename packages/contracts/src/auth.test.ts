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
