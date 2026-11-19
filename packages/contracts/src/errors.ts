import { z } from "zod";

export const ErrorCode = z.enum([
  "VALIDATION_FAILED",
  "NOT_FOUND",
  "UNAUTHORIZED",
  "FORBIDDEN",
  "RATE_LIMITED",
  "SLOT_TAKEN",
  "HOLD_EXPIRED",
  "OTP_INVALID",
  "MFA_INVALID",
  "LINK_INVALID",
  "OUTSIDE_CANCEL_WINDOW",
  "CONFLICT",
  "BAD_REQUEST",
  "INTERNAL",
]);
export type ErrorCode = z.infer<typeof ErrorCode>;

export const ProblemSchema = z.object({
  type: z.string(),
  title: z.string(),
  status: z.number().int(),
  code: ErrorCode,
  detail: z.string().optional(),
  errors: z.array(z.object({ path: z.string(), message: z.string() })).optional(),
});
export type Problem = z.infer<typeof ProblemSchema>;
