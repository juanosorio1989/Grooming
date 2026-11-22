import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { bookSegment, createPetVisit, createTestClient, type Fixture, rejectionCode, seedFixture, truncateAll } from "./helpers.js";

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

describe("customer_identity and outbox_event", () => {
  const identity = (customerId: string, subject: string) =>
    prisma.customerIdentity.create({
      data: { organizationId: f.orgId, customerId, provider: "GOOGLE", subject, email: "ana@example.com" },
    });

  const otherCustomer = () =>
    prisma.customer.create({
      data: { organizationId: f.orgId, phoneE164: "+13055550112", name: "Cleo", locale: "en", createdVia: "ONLINE" },
    });

  it("allows one Google subject per organization (23505)", async () => {
    await identity(f.customerId, "sub-1");
    const other = await otherCustomer();
    expect(await rejectionCode(identity(other.id, "sub-1"))).toBe("23505");
  });

  it("allows the same Google subject in another organization", async () => {
    await identity(f.customerId, "sub-1");
    const org2 = await prisma.organization.create({ data: { name: "Other", slug: "other-shop", defaultLocale: "en" } });
    const c2 = await prisma.customer.create({
      data: { organizationId: org2.id, phoneE164: "+13055550100", locale: "en", createdVia: "ONLINE" },
    });
    const row = await prisma.customerIdentity.create({
      data: { organizationId: org2.id, customerId: c2.id, provider: "GOOGLE", subject: "sub-1", email: "ana@example.com" },
    });
    expect(row.subject).toBe("sub-1");
  });

  it("allows one Google account per customer (23505)", async () => {
    await identity(f.customerId, "sub-1");
    expect(await rejectionCode(identity(f.customerId, "sub-2"))).toBe("23505");
  });

  it("refuses to delete a customer that has an identity (23503)", async () => {
    const c = await otherCustomer();
    await identity(c.id, "sub-3");
    const code = await rejectionCode(prisma.$executeRaw`DELETE FROM customer WHERE id = ${c.id}::uuid`);
    expect(code).toBe("23503");
  });

  it("refuses to delete a customer that has an identity through Prisma (P2003)", async () => {
    const c = await otherCustomer();
    await identity(c.id, "sub-4");
    const err = await prisma.customer.delete({ where: { id: c.id } }).then(
      () => undefined,
      (e: unknown) => e,
    );
    expect((err as { code?: string } | undefined)?.code).toBe("P2003");
  });

  it("inserts an unprocessed outbox event", async () => {
    const row = await prisma.outboxEvent.create({
      data: { organizationId: f.orgId, type: "google_link_notice", payload: { customerId: f.customerId } },
    });
    expect(row.processedAt).toBeNull();
    expect(row.payload).toEqual({ customerId: f.customerId });
  });

  it("indexes outbox_event on (processed_at, created_at)", async () => {
    const rows = await prisma.$queryRaw<{ indexdef: string }[]>`
      SELECT indexdef FROM pg_indexes WHERE schemaname = 'public' AND tablename = 'outbox_event'`;
    expect(rows.some((r) => r.indexdef.includes("(processed_at, created_at)"))).toBe(true);
  });
});

describe("partial indexes", () => {
  it("service_price_any_coat is unique on (service_id, size_class) for NULL coat rows only", async () => {
    const rows = await prisma.$queryRaw<{ indexdef: string }[]>`
      SELECT indexdef FROM pg_indexes WHERE schemaname = 'public' AND indexname = 'service_price_any_coat'`;
    expect(rows).toHaveLength(1);
    const def = rows[0]!.indexdef;
    expect(def).toContain("UNIQUE");
    expect(def).toContain("(service_id, size_class)");
    expect(def).toContain("WHERE (coat_type IS NULL)");
  });
});

describe("pet_visit booking columns", () => {
  /** Raw insert so the database, not Prisma, rejects the row. */
  const insertVisit = (appointmentId: string, petId: string | null, pendingPet: string | null, position: number) =>
    prisma.$executeRaw`
      INSERT INTO pet_visit (id, organization_id, appointment_id, pet_id, pending_pet, position, coat_type_at_booking,
        status, size_class_at_booking, price_cents_quoted, updated_at)
      VALUES (gen_random_uuid(), ${f.orgId}::uuid, ${appointmentId}::uuid, ${petId}::uuid, ${pendingPet}::jsonb, ${position},
        'SMOOTH', 'BOOKED', 'M', 4000, now())`;

  it("rejects a visit with neither pet_id nor pending_pet (23514)", async () => {
    const visit = await createPetVisit(prisma, f);
    expect(await rejectionCode(insertVisit(visit.appointmentId, null, null, 1))).toBe("23514");
  });

  it("accepts a pending pet with no pet_id", async () => {
    const visit = await createPetVisit(prisma, f);
    expect(await insertVisit(visit.appointmentId, null, JSON.stringify({ ref: "new-1", name: "Rex" }), 1)).toBe(1);
  });

  it("rejects two visits with the same (appointment_id, position) (23505)", async () => {
    const visit = await createPetVisit(prisma, f);
    expect(await rejectionCode(insertVisit(visit.appointmentId, f.petId, null, 0))).toBe("23505");
  });
});
