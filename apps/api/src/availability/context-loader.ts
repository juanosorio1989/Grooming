import { Injectable } from "@nestjs/common";
import type { Context } from "@grooming/availability";
import { LocationService } from "../location/location.service.js";
import { PrismaService } from "../prisma/prisma.service.js";
import { TenancyService } from "../tenancy/tenancy.service.js";
import { toEngineContext, type ContextRows } from "./context-mapper.js";

/** Reads the engine inputs of the default location with one query per table. */
@Injectable()
export class AvailabilityContextLoader {
  constructor(
    private readonly prisma: PrismaService,
    private readonly tenancy: TenancyService,
    private readonly locations: LocationService,
  ) {}

  /**
   * One query per table for the whole UTC range [from, to). `now` is the current time.
   * A segment is busy when it occupies, its appointment is not `excludeAppointmentId`
   * (reschedule/move ignore their own rows), and the appointment is not an expired hold.
   */
  async load(
    range: { from: Date; to: Date },
    opts: { excludeAppointmentId?: string } = {},
  ): Promise<{ rows: ContextRows; context: Omit<Context, "mode" | "override"> }> {
    const now = new Date();
    const organizationId = await this.tenancy.getOrgId();
    const location = await this.locations.getDefault();
    const locationId = location.id;
    const overlap = { startsAt: { lt: range.to }, endsAt: { gt: range.from } };

    const [hours, closures, services, employees, resources, busy] = await Promise.all([
      this.prisma.locationHours.findMany({ where: { locationId }, select: { weekday: true, opens: true, closes: true } }),
      this.prisma.locationClosure.findMany({ where: { locationId, ...overlap }, select: { startsAt: true, endsAt: true } }),
      this.prisma.service.findMany({
        where: { organizationId, active: true },
        select: {
          id: true, stage: true, species: true, resourceTypeId: true, requiredSkill: true, bufferAfterMin: true, onlineBookable: true, bookingMode: true,
          prices: { select: { serviceId: true, sizeClass: true, coatType: true, durationMin: true, priceCents: true } },
        },
      }),
      this.prisma.staffUser.findMany({
        where: { organizationId, active: true, employeeProfile: { isNot: null }, staffLocations: { some: { locationId } } },
        select: {
          id: true,
          employeeProfile: { select: { skills: true, bookableOnline: true } },
          employeeServices: { select: { serviceId: true } },
          workingHours: { where: { locationId }, select: { weekday: true, startTime: true, endTime: true } },
          timeOff: {
            where: { OR: [{ locationId: null }, { locationId }], ...overlap },
            select: { startsAt: true, endsAt: true },
          },
        },
      }),
      this.prisma.resource.findMany({
        where: { organizationId, locationId, active: true },
        select: { id: true, resourceTypeId: true, name: true, resourceType: { select: { kind: true } } },
      }),
      this.prisma.appointmentSegment.findMany({
        where: {
          organizationId,
          occupies: true,
          appointment: {
            locationId,
            ...(opts.excludeAppointmentId !== undefined ? { id: { not: opts.excludeAppointmentId } } : {}),
            NOT: { status: "HELD", holdExpiresAt: { lte: now } },
          },
          startsAt: { lt: range.to },
          blockEndsAt: { gt: range.from },
        },
        select: { staffUserId: true, resourceId: true, startsAt: true, blockEndsAt: true },
      }),
    ]);

    const rows: ContextRows = {
      location,
      hours,
      closures,
      services: services.map((s) => ({
        id: s.id, stage: s.stage, species: s.species, resourceTypeId: s.resourceTypeId,
        requiredSkill: s.requiredSkill, bufferAfterMin: s.bufferAfterMin, onlineBookable: s.onlineBookable,
        bookingMode: s.bookingMode,
      })),
      prices: services.flatMap((s) => s.prices),
      employees: employees.flatMap((e) =>
        e.employeeProfile
          ? [{ id: e.id, profile: e.employeeProfile, serviceIds: e.employeeServices.map((x) => x.serviceId), workingHours: e.workingHours, timeOff: e.timeOff }]
          : [],
      ),
      resources: resources.map((r) => ({ id: r.id, resourceTypeId: r.resourceTypeId, name: r.name, kind: r.resourceType.kind })),
      busy,
    };
    return { rows, context: toEngineContext(rows, now) };
  }
}
