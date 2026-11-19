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
  /** A customer with no pets, so only the relation under test can block the delete. */
  const petlessCustomer = () =>
    prisma.customer.create({
      data: { organizationId: f.orgId, phoneE164: "+13055550111", name: "Bea", locale: "en", createdVia: "RECEPTION" },
    });

  it("refuses to delete a customer that has an appointment (23503)", async () => {
    const c = await petlessCustomer();
    await prisma.appointment.create({
      data: { organizationId: f.orgId, locationId: f.locationId, customerId: c.id, status: "BOOKED", source: "RECEPTION", bookingMode: "WAIT" },
    });
    const code = await rejectionCode(prisma.$executeRaw`DELETE FROM customer WHERE id = ${c.id}::uuid`);
    expect(code).toBe("23503");
  });

  it("refuses to delete a customer that has consent history (23503)", async () => {
    const c = await petlessCustomer();
    await prisma.notificationConsent.create({
      data: { organizationId: f.orgId, customerId: c.id, channel: "WHATSAPP", granted: true, source: "BOOKING_FORM" },
    });
    const code = await rejectionCode(prisma.$executeRaw`DELETE FROM customer WHERE id = ${c.id}::uuid`);
    expect(code).toBe("23503");
  });

  it("deletes a petless customer with no history", async () => {
    const c = await petlessCustomer();
    expect(await prisma.$executeRaw`DELETE FROM customer WHERE id = ${c.id}::uuid`).toBe(1);
  });

  it("refuses to delete a resource referenced by a segment (23503)", async () => {
    await bookSegment(prisma, f, { staffUserId: f.staffA, startsAt: "10:00", endsAt: "11:00", resourceId: f.resource1 });
    const code = await rejectionCode(prisma.$executeRaw`DELETE FROM resource WHERE id = ${f.resource1}::uuid`);
    expect(code).toBe("23503");
  });

  it("refuses to delete a customer that has a pet (23503)", async () => {
    const code = await rejectionCode(prisma.$executeRaw`DELETE FROM customer WHERE id = ${f.customerId}::uuid`);
    expect(code).toBe("23503");
  });

  it("refuses to delete a pet that has a visit (23503)", async () => {
    await bookSegment(prisma, f, { staffUserId: f.staffA, startsAt: "10:00", endsAt: "11:00" });
    const code = await rejectionCode(prisma.$executeRaw`DELETE FROM pet WHERE id = ${f.petId}::uuid`);
    expect(code).toBe("23503");
  });

  it("refuses to delete a resource type used by a service (23503)", async () => {
    const code = await rejectionCode(prisma.$executeRaw`DELETE FROM resource_type WHERE id = ${f.resourceTypeId}::uuid`);
    expect(code).toBe("23503");
  });
});

describe("tenancy and flexible columns", () => {
  it("stores organization_id directly on hot child tables and every grooming table", async () => {
    const rows = await prisma.$queryRaw<{ table_name: string }[]>`
      SELECT table_name::text FROM information_schema.columns
      WHERE table_schema = 'public' AND column_name = 'organization_id' AND is_nullable = 'NO'
        AND table_name IN ('resource', 'appointment_segment', 'working_hours', 'time_off', 'notification_consent',
          'pet', 'pet_vaccine', 'media', 'service_price', 'pet_visit', 'pet_visit_service', 'visit_step',
          'visit_observation', 'visit_report', 'payment_record')
      ORDER BY table_name`;
    expect(rows.map((r) => r.table_name)).toEqual([
      "appointment_segment",
      "media",
      "notification_consent",
      "payment_record",
      "pet",
      "pet_vaccine",
      "pet_visit",
      "pet_visit_service",
      "resource",
      "service_price",
      "time_off",
      "visit_observation",
      "visit_report",
      "visit_step",
      "working_hours",
    ]);
  });

  it("makes every organization_id foreign key restrictive", async () => {
    const rows = await prisma.$queryRaw<{ table_name: string; confdeltype: string }[]>`
      SELECT c.conrelid::regclass::text AS table_name, c.confdeltype::text AS confdeltype
      FROM pg_constraint c
      JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = ANY (c.conkey)
      WHERE c.contype = 'f' AND c.confrelid = 'organization'::regclass AND a.attname = 'organization_id'`;
    expect(rows.length).toBeGreaterThanOrEqual(24);
    expect(rows.filter((r) => r.confdeltype !== "r")).toEqual([]);
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
