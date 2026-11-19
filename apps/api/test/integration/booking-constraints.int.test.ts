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

describe("appointment_segment booking constraints", () => {
  it("has both exclusion constraints and the time-order check", async () => {
    const rows = await prisma.$queryRaw<{ conname: string; contype: string }[]>`
      SELECT conname, contype::text AS contype FROM pg_constraint
      WHERE conrelid = 'appointment_segment'::regclass
        AND conname IN ('no_employee_overlap', 'no_resource_overlap', 'segment_time_order')
      ORDER BY conname`;
    expect(rows).toEqual([
      { conname: "no_employee_overlap", contype: "x" },
      { conname: "no_resource_overlap", contype: "x" },
      { conname: "segment_time_order", contype: "c" },
    ]);
  });

  it("rejects overlapping segments for the same employee with 23P01", async () => {
    await bookSegment(prisma, f, { staffUserId: f.staffA, startsAt: "10:00", endsAt: "11:00" });
    const code = await rejectionCode(
      bookSegment(prisma, f, { staffUserId: f.staffA, startsAt: "10:30", endsAt: "11:30" }),
    );
    expect(code).toBe("23P01");
    expect(await prisma.appointment.count()).toBe(1);
  });

  it("allows adjacent segments for the same employee", async () => {
    await bookSegment(prisma, f, { staffUserId: f.staffA, startsAt: "10:00", endsAt: "11:00" });
    await bookSegment(prisma, f, { staffUserId: f.staffA, startsAt: "11:00", endsAt: "12:00" });
    expect(await prisma.appointmentSegment.count()).toBe(2);
  });

  it("ignores segments that do not occupy (cancelled / no-show)", async () => {
    await bookSegment(prisma, f, { staffUserId: f.staffA, startsAt: "10:00", endsAt: "11:00", occupies: false });
    await bookSegment(prisma, f, { staffUserId: f.staffA, startsAt: "10:30", endsAt: "11:30" });
    expect(await prisma.appointmentSegment.count()).toBe(2);
  });

  it("rejects different employees sharing an overlapping resource with 23P01", async () => {
    await bookSegment(prisma, f, {
      staffUserId: f.staffA,
      startsAt: "10:00",
      endsAt: "11:00",
      resourceId: f.resource1,
    });
    const code = await rejectionCode(
      bookSegment(prisma, f, { staffUserId: f.staffB, startsAt: "10:30", endsAt: "11:30", resourceId: f.resource1 }),
    );
    expect(code).toBe("23P01");
  });

  it("allows different employees on different resources at the same time", async () => {
    await bookSegment(prisma, f, { staffUserId: f.staffA, startsAt: "10:00", endsAt: "11:00", resourceId: f.resource1 });
    await bookSegment(prisma, f, { staffUserId: f.staffB, startsAt: "10:00", endsAt: "11:00", resourceId: f.resource2 });
    expect(await prisma.appointmentSegment.count()).toBe(2);
  });

  it("ignores a non-occupying segment on a shared resource", async () => {
    await bookSegment(prisma, f, {
      staffUserId: f.staffA,
      startsAt: "10:00",
      endsAt: "11:00",
      resourceId: f.resource1,
      occupies: false,
    });
    await bookSegment(prisma, f, { staffUserId: f.staffB, startsAt: "10:30", endsAt: "11:30", resourceId: f.resource1 });
    expect(await prisma.appointmentSegment.count()).toBe(2);
  });

  it("allows different employees overlapping when both have no resource", async () => {
    await bookSegment(prisma, f, { staffUserId: f.staffA, startsAt: "10:00", endsAt: "11:00", resourceId: null });
    await bookSegment(prisma, f, { staffUserId: f.staffB, startsAt: "10:30", endsAt: "11:30", resourceId: null });
    expect(await prisma.appointmentSegment.count()).toBe(2);
  });

  it("counts the buffer (block_ends_at) as occupied time", async () => {
    await bookSegment(prisma, f, { staffUserId: f.staffA, startsAt: "10:00", endsAt: "10:30", blockEndsAt: "10:45" });
    const code = await rejectionCode(
      bookSegment(prisma, f, { staffUserId: f.staffA, startsAt: "10:40", endsAt: "11:10" }),
    );
    expect(code).toBe("23P01");
  });

  it("rejects ends_at after block_ends_at with check violation 23514", async () => {
    const code = await rejectionCode(
      bookSegment(prisma, f, { staffUserId: f.staffA, startsAt: "10:00", endsAt: "11:00", blockEndsAt: "10:45" }),
    );
    expect(code).toBe("23514");
  });

  it("rejects starts_at equal to ends_at with check violation 23514", async () => {
    const code = await rejectionCode(
      bookSegment(prisma, f, { staffUserId: f.staffA, startsAt: "10:00", endsAt: "10:00" }),
    );
    expect(code).toBe("23514");
  });
});
