import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
} from "@nestjs/common";
import type { Prisma, StaffTokenPurpose } from "@prisma/client";
import type { Request } from "express";
import {
  LocaleSchema,
  type AccessClaims,
  type InviteAcceptRequest,
  type Locale,
  type MfaStepResponse,
  type PasswordForgotRequest,
  type PasswordResetRequest,
} from "@grooming/contracts";
import { AuditService } from "../../audit/audit.service.js";
import { ENV, type Env } from "../../config/env.js";
import { MAILER, type Mailer } from "../../mail/mailer.js";
import { PrismaService } from "../../prisma/prisma.service.js";
import { RateLimitService } from "../../rate-limit/rate-limit.service.js";
import { TenancyService } from "../../tenancy/tenancy.service.js";
import { hashPassword } from "../crypto/password.js";
import { randomToken, sha256Hex } from "../crypto/tokens.js";
import { RefreshTokenService } from "../refresh-token.service.js";
import { requestMeta } from "../request-meta.js";
import { TokenService } from "../token.service.js";
import { inviteEmail, resetEmail } from "./emails.js";
import { loginFailureKey } from "./staff-auth.service.js";

/** Link lifetimes. */
export const LINK_TTL_MS: Record<StaffTokenPurpose, number> = {
  INVITE: 72 * 3600_000,
  PASSWORD_RESET: 3600_000,
};
/** Rate limits: [limit, window seconds]. */
export const LINK_PER_IP = [10, 900] as const;
export const FORGOT_PER_EMAIL = [3, 3600] as const;

const LINK_PATH: Record<StaffTokenPurpose, string> = { INVITE: "invite", PASSWORD_RESET: "reset" };

/** One answer for unknown, used, expired, wrong-purpose and inactive-staff links. */
const linkInvalid = () => new BadRequestException({ code: "LINK_INVALID", message: "This link is invalid or has expired" });
const notFound = () => new NotFoundException({ code: "NOT_FOUND", message: "Staff member not found" });

const toLocale = (value: string): Locale => {
  const parsed = LocaleSchema.safeParse(value);
  return parsed.success ? parsed.data : "en";
};

type ClaimedLink = { tokenId: string; staffId: string; orgId: string; enrolled: boolean; email: string | null };

/**
 * Single-use staff links: invites (72 h) and password resets (1 h). The link
 * token is 32 random bytes (base64url); only `sha256Hex(token)` is stored in
 * `staff_auth_token`. Issuing a link marks older unused links of the same
 * purpose used. Also the OWNER actions (invite, reset another member's 2FA)
 * and the `create-owner` CLI.
 */
@Injectable()
export class StaffLinksService {
  private readonly logger = new Logger(StaffLinksService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly rateLimit: RateLimitService,
    private readonly tenancy: TenancyService,
    private readonly tokens: TokenService,
    private readonly refreshTokens: RefreshTokenService,
    private readonly audit: AuditService,
    @Inject(MAILER) private readonly mailer: Mailer,
    @Inject(ENV) private readonly env: Env,
  ) {}

  /** Stores a new link for `staffId` (superseding unused ones of `purpose`) and returns its URL. */
  async issue(staffId: string, purpose: StaffTokenPurpose, tx?: Prisma.TransactionClient): Promise<string> {
    const db = tx ?? this.prisma;
    const staff = await db.staffUser.findUniqueOrThrow({ where: { id: staffId }, select: { locale: true } });
    const now = new Date();
    await db.staffAuthToken.updateMany({
      where: { staffUserId: staffId, purpose, usedAt: null },
      data: { usedAt: now },
    });
    const token = randomToken();
    await db.staffAuthToken.create({
      data: {
        staffUserId: staffId,
        purpose,
        tokenHash: sha256Hex(token),
        expiresAt: new Date(now.getTime() + LINK_TTL_MS[purpose]),
      },
    });
    const url = new URL(`/${toLocale(staff.locale)}/staff/${LINK_PATH[purpose]}`, this.env.WEB_ORIGIN);
    url.searchParams.set("token", token);
    return url.toString();
  }

  /** Invite link + new password → `can_login`, then the MFA step (enroll, or verify if already enrolled). */
  async acceptInvite(body: InviteAcceptRequest, req: Request): Promise<MfaStepResponse> {
    const ip = requestMeta(req).ip;
    await this.limitIp("accept", ip);
    const link = await this.findLink(body.token, "INVITE");
    const passwordHash = await hashPassword(body.password);
    await this.prisma.$transaction(async (tx) => {
      await this.claim(tx, link.tokenId);
      await tx.staffUser.update({ where: { id: link.staffId }, data: { passwordHash, canLogin: true } });
      await this.audit.record(
        {
          orgId: link.orgId,
          actorType: "STAFF",
          actorId: link.staffId,
          action: "auth.staff.invite_accepted",
          entity: "staff_user",
          entityId: link.staffId,
          ip,
        },
        tx,
      );
    });
    await this.clearLoginLockout(link.email);
    const mfa = await this.tokens.issueMfa(link.staffId, link.orgId, link.enrolled ? "verify" : "enroll");
    return {
      status: link.enrolled ? "MFA_REQUIRED" : "ENROLL_REQUIRED",
      mfaToken: mfa.token,
      mfaTokenExpiresAt: mfa.expiresAt.toISOString(),
    };
  }

  /**
   * Emails a reset link to an active, `can_login`, password-holding staff member.
   * Always resolves (the controller answers 204) so the answer never reveals an
   * account; over 3 requests per email per hour nothing is sent. 429 per IP.
   */
  async forgot(body: PasswordForgotRequest, ip: string | null): Promise<void> {
    await this.limitIp("forgot", ip);
    const email = body.email.trim().toLowerCase();
    const perEmail = await this.rateLimit.consume(`pwforgot:email:${this.rateLimit.hashKeyPart(email)}`, ...FORGOT_PER_EMAIL);
    if (!perEmail.allowed) return;

    const orgId = await this.tenancy.getOrgId();
    const staff = await this.prisma.staffUser.findUnique({
      where: { organizationId_email: { organizationId: orgId, email } },
      select: { id: true, active: true, canLogin: true, passwordHash: true, locale: true },
    });
    if (!staff || !staff.active || !staff.canLogin || !staff.passwordHash) return;

    const link = await this.issue(staff.id, "PASSWORD_RESET");
    try {
      await this.mailer.send({ to: email, ...resetEmail(toLocale(staff.locale), link) });
    } catch (err) {
      // A 500 here would tell the caller the account exists; the user can ask again.
      this.logger.error(`Password reset email failed: ${err instanceof Error ? err.message : "unknown error"}`);
    }
  }

  /** Reset link + new password → password replaced, every session revoked. */
  async reset(body: PasswordResetRequest, req: Request): Promise<void> {
    const ip = requestMeta(req).ip;
    await this.limitIp("reset", ip);
    const link = await this.findLink(body.token, "PASSWORD_RESET");
    const passwordHash = await hashPassword(body.password);
    await this.prisma.$transaction(async (tx) => {
      await this.claim(tx, link.tokenId);
      await tx.staffUser.update({ where: { id: link.staffId }, data: { passwordHash } });
      await this.refreshTokens.revokeAllFor({ type: "STAFF", id: link.staffId }, tx);
      await this.audit.record(
        {
          orgId: link.orgId,
          actorType: "STAFF",
          actorId: link.staffId,
          action: "auth.staff.password_reset",
          entity: "staff_user",
          entityId: link.staffId,
          ip,
        },
        tx,
      );
    });
    await this.clearLoginLockout(link.email);
  }

  /** OWNER emails a 72 h invite to a member of the same org who has an email and no password yet. */
  async inviteByOwner(owner: AccessClaims, staffId: string, ip: string | null): Promise<void> {
    const staff = await this.prisma.staffUser.findFirst({
      where: { id: staffId, organizationId: owner.org },
      select: { id: true, email: true, passwordHash: true, active: true, locale: true },
    });
    if (!staff) throw notFound();
    if (!staff.email) throw new ConflictException({ code: "CONFLICT", message: "Staff member has no email" });
    if (!staff.active) throw new ConflictException({ code: "CONFLICT", message: "Staff member is inactive" });
    if (staff.passwordHash) throw new ConflictException({ code: "CONFLICT", message: "Staff member already has a password" });

    const link = await this.prisma.$transaction(async (tx) => {
      const url = await this.issue(staff.id, "INVITE", tx);
      await this.audit.record(
        {
          orgId: owner.org,
          actorType: "STAFF",
          actorId: owner.sub,
          action: "staff.invite",
          entity: "staff_user",
          entityId: staff.id,
          ip,
        },
        tx,
      );
      return url;
    });
    await this.mailer.send({ to: staff.email, ...inviteEmail(toLocale(staff.locale), link) });
  }

  /** OWNER clears another member's TOTP and recovery codes and ends their sessions (they enroll again at next login). */
  async reset2faByOwner(owner: AccessClaims, staffId: string, ip: string | null): Promise<void> {
    if (staffId === owner.sub) {
      throw new ForbiddenException({ code: "FORBIDDEN", message: "Use your recovery codes or the CLI to reset your own 2FA" });
    }
    await this.prisma.$transaction(async (tx) => {
      const rows = await tx.$queryRaw<{ totp_enrolled_at: Date | null }[]>`
        SELECT totp_enrolled_at FROM staff_user
        WHERE id = ${staffId}::uuid AND organization_id = ${owner.org}::uuid
        FOR UPDATE`;
      const target = rows[0];
      if (!target) throw notFound();
      await tx.staffUser.update({ where: { id: staffId }, data: { totpSecretEnc: null, totpEnrolledAt: null } });
      await tx.staffRecoveryCode.deleteMany({ where: { staffUserId: staffId } });
      await this.refreshTokens.revokeAllFor({ type: "STAFF", id: staffId }, tx);
      await this.audit.record(
        {
          orgId: owner.org,
          actorType: "STAFF",
          actorId: owner.sub,
          action: "staff.reset_2fa",
          entity: "staff_user",
          entityId: staffId,
          before: { totpEnrolled: target.totp_enrolled_at !== null },
          ip,
        },
        tx,
      );
    });
  }

  /**
   * `create-owner` CLI. In the default org: creates an OWNER with that email, or
   * resets an existing OWNER (password, TOTP, recovery codes and sessions cleared;
   * login re-enabled). Either way returns a fresh 72 h invite link in the OWNER's
   * locale. `locale`: used on create (default `en`); on reset it replaces the
   * stored locale only when given. Throws for an email that belongs to a non-owner.
   */
  async createOrResetOwner(rawEmail: string, locale?: Locale): Promise<{ link: string; created: boolean }> {
    const email = rawEmail.trim().toLowerCase();
    const orgId = await this.tenancy.getOrgId();
    return this.prisma.$transaction(async (tx) => {
      const existing = await tx.staffUser.findUnique({
        where: { organizationId_email: { organizationId: orgId, email } },
        select: { id: true, role: true },
      });
      if (existing && existing.role !== "OWNER") throw new Error(`${email} belongs to a non-owner staff member`);

      let staffId: string;
      if (existing) {
        staffId = existing.id;
        await tx.staffUser.update({
          where: { id: staffId },
          data: {
            passwordHash: null,
            totpSecretEnc: null,
            totpEnrolledAt: null,
            canLogin: true,
            active: true,
            ...(locale !== undefined && { locale }),
          },
        });
        await tx.staffRecoveryCode.deleteMany({ where: { staffUserId: staffId } });
        await this.refreshTokens.revokeAllFor({ type: "STAFF", id: staffId }, tx);
      } else {
        const created = await tx.staffUser.create({
          data: { organizationId: orgId, email, role: "OWNER", canLogin: true, locale: locale ?? "en" },
          select: { id: true },
        });
        staffId = created.id;
      }
      const link = await this.issue(staffId, "INVITE", tx);
      await this.audit.record(
        {
          orgId,
          actorType: "SYSTEM",
          actorId: null,
          action: "staff.owner_cli",
          entity: "staff_user",
          entityId: staffId,
          after: { created: !existing },
        },
        tx,
      );
      return { link, created: !existing };
    });
  }

  /**
   * A new password set through a link ends any login lockout on that email.
   * Runs after the commit; a Redis failure is logged and never undoes the success.
   */
  private async clearLoginLockout(email: string | null): Promise<void> {
    if (!email) return;
    try {
      await this.rateLimit.reset(loginFailureKey(email));
    } catch (err) {
      this.logger.warn(`Login lockout reset failed: ${err instanceof Error ? err.name : "unknown error"}`);
    }
  }

  private limitIp(scope: "accept" | "forgot" | "reset", ip: string | null): Promise<void> {
    return this.rateLimit.enforce(`link:${scope}:ip:${this.rateLimit.hashKeyPart(ip ?? "unknown")}`, ...LINK_PER_IP);
  }

  /** The unused, unexpired link of `purpose` for an active member of this org, else `LINK_INVALID`. */
  private async findLink(token: string, purpose: StaffTokenPurpose): Promise<ClaimedLink> {
    const orgId = await this.tenancy.getOrgId();
    const row = await this.prisma.staffAuthToken.findUnique({
      where: { tokenHash: sha256Hex(token) },
      select: {
        id: true,
        purpose: true,
        expiresAt: true,
        usedAt: true,
        staffUser: { select: { id: true, organizationId: true, active: true, totpEnrolledAt: true, email: true } },
      },
    });
    if (
      !row ||
      row.purpose !== purpose ||
      row.usedAt !== null ||
      row.expiresAt <= new Date() ||
      !row.staffUser.active ||
      row.staffUser.organizationId !== orgId
    ) {
      throw linkInvalid();
    }
    return {
      tokenId: row.id,
      staffId: row.staffUser.id,
      orgId,
      enrolled: row.staffUser.totpEnrolledAt !== null,
      email: row.staffUser.email,
    };
  }

  /** Spends the link inside `tx`; a concurrent use (or expiry since the check) loses here. */
  private async claim(tx: Prisma.TransactionClient, tokenId: string): Promise<void> {
    const now = new Date();
    const claimed = await tx.staffAuthToken.updateMany({
      where: { id: tokenId, usedAt: null, expiresAt: { gt: now } },
      data: { usedAt: now },
    });
    if (claimed.count !== 1) throw linkInvalid();
  }
}
