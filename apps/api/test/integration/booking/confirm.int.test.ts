import request from "supertest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AppointmentViewSchema, MAX_PETS_PER_CUSTOMER } from "@grooming/contracts";
import { HoldsService } from "../../../src/booking/holds.service.js";
import { createIntegrationApp, resetState } from "../app.js";
import { FROM, seedBookableTuesday } from "../bookable-day.js";
import { seedFixture, type Fixture } from "../helpers.js";
import { customerToken, staffToken } from "../tokens.js";

const MIN = 60_000;

type SlotView = { startsAt: string; readyAt: string; bookingMode: string; pets: { petId?: string; ref?: string }[] };

describe("POST /v1/appointments (confirm a hold)", () => {
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

  const inlineQuery = () => ({ ref: "new-1", species: "DOG", sizeClass: "M", coatType: "CURLY", serviceIds: [f.serviceId] });
  const newPet = (over: Record<string, unknown> = {}) => ({ ...inlineQuery(), name: "Rex", breed: "Poodle", ...over });
  const savedPet = () => ({ petId: f.petId, serviceIds: [f.serviceId] });

  async function slots(pets: unknown[], token?: string): Promise<SlotView[]> {
    const res = await auth(request(server()).get("/v1/availability").query({ from: FROM, pets: JSON.stringify(pets) }), token);
    expect(res.status).toBe(200);
    return res.body.slots as SlotView[];
  }
  const holdReq = (body: unknown, token?: string) =>
    auth(request(server()).post("/v1/holds").set("X-Forwarded-For", "203.0.113.20").send(body as object), token);
  const confirm = (body: unknown, token?: string) => auth(request(server()).post("/v1/appointments").send(body as object), token);

  /** An anonymous hold for one new pet on the first slot. */
  async function anonymousHold(pet: Record<string, unknown> = {}) {
    const [slot] = await slots([inlineQuery()]);
    const body = { pets: [newPet(pet)], slot: slot! };
    const res = await holdReq(body);
    expect(res.status).toBe(201);
    return { holdId: res.body.holdId as string, body };
  }

  /** A customer hold for the fixture's saved pet on the first slot. */
  async function savedHold(token: string) {
    const [slot] = await slots([savedPet()], token);
    const res = await holdReq({ pets: [savedPet()], slot }, token);
    expect(res.status).toBe(201);
    return res.body.holdId as string;
  }

  const appt = (id: string) => ctx.prisma.appointment.findUniqueOrThrow({ where: { id }, include: { petVisits: true, segments: true } });

  it("anonymous hold + customer token → 201 BOOKED; a new pet created for the customer with sizeClass from the snapshot; visit pet_id set, pending_pet null; outbox appointment.booked; audit appointment.create", async () => {
    const token = await ownerToken();
    const { holdId, body } = await anonymousHold({ weightG: 19_000 });
    const res = await confirm({ holdId, notes: "  Gate code 12  " }, token);
    expect(res.status).toBe(201);
    expect(AppointmentViewSchema.strict().parse(res.body)).toEqual(res.body);

    const pets = await ctx.prisma.pet.findMany({ where: { customerId: f.customerId, name: "Rex" } });
    expect(pets).toHaveLength(1);
    const rex = pets[0]!;
    expect(rex).toMatchObject({ species: "DOG", breed: "Poodle", weightG: 19_000, sizeClass: "M", coatType: "CURLY", deletedAt: null, organizationId: f.orgId });
    expect(rex.weightMeasuredAt).not.toBeNull();

    const row = await appt(holdId);
    expect(row).toMatchObject({ status: "BOOKED", customerId: f.customerId, holdExpiresAt: null, notes: "Gate code 12", source: "ONLINE" });
    expect(row.petVisits).toHaveLength(1);
    expect(row.petVisits[0]).toMatchObject({ petId: rex.id, pendingPet: null, status: "BOOKED" });
    expect(row.segments.every((s) => s.occupies)).toBe(true);

    expect(res.body).toMatchObject({
      id: holdId,
      status: "BOOKED",
      source: "ONLINE",
      bookingMode: "DROP_OFF",
      startsAt: body.slot.startsAt,
      dropOffAt: body.slot.startsAt,
      estimatedReadyAt: body.slot.readyAt,
      notes: "Gate code 12",
      cancelledAt: null,
    });
    expect(res.body.pets).toHaveLength(1);
    expect(res.body.pets[0]).toMatchObject({ visitId: row.petVisits[0]!.id, petId: rex.id, petName: "Rex", status: "BOOKED", priceCentsQuoted: 4500 });
    expect(res.body.pets[0].services).toEqual([{ serviceId: f.serviceId, priceCents: 4500, durationMin: 60 }]);
    expect(res.body.pets[0].segments).toHaveLength(row.segments.length);
    const starts = res.body.pets[0].segments.map((s: { startsAt: string }) => Date.parse(s.startsAt));
    expect([...starts].sort((a, b) => a - b)).toEqual(starts);

    const outbox = await ctx.prisma.outboxEvent.findMany();
    expect(outbox).toHaveLength(1);
    expect(outbox[0]).toMatchObject({ organizationId: f.orgId, type: "appointment.booked", payload: { appointmentId: holdId } });

    const audit = await ctx.prisma.auditLog.findMany({ orderBy: { at: "asc" } });
    expect(audit.map((a) => a.action)).toEqual(["pet.create", "appointment.create"]);
    expect(audit[1]).toMatchObject({
      organizationId: f.orgId,
      actorType: "CUSTOMER",
      actorId: f.customerId,
      entity: "appointment",
      entityId: holdId,
      after: { source: "ONLINE", status: "BOOKED", petVisitIds: [row.petVisits[0]!.id] },
    });
    expect(audit[0]).toMatchObject({ actorType: "CUSTOMER", actorId: f.customerId, entity: "pet", entityId: rex.id });
  });

  it("usePets maps new-1 to the matching existing pet → no new pet; visit uses it", async () => {
    const token = await ownerToken();
    const { holdId } = await anonymousHold({ name: " max " });
    const before = await ctx.prisma.pet.count();
    const res = await confirm({ holdId, usePets: { "new-1": f.petId } }, token);
    expect(res.status).toBe(201);
    expect(await ctx.prisma.pet.count()).toBe(before);
    const row = await appt(holdId);
    expect(row.petVisits[0]).toMatchObject({ petId: f.petId, pendingPet: null });
    expect(res.body.pets[0]).toMatchObject({ petId: f.petId, petName: "Max" });
    expect((await ctx.prisma.auditLog.findMany()).map((a) => a.action)).toEqual(["appointment.create"]);
  });

  it("usePets pointing to a pet with a different name → 400 path usePets.new-1", async () => {
    const token = await ownerToken();
    const bella = await ctx.prisma.pet.create({
      data: { organizationId: f.orgId, customerId: f.customerId, name: "Bella", species: "DOG", breed: "Lab" },
    });
    const { holdId } = await anonymousHold({ name: "Max" });
    const res = await confirm({ holdId, usePets: { "new-1": bella.id } }, token);
    expect(res.status).toBe(400);
    expect(res.body.code).toBe("VALIDATION_FAILED");
    expect(res.body.errors.map((e: { path: string }) => e.path)).toEqual(["usePets.new-1"]);
    expect((await appt(holdId)).status).toBe("HELD");
  });

  it("usePets with a ref that is not a new pet of the hold → 400 path usePets.new-2", async () => {
    const token = await ownerToken();
    const { holdId } = await anonymousHold({ name: "Max" });
    const res = await confirm({ holdId, usePets: { "new-2": f.petId } }, token);
    expect(res.status).toBe(400);
    expect(res.body.errors.map((e: { path: string }) => e.path)).toEqual(["usePets.new-2"]);
  });

  it("hold owned by another customer → 404; already BOOKED → 404", async () => {
    const token = await ownerToken();
    const holdId = await savedHold(token);
    const other = await ctx.prisma.customer.create({
      data: { organizationId: f.orgId, phoneE164: "+13055550199", name: "Bo", locale: "en", createdVia: "ONLINE" },
    });
    const otherToken = await customerToken(ctx.app, { sub: other.id, org: f.orgId });
    const theirs = await confirm({ holdId }, otherToken);
    expect(theirs.status).toBe(404);
    expect(theirs.body.code).toBe("NOT_FOUND");
    expect((await appt(holdId)).status).toBe("HELD");

    expect((await confirm({ holdId }, token)).status).toBe(201);
    const again = await confirm({ holdId }, token);
    expect(again.status).toBe(404);
    expect(again.body.code).toBe("NOT_FOUND");
    expect(await ctx.prisma.outboxEvent.count()).toBe(1);
  });

  it("another organization's hold → 404; unknown id → 404", async () => {
    const token = await ownerToken();
    const f2 = await seedFixture(ctx.prisma, { slug: "other-salon" });
    const theirs = await ctx.prisma.appointment.create({
      data: {
        organizationId: f2.orgId, locationId: f2.locationId, status: "HELD", source: "ONLINE", bookingMode: "WAIT",
        holdExpiresAt: new Date(Date.now() + 5 * MIN),
      },
    });
    expect((await confirm({ holdId: theirs.id }, token)).status).toBe(404);
    expect((await ctx.prisma.appointment.findUniqueOrThrow({ where: { id: theirs.id } })).status).toBe("HELD");
    expect((await confirm({ holdId: "0194b2a0-0000-7000-8000-000000000000" }, token)).status).toBe(404);
  });

  it("expired hold → 409 HOLD_EXPIRED; appointment CANCELLED reason HOLD_EXPIRED; holding the same slot again → 201", async () => {
    const token = await ownerToken();
    const { holdId, body } = await anonymousHold();
    await ctx.prisma.appointment.update({ where: { id: holdId }, data: { holdExpiresAt: new Date(Date.now() - MIN) } });
    const res = await confirm({ holdId }, token);
    expect(res.status).toBe(409);
    expect(res.body.code).toBe("HOLD_EXPIRED");
    const row = await appt(holdId);
    expect(row).toMatchObject({ status: "CANCELLED", cancelReason: "HOLD_EXPIRED", cancelledBy: "SYSTEM" });
    expect(row.segments.every((s) => !s.occupies)).toBe(true);
    expect(await ctx.prisma.pet.count({ where: { name: "Rex" } })).toBe(0);
    expect(await ctx.prisma.outboxEvent.count()).toBe(0);

    expect((await holdReq(body)).status).toBe(201);
  });

  it("hold that expires between the expiry check and the booking transaction → 409 HOLD_EXPIRED (not 404); appointment still HELD", async () => {
    const token = await ownerToken();
    const holdId = await savedHold(token);
    // The first (unlocked) read sees a live hold; the hold expires right after it, before the booking transaction.
    const holds = ctx.app.get(HoldsService);
    const loadUsable = holds.loadUsable.bind(holds);
    vi.spyOn(holds, "loadUsable").mockImplementation(async (tx, id, principal, opts) => {
      const row = await loadUsable(tx, id, principal, opts);
      if (!opts?.lock) await ctx.prisma.appointment.update({ where: { id: holdId }, data: { holdExpiresAt: new Date(Date.now() - MIN) } });
      return row;
    });
    const res = await confirm({ holdId }, token);
    expect(res.status).toBe(409);
    expect(res.body.code).toBe("HOLD_EXPIRED");
    // The booking transaction rolled back; the sweeper or the next write releases the hold.
    expect((await appt(holdId)).status).toBe("HELD");
  });

  it("saved pet soft-deleted after the hold → 409 PET_UNAVAILABLE; appointment still HELD", async () => {
    const token = await ownerToken();
    const holdId = await savedHold(token);
    await ctx.prisma.pet.update({ where: { id: f.petId }, data: { deletedAt: new Date() } });
    const res = await confirm({ holdId }, token);
    expect(res.status).toBe(409);
    expect(res.body.code).toBe("PET_UNAVAILABLE");
    const row = await appt(holdId);
    expect(row.status).toBe("HELD");
    expect(row.segments.every((s) => s.occupies)).toBe(true);
    expect(await ctx.prisma.outboxEvent.count()).toBe(0);
    expect(await ctx.prisma.auditLog.count({ where: { action: "appointment.create" } })).toBe(0);
  });

  it("saved pet whose row has deletedAt set but the visit still points to it (as a merge source would) → 409 PET_UNAVAILABLE", async () => {
    const token = await ownerToken();
    const holdId = await savedHold(token);
    const target = await ctx.prisma.pet.create({
      data: { organizationId: f.orgId, customerId: f.customerId, name: "Max", species: "DOG", breed: "Poodle" },
    });
    // The merge source's state without the visit move: soft-deleted.
    await ctx.prisma.pet.update({ where: { id: f.petId }, data: { deletedAt: new Date() } });
    const res = await confirm({ holdId }, token);
    expect(res.status).toBe(409);
    expect(res.body.code).toBe("PET_UNAVAILABLE");
    expect((await appt(holdId)).petVisits[0]?.petId).toBe(f.petId);
    expect(target.deletedAt).toBeNull();
  });

  it("a real merge moves the hold's visit to the target pet, so confirm books the target (201)", async () => {
    const token = await ownerToken();
    const holdId = await savedHold(token);
    const target = await ctx.prisma.pet.create({
      data: { organizationId: f.orgId, customerId: f.customerId, name: "Max", species: "DOG", breed: "Poodle" },
    });
    const staff = await staffToken(ctx.app, { sub: f.staffA, org: f.orgId, role: "OWNER" });
    const merged = await auth(request(server()).post(`/v1/staff/pets/${f.petId}/merge`).send({ intoPetId: target.id }), staff);
    expect(merged.status).toBe(200);
    const res = await confirm({ holdId }, token);
    expect(res.status).toBe(201);
    expect(res.body.pets[0].petId).toBe(target.id);
  });

  it("a saved pet of the hold that now belongs to another customer → 409 PET_UNAVAILABLE", async () => {
    const token = await ownerToken();
    const holdId = await savedHold(token);
    const other = await ctx.prisma.customer.create({
      data: { organizationId: f.orgId, phoneE164: "+13055550199", name: "Bo", locale: "en", createdVia: "ONLINE" },
    });
    await ctx.prisma.pet.update({ where: { id: f.petId }, data: { customerId: other.id } });
    const res = await confirm({ holdId }, token);
    expect(res.status).toBe(409);
    expect(res.body.code).toBe("PET_UNAVAILABLE");
  });

  it("soft-deleted customer token → 401", async () => {
    const token = await ownerToken();
    const { holdId } = await anonymousHold();
    await ctx.prisma.customer.update({ where: { id: f.customerId }, data: { deletedAt: new Date() } });
    const res = await confirm({ holdId }, token);
    expect(res.status).toBe(401);
    expect(res.body.code).toBe("UNAUTHORIZED");
    expect((await appt(holdId)).status).toBe("HELD");
  });

  it("no token → 401; staff token → 403; unknown body field → 400", async () => {
    const { holdId } = await anonymousHold();
    expect((await confirm({ holdId })).status).toBe(401);
    const staff = await staffToken(ctx.app, { sub: f.staffA, org: f.orgId, role: "OWNER" });
    expect((await confirm({ holdId }, staff)).status).toBe(403);
    const bad = await confirm({ holdId, extra: 1 }, await ownerToken());
    expect(bad.status).toBe(400);
    expect(bad.body.code).toBe("VALIDATION_FAILED");
  });

  it('holdId "not-a-uuid" → 400 VALIDATION_FAILED', async () => {
    const res = await confirm({ holdId: "not-a-uuid" }, await ownerToken());
    expect(res.status).toBe(400);
    expect(res.body.code).toBe("VALIDATION_FAILED");
  });

  it("saved pet deleted and an invalid usePets choice → 409 PET_UNAVAILABLE first", async () => {
    const token = await ownerToken();
    const [slot] = await slots([savedPet(), { ...inlineQuery(), ref: "new-1" }], token);
    expect(slot).toBeDefined();
    const res = await holdReq({ pets: [savedPet(), newPet({ name: "Max" })], slot }, token);
    expect(res.status).toBe(201);
    await ctx.prisma.pet.update({ where: { id: f.petId }, data: { deletedAt: new Date() } });
    const out = await confirm({ holdId: res.body.holdId, usePets: { "new-1": f.petId } }, token);
    expect(out.status).toBe(409);
    expect(out.body.code).toBe("PET_UNAVAILABLE");
  });

  it("customer already at MAX_PETS_PER_CUSTOMER → 409 CONFLICT (the pet cap of POST /me/pets), appointment still HELD", async () => {
    const token = await ownerToken();
    await ctx.prisma.pet.createMany({
      data: Array.from({ length: MAX_PETS_PER_CUSTOMER - 1 }, (_, i) => ({
        organizationId: f.orgId, customerId: f.customerId, name: `Pet ${i}`, species: "DOG" as const, breed: "Mix",
      })),
    });
    const { holdId } = await anonymousHold();
    const res = await confirm({ holdId }, token);
    expect(res.status).toBe(409);
    expect(res.body.code).toBe("CONFLICT");
    const row = await appt(holdId);
    expect(row.status).toBe("HELD");
    expect(row.petVisits[0]?.petId).toBeNull();
    expect(await ctx.prisma.pet.count({ where: { name: "Rex" } })).toBe(0);
    expect(await ctx.prisma.auditLog.count()).toBe(0);
  });

  it("two concurrent confirms of the same hold → one 201, one 404", async () => {
    const token = await ownerToken();
    const { holdId } = await anonymousHold();
    // Barrier after the expiry check (the unlocked read of step 1): both requests then enter the main
    // transaction together. The main transaction takes the customer and hold locks first, so a barrier
    // inside it would block one request behind the other's locks.
    const holds = ctx.app.get(HoldsService);
    const original = holds.loadUsable.bind(holds);
    let arrived = 0;
    let open!: () => void;
    const gate = new Promise<void>((resolve) => (open = resolve));
    vi.spyOn(holds, "loadUsable").mockImplementation(async (tx, id, principal, opts) => {
      const row = await original(tx, id, principal, opts);
      if (!opts?.lock) {
        if (++arrived === 2) open();
        await Promise.race([gate, new Promise((r) => setTimeout(r, 2_000))]);
      }
      return row;
    });

    const [r1, r2] = await Promise.all([confirm({ holdId }, token), confirm({ holdId }, token)]);
    expect([r1.status, r2.status].sort()).toEqual([201, 404]);
    expect(arrived).toBe(2);
    expect(await ctx.prisma.pet.count({ where: { name: "Rex" } })).toBe(1);
    expect(await ctx.prisma.outboxEvent.count()).toBe(1);
    expect(await ctx.prisma.auditLog.count({ where: { action: "appointment.create" } })).toBe(1);
  });

  it("two concurrent confirms of one anonymous hold by two customers → one 201, one 404", async () => {
    const { holdId } = await anonymousHold();
    const other = await ctx.prisma.customer.create({
      data: { organizationId: f.orgId, phoneE164: "+13055550199", name: "Bo", locale: "en", createdVia: "ONLINE" },
    });
    const [t1, t2] = [await ownerToken(), await customerToken(ctx.app, { sub: other.id, org: f.orgId })];
    const [r1, r2] = await Promise.all([confirm({ holdId }, t1), confirm({ holdId }, t2)]);
    expect([r1.status, r2.status].sort()).toEqual([201, 404]);
    expect(await ctx.prisma.pet.count({ where: { name: "Rex" } })).toBe(1);
  });
});
