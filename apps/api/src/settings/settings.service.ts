import { isDeepStrictEqual } from "node:util";
import { Injectable, NotFoundException } from "@nestjs/common";
import { ZodValidationException } from "nestjs-zod";
import type { Prisma, SizeClass } from "@prisma/client";
import type {
  AccessClaims,
  Closure,
  ClosureItem,
  ClosureQuery,
  LocationHours,
  LocationSettings,
  SettingsPatchBody,
  SettingsView,
} from "@grooming/contracts";
import { LocationSettingsSchema } from "@grooming/contracts";
import { sizeClassFromWeight } from "@grooming/pricing";
import { AuditService } from "../audit/audit.service.js";
import { dbTimeToWall, wallToDbTime } from "../common/wall-time.js";
import { LocationService } from "../location/location.service.js";
import { PrismaService } from "../prisma/prisma.service.js";
import { TenancyService } from "../tenancy/tenancy.service.js";

const LOCATION_FIELDS = ["name", "address", "phone"] as const;

function toClosure(c: { id: string; startsAt: Date; endsAt: Date; reason: string | null }): ClosureItem {
  return { id: c.id, startsAt: c.startsAt.toISOString(), endsAt: c.endsAt.toISOString(), ...(c.reason ? { reason: c.reason } : {}) };
}

@Injectable()
export class SettingsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly tenancy: TenancyService,
    private readonly location: LocationService,
    private readonly audit: AuditService,
  ) {}

  async view(): Promise<SettingsView> {
    const { id } = await this.location.getDefault();
    return this.viewOf(this.prisma, id);
  }

  private async viewOf(db: Prisma.TransactionClient | PrismaService, locationId: string): Promise<SettingsView> {
    const loc = await db.location.findUniqueOrThrow({ where: { id: locationId } });
    const hours = await db.locationHours.findMany({ where: { locationId }, orderBy: [{ weekday: "asc" }, { opens: "asc" }] });
    return {
      location: { id: loc.id, name: loc.name, address: loc.address, phone: loc.phone, timezone: loc.timezone },
      settings: LocationSettingsSchema.parse(loc.settings),
      hours: hours.map((h) => ({ weekday: h.weekday, opens: dbTimeToWall(h.opens, false), closes: dbTimeToWall(h.closes, true) })),
    };
  }

  async patch(actor: AccessClaims, body: SettingsPatchBody, ip: string | null): Promise<SettingsView> {
    const orgId = await this.tenancy.getOrgId();
    const { id: locationId } = await this.location.getDefault();
    const view = await this.prisma.$transaction(async (tx) => {
      const loc = await tx.location.findUniqueOrThrow({ where: { id: locationId } });
      const current = loc.settings as unknown as Record<string, unknown>;
      const beforeSettings: Record<string, unknown> = {};
      const afterSettings: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(body.settings ?? {})) {
        if (!isDeepStrictEqual(current[key], value)) {
          beforeSettings[key] = current[key] ?? null;
          afterSettings[key] = value;
        }
      }
      const beforeLoc: Record<string, unknown> = {};
      const afterLoc: Record<string, unknown> = {};
      for (const key of LOCATION_FIELDS) {
        const value = body.location?.[key];
        if (value !== undefined && value !== loc[key]) {
          beforeLoc[key] = loc[key];
          afterLoc[key] = value;
        }
      }
      const settingsChanged = Object.keys(afterSettings).length > 0;
      const locationChanged = Object.keys(afterLoc).length > 0;
      if (!settingsChanged && !locationChanged) return this.viewOf(tx, locationId);

      let merged: LocationSettings | undefined;
      if (settingsChanged) {
        const r = LocationSettingsSchema.safeParse({ ...current, ...afterSettings });
        if (!r.success) throw new ZodValidationException(r.error);
        merged = r.data;
      }
      await tx.location.update({
        where: { id: locationId },
        data: {
          ...afterLoc,
          ...(merged ? { settings: merged as unknown as Prisma.InputJsonObject } : {}),
        },
      });
      if ("sizeThresholdsLb" in afterSettings) {
        await this.rederiveSizeClasses(tx, orgId, afterSettings.sizeThresholdsLb as LocationSettings["sizeThresholdsLb"]);
      }
      await this.audit.record(
        {
          orgId,
          actorType: "STAFF",
          actorId: actor.sub,
          action: "settings.update",
          entity: "settings",
          entityId: locationId,
          before: { ...(settingsChanged ? { settings: beforeSettings } : {}), ...(locationChanged ? { location: beforeLoc } : {}) },
          after: { ...(settingsChanged ? { settings: afterSettings } : {}), ...(locationChanged ? { location: afterLoc } : {}) },
          ip,
        },
        tx,
      );
      return this.viewOf(tx, locationId);
    });
    this.location.invalidate();
    return view;
  }

  /** Recomputes `sizeClass` of weighed, non-deleted pets; only rows whose class changes are written. */
  private async rederiveSizeClasses(tx: Prisma.TransactionClient, orgId: string, thresholds: LocationSettings["sizeThresholdsLb"]): Promise<void> {
    const pets = await tx.pet.findMany({
      where: { organizationId: orgId, deletedAt: null, weightG: { not: null } },
      select: { id: true, weightG: true, sizeClass: true },
    });
    const byClass = new Map<SizeClass, string[]>();
    for (const p of pets) {
      const next = sizeClassFromWeight(p.weightG as number, thresholds);
      if (next === p.sizeClass) continue;
      byClass.set(next, [...(byClass.get(next) ?? []), p.id]);
    }
    for (const [sizeClass, ids] of byClass) {
      await tx.pet.updateMany({ where: { id: { in: ids }, organizationId: orgId }, data: { sizeClass } });
    }
  }

  async replaceHours(actor: AccessClaims, hours: LocationHours[], ip: string | null): Promise<LocationHours[]> {
    const orgId = await this.tenancy.getOrgId();
    const { id: locationId } = await this.location.getDefault();
    return this.prisma.$transaction(async (tx) => {
      const before = (await this.viewOf(tx, locationId)).hours;
      await tx.locationHours.deleteMany({ where: { locationId } });
      await tx.locationHours.createMany({
        data: hours.map((h) => ({ locationId, weekday: h.weekday, opens: wallToDbTime(h.opens), closes: wallToDbTime(h.closes) })),
      });
      const after = (await this.viewOf(tx, locationId)).hours;
      await this.audit.record(
        { orgId, actorType: "STAFF", actorId: actor.sub, action: "location_hours.replace", entity: "location_hours", entityId: locationId, before: { hours: before }, after: { hours: after }, ip },
        tx,
      );
      return after;
    });
  }

  async listClosures(q: ClosureQuery): Promise<ClosureItem[]> {
    const { id: locationId } = await this.location.getDefault();
    const rows = await this.prisma.locationClosure.findMany({
      where: {
        locationId,
        ...(q.from ? { endsAt: { gt: new Date(q.from) } } : {}),
        ...(q.to ? { startsAt: { lt: new Date(q.to) } } : {}),
      },
      orderBy: [{ startsAt: "asc" }, { id: "asc" }],
    });
    return rows.map(toClosure);
  }

  async createClosure(actor: AccessClaims, body: Closure, ip: string | null): Promise<ClosureItem> {
    const orgId = await this.tenancy.getOrgId();
    const { id: locationId } = await this.location.getDefault();
    return this.prisma.$transaction(async (tx) => {
      const row = await tx.locationClosure.create({
        data: { locationId, startsAt: new Date(body.startsAt), endsAt: new Date(body.endsAt), reason: body.reason ?? null },
      });
      const item = toClosure(row);
      await this.audit.record(
        { orgId, actorType: "STAFF", actorId: actor.sub, action: "closure.create", entity: "closure", entityId: row.id, after: item, ip },
        tx,
      );
      return item;
    });
  }

  async deleteClosure(actor: AccessClaims, id: string, ip: string | null): Promise<void> {
    const orgId = await this.tenancy.getOrgId();
    await this.prisma.$transaction(async (tx) => {
      const row = await tx.locationClosure.findFirst({ where: { id, location: { organizationId: orgId } } });
      if (!row) throw new NotFoundException("Closure not found");
      await tx.locationClosure.delete({ where: { id } });
      await this.audit.record(
        { orgId, actorType: "STAFF", actorId: actor.sub, action: "closure.delete", entity: "closure", entityId: id, before: toClosure(row), ip },
        tx,
      );
    });
  }
}
