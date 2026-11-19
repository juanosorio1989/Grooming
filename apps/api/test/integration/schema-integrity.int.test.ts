import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { bookSegment, createTestClient, type Fixture, rejectionCode, seedFixture, truncateAll } from "./helpers.js";

const prisma = createTestClient();
let f: Fixture;

beforeEach(async () => {
  await truncateAll(prisma);
  f = await seedFixture(prisma);
});

afterAll(async () => {
  await prisma.$disconnect();
});

describe("history foreign keys are restrictive", () => {
  it("refuses to delete a customer that has an appointment (23503)", async () => {
    await bookSegment(prisma, f, { staffUserId: f.staffA, startsAt: "10:00", endsAt: "11:00" });
    const code = await rejectionCode(prisma.$executeRaw`DELETE FROM customer WHERE id = ${f.customerId}::uuid`);
    expect(code).toBe("23503");
  });

  it("refuses to delete a customer that has consent history (23503)", async () => {
    await prisma.notificationConsent.create({
      data: { organizationId: f.orgId, customerId: f.customerId, channel: "WHATSAPP", granted: true, source: "BOOKING_FORM" },
    });
    const code = await rejectionCode(prisma.$executeRaw`DELETE FROM customer WHERE id = ${f.customerId}::uuid`);
    expect(code).toBe("23503");
  });

  it("refuses to delete a resource referenced by a segment (23503)", async () => {
    await bookSegment(prisma, f, { staffUserId: f.staffA, startsAt: "10:00", endsAt: "11:00", resourceId: f.resource1 });
    const code = await rejectionCode(prisma.$executeRaw`DELETE FROM resource WHERE id = ${f.resource1}::uuid`);
    expect(code).toBe("23503");
  });

  it("refuses to delete a resource type used by a service (23503)", async () => {
    const code = await rejectionCode(prisma.$executeRaw`DELETE FROM resource_type WHERE id = ${f.resourceTypeId}::uuid`);
    expect(code).toBe("23503");
  });
});

describe("tenancy and flexible columns", () => {
  it("stores organization_id directly on hot child tables", async () => {
    const rows = await prisma.$queryRaw<{ table_name: string }[]>`
      SELECT table_name::text FROM information_schema.columns
      WHERE table_schema = 'public' AND column_name = 'organization_id' AND is_nullable = 'NO'
        AND table_name IN ('resource', 'appointment_segment', 'working_hours', 'time_off', 'notification_consent')
      ORDER BY table_name`;
    expect(rows.map((r) => r.table_name)).toEqual([
      "appointment_segment",
      "notification_consent",
      "resource",
      "time_off",
      "working_hours",
    ]);
  });

  it("allows a customer without a name (created at OTP verify)", async () => {
    const c = await prisma.customer.create({
      data: { organizationId: f.orgId, phoneE164: "+13055550199", locale: "es", createdVia: "ONLINE" },
    });
    expect(c.name).toBeNull();
  });

  it("accepts a non-UUID audit entity_id", async () => {
    const row = await prisma.auditLog.create({
      data: { organizationId: f.orgId, actorType: "SYSTEM", action: "employee_service.add", entity: "employee_service", entityId: `${f.staffA}:${f.serviceId}` },
    });
    expect(row.entityId).toContain(":");
  });
});
