import { Inject, Injectable } from "@nestjs/common";
import { ENV, type Env } from "../config/env.js";
import { PrismaService } from "../prisma/prisma.service.js";

/**
 * Single-tenant MVP: every request belongs to the organization whose slug is
 * `DEFAULT_ORG_SLUG`. The id is looked up once and cached; a missing
 * organization is a server misconfiguration (500), and is not cached.
 */
@Injectable()
export class TenancyService {
  private orgId?: string;

  constructor(
    private readonly prisma: PrismaService,
    @Inject(ENV) private readonly env: Env,
  ) {}

  async getOrgId(): Promise<string> {
    if (this.orgId) return this.orgId;
    const slug = this.env.DEFAULT_ORG_SLUG;
    const org = await this.prisma.organization.findUnique({ where: { slug }, select: { id: true } });
    if (!org) throw new Error(`Organization ${slug} not found`);
    this.orgId = org.id;
    return org.id;
  }
}
