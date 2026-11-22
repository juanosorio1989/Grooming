import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AvailabilityContextLoader } from "../../../src/availability/context-loader.js";
import { createIntegrationApp, resetState } from "../app.js";
import { at, bookSegment, seedFixture, type Fixture } from "../helpers.js";

const t = (hhmm: string) => new Date(`1970-01-01T${hhmm}:00.000Z`);
const range = { from: at("00:00"), to: new Date("2026-12-02T00:00:00.000Z") };

describe("AvailabilityContextLoader", () => {
  let ctx: Awaited<ReturnType<typeof createIntegrationApp>>;
  let f: Fixture;
  let loader: AvailabilityContextLoader;

  beforeEach(async () => {
    ctx = await createIntegrationApp();
    await resetState(ctx.prisma, ctx.redis);
    f = await seedFixture(ctx.prisma);
    loader = ctx.app.get(AvailabilityContextLoader);
  });
  afterEach(async () => {
    await ctx?.close();
  });

  async function addEmployee(staffUserId: string, withLocation: boolean) {
    await ctx.prisma.employeeProfile.create({ data: { staffUserId, displayName: "E", skills: ["BATHER"] } });
    await ctx.prisma.employeeService.create({ data: { staffUserId, serviceId: f.serviceId } });
    if (withLocation) await ctx.prisma.staffLocation.create({ data: { staffUserId, locationId: f.locationId } });
    await ctx.prisma.workingHours.create({
      data: { organizationId: f.orgId, staffUserId, locationId: f.locationId, weekday: 2, startTime: t("09:00"), endTime: t("00:00") },
    });
  }

  it("inactive service, inactive resource, inactive staff and a staff without StaffLocation are excluded", async () => {
    await addEmployee(f.staffA, true);
    await addEmployee(f.staffB, false);
    const c = await ctx.prisma.staffUser.create({ data: { organizationId: f.orgId, email: "c@test.dev", role: "EMPLOYEE", locale: "en", active: false } });
    await addEmployee(c.id, true);
    await ctx.prisma.service.create({
      data: { organizationId: f.orgId, name: { en: "Old", es: "Viejo" }, species: "ANY", stage: "DRY", isMain: false, requiredSkill: "BATHER", active: false },
    });
    await ctx.prisma.resource.update({ where: { id: f.resource2 }, data: { active: false } });

    const { context } = await loader.load(range);
    expect(context.services.map((s) => s.id)).toEqual([f.serviceId]);
    expect(context.employees.map((e) => e.id)).toEqual([f.staffA]);
    expect(context.employees[0]).toMatchObject({
      serviceIds: [f.serviceId],
      skills: ["BATHER"],
      bookableOnline: true,
      workingHours: [{ weekday: 2, start: "09:00", end: "24:00" }],
    });
    expect(context.resources.map((r) => r.id).sort()).toEqual([f.resource1, f.kennel1, f.kennel2].sort());
    expect(context.resources.find((r) => r.id === f.kennel1)?.kind).toBe("KENNEL");
  });

  it("cancelled segment (occupies false) is not busy; a segment ending before the range is not busy", async () => {
    await addEmployee(f.staffA, true);
    await bookSegment(ctx.prisma, f, { staffUserId: f.staffA, startsAt: "10:00", endsAt: "11:00", resourceId: f.resource1 });
    await bookSegment(ctx.prisma, f, { staffUserId: f.staffA, startsAt: "12:00", endsAt: "13:00", occupies: false });
    await bookSegment(ctx.prisma, f, { staffUserId: null, startsAt: "10:00", endsAt: "11:00", stage: "KENNEL", serviceId: null, resourceId: f.kennel1 });

    const { context } = await loader.load(range);
    expect(context.busy).toHaveLength(2);
    expect(context.busy.find((b) => b.employeeId === null)?.resourceId).toBe(f.kennel1);

    const later = await loader.load({ from: at("14:00"), to: new Date("2026-12-02T00:00:00.000Z") });
    expect(later.context.busy).toEqual([]);
  });

  it("time off at another location is excluded", async () => {
    await addEmployee(f.staffA, true);
    const other = await ctx.prisma.location.create({
      data: { organizationId: f.orgId, name: "Other", timezone: "America/New_York", settings: {} },
    });
    const base = { organizationId: f.orgId, staffUserId: f.staffA, kind: "BLOCK" as const };
    await ctx.prisma.timeOff.create({ data: { ...base, locationId: other.id, startsAt: at("09:00"), endsAt: at("10:00") } });
    await ctx.prisma.timeOff.create({ data: { ...base, locationId: f.locationId, startsAt: at("11:00"), endsAt: at("12:00") } });
    await ctx.prisma.timeOff.create({ data: { ...base, locationId: null, startsAt: at("13:00"), endsAt: at("14:00") } });

    const { context } = await loader.load(range);
    expect(context.employees[0]?.timeOff.map((x) => x.start).sort()).toEqual([at("11:00").getTime(), at("13:00").getTime()]);
  });
});
