import { z } from "zod";
import { IdSchema, IsoInstantSchema, LocaleSchema, PhoneE164Schema } from "./common";

export const EmailSchema = z.string().trim().toLowerCase().email().max(254);
export type Email = z.infer<typeof EmailSchema>;

export const NewPasswordSchema = z.string().min(12).max(128);
export type NewPassword = z.infer<typeof NewPasswordSchema>;

export const StaffRoleSchema = z.enum(["OWNER", "RECEPTION", "EMPLOYEE"]);
export type StaffRole = z.infer<typeof StaffRoleSchema>;

export const OtpCodeSchema = z.string().regex(/^\d{6}$/);
export type OtpCode = z.infer<typeof OtpCodeSchema>;

export const OtpStartRequestSchema = z.object({ phone: PhoneE164Schema, locale: LocaleSchema });
export type OtpStartRequest = z.infer<typeof OtpStartRequestSchema>;

export const OtpStartResponseSchema = z.object({ channel: z.enum(["whatsapp", "sms"]) });
export type OtpStartResponse = z.infer<typeof OtpStartResponseSchema>;

export const OtpVerifyRequestSchema = z.object({
  phone: PhoneE164Schema,
  code: OtpCodeSchema,
  locale: LocaleSchema.optional(),
  /** Google link ticket from `PHONE_REQUIRED`; ignored when Google sign-in is off. */
  linkTicket: z.string().min(1).max(128).optional(),
}).strict();
export type OtpVerifyRequest = z.infer<typeof OtpVerifyRequestSchema>;

export const TokenResponseSchema = z.object({
  accessToken: z.string(),
  accessTokenExpiresAt: IsoInstantSchema,
  refreshToken: z.string().optional(),
});
export type TokenResponse = z.infer<typeof TokenResponseSchema>;

export const OtpVerifyResponseSchema = TokenResponseSchema.extend({
  isNew: z.boolean(),
  /** Present only when the request carried a `linkTicket` (and Google sign-in is on). */
  identityLinked: z.boolean().optional(),
});
export type OtpVerifyResponse = z.infer<typeof OtpVerifyResponseSchema>;

export const GoogleNonceResponseSchema = z.object({ nonce: z.string() });
export type GoogleNonceResponse = z.infer<typeof GoogleNonceResponseSchema>;

export const GoogleSignInRequestSchema = z.object({ idToken: z.string().min(1).max(4096) }).strict();
export type GoogleSignInRequest = z.infer<typeof GoogleSignInRequestSchema>;

/** `isNew` = the customer has no name yet, as in OTP verify. */
export const GoogleSignedInSchema = TokenResponseSchema.extend({
  status: z.literal("SIGNED_IN"),
  isNew: z.boolean(),
});

/** No customer is linked to this Google account: verify a phone with the ticket. */
export const GooglePhoneRequiredSchema = z.object({
  status: z.literal("PHONE_REQUIRED"),
  linkTicket: z.string(),
  givenName: z.string().optional(),
  name: z.string().optional(),
});

export const GoogleSignInResponseSchema = z.discriminatedUnion("status", [
  GoogleSignedInSchema,
  GooglePhoneRequiredSchema,
]);
export type GoogleSignInResponse = z.infer<typeof GoogleSignInResponseSchema>;

export const LinkGoogleRequestSchema = GoogleSignInRequestSchema;
export type LinkGoogleRequest = z.infer<typeof LinkGoogleRequestSchema>;

export const StaffLoginRequestSchema = z.object({
  email: EmailSchema,
  password: z.string().min(1).max(128),
});
export type StaffLoginRequest = z.infer<typeof StaffLoginRequestSchema>;

export const MfaStepResponseSchema = z.object({
  status: z.enum(["MFA_REQUIRED", "ENROLL_REQUIRED"]),
  mfaToken: z.string(),
  mfaTokenExpiresAt: IsoInstantSchema,
});
export type MfaStepResponse = z.infer<typeof MfaStepResponseSchema>;

export const MfaTokenRequestSchema = z.object({ mfaToken: z.string().min(1).max(2048) });
export type MfaTokenRequest = z.infer<typeof MfaTokenRequestSchema>;

export const MfaEnrollStartResponseSchema = z.object({ secret: z.string(), otpauthUrl: z.string() });
export type MfaEnrollStartResponse = z.infer<typeof MfaEnrollStartResponseSchema>;

export const MfaCodeRequestSchema = MfaTokenRequestSchema.extend({ code: OtpCodeSchema });
export type MfaCodeRequest = z.infer<typeof MfaCodeRequestSchema>;

export const MfaEnrollConfirmResponseSchema = TokenResponseSchema.extend({
  recoveryCodes: z.array(z.string()).length(10),
});
export type MfaEnrollConfirmResponse = z.infer<typeof MfaEnrollConfirmResponseSchema>;

export const MfaRecoverRequestSchema = MfaTokenRequestSchema.extend({
  recoveryCode: z.string().trim().min(1).max(64),
});
export type MfaRecoverRequest = z.infer<typeof MfaRecoverRequestSchema>;

export const LinkTokenSchema = z.string().min(20).max(200);
export type LinkToken = z.infer<typeof LinkTokenSchema>;

export const InviteAcceptRequestSchema = z.object({ token: LinkTokenSchema, password: NewPasswordSchema });
export type InviteAcceptRequest = z.infer<typeof InviteAcceptRequestSchema>;

export const PasswordResetRequestSchema = z.object({ token: LinkTokenSchema, password: NewPasswordSchema });
export type PasswordResetRequest = z.infer<typeof PasswordResetRequestSchema>;

export const PasswordForgotRequestSchema = z.object({ email: EmailSchema });
export type PasswordForgotRequest = z.infer<typeof PasswordForgotRequestSchema>;

export const RefreshRequestSchema = z.object({ refreshToken: z.string().min(1).max(512).optional() });
export type RefreshRequest = z.infer<typeof RefreshRequestSchema>;

export const LogoutRequestSchema = z.object({ refreshToken: z.string().min(1).max(512).optional() });
export type LogoutRequest = z.infer<typeof LogoutRequestSchema>;

export const AccessClaimsSchema = z.object({
  sub: IdSchema,
  typ: z.enum(["customer", "staff"]),
  org: IdSchema,
  role: z.union([StaffRoleSchema, z.literal("CUSTOMER")]),
});
export type AccessClaims = z.infer<typeof AccessClaimsSchema>;

export const AUTH_HEADERS = { tokenTransport: "x-token-transport", csrf: "x-grooming-csrf" } as const;
