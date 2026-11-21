import type { PrismaClient } from "@prisma/client";
import { LocationSettingsSchema } from "@grooming/contracts";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { runSeed } from "../../prisma/seed.js";
import { createTestClient, truncateAll } from "./helpers.js";

describe("development seed", () => {
  let prisma: PrismaClient;
  beforeEach(async () => {
    prisma ??= createTestClient();
    await truncateAll(prisma);
  });
  afterAll(async () => {
    await prisma?.$disconnect();
  });

  it("fills an empty database with the demo shop", async () => {
    const s = await runSeed(prisma);
    expect(s.services).toBeGreaterThanOrEqual(15);
    expect(s).toMatchObject({ staff: 6, customers: 4, pets: 6, visits: 3, reports: 3 });
  });

  it("gives every service a NULL-coat row for each size", async () => {
    await runSeed(prisma);
    const services = await prisma.service.findMany({ include: { prices: true } });
    for (const svc of services) {
      for (const size of ["S", "M", "L", "XL"]) {
        expect(svc.prices.some((p) => p.sizeClass === size && p.coatType === null)).toBe(true);
      }
    }
  });

  it("is idempotent", async () => {
    const first = await runSeed(prisma);
    const second = await runSeed(prisma);
    expect(second).toEqual(first);
  });

  it("stores location settings that parse", async () => {
    await runSeed(prisma);
    const location = await prisma.location.findFirstOrThrow();
    expect(LocationSettingsSchema.safeParse(location.settings).success).toBe(true);
  });

  it("only assigns and schedules qualified staff", async () => {
    await runSeed(prisma);
    const links = await prisma.employeeService.findMany({
      include: { service: true, staffUser: { include: { employeeProfile: true } } },
    });
    expect(links.length).toBeGreaterThan(0);
    for (const l of links) {
      expect(l.staffUser.employeeProfile?.skills).toContain(l.service.requiredSkill);
    }
    const segments = await prisma.appointmentSegment.findMany({
      where: { staffUserId: { not: null }, serviceId: { not: null } },
      include: { service: true, staffUser: { include: { employeeProfile: true } } },
    });
    expect(segments.length).toBeGreaterThan(0);
    for (const s of segments) {
      expect(s.staffUser?.employeeProfile?.skills).toContain(s.service?.requiredSkill);
    }
  });
});
