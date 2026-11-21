import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from "@nestjs/common";
import type { TimeOff } from "@prisma/client";
import type { AccessClaims, TimeOffBody, TimeOffItem, TimeOffPatch, TimeOffQuery } from "@grooming/contracts";
import { AuditService } from "../audit/audit.service.js";
import { PrismaService } from "../prisma/prisma.service.js";
import { TenancyService } from "../tenancy/tenancy.service.js";

function toItem(r: TimeOff): TimeOffItem {
  return {
    id: r.id,
    staffUserId: r.staffUserId,
    startsAt: r.startsAt.toISOString(),
    endsAt: r.endsAt.toISOString(),
    kind: r.kind,
    note: r.note,
  };
}

@Injectable()
export class TimeOffService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly tenancy: TenancyService,
    private readonly audit: AuditService,
  ) {}

  async list(actor: AccessClaims, q: TimeOffQuery): Promise<TimeOffItem[]> {
    const organizationId = await this.tenancy.getOrgId();
    let staffUserId = q.staffUserId;
    if (actor.role === "EMPLOYEE") {
      if (staffUserId !== undefined && staffUserId !== actor.sub) throw new ForbiddenException();
      staffUserId = actor.sub;
    }
    const rows = await this.prisma.timeOff.findMany({
      where: {
        organizationId,
        ...(staffUserId ? { staffUserId } : {}),
        // Overlap with [from, to).
        ...(q.from ? { endsAt: { gt: new Date(q.from) } } : {}),
        ...(q.to ? { startsAt: { lt: new Date(q.to) } } : {}),
      },
      orderBy: [{ startsAt: "asc" }, { id: "asc" }],
    });
    return rows.map(toItem);
  }

  async create(actor: AccessClaims, body: TimeOffBody, ip: string | null): Promise<TimeOffItem> {
    const orgId = await this.tenancy.getOrgId();
    return this.prisma.$transaction(async (tx) => {
      const person = await tx.staffUser.findFirst({ where: { id: body.staffUserId, organizationId: orgId }, select: { id: true } });
      if (!person) throw new NotFoundException("Staff member not found");
      const row = await tx.timeOff.create({
        data: {
          organizationId: orgId,
          staffUserId: body.staffUserId,
          startsAt: new Date(body.startsAt),
          endsAt: new Date(body.endsAt),
          kind: body.kind,
          note: body.note ?? null,
        },
      });
      const item = toItem(row);
      await this.audit.record(
        { orgId, actorType: "STAFF", actorId: actor.sub, action: "time_off.create", entity: "time_off", entityId: row.id, after: item, ip },
        tx,
      );
      return item;
    });
  }

  async patch(actor: AccessClaims, id: string, body: TimeOffPatch, ip: string | null): Promise<TimeOffItem> {
    const orgId = await this.tenancy.getOrgId();
    return this.prisma.$transaction(async (tx) => {
      const before = await tx.timeOff.findFirst({ where: { id, organizationId: orgId } });
      if (!before) throw new NotFoundException("Time off not found");
      const startsAt = body.startsAt ? new Date(body.startsAt) : before.startsAt;
      const endsAt = body.endsAt ? new Date(body.endsAt) : before.endsAt;
      if (endsAt <= startsAt) {
        throw new BadRequestException({ code: "VALIDATION_FAILED", message: "endsAt must be after startsAt" });
      }
      const row = await tx.timeOff.update({
        where: { id },
        data: {
          startsAt,
          endsAt,
          ...(body.kind ? { kind: body.kind } : {}),
          ...(body.note !== undefined ? { note: body.note } : {}),
        },
      });
      const item = toItem(row);
      await this.audit.record(
        { orgId, actorType: "STAFF", actorId: actor.sub, action: "time_off.update", entity: "time_off", entityId: id, before: toItem(before), after: item, ip },
        tx,
      );
      return item;
    });
  }

  async remove(actor: AccessClaims, id: string, ip: string | null): Promise<void> {
    const orgId = await this.tenancy.getOrgId();
    await this.prisma.$transaction(async (tx) => {
      const before = await tx.timeOff.findFirst({ where: { id, organizationId: orgId } });
      if (!before) throw new NotFoundException("Time off not found");
      await tx.timeOff.delete({ where: { id } });
      await this.audit.record(
        { orgId, actorType: "STAFF", actorId: actor.sub, action: "time_off.delete", entity: "time_off", entityId: id, before: toItem(before), ip },
        tx,
      );
    });
  }
}
