import { Injectable } from "@nestjs/common";
import type { Prisma } from "@prisma/client";
import { localDayBoundsUtc, todayIn } from "@grooming/datetime";
import { LocationService } from "../location/location.service.js";
import { PrismaService } from "../prisma/prisma.service.js";
import { TenancyService } from "../tenancy/tenancy.service.js";

/** EMPLOYEE visibility of pets: only pets they work on during the location's local day. */
@Injectable()
export class PetAccessService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly tenancy: TenancyService,
    private readonly location: LocationService,
  ) {}

  /** Pet filter: a non-cancelled segment of `staffId` starts within the local day of `now`. */
  async employeeTodayWhere(staffId: string, now: Date): Promise<Prisma.PetWhereInput> {
    const { timezone } = await this.location.getDefault();
    const { start, end } = localDayBoundsUtc(todayIn(timezone, now.getTime()), timezone);
    return {
      visits: {
        some: {
          segments: {
            some: {
              staffUserId: staffId,
              startsAt: { gte: new Date(start), lt: new Date(end) },
              appointment: { status: { not: "CANCELLED" } },
            },
          },
        },
      },
    };
  }

  async employeeCanSee(staffId: string, petId: string, now: Date): Promise<boolean> {
    const organizationId = await this.tenancy.getOrgId();
    const where = await this.employeeTodayWhere(staffId, now);
    const n = await this.prisma.pet.count({ where: { id: petId, organizationId, deletedAt: null, ...where } });
    return n > 0;
  }
}
