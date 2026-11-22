import request from "supertest";
import { Logger } from "@nestjs/common";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HoldResponseSchema, HoldViewSchema } from "@grooming/contracts";
import { HoldReleaseService } from "../../../src/booking/hold-release.service.js";
import { createIntegrationApp, resetState } from "../app.js";
import { FROM, local, seedBookableTuesday } from "../bookable-day.js";
import { seedFixture, type Fixture } from "../helpers.js";
import { customerToken, staffToken } from "../tokens.js";

const MIN = 60_000;
const DAY = 24 * 60 * MIN;

type SegView = { stage: string; priceCents: number; employeeId: string | null; resourceId: string | null; startsAt: string; endsAt: string; blockEndsAt: string };
type SlotView = { startsAt: string; readyAt: string; bookingMode: string; pets: { petId?: string; ref?: string; priceCents: number; segments: SegView[] }[] };

describe("/v1/holds", () => {
  let ctx: Awaited<ReturnType<typeof createIntegrationApp>>;
  let f: Fixture;

  // A fresh app per test: TenancyService and LocationService cache the seeded org and location.
  beforeEach(async () => {
    ctx = await createIntegrationApp({ env: { TRUST_PROXY: "1" } });
    await resetState(ctx.prisma, ctx.redis);
    f = await seedFixture(ctx.prisma);
    await seedBookableTuesday(ctx.prisma, f);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await ctx?.close();
  });

  const server = () => ctx.app.getHttpServer();
  const auth = <T extends request.Test>(req: T, token?: string) => (token ? req.set("Authorization", `Bearer ${token}`) : req);
  const ownerToken = () => customerToken(ctx.app, { sub: f.customerId, org: f.orgId });

  /** The engine-facing part of an inline pet (what `/availability` takes). */
  const inlineQuery = (over: Record<string, unknown> = {}) => ({
    ref: "new-1", species: "DOG", sizeClass: "M", coatType: "CURLY", serviceIds: [f.serviceId], ...over,
  });
  /** An inline pet plus the details a hold needs. */
  const newPet = (over: Record<string, unknown> = {}) => ({ ...inlineQuery(), name: "Max ", breed: "Poodle", ...over });
  const savedPet = () => ({ petId: f.petId, serviceIds: [f.serviceId] });

  async function slots(pets: unknown[], token?: string): Promise<SlotView[]> {
    const res = await auth(request(server()).get("/v1/availability").query({ from: FROM, pets: JSON.stringify(pets) }), token);
    expect(res.status).toBe(200);
    return res.body.slots as SlotView[];
  }
  const hold = (body: unknown, token?: string, ip = "203.0.113.20") =>
    auth(request(server()).post("/v1/holds").set("X-Forwarded-For", ip).send(body as object), token);
  const view = (id: string, token?: string) => auth(request(server()).get(`/v1/holds/${id}`), token);
  const cancel = (id: string, token?: string) => auth(request(server()).delete(`/v1/holds/${id}`), token);

  /** The first slot for one inline dog, and a hold body for it. */
  async function firstInline(over: Record<string, unknown> = {}) {
    const [slot] = await slots([inlineQuery()]);
    expect(slot).toBeDefined();
    return { slot: slot!, body: { pets: [newPet()], slot: slot!, ...over } };
  }

  it("anonymous hold with one new pet → 201; appointment HELD, customerId null, holdExpiresAt = now + 5 min (±5 s); visit pending_pet has the name; segments occupy", async () => {
    const { body } = await firstInline();
    const before = Date.now();
    const res = await hold(body);
    expect(res.status).toBe(201);
    expect(HoldResponseSchema.strict().parse(res.body)).toEqual(res.body);

    const appt = await ctx.prisma.appointment.findUniqueOrThrow({
      where: { id: res.body.holdId },
      include: { petVisits: true, segments: true },
    });
    expect(appt).toMatchObject({ status: "HELD", source: "ONLINE", customerId: null, bookingMode: "DROP_OFF", organizationId: f.orgId });
    expect(Math.abs(appt.holdExpiresAt!.getTime() - (before + 5 * MIN))).toBeLessThan(5_000);
    expect(res.body.expiresAt).toBe(appt.holdExpiresAt!.toISOString());
    expect(appt.dropOffAt?.toISOString()).toBe(body.slot.startsAt);
    expect(appt.estimatedReadyAt?.toISOString()).toBe(body.slot.readyAt);
    expect(appt.petVisits).toHaveLength(1);
    expect(appt.petVisits[0]).toMatchObject({ petId: null, position: 0, sizeClassAtBooking: "M", coatTypeAtBooking: "CURLY", priceCentsQuoted: 4500 });
    expect(appt.petVisits[0]?.pendingPet).toEqual({ ref: "new-1", species: "DOG", name: "Max", breed: "Poodle", breedCode: null, weightG: null });
    expect(appt.segments.length).toBe(body.slot.pets[0]!.segments.length);
    expect(appt.segments.every((s) => s.occupies)).toBe(true);
  });

  it("customer hold with a saved pet → appointment customerId set", async () => {
    const token = await ownerToken();
    const [slot] = await slots([savedPet()], token);
    const res = await hold({ pets: [savedPet()], slot }, token);
    expect(res.status).toBe(201);
    const appt = await ctx.prisma.appointment.findUniqueOrThrow({ where: { id: res.body.holdId }, include: { petVisits: true } });
    expect(appt.customerId).toBe(f.customerId);
    expect(appt.petVisits[0]).toMatchObject({ petId: f.petId, pendingPet: null });
  });

  it("the same slot held twice → second 409 SLOT_TAKEN", async () => {
    const { body } = await firstInline();
    expect((await hold(body)).status).toBe(201);
    const again = await hold(body);
    expect(again.status).toBe(409);
    expect(again.body.code).toBe("SLOT_TAKEN");
  });

  it("slot with a tampered segment price → 400 VALIDATION_FAILED detail MALFORMED_PLAN", async () => {
    const { body } = await firstInline();
    body.slot.pets[0]!.segments[0]!.priceCents = 1;
    const res = await hold(body);
    expect(res.status).toBe(400);
    expect(res.body.code).toBe("VALIDATION_FAILED");
    expect(res.body.detail).toBe("MALFORMED_PLAN");
  });

  it('slot with a malformed startsAt ("2026-13-01T…") → 400 VALIDATION_FAILED', async () => {
    const { body } = await firstInline();
    body.slot.startsAt = "2026-13-01T13:00:00.000Z";
    const res = await hold(body);
    expect(res.status).toBe(400);
    expect(res.body.code).toBe("VALIDATION_FAILED");
  });

  it("slot whose start is now in the past (TOO_SOON) → 409 SLOT_TAKEN", async () => {
    const { body } = await firstInline();
    // Two weeks back: same weekday and wall times, always before today.
    const back = (iso: string) => new Date(Date.parse(iso) - 14 * DAY).toISOString();
    const s = body.slot;
    s.startsAt = back(s.startsAt);
    s.readyAt = back(s.readyAt);
    for (const seg of s.pets[0]!.segments) {
      seg.startsAt = back(seg.startsAt);
      seg.endsAt = back(seg.endsAt);
      seg.blockEndsAt = back(seg.blockEndsAt);
    }
    const res = await hold(body);
    expect(res.status).toBe(409);
    expect(res.body.code).toBe("SLOT_TAKEN");
  });

  it('new pet with weightG 9000 (S) and sizeClass "L" → 400 path pets.0.sizeClass', async () => {
    const { body } = await firstInline();
    const res = await hold({ ...body, pets: [newPet({ weightG: 9000, sizeClass: "L" })] });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe("VALIDATION_FAILED");
    expect(res.body.errors.map((e: { path: string }) => e.path)).toEqual(["pets.0.sizeClass"]);
  });

  it("replaceHoldId: the old hold is CANCELLED with reason HOLD_RELEASED and the new hold may overlap its time", async () => {
    const { body } = await firstInline();
    const first = await hold(body);
    expect(first.status).toBe(201);
    const second = await hold({ ...body, replaceHoldId: first.body.holdId });
    expect(second.status).toBe(201);
    expect(second.body.holdId).not.toBe(first.body.holdId);

    const old = await ctx.prisma.appointment.findUniqueOrThrow({ where: { id: first.body.holdId }, include: { segments: true, petVisits: true } });
    expect(old).toMatchObject({ status: "CANCELLED", cancelReason: "HOLD_RELEASED", cancelledBy: "CUSTOMER" });
    expect(old.segments.every((s) => !s.occupies)).toBe(true);
    expect(old.petVisits.every((v) => v.status === "CANCELLED")).toBe(true);
    const fresh = await ctx.prisma.appointment.findUniqueOrThrow({ where: { id: second.body.holdId }, include: { segments: true } });
    expect(fresh.status).toBe("HELD");
    expect(fresh.segments.every((s) => s.occupies)).toBe(true);
  });

  it("replaceHoldId of another customer's hold → 404 and nothing changes", async () => {
    const token = await ownerToken();
    const [slot] = await slots([savedPet()], token);
    const mine = await hold({ pets: [savedPet()], slot }, token);
    expect(mine.status).toBe(201);
    const { body } = await firstInline();
    const res = await hold({ ...body, replaceHoldId: mine.body.holdId });
    expect(res.status).toBe(404);
    expect(res.body.code).toBe("NOT_FOUND");
    const row = await ctx.prisma.appointment.findUniqueOrThrow({ where: { id: mine.body.holdId } });
    expect(row.status).toBe("HELD");
    expect(await ctx.prisma.appointment.count()).toBe(1);
  });

  it("an expired overlapping hold does not block a new hold", async () => {
    const { body } = await firstInline();
    const first = await hold(body);
    expect(first.status).toBe(201);
    await ctx.prisma.appointment.update({ where: { id: first.body.holdId }, data: { holdExpiresAt: new Date(Date.now() - MIN) } });
    const second = await hold(body);
    expect(second.status).toBe(201);
    const old = await ctx.prisma.appointment.findUniqueOrThrow({ where: { id: first.body.holdId }, include: { segments: true } });
    expect(old).toMatchObject({ status: "CANCELLED", cancelReason: "HOLD_EXPIRED", cancelledBy: "SYSTEM" });
    expect(old.segments.every((s) => !s.occupies)).toBe(true);
  });

  it("two concurrent holds on the last free kennel (one kennel left, Promise.all) → one 201, one 409; one KENNEL segment", async () => {
    await ctx.prisma.resource.update({ where: { id: f.kennel2 }, data: { active: false } });
    const all = await slots([inlineQuery()]);
    const work = (s: SlotView) => s.pets[0]!.segments.filter((x) => x.stage !== "KENNEL");
    const kennel = (s: SlotView) => s.pets[0]!.segments.find((x) => x.stage === "KENNEL")!;
    const overlap = (a: SegView, b: SegView) => Date.parse(a.startsAt) < Date.parse(b.blockEndsAt) && Date.parse(b.startsAt) < Date.parse(a.blockEndsAt);
    const a = all[0]!;
    // A second slot that collides with the first only on the kennel, so the database (not validatePlan) decides.
    const b = all.find((s) => s !== a && overlap(kennel(a), kennel(s)) && work(s).every((x) => work(a).every((y) => !overlap(x, y))));
    expect(b).toBeDefined();
    expect(kennel(a).resourceId).toBe(f.kennel1);
    expect(kennel(b!).resourceId).toBe(f.kennel1);

    // Barrier on the first statement of each transaction: both requests have passed validatePlan
    // before either inserts, so the exclusion constraint (23P01), not the pre-check, picks the loser.
    const release = ctx.app.get(HoldReleaseService);
    const original = release.releaseExpired.bind(release);
    let arrived = 0;
    let open!: () => void;
    const gate = new Promise<void>((resolve) => (open = resolve));
    vi.spyOn(release, "releaseExpired").mockImplementation(async (...args) => {
      if (++arrived === 2) open();
      await gate;
      return original(...args);
    });
    const warn = vi.spyOn(Logger.prototype, "warn");

    const [r1, r2] = await Promise.all([
      hold({ pets: [newPet()], slot: a }, undefined, "203.0.113.31"),
      hold({ pets: [newPet()], slot: b }, undefined, "203.0.113.32"),
    ]);
    expect([r1.status, r2.status].sort()).toEqual([201, 409]);
    expect([r1, r2].find((r) => r.status === 409)?.body.code).toBe("SLOT_TAKEN");
    expect(await ctx.prisma.appointmentSegment.count({ where: { stage: "KENNEL" } })).toBe(1);
    expect(await ctx.prisma.appointment.count()).toBe(1);
    expect(arrived).toBe(2);
    expect(warn.mock.calls.map((c) => c[0])).toContain("SLOT_TAKEN: exclusion constraint no_resource_overlap");
  });

  it('GET /holds/:id with a customer token lists the matching "max" pet for a pending "Max "; anonymous gets matches []; another customer\'s hold → 404; expired → 409 HOLD_EXPIRED', async () => {
    await ctx.prisma.pet.update({ where: { id: f.petId }, data: { name: "max" } });
    // Same name but a cat, and a deleted dog: never matches.
    await ctx.prisma.pet.create({ data: { organizationId: f.orgId, customerId: f.customerId, name: "MAX", species: "CAT", breed: "Siamese" } });
    await ctx.prisma.pet.create({
      data: { organizationId: f.orgId, customerId: f.customerId, name: "Max", species: "DOG", breed: "Lab", deletedAt: new Date() },
    });
    const token = await ownerToken();
    const { body } = await firstInline();
    const anon = await hold(body);
    expect(anon.status).toBe(201);

    const signedIn = await view(anon.body.holdId, token);
    expect(signedIn.status).toBe(200);
    expect(HoldViewSchema.strict().parse(signedIn.body)).toEqual(signedIn.body);
    expect(signedIn.body).toMatchObject({
      holdId: anon.body.holdId,
      expiresAt: anon.body.expiresAt,
      bookingMode: "DROP_OFF",
      startsAt: body.slot.startsAt,
      readyAt: body.slot.readyAt,
    });
    expect(signedIn.body.pets).toHaveLength(1);
    expect(signedIn.body.pets[0]).toMatchObject({ petId: null, ref: "new-1", name: "Max", priceCents: 4500 });
    expect(signedIn.body.pets[0].matches).toEqual([{ petId: f.petId, name: "max", breed: "Poodle", weightG: 19_000 }]);

    const anonymous = await view(anon.body.holdId);
    expect(anonymous.status).toBe(200);
    expect(anonymous.body.pets[0].matches).toEqual([]);

    // A hold owned by the customer: another customer and anonymous visitors get 404.
    await ctx.prisma.appointment.update({ where: { id: anon.body.holdId }, data: { customerId: f.customerId } });
    const other = await ctx.prisma.customer.create({
      data: { organizationId: f.orgId, phoneE164: "+13055550199", name: "Bo", locale: "en", createdVia: "ONLINE" },
    });
    const otherToken = await customerToken(ctx.app, { sub: other.id, org: f.orgId });
    expect((await view(anon.body.holdId, otherToken)).status).toBe(404);
    expect((await view(anon.body.holdId)).status).toBe(404);
    expect((await view(anon.body.holdId, token)).status).toBe(200);

    await ctx.prisma.appointment.update({ where: { id: anon.body.holdId }, data: { holdExpiresAt: new Date(Date.now() - MIN) } });
    const expired = await view(anon.body.holdId, token);
    expect(expired.status).toBe(409);
    expect(expired.body.code).toBe("HOLD_EXPIRED");
  });

  it("GET a saved-pet hold shows the pet's name and no matches", async () => {
    const token = await ownerToken();
    const [slot] = await slots([savedPet()], token);
    const res = await hold({ pets: [savedPet()], slot }, token);
    const got = await view(res.body.holdId, token);
    expect(got.status).toBe(200);
    expect(got.body.pets[0]).toMatchObject({ petId: f.petId, ref: null, name: "Max", matches: [] });
  });

  it("GET/DELETE with a soft-deleted customer token → 401; unknown or BOOKED → 404", async () => {
    const token = await ownerToken();
    const { body } = await firstInline();
    const res = await hold(body);
    await ctx.prisma.customer.update({ where: { id: f.customerId }, data: { deletedAt: new Date() } });
    expect((await view(res.body.holdId, token)).status).toBe(401);
    expect((await cancel(res.body.holdId, token)).status).toBe(401);
    expect((await hold(body, token)).status).toBe(401);
    expect((await view("0194b2a0-0000-7000-8000-000000000000")).status).toBe(404);
    await ctx.prisma.appointment.update({ where: { id: res.body.holdId }, data: { status: "BOOKED", holdExpiresAt: null } });
    expect((await view(res.body.holdId)).status).toBe(404);
    expect((await cancel(res.body.holdId)).status).toBe(404);
  });

  it("DELETE /holds/:id → 204 and segments no longer occupy; again → 404", async () => {
    const { body } = await firstInline();
    const res = await hold(body);
    const del = await cancel(res.body.holdId);
    expect(del.status).toBe(204);
    const row = await ctx.prisma.appointment.findUniqueOrThrow({ where: { id: res.body.holdId }, include: { segments: true } });
    expect(row).toMatchObject({ status: "CANCELLED", cancelReason: "HOLD_RELEASED", cancelledBy: "CUSTOMER" });
    expect(row.segments.every((s) => !s.occupies)).toBe(true);
    const again = await cancel(res.body.holdId);
    expect(again.status).toBe(404);
    expect(again.body.code).toBe("NOT_FOUND");
  });

  it("another organization's hold → 404 on GET and DELETE", async () => {
    const f2 = await seedFixture(ctx.prisma, { slug: "other-salon" });
    // An anonymous hold (usable by anyone holding the id) in the other organization.
    const theirs = await ctx.prisma.appointment.create({
      data: {
        organizationId: f2.orgId, locationId: f2.locationId, status: "HELD", source: "ONLINE", bookingMode: "WAIT",
        holdExpiresAt: new Date(Date.now() + 5 * MIN),
      },
    });
    expect((await view(theirs.id)).status).toBe(404);
    expect((await cancel(theirs.id)).status).toBe(404);
    expect((await ctx.prisma.appointment.findUniqueOrThrow({ where: { id: theirs.id } })).status).toBe("HELD");
  });

  it("21st POST from one IP in 10 min → 429", async () => {
    const { body } = await firstInline();
    expect((await hold(body, undefined, "198.51.100.9")).status).toBe(201);
    const keys = await ctx.redis.keys("rl:holds:ip:*");
    expect(keys).toHaveLength(1);
    await ctx.redis.set(keys[0]!, "20", "KEEPTTL");
    const limited = await hold(body, undefined, "198.51.100.9");
    expect(limited.status).toBe(429);
    expect(limited.body.code).toBe("RATE_LIMITED");
  });

  it("staff token on POST /holds → 403", async () => {
    const { body } = await firstInline();
    const staff = await staffToken(ctx.app, { sub: f.staffA, org: f.orgId, role: "OWNER" });
    expect((await hold(body, staff)).status).toBe(403);
  });

  it('slot with bookingMode "WAIT" for a DROP_OFF service → 400 path slot.bookingMode', async () => {
    const { body } = await firstInline();
    body.slot.bookingMode = "WAIT";
    const res = await hold(body);
    expect(res.status).toBe(400);
    expect(res.body.code).toBe("VALIDATION_FAILED");
    expect(res.body.errors.map((e: { path: string }) => e.path)).toEqual(["slot.bookingMode"]);
  });

  it("slot more than 400 days ahead → 400 path slot.startsAt", async () => {
    const { body } = await firstInline();
    const ahead = (iso: string) => new Date(Date.parse(iso) + 500 * DAY).toISOString();
    const s = body.slot;
    s.startsAt = ahead(s.startsAt);
    s.readyAt = ahead(s.readyAt);
    for (const seg of s.pets[0]!.segments) {
      seg.startsAt = ahead(seg.startsAt);
      seg.endsAt = ahead(seg.endsAt);
      seg.blockEndsAt = ahead(seg.blockEndsAt);
    }
    const res = await hold(body);
    expect(res.status).toBe(400);
    expect(res.body.code).toBe("VALIDATION_FAILED");
    expect(res.body.errors.map((e: { path: string }) => e.path)).toEqual(["slot.startsAt"]);
  });

  it("soft-deleted customer token with a size that does not match the weight → 401 (before the 400)", async () => {
    const token = await ownerToken();
    const { body } = await firstInline();
    await ctx.prisma.customer.update({ where: { id: f.customerId }, data: { deletedAt: new Date() } });
    const res = await hold({ ...body, pets: [newPet({ weightG: 9000, sizeClass: "L" })] }, token);
    expect(res.status).toBe(401);
  });

  it("replaceHoldId of my hold that expired and was released → ignored; the new hold is created", async () => {
    const { body } = await firstInline();
    const first = await hold(body);
    await ctx.prisma.appointment.update({ where: { id: first.body.holdId }, data: { holdExpiresAt: new Date(Date.now() - MIN) } });
    const second = await hold({ ...body, replaceHoldId: first.body.holdId });
    expect(second.status).toBe(201);
    const old = await ctx.prisma.appointment.findUniqueOrThrow({ where: { id: first.body.holdId } });
    expect(old).toMatchObject({ status: "CANCELLED", cancelReason: "HOLD_EXPIRED", cancelledBy: "SYSTEM" });
    expect((await ctx.prisma.appointment.findUniqueOrThrow({ where: { id: second.body.holdId } })).status).toBe("HELD");
  });

  it("replaceHoldId of my hold that was already released → ignored; the new hold is created", async () => {
    const token = await ownerToken();
    const [slot] = await slots([savedPet()], token);
    const first = await hold({ pets: [savedPet()], slot }, token);
    expect((await cancel(first.body.holdId, token)).status).toBe(204);
    const second = await hold({ pets: [savedPet()], slot, replaceHoldId: first.body.holdId }, token);
    expect(second.status).toBe(201);
    const old = await ctx.prisma.appointment.findUniqueOrThrow({ where: { id: first.body.holdId } });
    expect(old).toMatchObject({ status: "CANCELLED", cancelReason: "HOLD_RELEASED" });
  });

  it("replaceHoldId that does not exist in this organization → 404", async () => {
    const { body } = await firstInline();
    const f2 = await seedFixture(ctx.prisma, { slug: "other-salon" });
    const theirs = await ctx.prisma.appointment.create({
      data: {
        organizationId: f2.orgId, locationId: f2.locationId, status: "CANCELLED", source: "ONLINE", bookingMode: "WAIT",
      },
    });
    expect((await hold({ ...body, replaceHoldId: "0194b2a0-0000-7000-8000-000000000000" })).status).toBe(404);
    expect((await hold({ ...body, replaceHoldId: theirs.id })).status).toBe(404);
    expect(await ctx.prisma.appointment.count({ where: { organizationId: f.orgId } })).toBe(0);
  });

  it("replaceHoldId of another customer's released hold → 404", async () => {
    const token = await ownerToken();
    const [slot] = await slots([savedPet()], token);
    const mine = await hold({ pets: [savedPet()], slot }, token);
    expect((await cancel(mine.body.holdId, token)).status).toBe(204);
    const other = await ctx.prisma.customer.create({
      data: { organizationId: f.orgId, phoneE164: "+13055550199", name: "Bo", locale: "en", createdVia: "ONLINE" },
    });
    const otherToken = await customerToken(ctx.app, { sub: other.id, org: f.orgId });
    const { body } = await firstInline();
    expect((await hold({ ...body, replaceHoldId: mine.body.holdId }, otherToken)).status).toBe(404);
  });

  it("wall-time sanity: the first drop-off slot is 08:00", async () => {
    const { slot } = await firstInline();
    expect(slot.startsAt).toBe(local("08:00"));
  });
});
