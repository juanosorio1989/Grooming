import { afterAll, beforeEach, describe, expect, it } from "vitest";
import {
  at,
  bookSegment,
  createPetVisit,
  createTestClient,
  type Fixture,
  rejectionCode,
  seedFixture,
  truncateAll,
} from "./helpers.js";

const prisma = createTestClient();
let f: Fixture;

beforeEach(async () => {
  await truncateAll(prisma);
  f = await seedFixture(prisma);
});

afterAll(async () => {
  await prisma.$disconnect();
});

const kennel = (resourceId: string, startsAt: string, endsAt: string) =>
  bookSegment(prisma, f, { staffUserId: null, serviceId: null, stage: "KENNEL", resourceId, startsAt, endsAt });

describe("kennel segments", () => {
  it("kennel segments on different kennels overlap freely", async () => {
    await kennel(f.kennel1, "09:00", "13:00");
    await kennel(f.kennel2, "09:00", "13:00");
    expect(await prisma.appointmentSegment.count({ where: { stage: "KENNEL" } })).toBe(2);
  });

  it("same kennel cannot be double-booked", async () => {
    await kennel(f.kennel1, "09:00", "13:00");
    expect(await rejectionCode(kennel(f.kennel1, "12:00", "15:00"))).toBe("23P01");
    expect(await prisma.appointmentSegment.count()).toBe(1);
  });

  it("pickup shortens a kennel segment and frees it at that instant", async () => {
    const seg = await kennel(f.kennel1, "09:00", "13:00");
    await prisma.appointmentSegment.update({
      where: { id: seg.id },
      data: { endsAt: at("11:00"), blockEndsAt: at("11:00") },
    });
    await kennel(f.kennel1, "11:00", "14:00");
    expect(await prisma.appointmentSegment.count({ where: { resourceId: f.kennel1 } })).toBe(2);
  });
});

describe("person segments", () => {
  it("person segments still cannot overlap", async () => {
    await bookSegment(prisma, f, { staffUserId: f.staffA, stage: "BATH", startsAt: "09:00", endsAt: "10:00" });
    const code = await rejectionCode(
      bookSegment(prisma, f, { staffUserId: f.staffA, stage: "GROOM", startsAt: "09:30", endsAt: "10:30" }),
    );
    expect(code).toBe("23P01");
  });
});

describe("segment staff matches stage", () => {
  it("non-kennel segment requires a staff member", async () => {
    const code = await rejectionCode(
      bookSegment(prisma, f, { staffUserId: null, stage: "BATH", startsAt: "09:00", endsAt: "10:00" }),
    );
    expect(code).toBe("23514");
  });

  it("kennel segment cannot have a staff member or miss its kennel", async () => {
    const withStaff = bookSegment(prisma, f, {
      staffUserId: f.staffA,
      serviceId: null,
      stage: "KENNEL",
      resourceId: f.kennel1,
      startsAt: "09:00",
      endsAt: "13:00",
    });
    expect(await rejectionCode(withStaff)).toBe("23514");
    const noKennel = bookSegment(prisma, f, {
      staffUserId: null,
      serviceId: null,
      stage: "KENNEL",
      resourceId: null,
      startsAt: "09:00",
      endsAt: "13:00",
    });
    expect(await rejectionCode(noKennel)).toBe("23514");
    expect(await prisma.appointmentSegment.count()).toBe(0);
  });
});

describe("offline idempotency keys", () => {
  it("client_ref is unique per organization (visit_step)", async () => {
    const other = await seedFixture(prisma, { slug: "test-salon-b" });
    const visitA = await createPetVisit(prisma, f);
    const visitB = await createPetVisit(prisma, other);
    const step = (orgId: string, petVisitId: string) =>
      prisma.visitStep.create({ data: { organizationId: orgId, petVisitId, stage: "BATH", sort: 1, clientRef: "r1" } });

    await step(f.orgId, visitA.id);
    expect(await rejectionCode(step(f.orgId, visitA.id), "client_ref")).toBe("23505");
    await step(other.orgId, visitB.id);
    expect(await prisma.visitStep.count({ where: { clientRef: "r1" } })).toBe(2);
  });

  it("client_ref is unique per organization (media)", async () => {
    const other = await seedFixture(prisma, { slug: "test-salon-b" });
    let n = 0;
    const media = (fx: Fixture) =>
      prisma.media.create({
        data: {
          organizationId: fx.orgId,
          kind: "STEP",
          objectKey: `media/${(n += 1)}.jpg`,
          contentType: "image/jpeg",
          petId: fx.petId,
          uploadedByType: "STAFF",
          clientRef: "r1",
        },
      });

    await media(f);
    expect(await rejectionCode(media(f), "client_ref")).toBe("23505");
    await media(other);
    expect(await prisma.media.count({ where: { clientRef: "r1" } })).toBe(2);
  });
});

describe("service_price", () => {
  it("one any-coat price row per service and size", async () => {
    const price = (coatType: "CURLY" | null) =>
      prisma.servicePrice.create({
        data: { organizationId: f.orgId, serviceId: f.serviceId, sizeClass: "M", coatType, durationMin: 60, priceCents: 5500 },
      });

    await price(null);
    expect(await rejectionCode(price(null), "size_class")).toBe("23505");
    await price("CURLY");
    expect(await prisma.servicePrice.count()).toBe(2);
  });
});
