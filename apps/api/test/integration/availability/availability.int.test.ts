import request from "supertest";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AvailabilityResponseSchema } from "@grooming/contracts";
import { addDays, todayIn, wallTimeToUtc, weekdayOf, type IsoDate } from "@grooming/datetime";
import { createIntegrationApp, resetState } from "../app.js";
import { createPetVisit, seedFixture, type Fixture } from "../helpers.js";
import { customerToken, staffToken } from "../tokens.js";

const TZ = "America/New_York";
const t = (hhmm: string) => new Date(`1970-01-01T${hhmm}:00.000Z`);

/** The first Tuesday at least 3 days after today (New York): inside the 60-day horizon, past the 60-min lead time. */
function nextTuesday(): IsoDate {
  let d = addDays(todayIn(TZ, Date.now()), 3);
  while (weekdayOf(d) !== 2) d = addDays(d, 1);
  return d;
}
const FROM = nextTuesday();
const local = (hhmm: string, date: IsoDate = FROM) => new Date(wallTimeToUtc(date, hhmm, TZ)).toISOString();
const wall = (iso: string) =>
  new Intl.DateTimeFormat("en-GB", { timeZone: TZ, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(new Date(iso));

describe("GET /v1/availability", () => {
  let ctx: Awaited<ReturnType<typeof createIntegrationApp>>;
  let f: Fixture;

  const get = (q: Record<string, string>, token?: string, ip = "203.0.113.10") => {
    const req = request(ctx.app.getHttpServer()).get("/v1/availability").query(q).set("X-Forwarded-For", ip);
    return token ? req.set("Authorization", `Bearer ${token}`) : req;
  };
  const inline = (over: Record<string, unknown> = {}) => ({
    ref: "new-1",
    species: "DOG",
    sizeClass: "M",
    coatType: "CURLY",
    serviceIds: [f.serviceId],
    ...over,
  });
  const q = (pets: unknown[], over: Record<string, string> = {}) => ({ from: FROM, pets: JSON.stringify(pets), ...over });
  const ownerToken = () => customerToken(ctx.app, { sub: f.customerId, org: f.orgId });

  // A fresh app per test: TenancyService and LocationService cache the seeded org and location.
  // TRUST_PROXY=1 lets X-Forwarded-For set the client IP for the rate-limit test.
  beforeEach(async () => {
    ctx = await createIntegrationApp({ env: { TRUST_PROXY: "1" } });
    await resetState(ctx.prisma, ctx.redis);
    f = await seedFixture(ctx.prisma);
    await ctx.prisma.locationHours.create({ data: { locationId: f.locationId, weekday: 2, opens: t("08:00"), closes: t("18:00") } });
    await ctx.prisma.employeeProfile.create({ data: { staffUserId: f.staffA, displayName: "A", skills: ["BATHER"] } });
    await ctx.prisma.employeeService.create({ data: { staffUserId: f.staffA, serviceId: f.serviceId } });
    await ctx.prisma.staffLocation.create({ data: { staffUserId: f.staffA, locationId: f.locationId } });
    await ctx.prisma.workingHours.create({
      data: { organizationId: f.orgId, staffUserId: f.staffA, locationId: f.locationId, weekday: 2, startTime: t("08:00"), endTime: t("17:00") },
    });
    await ctx.prisma.servicePrice.create({
      data: { organizationId: f.orgId, serviceId: f.serviceId, sizeClass: "M", coatType: null, durationMin: 60, priceCents: 4500 },
    });
  });

  afterEach(async () => {
    await ctx?.close();
  });

  const setWait = () => ctx.prisma.service.update({ where: { id: f.serviceId }, data: { bookingMode: "WAIT" } });

  it("anonymous, one inline dog, WAIT service → 200 WAIT, 15-min grid, ref new-1, matrix price", async () => {
    await setWait();
    const res = await get(q([inline()]));
    expect(res.status).toBe(200);
    expect(AvailabilityResponseSchema.strict().parse(res.body)).toEqual(res.body);
    expect(res.body.bookingMode).toBe("WAIT");
    expect(res.body.slots.length).toBeGreaterThan(0);
    for (const s of res.body.slots) {
      expect(new Date(s.startsAt).getUTCMinutes() % 15).toBe(0);
      expect(s.bookingMode).toBe("WAIT");
    }
    const first = res.body.slots[0];
    expect(first.startsAt).toBe(local("08:00"));
    expect(first.readyAt).toBe(local("09:00"));
    expect(first.pets).toHaveLength(1);
    expect(first.pets[0].ref).toBe("new-1");
    expect(first.pets[0].petId).toBeUndefined();
    expect(first.pets[0].priceCents).toBe(4500);
    expect(first.pets[0].segments[0]).toMatchObject({
      stage: "BATH",
      serviceIds: [f.serviceId],
      employeeId: f.staffA,
      durationMin: 60,
      priceCents: 4500,
      startsAt: local("08:00"),
      endsAt: local("09:00"),
    });
    // Last start: the bather works until 17:00 and the bath takes 60 min.
    expect(wall(res.body.slots.at(-1).startsAt)).toBe("16:00");
  });

  it("DROP_OFF service → DROP_OFF; every start inside the drop-off window; each pet has a KENNEL segment", async () => {
    const res = await get(q([inline()]));
    expect(res.status).toBe(200);
    expect(res.body.bookingMode).toBe("DROP_OFF");
    expect(AvailabilityResponseSchema.parse(res.body)).toEqual(res.body);
    expect(res.body.slots.length).toBeGreaterThan(0);
    for (const s of res.body.slots) {
      expect(wall(s.startsAt) >= "08:00" && wall(s.startsAt) < "11:00").toBe(true);
      for (const p of s.pets) expect(p.segments.some((x: { stage: string }) => x.stage === "KENNEL")).toBe(true);
    }
  });

  it("a range of two days concatenates slots in date order (Wednesday has no hours)", async () => {
    await setWait();
    const res = await get(q([inline()], { to: addDays(FROM, 1) }));
    expect(res.status).toBe(200);
    const one = await get(q([inline()]));
    expect(res.body.slots).toEqual(one.body.slots);
  });

  it("customer token + own petId → 200 with pets[0].petId", async () => {
    await setWait();
    const res = await get(q([{ petId: f.petId, serviceIds: [f.serviceId] }]), await ownerToken());
    expect(res.status).toBe(200);
    expect(res.body.slots[0].pets[0].petId).toBe(f.petId);
    expect(res.body.slots[0].pets[0].ref).toBeUndefined();
  });

  it("petId without a token → 401; another customer's pet → 404; a deleted pet → 404", async () => {
    const pets = [{ petId: f.petId, serviceIds: [f.serviceId] }];
    const anon = await get(q(pets));
    expect(anon.status).toBe(401);
    expect(anon.body.code).toBe("UNAUTHORIZED");

    const other = await ctx.prisma.customer.create({
      data: { organizationId: f.orgId, phoneE164: "+13055550199", name: "Bo", locale: "en", createdVia: "ONLINE" },
    });
    const otherToken = await customerToken(ctx.app, { sub: other.id, org: f.orgId });
    const foreign = await get(q(pets), otherToken);
    expect(foreign.status).toBe(404);
    expect(foreign.body.code).toBe("NOT_FOUND");

    await ctx.prisma.pet.update({ where: { id: f.petId }, data: { deletedAt: new Date() } });
    const deleted = await get(q(pets), await ownerToken());
    expect(deleted.status).toBe(404);
    expect(deleted.body.code).toBe("NOT_FOUND");
  });

  it('own pet with sizeClass null and no sizeClass in the query → 400 on "pets.0.sizeClass"; with "M" → 200', async () => {
    await setWait();
    await ctx.prisma.pet.update({ where: { id: f.petId }, data: { sizeClass: null, weightG: null } });
    const token = await ownerToken();
    const missing = await get(q([{ petId: f.petId, serviceIds: [f.serviceId] }]), token);
    expect(missing.status).toBe(400);
    expect(missing.body.code).toBe("VALIDATION_FAILED");
    expect(missing.body.errors.map((e: { path: string }) => e.path)).toEqual(["pets.0.sizeClass"]);

    const given = await get(q([{ petId: f.petId, sizeClass: "M", serviceIds: [f.serviceId] }]), token);
    expect(given.status).toBe(200);
    expect(given.body.slots[0].pets[0].priceCents).toBe(4500);
  });

  it("a stored sizeClass wins over the request value", async () => {
    await setWait();
    // The pet is M; an XL request value would find no price row if it were used.
    const res = await get(q([{ petId: f.petId, sizeClass: "XL", serviceIds: [f.serviceId] }]), await ownerToken());
    expect(res.status).toBe(200);
  });

  it('pets="{oops" → 400; pets of 4001 chars → 400; to = from + 7 → 400; never 500', async () => {
    const bad = await get({ from: FROM, pets: "{oops" });
    expect(bad.status).toBe(400);
    expect(bad.body.code).toBe("VALIDATION_FAILED");
    expect(bad.body.errors.map((e: { path: string }) => e.path)).toEqual(["pets"]);

    const huge = await get({ from: FROM, pets: JSON.stringify([inline({ pad: "x".repeat(4001) })]) });
    expect(huge.status).toBe(400);
    expect(huge.body.code).toBe("VALIDATION_FAILED");

    const long = await get(q([inline()], { to: addDays(FROM, 7) }));
    expect(long.status).toBe(400);
    expect(long.body.code).toBe("VALIDATION_FAILED");
    expect(long.body.errors.map((e: { path: string }) => e.path)).toEqual(["to"]);

    const nested = await request(ctx.app.getHttpServer()).get(`/v1/availability?from=${FROM}&pets[0][ref]=new-1`);
    expect(nested.status).toBe(400);
    const missing = await get({ from: FROM });
    expect(missing.status).toBe(400);
  });

  it('no pets → 400 on "pets"; excludeAppointmentId (reschedule) → 400 "not supported yet"; both → 400 on "pets"', async () => {
    const paths = (res: { body: { errors?: { path: string }[] } }) => (res.body.errors ?? []).map((e) => e.path);
    const missing = await get({ from: FROM });
    expect(missing.status).toBe(400);
    expect(missing.body.code).toBe("VALIDATION_FAILED");
    expect(paths(missing)).toEqual(["pets"]);

    const exclude = await get({ from: FROM, excludeAppointmentId: f.customerId });
    expect(exclude.status).toBe(400);
    expect(exclude.body.code).toBe("VALIDATION_FAILED");
    expect(exclude.body.errors).toEqual([{ path: "excludeAppointmentId", message: "not supported yet" }]);

    const both = await get(q([inline()], { excludeAppointmentId: f.customerId }));
    expect(both.status).toBe(400);
    expect(paths(both)).toEqual(["pets"]);
  });

  it("from in year 9999 or 0050 → 400 VALIDATION_FAILED, not 500", async () => {
    for (const from of ["9999-12-31", "0050-01-01"]) {
      const res = await get(q([inline()], { from }));
      expect(res.status).toBe(400);
      expect(res.body.code).toBe("VALIDATION_FAILED");
    }
  });

  it("service with no price row for the pet's size → 400 NO_PRICE_FOR_PET", async () => {
    const res = await get(q([inline({ sizeClass: "XL" })]));
    expect(res.status).toBe(400);
    expect(res.body.code).toBe("NO_PRICE_FOR_PET");
  });

  it("other engine errors → 400 VALIDATION_FAILED with detail = engine code", async () => {
    const res = await get(q([inline({ serviceIds: ["0194b2a0-0000-7000-8000-0000000000aa"] })]));
    expect(res.status).toBe(400);
    expect(res.body.code).toBe("VALIDATION_FAILED");
    expect(res.body.detail).toBe("UNKNOWN_SERVICE");
    const cat = await get(q([inline({ species: "CAT" })]));
    expect(cat.status).toBe(400);
    expect(cat.body.detail).toBe("SPECIES_MISMATCH");
  });

  it("a busy segment on the only groomer removes the overlapping start times", async () => {
    await setWait();
    const before = (await get(q([inline()]))).body.slots.map((s: { startsAt: string }) => wall(s.startsAt));
    expect(before).toContain("09:15");
    expect(before).toContain("10:45");

    const visit = await createPetVisit(ctx.prisma, f);
    await ctx.prisma.appointmentSegment.create({
      data: {
        organizationId: f.orgId,
        appointmentId: visit.appointmentId,
        petVisitId: visit.id,
        stage: "BATH",
        serviceId: f.serviceId,
        staffUserId: f.staffA,
        resourceId: f.resource1,
        startsAt: new Date(local("10:00")),
        endsAt: new Date(local("11:00")),
        blockEndsAt: new Date(local("11:00")),
        durationMin: 60,
        priceCents: 4500,
        occupies: true,
      },
    });
    const after = (await get(q([inline()]))).body.slots.map((s: { startsAt: string }) => wall(s.startsAt));
    for (const gone of ["09:15", "09:30", "09:45", "10:00", "10:15", "10:30", "10:45"]) expect(after).not.toContain(gone);
    expect(after).toContain("09:00");
    expect(after).toContain("11:00");
  });

  it("staff token → 403; malformed bearer → 401", async () => {
    const staff = await staffToken(ctx.app, { sub: f.staffA, org: f.orgId, role: "OWNER" });
    expect((await get(q([inline()]), staff)).status).toBe(403);
    expect((await get(q([inline()]), "garbage")).status).toBe(401);
  });

  it("121st request from one IP in 10 min → 429", async () => {
    await setWait();
    // Prefill the counter to the limit instead of sending 120 requests.
    const ipRes = await get(q([inline()]), undefined, "198.51.100.7");
    expect(ipRes.status).toBe(200);
    const keys = await ctx.redis.keys("rl:availability:ip:*");
    expect(keys).toHaveLength(1);
    await ctx.redis.set(keys[0]!, "120", "KEEPTTL");
    const limited = await get(q([inline()]), undefined, "198.51.100.7");
    expect(limited.status).toBe(429);
    expect(limited.body.code).toBe("RATE_LIMITED");
    expect((await get(q([inline()]), undefined, "198.51.100.8")).status).toBe(200);
  });
});
