import { ConflictException, Injectable, NotFoundException } from "@nestjs/common";
import type { Prisma, ResourceType } from "@prisma/client";
import type {
  AccessClaims,
  LocalizedText,
  ResourceBody,
  ResourceItem,
  ResourcePatch,
  ResourceQuery,
  ResourceTypeBody,
  ResourceTypeItem,
  ResourceTypePatch,
} from "@grooming/contracts";
import { AuditService } from "../audit/audit.service.js";
import { LocationService } from "../location/location.service.js";
import { PrismaService } from "../prisma/prisma.service.js";
import { TenancyService } from "../tenancy/tenancy.service.js";

type ResourceRow = Prisma.ResourceGetPayload<{ include: { resourceType: { select: { kind: true } } } }>;

function toResource(r: ResourceRow): ResourceItem {
  return { id: r.id, name: r.name, resourceTypeId: r.resourceTypeId, kind: r.resourceType.kind, active: r.active };
}

function toType(t: ResourceType, resourceCount: number): ResourceTypeItem {
  return { id: t.id, name: t.name as unknown as LocalizedText, kind: t.kind, resourceCount };
}

const duplicate = () => new ConflictException({ code: "CONFLICT", message: "An active resource with this name already exists" });

@Injectable()
export class ResourcesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly tenancy: TenancyService,
    private readonly location: LocationService,
    private readonly audit: AuditService,
  ) {}

  // ------------------------------------------------------------ resource types

  async listTypes(): Promise<ResourceTypeItem[]> {
    const organizationId = await this.tenancy.getOrgId();
    const rows = await this.prisma.resourceType.findMany({
      where: { organizationId },
      include: { _count: { select: { resources: true } } },
      orderBy: [{ kind: "asc" }, { createdAt: "asc" }, { id: "asc" }],
    });
    return rows.map((t) => toType(t, t._count.resources));
  }

  async createType(actor: AccessClaims, body: ResourceTypeBody, ip: string | null): Promise<ResourceTypeItem> {
    const orgId = await this.tenancy.getOrgId();
    return this.prisma.$transaction(async (tx) => {
      const row = await tx.resourceType.create({ data: { organizationId: orgId, name: body.name, kind: body.kind } });
      const item = toType(row, 0);
      await this.audit.record(
        { orgId, actorType: "STAFF", actorId: actor.sub, action: "resource_type.create", entity: "resource_type", entityId: row.id, after: { name: body.name, kind: body.kind }, ip },
        tx,
      );
      return item;
    });
  }

  async patchType(actor: AccessClaims, id: string, body: ResourceTypePatch, ip: string | null): Promise<ResourceTypeItem> {
    const orgId = await this.tenancy.getOrgId();
    return this.prisma.$transaction(async (tx) => {
      const before = await tx.resourceType.findFirst({ where: { id, organizationId: orgId } });
      if (!before) throw new NotFoundException("Resource type not found");
      const row = await tx.resourceType.update({ where: { id }, data: { name: body.name } });
      await this.audit.record(
        { orgId, actorType: "STAFF", actorId: actor.sub, action: "resource_type.update", entity: "resource_type", entityId: id, before: { name: before.name }, after: { name: body.name }, ip },
        tx,
      );
      return toType(row, await tx.resource.count({ where: { resourceTypeId: id } }));
    });
  }

  async deleteType(actor: AccessClaims, id: string, ip: string | null): Promise<void> {
    const orgId = await this.tenancy.getOrgId();
    await this.prisma.$transaction(async (tx) => {
      const row = await tx.resourceType.findFirst({ where: { id, organizationId: orgId } });
      if (!row) throw new NotFoundException("Resource type not found");
      const [resources, services] = await Promise.all([
        tx.resource.count({ where: { resourceTypeId: id } }),
        tx.service.count({ where: { resourceTypeId: id } }),
      ]);
      if (resources > 0 || services > 0) {
        throw new ConflictException({ code: "IN_USE", message: "Resource type is used by resources or services" });
      }
      await tx.resourceType.delete({ where: { id } });
      await this.audit.record(
        { orgId, actorType: "STAFF", actorId: actor.sub, action: "resource_type.delete", entity: "resource_type", entityId: id, before: { name: row.name, kind: row.kind }, ip },
        tx,
      );
    });
  }

  // ----------------------------------------------------------------- resources

  async list(q: ResourceQuery): Promise<ResourceItem[]> {
    const organizationId = await this.tenancy.getOrgId();
    const rows = await this.prisma.resource.findMany({
      where: {
        organizationId,
        ...(q.includeInactive === "true" ? {} : { active: true }),
        ...(q.kind ? { resourceType: { kind: q.kind } } : {}),
      },
      include: { resourceType: { select: { kind: true } } },
      orderBy: [{ resourceTypeId: "asc" }, { name: "asc" }, { id: "asc" }],
    });
    return rows.map(toResource);
  }

  async create(actor: AccessClaims, body: ResourceBody, ip: string | null): Promise<ResourceItem> {
    const orgId = await this.tenancy.getOrgId();
    const { id: locationId } = await this.location.getDefault();
    return this.prisma.$transaction(async (tx) => {
      const type = await tx.resourceType.findFirst({ where: { id: body.resourceTypeId, organizationId: orgId } });
      if (!type) throw new NotFoundException("Resource type not found");
      await this.assertNameFree(tx, locationId, body.name);
      const row = await tx.resource.create({
        data: { organizationId: orgId, locationId, resourceTypeId: type.id, name: body.name },
        include: { resourceType: { select: { kind: true } } },
      });
      const item = toResource(row);
      await this.audit.record(
        { orgId, actorType: "STAFF", actorId: actor.sub, action: "resource.create", entity: "resource", entityId: row.id, after: item, ip },
        tx,
      );
      return item;
    });
  }

  async patch(actor: AccessClaims, id: string, body: ResourcePatch, ip: string | null): Promise<ResourceItem> {
    const orgId = await this.tenancy.getOrgId();
    return this.prisma.$transaction(async (tx) => {
      const before = await this.find(tx, orgId, id);
      const name = body.name ?? before.name;
      const active = body.active ?? before.active;
      if (active && (name !== before.name || !before.active)) await this.assertNameFree(tx, before.locationId, name, id);
      const row = await tx.resource.update({ where: { id }, data: { name, active }, include: { resourceType: { select: { kind: true } } } });
      const item = toResource(row);
      await this.audit.record(
        { orgId, actorType: "STAFF", actorId: actor.sub, action: "resource.update", entity: "resource", entityId: id, before: toResource(before), after: item, ip },
        tx,
      );
      return item;
    });
  }

  async deactivate(actor: AccessClaims, id: string, ip: string | null): Promise<void> {
    const orgId = await this.tenancy.getOrgId();
    await this.prisma.$transaction(async (tx) => {
      const before = await this.find(tx, orgId, id);
      const row = await tx.resource.update({ where: { id }, data: { active: false }, include: { resourceType: { select: { kind: true } } } });
      await this.audit.record(
        { orgId, actorType: "STAFF", actorId: actor.sub, action: "resource.deactivate", entity: "resource", entityId: id, before: toResource(before), after: toResource(row), ip },
        tx,
      );
    });
  }

  private async find(tx: Prisma.TransactionClient, orgId: string, id: string): Promise<ResourceRow> {
    const row = await tx.resource.findFirst({ where: { id, organizationId: orgId }, include: { resourceType: { select: { kind: true } } } });
    if (!row) throw new NotFoundException("Resource not found");
    return row;
  }

  private async assertNameFree(tx: Prisma.TransactionClient, locationId: string, name: string, exceptId?: string): Promise<void> {
    const clash = await tx.resource.findFirst({
      where: { locationId, active: true, name: { equals: name, mode: "insensitive" }, ...(exceptId ? { id: { not: exceptId } } : {}) },
      select: { id: true },
    });
    if (clash) throw duplicate();
  }
}
