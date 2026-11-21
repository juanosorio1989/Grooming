import { Injectable } from "@nestjs/common";
import { LocationSettingsSchema, type LocationSettings } from "@grooming/contracts";
import { PrismaService } from "../prisma/prisma.service.js";
import { TenancyService } from "../tenancy/tenancy.service.js";

export const LOCATION_CACHE_TTL_MS = 30_000;

export interface DefaultLocation {
  id: string;
  timezone: string;
  /** Parsed with `LocationSettingsSchema`; an invalid stored row throws (500, misconfiguration). */
  settings: LocationSettings;
}

/**
 * Single-location MVP: the organization's oldest location is "the" location.
 * Cached per process for 30 s (`LOCATION_CACHE_TTL_MS`); call `invalidate()` after writing location settings.
 */
@Injectable()
export class LocationService {
  private cached?: { value: DefaultLocation; cachedAt: number };

  constructor(
    private readonly prisma: PrismaService,
    private readonly tenancy: TenancyService,
  ) {}

  async getDefault(): Promise<DefaultLocation> {
    if (this.cached && Date.now() - this.cached.cachedAt < LOCATION_CACHE_TTL_MS) return this.cached.value;
    const organizationId = await this.tenancy.getOrgId();
    const loc = await this.prisma.location.findFirst({
      where: { organizationId },
      orderBy: { createdAt: "asc" },
      select: { id: true, timezone: true, settings: true },
    });
    if (!loc) throw new Error(`Organization ${organizationId} has no location`);
    const value = { id: loc.id, timezone: loc.timezone, settings: LocationSettingsSchema.parse(loc.settings) };
    this.cached = { value, cachedAt: Date.now() };
    return value;
  }

  invalidate(): void {
    this.cached = undefined;
  }
}
