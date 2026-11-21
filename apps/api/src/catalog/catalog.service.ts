import { BadRequestException, ConflictException, Injectable, NotFoundException } from "@nestjs/common";
import { Prisma, type Service, type ServicePrice } from "@prisma/client";
import type {
  AccessClaims,
  CategoryBody,
  CategoryItem,
  CategoryPatch,
  LocalizedText,
  PriceMatrix,
  ServiceBody,
  ServicePatch,
  ServicePriceRow,
  ServiceQuery,
  ServiceView,
} from "@grooming/contracts";
import { AuditService } from "../audit/audit.service.js";
import { PrismaService } from "../prisma/prisma.service.js";
import { TenancyService } from "../tenancy/tenancy.service.js";
import { checkStageRule } from "./stage-rule.js";

type ServiceRow = Service & { prices: ServicePrice[] };

const toPriceRow = (p: ServicePrice): ServicePriceRow => ({
  sizeClass: p.sizeClass,
  coatType: p.coatType,
  durationMin: p.durationMin,
  priceCents: p.priceCents,
});

const SIZE_ORDER = ["S", "M", "L", "XL"];
const COAT_ORDER = ["SMOOTH", "DOUBLE", "CURLY", "WIRE", "LONG", "HAIRLESS"];
const sortRows = (rows: ServicePriceRow[]): ServicePriceRow[] =>
  [...rows].sort(
    (a, b) =>
      SIZE_ORDER.indexOf(a.sizeClass) - SIZE_ORDER.indexOf(b.sizeClass) ||
      (a.coatType === null ? -1 : COAT_ORDER.indexOf(a.coatType)) - (b.coatType === null ? -1 : COAT_ORDER.indexOf(b.coatType)),
  );

function toView(s: ServiceRow): ServiceView {
  return {
    id: s.id,
    categoryId: s.categoryId,
    name: s.name as unknown as LocalizedText,
    description: (s.description as unknown as LocalizedText | null) ?? null,
    species: s.species,
    stage: s.stage,
    isMain: s.isMain,
    resourceTypeId: s.resourceTypeId,
    requiredSkill: s.requiredSkill,
    bookingMode: s.bookingMode,
    bufferAfterMin: s.bufferAfterMin,
    onlineBookable: s.onlineBookable,
    active: s.active,
    prices: sortRows(s.prices.map(toPriceRow)),
  };
}

/** Audit snapshot: the service without its price rows. */
const snapshot = (v: ServiceView): Record<string, unknown> => ({ ...v, prices: undefined });

const toCategory = (c: { id: string; name: unknown; sort: number }): CategoryItem => ({
  id: c.id,
  name: c.name as LocalizedText,
  sort: c.sort,
});

const INCLUDE = { prices: true } as const;

@Injectable()
export class CatalogService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly tenancy: TenancyService,
    private readonly audit: AuditService,
  ) {}

  // ---------------------------------------------------------------- categories

  async listCategories(): Promise<CategoryItem[]> {
    const organizationId = await this.tenancy.getOrgId();
    const rows = await this.prisma.serviceCategory.findMany({ where: { organizationId }, orderBy: [{ sort: "asc" }, { createdAt: "asc" }, { id: "asc" }] });
    return rows.map(toCategory);
  }

  async createCategory(actor: AccessClaims, body: CategoryBody, ip: string | null): Promise<CategoryItem> {
    const orgId = await this.tenancy.getOrgId();
    return this.prisma.$transaction(async (tx) => {
      const row = await tx.serviceCategory.create({ data: { organizationId: orgId, name: body.name, sort: body.sort ?? 0 } });
      const item = toCategory(row);
      await this.audit.record(
        { orgId, actorType: "STAFF", actorId: actor.sub, action: "category.create", entity: "service_category", entityId: row.id, after: item, ip },
        tx,
      );
      return item;
    });
  }

  async patchCategory(actor: AccessClaims, id: string, body: CategoryPatch, ip: string | null): Promise<CategoryItem> {
    const orgId = await this.tenancy.getOrgId();
    return this.prisma.$transaction(async (tx) => {
      const before = await tx.serviceCategory.findFirst({ where: { id, organizationId: orgId } });
      if (!before) throw new NotFoundException("Category not found");
      const row = await tx.serviceCategory.update({ where: { id }, data: { name: body.name ?? (before.name as Prisma.InputJsonValue), sort: body.sort ?? before.sort } });
      const item = toCategory(row);
      await this.audit.record(
        { orgId, actorType: "STAFF", actorId: actor.sub, action: "category.update", entity: "service_category", entityId: id, before: toCategory(before), after: item, ip },
        tx,
      );
      return item;
    });
  }

  async deleteCategory(actor: AccessClaims, id: string, ip: string | null): Promise<void> {
    const orgId = await this.tenancy.getOrgId();
    await this.prisma.$transaction(async (tx) => {
      const before = await tx.serviceCategory.findFirst({ where: { id, organizationId: orgId } });
      if (!before) throw new NotFoundException("Category not found");
      await tx.serviceCategory.delete({ where: { id } });
      await this.audit.record(
        { orgId, actorType: "STAFF", actorId: actor.sub, action: "category.delete", entity: "service_category", entityId: id, before: toCategory(before), ip },
        tx,
      );
    });
  }

  // ------------------------------------------------------------------ services

  async listServices(q: ServiceQuery): Promise<ServiceView[]> {
    const organizationId = await this.tenancy.getOrgId();
    const rows = await this.prisma.service.findMany({
      where: { organizationId, ...(q.includeInactive === "true" ? {} : { active: true }) },
      include: INCLUDE,
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    });
    return rows.map(toView);
  }

  async getService(id: string): Promise<ServiceView> {
    const orgId = await this.tenancy.getOrgId();
    return toView(await this.find(this.prisma, orgId, id));
  }

  async createService(actor: AccessClaims, body: ServiceBody, ip: string | null): Promise<ServiceView> {
    const orgId = await this.tenancy.getOrgId();
    return this.prisma.$transaction(async (tx) => {
      await this.assertRefs(tx, orgId, body.categoryId ?? null, body.resourceTypeId ?? null);
      const candidate = { id: "", stage: body.stage, species: body.species, resourceTypeId: body.resourceTypeId ?? null };
      await this.assertStageRule(tx, orgId, candidate);
      const row = await tx.service.create({
        data: {
          organizationId: orgId,
          categoryId: body.categoryId ?? null,
          name: body.name,
          description: body.description ?? undefined,
          species: body.species,
          stage: body.stage,
          isMain: body.isMain,
          resourceTypeId: body.resourceTypeId ?? null,
          requiredSkill: body.requiredSkill,
          bookingMode: body.bookingMode ?? null,
          bufferAfterMin: body.bufferAfterMin,
          onlineBookable: body.onlineBookable,
        },
        include: INCLUDE,
      });
      const view = toView(row);
      await this.audit.record(
        { orgId, actorType: "STAFF", actorId: actor.sub, action: "service.create", entity: "service", entityId: row.id, after: snapshot(view), ip },
        tx,
      );
      return view;
    });
  }

  async patchService(actor: AccessClaims, id: string, body: ServicePatch, ip: string | null): Promise<ServiceView> {
    const orgId = await this.tenancy.getOrgId();
    return this.prisma.$transaction(async (tx) => {
      const before = await this.find(tx, orgId, id);
      const has = (k: keyof ServicePatch) => body[k] !== undefined;
      const categoryId = has("categoryId") ? (body.categoryId ?? null) : before.categoryId;
      const resourceTypeId = has("resourceTypeId") ? (body.resourceTypeId ?? null) : before.resourceTypeId;
      const species = body.species ?? before.species;
      const stage = body.stage ?? before.stage;
      const active = body.active ?? before.active;
      if (has("categoryId") || has("resourceTypeId")) {
        await this.assertRefs(tx, orgId, has("categoryId") ? categoryId : null, has("resourceTypeId") ? resourceTypeId : null);
      }
      if (active) await this.assertStageRule(tx, orgId, { id, stage, species, resourceTypeId });
      const row = await tx.service.update({
        where: { id },
        data: {
          categoryId,
          resourceTypeId,
          species,
          stage,
          active,
          ...(body.name ? { name: body.name } : {}),
          ...(has("description") ? { description: body.description ?? Prisma.DbNull } : {}),
          ...(body.isMain !== undefined ? { isMain: body.isMain } : {}),
          ...(body.requiredSkill ? { requiredSkill: body.requiredSkill } : {}),
          ...(has("bookingMode") ? { bookingMode: body.bookingMode ?? null } : {}),
          ...(body.bufferAfterMin !== undefined ? { bufferAfterMin: body.bufferAfterMin } : {}),
          ...(body.onlineBookable !== undefined ? { onlineBookable: body.onlineBookable } : {}),
        },
        include: INCLUDE,
      });
      const view = toView(row);
      await this.audit.record(
        { orgId, actorType: "STAFF", actorId: actor.sub, action: "service.update", entity: "service", entityId: id, before: snapshot(toView(before)), after: snapshot(view), ip },
        tx,
      );
      return view;
    });
  }

  async deactivateService(actor: AccessClaims, id: string, ip: string | null): Promise<void> {
    const orgId = await this.tenancy.getOrgId();
    await this.prisma.$transaction(async (tx) => {
      const before = await this.find(tx, orgId, id);
      const row = await tx.service.update({ where: { id }, data: { active: false }, include: INCLUDE });
      await this.audit.record(
        { orgId, actorType: "STAFF", actorId: actor.sub, action: "service.deactivate", entity: "service", entityId: id, before: snapshot(toView(before)), after: snapshot(toView(row)), ip },
        tx,
      );
    });
  }

  // -------------------------------------------------------------------- prices

  async getPrices(id: string): Promise<ServicePriceRow[]> {
    const orgId = await this.tenancy.getOrgId();
    return toView(await this.find(this.prisma, orgId, id)).prices;
  }

  async replacePrices(actor: AccessClaims, id: string, rows: PriceMatrix, ip: string | null): Promise<ServicePriceRow[]> {
    const orgId = await this.tenancy.getOrgId();
    return this.prisma.$transaction(async (tx) => {
      const before = toView(await this.find(tx, orgId, id)).prices;
      await tx.servicePrice.deleteMany({ where: { serviceId: id } });
      if (rows.length > 0) {
        await tx.servicePrice.createMany({
          data: rows.map((r) => ({ organizationId: orgId, serviceId: id, sizeClass: r.sizeClass, coatType: r.coatType, durationMin: r.durationMin, priceCents: r.priceCents })),
        });
      }
      const after = sortRows(rows);
      await this.audit.record(
        { orgId, actorType: "STAFF", actorId: actor.sub, action: "service_price.replace", entity: "service", entityId: id, before: { rows: before }, after: { rows: after }, ip },
        tx,
      );
      return after;
    });
  }

  // ------------------------------------------------------------------- helpers

  private async find(db: Prisma.TransactionClient | PrismaService, orgId: string, id: string): Promise<ServiceRow> {
    const row = await db.service.findFirst({ where: { id, organizationId: orgId }, include: INCLUDE });
    if (!row) throw new NotFoundException("Service not found");
    return row;
  }

  private async assertRefs(tx: Prisma.TransactionClient, orgId: string, categoryId: string | null, resourceTypeId: string | null): Promise<void> {
    if (categoryId) {
      const c = await tx.serviceCategory.findFirst({ where: { id: categoryId, organizationId: orgId }, select: { id: true } });
      if (!c) throw new NotFoundException("Category not found");
    }
    if (resourceTypeId) {
      const t = await tx.resourceType.findFirst({ where: { id: resourceTypeId, organizationId: orgId }, select: { kind: true } });
      if (!t) throw new NotFoundException("Resource type not found");
      if (t.kind !== "STATION") throw new BadRequestException("resourceTypeId must reference a STATION resource type");
    }
  }

  private async assertStageRule(
    tx: Prisma.TransactionClient,
    orgId: string,
    candidate: { id: string; stage: ServiceBody["stage"]; species: ServiceBody["species"]; resourceTypeId: string | null },
  ): Promise<void> {
    const others = await tx.service.findMany({
      where: { organizationId: orgId, active: true, ...(candidate.id ? { id: { not: candidate.id } } : {}) },
      select: { id: true, stage: true, species: true, resourceTypeId: true, active: true },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    });
    const clash = checkStageRule(candidate, others);
    if (clash) {
      throw new ConflictException({
        code: "STAGE_RESOURCE_MISMATCH",
        message: `Services in the same stage must use the same resource type; conflicts with service ${clash}`,
      });
    }
  }
}
