import { HttpException, HttpStatus, Injectable, UnauthorizedException, type OnModuleInit } from "@nestjs/common";
import type { Request } from "express";
import type { MfaStepResponse, StaffLoginRequest } from "@grooming/contracts";
import { AuditService } from "../../audit/audit.service.js";
import { PrismaService } from "../../prisma/prisma.service.js";
import { RateLimitService, hashKeyPart } from "../../rate-limit/rate-limit.service.js";
import { TenancyService } from "../../tenancy/tenancy.service.js";
import { DUMMY_PASSWORD_HASH_INPUT, hashPassword, verifyPassword } from "../crypto/password.js";
import { requestMeta } from "../request-meta.js";
import { TokenService } from "../token.service.js";

/** Rate limits: [limit, window seconds]. */
export const LOGIN_FAILURES_PER_EMAIL = [5, 900] as const;
export const LOGIN_PER_IP = [30, 900] as const;

/** Rate-limit key of the per-email login failure counter (lockout). `email` must already be trimmed and lowercased. */
export function loginFailureKey(email: string): string {
  return `login:fail:${hashKeyPart(email)}`;
}

const INVALID_CREDENTIALS = "Invalid email or password";
const invalidCredentials = () => new UnauthorizedException({ code: "UNAUTHORIZED", message: INVALID_CREDENTIALS });

/**
 * Staff step 1: email + password. Answers an MFA step (never a session):
 * `MFA_REQUIRED` + verify token when TOTP is enrolled, else `ENROLL_REQUIRED` + enroll token.
 * Unknown email, inactive, `can_login=false`, no password and wrong password all
 * answer the same 401 after an argon2 verification of similar cost. Five failures
 * per email in 15 min lock that email (429) until the window ends; a success resets.
 * The per-email counter is consumed before the password check, so a parallel burst
 * cannot get more than 5 guesses per window.
 */
@Injectable()
export class StaffAuthService implements OnModuleInit {
  private dummyHash = "";

  constructor(
    private readonly prisma: PrismaService,
    private readonly rateLimit: RateLimitService,
    private readonly tenancy: TenancyService,
    private readonly tokens: TokenService,
    private readonly audit: AuditService,
  ) {}

  async login(body: StaffLoginRequest, req: Request): Promise<MfaStepResponse> {
    const email = body.email.trim().toLowerCase();
    const ip = requestMeta(req).ip;
    await this.rateLimit.enforce(`login:ip:${this.rateLimit.hashKeyPart(ip ?? "unknown")}`, ...LOGIN_PER_IP);
    const failKey = loginFailureKey(email);
    if (!(await this.rateLimit.consume(failKey, ...LOGIN_FAILURES_PER_EMAIL)).allowed) {
      throw new HttpException(
        { code: "RATE_LIMITED", message: "Too many attempts, try again later" },
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }

    const orgId = await this.tenancy.getOrgId();
    const staff = await this.prisma.staffUser.findUnique({
      where: { organizationId_email: { organizationId: orgId, email } },
      select: { id: true, active: true, canLogin: true, passwordHash: true, totpEnrolledAt: true },
    });

    if (!staff || !staff.active || !staff.canLogin || !staff.passwordHash) {
      await verifyPassword(this.dummyHash, body.password);
      throw invalidCredentials();
    }

    if (!(await verifyPassword(staff.passwordHash, body.password))) {
      await this.audit.record({
        orgId,
        actorType: "SYSTEM",
        actorId: null,
        action: "auth.staff.login_failed",
        entity: "staff_user",
        entityId: staff.id,
        ip,
      });
      throw invalidCredentials();
    }

    await this.rateLimit.reset(failKey);
    const enrolled = staff.totpEnrolledAt !== null;
    const mfa = await this.tokens.issueMfa(staff.id, orgId, enrolled ? "verify" : "enroll");
    return {
      status: enrolled ? "MFA_REQUIRED" : "ENROLL_REQUIRED",
      mfaToken: mfa.token,
      mfaTokenExpiresAt: mfa.expiresAt.toISOString(),
    };
  }

  /** The dummy hash for unknown/ineligible accounts, computed once at startup. */
  async onModuleInit(): Promise<void> {
    this.dummyHash = await hashPassword(DUMMY_PASSWORD_HASH_INPUT);
  }
}
