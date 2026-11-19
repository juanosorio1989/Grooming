import { randomUUID } from "node:crypto";
import { Injectable, Logger, UnauthorizedException } from "@nestjs/common";
import type { Prisma } from "@prisma/client";
import { AuditService } from "../audit/audit.service.js";
import { PrismaService } from "../prisma/prisma.service.js";
import { TenancyService } from "../tenancy/tenancy.service.js";
import { randomToken, sha256Hex } from "./crypto/tokens.js";
import type { RequestMeta, Subject } from "./request-meta.js";

export const REFRESH_TTL_MS: Record<Subject["type"], number> = {
  CUSTOMER: 30 * 24 * 3600_000,
  STAFF: 12 * 3600_000,
};

type RotateOutcome =
  | { kind: "ok"; subject: Subject; token: string; expiresAt: Date }
  | { kind: "invalid" }
  | { kind: "reuse"; familyId: string; subject: Subject };

const unauthorized = () => new UnauthorizedException({ code: "UNAUTHORIZED" });

/**
 * Opaque refresh tokens (32 random bytes, base64url). Only `sha256Hex(token)` is
 * stored. Each login starts a family; every refresh rotates the token within
 * the family and the successor inherits `expires_at` (absolute lifetime per
 * login). Only reuse revokes the whole family: presenting an already rotated
 * token, or losing a concurrent claim on the same token. A token that is only
 * revoked (logout, `revokeAllFor`, a family already revoked) is a plain 401.
 */
@Injectable()
export class RefreshTokenService {
  private readonly logger = new Logger(RefreshTokenService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly tenancy: TenancyService,
  ) {}

  async create(subject: Subject, meta: RequestMeta): Promise<{ token: string; expiresAt: Date }> {
    const token = randomToken();
    const expiresAt = new Date(Date.now() + REFRESH_TTL_MS[subject.type]);
    await this.prisma.refreshToken.create({
      data: {
        subjectType: subject.type,
        subjectId: subject.id,
        familyId: randomUUID(),
        tokenHash: sha256Hex(token),
        expiresAt,
        userAgent: meta.userAgent,
        ip: meta.ip,
      },
    });
    return { token, expiresAt };
  }

  /**
   * Rotates `token`. Throws 401 `UNAUTHORIZED` when it is unknown, expired or
   * revoked. Presenting an already rotated token (or losing a concurrent
   * rotation) is reuse: the family revocation is committed first, then an
   * `auth.refresh_reuse` audit row is written; an audit failure is logged and
   * the answer is still 401.
   */
  async rotate(token: string, meta: RequestMeta): Promise<{ subject: Subject; token: string; expiresAt: Date }> {
    const orgId = await this.tenancy.getOrgId();
    const outcome = await this.prisma.$transaction(async (tx): Promise<RotateOutcome> => {
      const now = new Date();
      const current = await tx.refreshToken.findUnique({ where: { tokenHash: sha256Hex(token) } });
      if (!current || current.expiresAt <= now) return { kind: "invalid" };
      const subject: Subject = { type: current.subjectType, id: current.subjectId };
      // Revoked but never rotated (logout, revokeAllFor): an ended session, not reuse.
      if (current.revokedAt !== null && current.rotatedAt === null) return { kind: "invalid" };

      const claimed =
        current.rotatedAt === null
          ? await tx.refreshToken.updateMany({
              where: { id: current.id, rotatedAt: null, revokedAt: null },
              data: { rotatedAt: now },
            })
          : { count: 0 };
      if (claimed.count !== 1) {
        // Reuse of a rotated token, or a concurrent rotation that lost the race.
        await this.revokeFamily(tx, current.familyId, now);
        return { kind: "reuse", familyId: current.familyId, subject };
      }

      const next = randomToken();
      await tx.refreshToken.create({
        data: {
          subjectType: current.subjectType,
          subjectId: current.subjectId,
          familyId: current.familyId,
          tokenHash: sha256Hex(next),
          expiresAt: current.expiresAt,
          userAgent: meta.userAgent,
          ip: meta.ip,
        },
      });
      return { kind: "ok", subject, token: next, expiresAt: current.expiresAt };
    });

    if (outcome.kind === "reuse") await this.auditReuse(orgId, outcome.familyId, outcome.subject, meta);
    if (outcome.kind !== "ok") throw unauthorized();
    return { subject: outcome.subject, token: outcome.token, expiresAt: outcome.expiresAt };
  }

  /** Runs after the revocation committed; never turns the 401 into a 500. */
  private async auditReuse(orgId: string, familyId: string, subject: Subject, meta: RequestMeta): Promise<void> {
    try {
      await this.audit.record({
        orgId,
        actorType: "SYSTEM",
        actorId: null,
        action: "auth.refresh_reuse",
        entity: "refresh_token_family",
        entityId: familyId,
        after: { subjectType: subject.type, subjectId: subject.id },
        ip: meta.ip,
      });
    } catch (err) {
      this.logger.warn(
        `auth.refresh_reuse audit write failed for family ${familyId}: ${err instanceof Error ? err.name : "unknown error"}`,
      );
    }
  }

  /** Revokes the family `token` belongs to. No-op for an unknown token. */
  async revokeFamilyOf(token: string): Promise<void> {
    const row = await this.prisma.refreshToken.findUnique({
      where: { tokenHash: sha256Hex(token) },
      select: { familyId: true },
    });
    if (row) await this.revokeFamily(this.prisma, row.familyId, new Date());
  }

  /** Revokes every live refresh token of `subject` (all devices). Pass `tx` to run inside the caller's transaction. */
  async revokeAllFor(subject: Subject, tx?: Prisma.TransactionClient): Promise<void> {
    await (tx ?? this.prisma).refreshToken.updateMany({
      where: { subjectType: subject.type, subjectId: subject.id, revokedAt: null },
      data: { revokedAt: new Date() },
    });
  }

  private async revokeFamily(db: Prisma.TransactionClient, familyId: string, now: Date): Promise<void> {
    await db.refreshToken.updateMany({ where: { familyId, revokedAt: null }, data: { revokedAt: now } });
  }
}
