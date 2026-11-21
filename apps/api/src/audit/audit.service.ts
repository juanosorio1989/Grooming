import { Injectable } from "@nestjs/common";
import type { Prisma } from "@prisma/client";
import type { AuditItem, AuditPage, AuditQuery } from "@grooming/contracts";
import { PrismaService } from "../prisma/prisma.service.js";

export interface AuditEntry {
  orgId: string;
  actorType: "STAFF" | "CUSTOMER" | "SYSTEM";
  /** Null for SYSTEM. */
  actorId: string | null;
  /** e.g. `auth.refresh_reuse`, `appointment.create`. */
  action: string;
  entity: string;
  entityId?: string | null;
  /** Never put secrets (tokens, hashes, passwords, TOTP secrets) in `before`/`after`. */
  before?: object | null;
  after?: object | null;
  ip?: string | null;
}

/** Append-only writer for `audit_log`. Pass `tx` to write inside the caller's transaction. */
@Injectable()
export class AuditService {
  constructor(private readonly prisma: PrismaService) {}

  async record(entry: AuditEntry, tx?: Prisma.TransactionClient): Promise<void> {
    const db = tx ?? this.prisma;
    await db.auditLog.create({
      data: {
        organizationId: entry.orgId,
        actorType: entry.actorType,
        actorId: entry.actorId,
        action: entry.action,
        entity: entry.entity,
        entityId: entry.entityId ?? null,
        ...(entry.before ? { before: entry.before as Prisma.InputJsonObject } : {}),
        ...(entry.after ? { after: entry.after as Prisma.InputJsonObject } : {}),
        ip: entry.ip ?? null,
      },
    });
  }

  /** Newest first (`at desc, id desc`); `nextBefore` is the last item's `at` when more rows may follow. `ip` is never returned. */
  async list(orgId: string, q: AuditQuery): Promise<AuditPage> {
    const rows = await this.prisma.auditLog.findMany({
      where: {
        organizationId: orgId,
        ...(q.entity ? { entity: q.entity } : {}),
        ...(q.entityId ? { entityId: q.entityId } : {}),
        ...(q.before ? { at: { lt: new Date(q.before) } } : {}),
      },
      orderBy: [{ at: "desc" }, { id: "desc" }],
      take: q.limit + 1,
    });
    const page = rows.slice(0, q.limit);
    const items: AuditItem[] = page.map((r) => ({
      id: r.id,
      at: r.at.toISOString(),
      actorType: r.actorType,
      actorId: r.actorId,
      action: r.action,
      entity: r.entity,
      entityId: r.entityId,
      before: r.before,
      after: r.after,
    }));
    const last = page.at(-1);
    return { items, nextBefore: rows.length > q.limit && last ? last.at.toISOString() : null };
  }
}
