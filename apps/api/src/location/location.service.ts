import { Injectable } from "@nestjs/common";
import type { Prisma } from "@prisma/client";
import { PrismaService } from "../prisma/prisma.service.js";
import { TenancyService } from "../tenancy/tenancy.service.js";

export interface DefaultLocation {
  id: string;
  timezone: string;
  /** Untyped JSON until the settings schema lands. */
  settings: Prisma.JsonValue;
}

/**
 * Single-location MVP: the organization's oldest location is "the" location.
 * Cached per process; call `invalidate()` after writing location settings.
 */
@Injectable()
export class LocationService {
  private cached?: DefaultLocation;

  constructor(
    private readonly prisma: PrismaService,
    private readonly tenancy: TenancyService,
  ) {}

  async getDefault(): Promise<DefaultLocation> {
    if (this.cached) return this.cached;
    const organizationId = await this.tenancy.getOrgId();
    const loc = await this.prisma.location.findFirst({
      where: { organizationId },
      orderBy: { createdAt: "asc" },
      select: { id: true, timezone: true, settings: true },
    });
    if (!loc) throw new Error(`Organization ${organizationId} has no location`);
    this.cached = loc;
    return loc;
  }

  invalidate(): void {
    this.cached = undefined;
  }
}
