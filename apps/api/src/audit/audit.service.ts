import { Injectable } from "@nestjs/common";
import type { Prisma } from "@prisma/client";
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
}
