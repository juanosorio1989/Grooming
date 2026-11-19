import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  UnauthorizedException,
} from "@nestjs/common";
import type { Request, Response } from "express";
import type { Prisma } from "@prisma/client";
import type { Redis } from "ioredis";
import type {
  MfaCodeRequest,
  MfaEnrollConfirmResponse,
  MfaEnrollStartResponse,
  MfaRecoverRequest,
  MfaStepResponse,
  MfaTokenRequest,
  TokenResponse,
} from "@grooming/contracts";
import { AuditService } from "../../audit/audit.service.js";
import { PrismaService } from "../../prisma/prisma.service.js";
import { RateLimitService } from "../../rate-limit/rate-limit.service.js";
import { REDIS } from "../../redis/redis.module.js";
import { Encryptor } from "../crypto/encryption.js";
import { generateRecoveryCodes, hashRecoveryCode } from "../crypto/recovery-codes.js";
import { generateTotpSecret, otpauthUrl, verifyTotp } from "../crypto/totp.js";
import { RefreshTokenService } from "../refresh-token.service.js";
import { requestMeta } from "../request-meta.js";
import { SessionService } from "../session.service.js";
import { TokenService, type MfaPurpose } from "../token.service.js";

/** MFA confirm/verify/recover attempts per staff id: [limit, window seconds]. Shared by all three. */
export const MFA_ATTEMPTS_PER_STAFF = [5, 300] as const;
/** A matched TOTP step stays spent this long (covers the ±1 step window). */
const REPLAY_TTL_SEC = 120;
const TOTP_STEP_SEC = 30;
/** Oldest step whose replay key can still be alive: TTL / step + 1 (matched at current - 1). */
const SPENT_STEP_SPAN = REPLAY_TTL_SEC / TOTP_STEP_SEC + 2;

const unauthorized = () => new UnauthorizedException({ code: "UNAUTHORIZED" });
const mfaInvalid = () => new BadRequestException({ code: "MFA_INVALID", message: "Invalid code" });

/** `SELECT ... FOR UPDATE` on the staff row: serializes MFA state changes of one user. */
async function lockStaffRow(tx: Prisma.TransactionClient, staffId: string): Promise<void> {
  await tx.$queryRaw`SELECT id FROM staff_user WHERE id = ${staffId}::uuid FOR UPDATE`;
}

type StaffRow = {
  id: string;
  organizationId: string;
  email: string | null;
  totpSecretEnc: string | null;
  totpEnrolledAt: Date | null;
};

/**
 * Staff step 2 (TOTP). All routes take an `mfaToken` from login (`verify`) or from
 * login/recovery (`enroll`); the purpose must match. The TOTP secret is stored
 * AES-256-GCM encrypted in `totp_secret_enc`; it is pending while
 * `totp_enrolled_at` is null. Each matched TOTP step is usable once per user
 * (`totp:used:<staffId>:<counter>`).
 */
@Injectable()
export class MfaService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly tokens: TokenService,
    private readonly sessions: SessionService,
    private readonly refreshTokens: RefreshTokenService,
    private readonly rateLimit: RateLimitService,
    private readonly audit: AuditService,
    private readonly encryptor: Encryptor,
    @Inject(REDIS) private readonly redis: Redis,
  ) {}

  /** New pending secret (replaces any previous pending one). 409 once enrolled. Shares the per-staff MFA limit. */
  async enrollStart(body: MfaTokenRequest): Promise<MfaEnrollStartResponse> {
    const staff = await this.eligibleStaff(body.mfaToken, "enroll");
    await this.limit(staff.id);
    if (staff.totpEnrolledAt) throw new ConflictException({ code: "CONFLICT", message: "TOTP already enrolled" });
    const secret = generateTotpSecret();
    await this.prisma.staffUser.update({
      where: { id: staff.id },
      data: { totpSecretEnc: this.encryptor.encrypt(secret) },
    });
    await this.forgetSpentSteps(staff.id);
    return { secret, otpauthUrl: otpauthUrl(secret, staff.email ?? staff.id) };
  }

  async enrollConfirm(body: MfaCodeRequest, req: Request, res: Response): Promise<MfaEnrollConfirmResponse> {
    const staff = await this.eligibleStaff(body.mfaToken, "enroll");
    await this.limit(staff.id);
    if (staff.totpEnrolledAt || !staff.totpSecretEnc) {
      throw new ConflictException({ code: "CONFLICT", message: "No pending TOTP enrollment" });
    }
    const verifiedSecretEnc = staff.totpSecretEnc;
    await this.checkCode(staff.id, verifiedSecretEnc, body.code);

    const recoveryCodes = generateRecoveryCodes();
    await this.prisma.$transaction(async (tx) => {
      await lockStaffRow(tx, staff.id);
      // Only the exact pending secret the code was checked against may be enrolled: a
      // concurrent enrollStart (new secret) or a concurrent confirm makes this a 409.
      const enrolled = await tx.staffUser.updateMany({
        where: { id: staff.id, totpEnrolledAt: null, totpSecretEnc: verifiedSecretEnc },
        data: { totpEnrolledAt: new Date() },
      });
      if (enrolled.count !== 1) {
        throw new ConflictException({ code: "CONFLICT", message: "No pending TOTP enrollment" });
      }
      await tx.staffRecoveryCode.deleteMany({ where: { staffUserId: staff.id } });
      await tx.staffRecoveryCode.createMany({
        data: recoveryCodes.map((c) => ({ staffUserId: staff.id, codeHash: hashRecoveryCode(c) })),
      });
      await this.audit.record(
        {
          orgId: staff.organizationId,
          actorType: "STAFF",
          actorId: staff.id,
          action: "auth.staff.mfa_enrolled",
          entity: "staff_user",
          entityId: staff.id,
          ip: requestMeta(req).ip,
        },
        tx,
      );
    });
    const tokens = await this.sessions.start({ type: "STAFF", id: staff.id }, req, res);
    return { ...tokens, recoveryCodes };
  }

  async verify(body: MfaCodeRequest, req: Request, res: Response): Promise<TokenResponse> {
    const staff = await this.eligibleStaff(body.mfaToken, "verify");
    await this.limit(staff.id);
    if (!staff.totpEnrolledAt || !staff.totpSecretEnc) throw mfaInvalid();
    await this.checkCode(staff.id, staff.totpSecretEnc, body.code);
    await this.audit.record({
      orgId: staff.organizationId,
      actorType: "STAFF",
      actorId: staff.id,
      action: "auth.staff.login",
      entity: "staff_user",
      entityId: staff.id,
      ip: requestMeta(req).ip,
    });
    return this.sessions.start({ type: "STAFF", id: staff.id }, req, res);
  }

  /**
   * Spends one recovery code: clears TOTP, deletes the other codes, revokes every
   * refresh token of the user, and answers an enroll step (no session).
   */
  async recover(body: MfaRecoverRequest, req: Request): Promise<MfaStepResponse> {
    const staff = await this.eligibleStaff(body.mfaToken, "verify");
    await this.limit(staff.id);
    const codeHash = hashRecoveryCode(body.recoveryCode);

    const recovered = await this.prisma.$transaction(async (tx) => {
      // Serializes recoveries of one user (two different valid codes would otherwise
      // race on the "delete the other codes" step and deadlock or both succeed).
      await lockStaffRow(tx, staff.id);
      const code = await tx.staffRecoveryCode.findFirst({
        where: { staffUserId: staff.id, codeHash, usedAt: null },
        select: { id: true },
      });
      if (!code) return false;
      // Conditional on `used_at IS NULL`: a concurrent recovery with the same code loses here.
      const claimed = await tx.staffRecoveryCode.updateMany({
        where: { id: code.id, usedAt: null },
        data: { usedAt: new Date() },
      });
      if (claimed.count !== 1) return false;
      await tx.staffRecoveryCode.deleteMany({ where: { staffUserId: staff.id, id: { not: code.id } } });
      await tx.staffUser.update({
        where: { id: staff.id },
        data: { totpSecretEnc: null, totpEnrolledAt: null },
      });
      await this.refreshTokens.revokeAllFor({ type: "STAFF", id: staff.id }, tx);
      await this.audit.record(
        {
          orgId: staff.organizationId,
          actorType: "STAFF",
          actorId: staff.id,
          action: "auth.staff.recovery_used",
          entity: "staff_user",
          entityId: staff.id,
          ip: requestMeta(req).ip,
        },
        tx,
      );
      return true;
    });
    if (!recovered) throw mfaInvalid();

    const mfa = await this.tokens.issueMfa(staff.id, staff.organizationId, "enroll");
    return { status: "ENROLL_REQUIRED", mfaToken: mfa.token, mfaTokenExpiresAt: mfa.expiresAt.toISOString() };
  }

  /** Verifies the MFA token for `purpose` and re-checks that the user may still log in (401 otherwise). */
  private async eligibleStaff(mfaToken: string, purpose: MfaPurpose): Promise<StaffRow> {
    const { staffId, orgId } = await this.tokens.verifyMfa(mfaToken, purpose);
    const staff = await this.prisma.staffUser.findUnique({
      where: { id: staffId },
      select: {
        id: true,
        organizationId: true,
        email: true,
        active: true,
        canLogin: true,
        totpSecretEnc: true,
        totpEnrolledAt: true,
      },
    });
    if (!staff || staff.organizationId !== orgId || !staff.active || !staff.canLogin) throw unauthorized();
    return staff;
  }

  /**
   * Steps spent with a previous secret mean nothing for a new one; without this, a
   * user who recovers and re-enrolls within the same 30 s step could not confirm.
   * Covers every step a live replay key can name (TTL 120 s, ±1 step).
   */
  private async forgetSpentSteps(staffId: string): Promise<void> {
    const current = Math.floor(Date.now() / 1000 / TOTP_STEP_SEC);
    const keys: string[] = [];
    for (let step = current - SPENT_STEP_SPAN; step <= current + 1; step++) keys.push(`totp:used:${staffId}:${step}`);
    await this.redis.del(...keys);
  }

  private limit(staffId: string): Promise<void> {
    return this.rateLimit.enforce(`mfa:staff:${staffId}`, ...MFA_ATTEMPTS_PER_STAFF);
  }

  /**
   * 400 `MFA_INVALID` unless `code` matches a step in ±1 that this user has not spent.
   * A corrupt stored secret throws (500): that is a server fault, not a bad code.
   */
  private async checkCode(staffId: string, secretEnc: string, code: string): Promise<void> {
    const counter = verifyTotp(this.encryptor.decrypt(secretEnc), code, Date.now());
    if (counter === null) throw mfaInvalid();
    const fresh = await this.redis.set(`totp:used:${staffId}:${counter}`, "1", "EX", REPLAY_TTL_SEC, "NX");
    if (fresh !== "OK") throw mfaInvalid();
  }
}
