import request from "supertest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AvailabilityResponseSchema, type StaffRole } from "@grooming/contracts";
import { addDays, wallTimeToUtc } from "@grooming/datetime";
import { createIntegrationApp, resetState } from "../app.js";
import { FROM, local, seedBookableTuesday, TZ, wall } from "../bookable-day.js";
import { createPetVisit, seedFixture, type Fixture } from "../helpers.js";
import { customerToken, staffToken } from "../tokens.js";

type SlotView = { startsAt: string; pets: { petId?: string; ref?: string }[] };

describe("GET /v1/availability (staff mode)", () => {
  let ctx: Awaited<ReturnType<typeof createIntegrationApp>>;
  let f: Fixture;

  const get = (q: Record<string, string>, token?: string, ip = "203.0.113.40") => {
    const req = request(ctx.app.getHttpServer()).get("/v1/availability").query(q).set("X-Forwarded-For", ip);
    return token ? req.set("Authorization", `Bearer ${token}`) : req;
  };
  const inline = () => ({ ref: "new-1", species: "DOG", sizeClass: "M", coatType: "CURLY", serviceIds: [f.serviceId] });
  const q = (pets: unknown[], over: Record<string, string> = {}) => ({ from: FROM, pets: JSON.stringify(pets), ...over });
  const staff = (role: StaffRole = "RECEPTION") => staffToken(ctx.app, { sub: f.staffB, org: f.orgId, role });
  const ownerToken = () => customerToken(ctx.app, { sub: f.customerId, org: f.orgId });
  const starts = (res: { body: { slots: SlotView[] } }) => res.body.slots.map((s) => wall(s.startsAt));
  const setWait = () => ctx.prisma.service.update({ where: { id: f.serviceId }, data: { bookingMode: "WAIT" } });

  async function otherCustomerPet() {
    const other = await ctx.prisma.customer.create({
      data: { organizationId: f.orgId, phoneE164: "+13055550199", name: "Bo", locale: "en", createdVia: "ONLINE" },
    });
    const pet = await ctx.prisma.pet.create({
      data: { organizationId: f.orgId, customerId: other.id, name: "Bo dog", species: "DOG", breed: "Lab", sizeClass: "M", coatType: "CURLY" },
    });
    return { id: other.id, petId: pet.id };
  }

  /** A BOOKED appointment of the fixture's customer, 08:00-09:00 on FROM with the only bather; returns its id. */
  async function bookedAt0800(): Promise<string> {
    const visit = await createPetVisit(ctx.prisma, f);
    await ctx.prisma.petVisitService.create({
      data: { organizationId: f.orgId, petVisitId: visit.id, serviceId: f.serviceId, priceCents: 4500, durationMin: 60 },
    });
    await ctx.prisma.appointmentSegment.create({
      data: {
        organizationId: f.orgId,
        appointmentId: visit.appointmentId,
        petVisitId: visit.id,
        stage: "BATH",
        serviceId: f.serviceId,
        staffUserId: f.staffA,
        resourceId: f.resource1,
        startsAt: new Date(local("08:00")),
        endsAt: new Date(local("09:00")),
        blockEndsAt: new Date(local("09:00")),
        durationMin: 60,
        priceCents: 4500,
        occupies: true,
      },
    });
    return visit.appointmentId;
  }

  beforeEach(async () => {
    ctx = await createIntegrationApp({ env: { TRUST_PROXY: "1" } });
    await resetState(ctx.prisma, ctx.redis);
    f = await seedFixture(ctx.prisma);
    await seedBookableTuesday(ctx.prisma, f);
  });

  afterEach(async () => {
    vi.useRealTimers();
    await ctx?.close();
  });

  it("RECEPTION, today, time already past the lead time → slots start from now rounded down to the grid (STAFF ignores minLeadMinutes)", async () => {
    await setWait();
    // "Now" is 10:07 on FROM (New York): FROM is today.
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(wallTimeToUtc(FROM, "10:07", TZ));
    const res = await get(q([inline()]), await staff());
    expect(res.status).toBe(200);
    expect(AvailabilityResponseSchema.strict().parse(res.body)).toEqual(res.body);
    expect(starts(res)[0]).toBe("10:00");
    // ONLINE: now + 60 min lead → 11:15 on the grid.
    const online = await get(q([inline()]));
    expect(online.status).toBe(200);
    expect(starts(online)[0]).toBe("11:15");
  });

  it("a date beyond bookingHorizonDays → slots", async () => {
    await setWait();
    const far = addDays(FROM, 63); // a Tuesday more than 60 days ahead
    const online = await get(q([inline()], { from: far }));
    expect(online.status).toBe(200);
    expect(online.body.slots).toEqual([]);
    const res = await get(q([inline()], { from: far }), await staff());
    expect(res.status).toBe(200);
    expect(res.body.slots.length).toBeGreaterThan(0);
  });

  it("a service with onlineBookable false → slots", async () => {
    await setWait();
    await ctx.prisma.service.update({ where: { id: f.serviceId }, data: { onlineBookable: false } });
    const online = await get(q([inline()]));
    expect(online.status).toBe(200);
    expect(online.body.slots).toEqual([]);
    const res = await get(q([inline()]), await staff());
    expect(res.status).toBe(200);
    expect(res.body.slots.length).toBeGreaterThan(0);
  });

  it("override=true → slots outside working hours; override=false or omitted keeps the hours", async () => {
    await setWait();
    const token = await staff();
    const plain = await get(q([inline()]), token);
    expect(plain.status).toBe(200);
    expect(starts(plain)[0]).toBe("08:00");
    expect(starts(plain).at(-1)).toBe("16:00");
    const off = await get(q([inline()], { override: "false" }), token);
    expect(starts(off)).toEqual(starts(plain));

    const over = await get(q([inline()], { override: "true" }), token);
    expect(over.status).toBe(200);
    expect(starts(over)).toContain("07:00");
    expect(starts(over)).toContain("17:00");
  });

  it("override with a customer token → 403; anonymous override → 403; customerId from a customer or anonymous → 403", async () => {
    const token = await ownerToken();
    const extras: Record<string, string>[] = [{ override: "true" }, { override: "false" }, { customerId: f.customerId }];
    for (const extra of extras) {
      for (const t of [token, undefined]) {
        const res = await get(q([inline()], extra), t);
        expect(res.status).toBe(403);
        expect(res.body.code).toBe("FORBIDDEN");
      }
    }
  });

  it("EMPLOYEE → 403; OWNER → 200", async () => {
    const res = await get(q([inline()]), await staff("EMPLOYEE"));
    expect(res.status).toBe(403);
    expect(res.body.code).toBe("FORBIDDEN");
    expect((await get(q([inline()]), await staff("OWNER"))).status).toBe(200);
  });

  it("petId without customerId → 400 path customerId", async () => {
    const res = await get(q([{ petId: f.petId, serviceIds: [f.serviceId] }]), await staff());
    expect(res.status).toBe(400);
    expect(res.body.code).toBe("VALIDATION_FAILED");
    expect(res.body.errors.map((e: { path: string }) => e.path)).toEqual(["customerId"]);
  });

  it("petId with its customerId → 200 with petId; petId of another customer → 404", async () => {
    await setWait();
    const token = await staff();
    const own = await get(q([{ petId: f.petId, serviceIds: [f.serviceId] }], { customerId: f.customerId }), token);
    expect(own.status).toBe(200);
    expect(own.body.slots[0].pets[0].petId).toBe(f.petId);

    const other = await otherCustomerPet();
    const foreign = await get(q([{ petId: other.petId, serviceIds: [f.serviceId] }], { customerId: f.customerId }), token);
    expect(foreign.status).toBe(404);
    expect(foreign.body.code).toBe("NOT_FOUND");
  });

  it("unknown or deleted customerId → 404, not 401 (inline pets too)", async () => {
    const token = await staff();
    const unknown = await get(q([inline()], { customerId: "0194b2a0-0000-7000-8000-0000000000ee" }), token);
    expect(unknown.status).toBe(404);
    expect(unknown.body.code).toBe("NOT_FOUND");
    await ctx.prisma.customer.update({ where: { id: f.customerId }, data: { deletedAt: new Date() } });
    const deleted = await get(q([{ petId: f.petId, serviceIds: [f.serviceId] }], { customerId: f.customerId }), token);
    expect(deleted.status).toBe(404);
    expect(deleted.body.code).toBe("NOT_FOUND");
  });

  it("excludeAppointmentId: any BOOKED appointment of the org → its pets, own time not busy; with customerId → 400; cancelled → 404", async () => {
    await setWait();
    const token = await staff();
    const id = await bookedAt0800();
    const before = await get(q([inline()]), token);
    expect(starts(before)).not.toContain("08:15");

    const res = await get({ from: FROM, excludeAppointmentId: id }, token);
    expect(res.status).toBe(200);
    const target = (res.body.slots as SlotView[]).find((s) => wall(s.startsAt) === "08:15");
    expect(target).toBeDefined();
    expect(target!.pets.map((p) => p.petId)).toEqual([f.petId]);

    const both = await get({ from: FROM, excludeAppointmentId: id, customerId: f.customerId }, token);
    expect(both.status).toBe(400);
    expect(both.body.errors.map((e: { path: string }) => e.path)).toEqual(["customerId"]);

    await ctx.prisma.appointment.update({ where: { id }, data: { status: "CANCELLED" } });
    const cancelled = await get({ from: FROM, excludeAppointmentId: id }, token);
    expect(cancelled.status).toBe(404);
    expect(cancelled.body.code).toBe("NOT_FOUND");
  });

  it("excludeAppointmentId of a BOOKED appointment whose customer is soft-deleted → 404 NOT_FOUND (as PATCH /staff/appointments/:id)", async () => {
    const id = await bookedAt0800();
    await ctx.prisma.customer.update({ where: { id: f.customerId }, data: { deletedAt: new Date() } });
    const res = await get({ from: FROM, excludeAppointmentId: id }, await staff());
    expect(res.status).toBe(404);
    expect(res.body.code).toBe("NOT_FOUND");
  });

  /** Another organization with a customer and a BOOKED appointment. */
  async function foreignOrg() {
    const org = await ctx.prisma.organization.create({ data: { name: "Other Grooming", slug: "other-salon", defaultLocale: "en" } });
    const location = await ctx.prisma.location.create({
      data: { organizationId: org.id, name: "Other", timezone: "America/New_York", settings: {} },
    });
    const customer = await ctx.prisma.customer.create({
      data: { organizationId: org.id, phoneE164: "+13055550188", name: "Zed", locale: "en", createdVia: "ONLINE" },
    });
    const appointment = await ctx.prisma.appointment.create({
      data: { organizationId: org.id, locationId: location.id, customerId: customer.id, status: "BOOKED", source: "ONLINE", bookingMode: "DROP_OFF" },
    });
    return { customerId: customer.id, appointmentId: appointment.id };
  }

  it("customerId of another organization → 404 NOT_FOUND", async () => {
    const foreign = await foreignOrg();
    const res = await get(q([inline()], { customerId: foreign.customerId }), await staff());
    expect(res.status).toBe(404);
    expect(res.body.code).toBe("NOT_FOUND");
  });

  it("excludeAppointmentId of another organization's BOOKED appointment → 404 NOT_FOUND", async () => {
    const foreign = await foreignOrg();
    const res = await get({ from: FROM, excludeAppointmentId: foreign.appointmentId }, await staff());
    expect(res.status).toBe(404);
    expect(res.body.code).toBe("NOT_FOUND");
  });

  it("staff requests skip the per-IP rate limit", async () => {
    await setWait();
    const ip = "198.51.100.9";
    expect((await get(q([inline()]), undefined, ip)).status).toBe(200);
    const keys = await ctx.redis.keys("rl:availability:ip:*");
    expect(keys).toHaveLength(1);
    await ctx.redis.set(keys[0]!, "120", "KEEPTTL");
    expect((await get(q([inline()]), undefined, ip)).status).toBe(429);
    const res = await get(q([inline()]), await staff(), ip);
    expect(res.status).toBe(200);
    expect(await ctx.redis.get(keys[0]!)).toBe("121");
  });
});
