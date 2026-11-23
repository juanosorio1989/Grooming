import request from "supertest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { StaffAppointmentViewSchema, type StaffRole } from "@grooming/contracts";
import { wallTimeToUtc } from "@grooming/datetime";
import { AvailabilityContextLoader } from "../../../src/availability/context-loader.js";
import { createIntegrationApp, resetState } from "../app.js";
import { FROM, local, seedBookableTuesday, TZ, wall } from "../bookable-day.js";
import { createPetVisit, seedFixture, type Fixture } from "../helpers.js";
import { staffToken } from "../tokens.js";

const HOUR = 3_600_000;

type SlotView = { startsAt: string; readyAt: string; bookingMode: string; pets: { petId?: string; ref?: string }[] };

describe("/v1/staff/appointments and /v1/staff/walk-in", () => {
  let ctx: Awaited<ReturnType<typeof createIntegrationApp>>;
  let f: Fixture;

  beforeEach(async () => {
    ctx = await createIntegrationApp({ env: { TRUST_PROXY: "1" } });
    await resetState(ctx.prisma, ctx.redis);
    f = await seedFixture(ctx.prisma);
    await seedBookableTuesday(ctx.prisma, f);
    await ctx.prisma.service.update({ where: { id: f.serviceId }, data: { bookingMode: "WAIT" } });
  });

  afterEach(async () => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    await ctx?.close();
  });

  const server = () => ctx.app.getHttpServer();
  const auth = <T extends request.Test>(req: T, token: string) => req.set("Authorization", `Bearer ${token}`);
  const staff = (role: StaffRole = "RECEPTION", sub = f.staffB) => staffToken(ctx.app, { sub, org: f.orgId, role });
  const savedPet = () => ({ petId: f.petId, serviceIds: [f.serviceId] });
  const newPet = () => ({
    ref: "new-1",
    species: "DOG",
    sizeClass: "M",
    coatType: "CURLY",
    serviceIds: [f.serviceId],
    name: "Luna",
    breed: "Beagle",
    weightG: 12_000,
  });
  const inline = (p: ReturnType<typeof newPet>) => ({
    ref: p.ref,
    species: p.species,
    sizeClass: p.sizeClass,
    coatType: p.coatType,
    serviceIds: p.serviceIds,
  });

  async function slots(token: string, pets: unknown[], extra: Record<string, string> = {}): Promise<SlotView[]> {
    const res = await auth(
      request(server())
        .get("/v1/availability")
        .query({ from: FROM, pets: JSON.stringify(pets), customerId: f.customerId, ...extra }),
      token,
    );
    expect(res.status).toBe(200);
    return res.body.slots as SlotView[];
  }
  const slotAt = (all: SlotView[], hhmm: string) => {
    const s = all.find((x) => x.startsAt === local(hhmm));
    expect(s).toBeDefined();
    return s!;
  };

  const create = (body: object, token: string) => auth(request(server()).post("/v1/staff/appointments").send(body), token);
  const get = (id: string, token: string) => auth(request(server()).get(`/v1/staff/appointments/${id}`), token);
  const move = (id: string, body: object, token: string) => auth(request(server()).patch(`/v1/staff/appointments/${id}`).send(body), token);
  const status = (id: string, body: object, token: string) =>
    auth(request(server()).post(`/v1/staff/appointments/${id}/status`).send(body), token);
  const walkIn = (body: object, token: string) => auth(request(server()).post("/v1/staff/walk-in").send(body), token);
  const row = (id: string) =>
    ctx.prisma.appointment.findUniqueOrThrow({ where: { id }, include: { petVisits: true, segments: { orderBy: { startsAt: "asc" } } } });

  /** Books the fixture's saved pet at `hhmm` on FROM as RECEPTION; returns the appointment id. */
  async function bookSaved(token: string, hhmm: string): Promise<string> {
    const slot = slotAt(await slots(token, [savedPet()]), hhmm);
    const res = await create({ customerId: f.customerId, pets: [savedPet()], slot }, token);
    expect(res.status).toBe(201);
    return res.body.id as string;
  }

  /** A BOOKED appointment of the fixture's pet with one segment for `staffUserId` at the given instants (no other checks). */
  async function seedBooked(startsAt: Date, endsAt: Date, staffUserId = f.staffA): Promise<string> {
    const visit = await createPetVisit(ctx.prisma, f);
    await ctx.prisma.appointment.update({ where: { id: visit.appointmentId }, data: { bookingMode: "WAIT", source: "RECEPTION" } });
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
        staffUserId,
        resourceId: f.resource1,
        startsAt,
        endsAt,
        blockEndsAt: endsAt,
        durationMin: Math.round((endsAt.getTime() - startsAt.getTime()) / 60_000),
        priceCents: 4500,
        occupies: true,
      },
    });
    return visit.appointmentId;
  }

  it("RECEPTION books a saved pet + a new pet for a customer → 201 BOOKED source RECEPTION; the new pet exists; createdByStaffId set; outbox appointment.booked", async () => {
    const token = await staff();
    const pets = [savedPet(), newPet()];
    const slot = slotAt(await slots(token, [savedPet(), inline(newPet())]), "08:00");
    const res = await create({ customerId: f.customerId, pets, slot, notes: "Gate code 12" }, token);
    expect(res.status).toBe(201);
    expect(StaffAppointmentViewSchema.strict().parse(res.body)).toEqual(res.body);
    expect(res.body).toMatchObject({
      status: "BOOKED",
      source: "RECEPTION",
      customerId: f.customerId,
      createdByStaffId: f.staffB,
      cancelReason: null,
      notes: "Gate code 12",
      startsAt: local("08:00"),
    });
    const luna = await ctx.prisma.pet.findFirstOrThrow({ where: { customerId: f.customerId, name: "Luna" } });
    expect(luna).toMatchObject({ species: "DOG", breed: "Beagle", weightG: 12_000, sizeClass: "M", coatType: "CURLY", deletedAt: null });
    expect(res.body.pets.map((p: { petId: string }) => p.petId)).toEqual([f.petId, luna.id]);

    const r = await row(res.body.id);
    expect(r).toMatchObject({ status: "BOOKED", source: "RECEPTION", createdByStaffId: f.staffB, holdExpiresAt: null });
    expect(r.petVisits.every((v) => v.pendingPet === null && v.petId !== null)).toBe(true);
    expect(r.segments.every((s) => s.occupies)).toBe(true);

    const outbox = await ctx.prisma.outboxEvent.findMany({ where: { type: "appointment.booked" } });
    expect(outbox).toHaveLength(1);
    expect(outbox[0]).toMatchObject({ organizationId: f.orgId, payload: { appointmentId: res.body.id } });
    const audit = await ctx.prisma.auditLog.findFirstOrThrow({ where: { action: "appointment.create" } });
    expect(audit).toMatchObject({ actorType: "STAFF", actorId: f.staffB, entity: "appointment", entityId: res.body.id });
    expect(audit.after).toMatchObject({ source: "RECEPTION", status: "BOOKED", override: false, startsAt: local("08:00") });
    // No free text in the audit.
    expect(JSON.stringify(audit.after)).not.toContain("Gate code");

    // A new pet whose stated size disagrees with its weight → 400 on pets.<i>.sizeClass.
    const slot2 = slotAt(await slots(token, [inline(newPet())]), "10:00");
    const bad = await create({ customerId: f.customerId, pets: [{ ...newPet(), weightG: 40_000 }], slot: slot2 }, token);
    expect(bad.status).toBe(400);
    expect(bad.body.errors).toEqual([{ path: "pets.0.sizeClass", message: "Does not match the weight" }]);
  });

  it("override=true outside working hours → 201 and audit after.override true; the same slot without override → 409 SLOT_TAKEN (EMPLOYEE_UNAVAILABLE)", async () => {
    const token = await staff("OWNER");
    const slot = slotAt(await slots(token, [savedPet()], { override: "true" }), "07:00");
    const without = await create({ customerId: f.customerId, pets: [savedPet()], slot }, token);
    expect(without.status).toBe(409);
    expect(without.body.code).toBe("SLOT_TAKEN");
    expect(await ctx.prisma.appointment.count()).toBe(0);

    const res = await create({ customerId: f.customerId, pets: [savedPet()], slot, override: true }, token);
    expect(res.status).toBe(201);
    expect(res.body.startsAt).toBe(local("07:00"));
    const audit = await ctx.prisma.auditLog.findFirstOrThrow({ where: { action: "appointment.create" } });
    expect(audit.after).toMatchObject({ override: true, source: "RECEPTION" });
  });

  it("a race lost at write time (23P01) → 409 SLOT_TAKEN; nothing is written, the new pet is rolled back", async () => {
    const token = await staff();
    const slot = slotAt(await slots(token, [inline(newPet())]), "08:00");
    // Booked meanwhile with the only bather; a stale context (busy not seen) passes validatePlan.
    await seedBooked(new Date(local("08:00")), new Date(local("09:00")));
    const loader = ctx.app.get(AvailabilityContextLoader);
    const load = loader.load.bind(loader);
    vi.spyOn(loader, "load").mockImplementation(async (...args) => {
      const out = await load(...args);
      return { ...out, context: { ...out.context, busy: [] } };
    });
    const before = { appointments: await ctx.prisma.appointment.count(), audits: await ctx.prisma.auditLog.count() };
    const res = await create({ customerId: f.customerId, pets: [newPet()], slot }, token);
    expect(res.status).toBe(409);
    expect(res.body.code).toBe("SLOT_TAKEN");
    expect(await ctx.prisma.appointment.count()).toBe(before.appointments);
    expect(await ctx.prisma.auditLog.count()).toBe(before.audits);
    expect(await ctx.prisma.pet.count({ where: { name: "Luna" } })).toBe(0);
    expect(await ctx.prisma.outboxEvent.count({ where: { type: "appointment.booked" } })).toBe(0);
  });

  it("deleted customer → 404; EMPLOYEE → 403; unknown customer → 404", async () => {
    const token = await staff();
    const slot = slotAt(await slots(token, [savedPet()]), "08:00");
    const employee = await create({ customerId: f.customerId, pets: [savedPet()], slot }, await staff("EMPLOYEE", f.staffA));
    expect(employee.status).toBe(403);
    expect((await walkIn({ customerId: f.customerId, pets: [savedPet()] }, await staff("EMPLOYEE", f.staffA))).status).toBe(403);

    const unknown = await create({ customerId: "0194b2a0-0000-7000-8000-000000000000", pets: [savedPet()], slot }, token);
    expect(unknown.status).toBe(404);

    await ctx.prisma.customer.update({ where: { id: f.customerId }, data: { deletedAt: new Date() } });
    const deleted = await create({ customerId: f.customerId, pets: [savedPet()], slot }, token);
    expect(deleted.status).toBe(404);
    expect(deleted.body.code).toBe("NOT_FOUND");
    expect((await walkIn({ customerId: f.customerId, pets: [newPet()] }, token)).status).toBe(404);
    expect(await ctx.prisma.appointment.count()).toBe(0);
  });

  it("move to a free time → 200, audit appointment.move; move onto a busy time → 409, segments unchanged; a deleted customer's appointment → 404", async () => {
    const token = await staff();
    const id = await bookSaved(token, "08:00");
    const busy = await seedBooked(new Date(local("12:00")), new Date(local("13:00")));
    const free = await auth(request(server()).get("/v1/availability").query({ from: FROM, excludeAppointmentId: id }), token);
    expect(free.status).toBe(200);
    const target = slotAt(free.body.slots as SlotView[], "10:00");

    await ctx.prisma.outboxEvent.deleteMany();
    const moved = await move(id, { slot: target }, token);
    expect(moved.status).toBe(200);
    expect(StaffAppointmentViewSchema.strict().parse(moved.body)).toEqual(moved.body);
    expect(moved.body).toMatchObject({ id, status: "BOOKED", startsAt: local("10:00"), customerId: f.customerId });
    const audit = await ctx.prisma.auditLog.findFirstOrThrow({ where: { action: "appointment.move" } });
    expect(audit).toMatchObject({
      actorType: "STAFF",
      actorId: f.staffB,
      entityId: id,
      before: { startsAt: local("08:00") },
      after: { startsAt: local("10:00"), override: false },
    });
    expect(await ctx.prisma.outboxEvent.count({ where: { type: "appointment.changed" } })).toBe(1);

    // 12:00 is taken by `busy`: a slot built for 12:00 (from before it was booked) is refused.
    const original = (await row(id)).segments;
    const stale = { ...target, startsAt: local("12:00"), readyAt: local("13:00") };
    stale.pets = target.pets.map((p) => ({
      ...p,
      segments: (p as { segments: { startsAt: string; endsAt: string; blockEndsAt: string }[] }).segments.map((s) => ({
        ...s,
        startsAt: local("12:00"),
        endsAt: local("13:00"),
        blockEndsAt: local("13:00"),
      })),
    }));
    const taken = await move(id, { slot: stale }, token);
    expect(taken.status).toBe(409);
    expect(taken.body.code).toBe("SLOT_TAKEN");
    expect((await row(id)).segments).toEqual(original);
    expect((await row(busy)).status).toBe("BOOKED");

    const employee = await move(id, { slot: target }, await staff("EMPLOYEE", f.staffA));
    expect(employee.status).toBe(403);
    expect((await move(id, { slot: target, extra: 1 }, token)).status).toBe(400);

    await ctx.prisma.customer.update({ where: { id: f.customerId }, data: { deletedAt: new Date() } });
    const gone = await move(id, { slot: target }, token);
    expect(gone.status).toBe(404);
    expect(gone.body.code).toBe("NOT_FOUND");
  });

  it("status CANCEL → CANCELLED with cancelReason; NO_SHOW before start → 409; NO_SHOW after start (seed past segments directly) → NO_SHOW, occupies false", async () => {
    const token = await staff();
    const id = await bookSaved(token, "08:00");

    const early = await status(id, { action: "NO_SHOW" }, token);
    expect(early.status).toBe(409);
    expect(early.body.code).toBe("CONFLICT");
    expect((await row(id)).status).toBe("BOOKED");

    await ctx.prisma.outboxEvent.deleteMany();
    const cancelled = await status(id, { action: "CANCEL", reason: "Owner called, dog is sick" }, token);
    expect(cancelled.status).toBe(200);
    expect(StaffAppointmentViewSchema.strict().parse(cancelled.body)).toEqual(cancelled.body);
    expect(cancelled.body).toMatchObject({ id, status: "CANCELLED", cancelReason: "Owner called, dog is sick" });
    const r = await row(id);
    expect(r).toMatchObject({ status: "CANCELLED", cancelledBy: "STAFF", cancelReason: "Owner called, dog is sick" });
    expect(r.segments.every((s) => !s.occupies)).toBe(true);
    expect(r.petVisits.every((v) => v.status === "CANCELLED")).toBe(true);
    expect(await ctx.prisma.outboxEvent.count({ where: { type: "appointment.cancelled" } })).toBe(1);
    const cancelAudit = await ctx.prisma.auditLog.findFirstOrThrow({ where: { action: "appointment.cancel" } });
    expect(cancelAudit.after).toEqual({ status: "CANCELLED", cancelledBy: "STAFF" });

    // Cancelled → any further status change is 409.
    expect((await status(id, { action: "CANCEL" }, token)).body.code).toBe("CONFLICT");
    expect((await status(id, { action: "NO_SHOW" }, token)).status).toBe(409);

    // A booking that started an hour ago.
    const past = await seedBooked(new Date(Date.now() - HOUR), new Date(Date.now()));
    await ctx.prisma.outboxEvent.deleteMany();
    const noShow = await status(past, { action: "NO_SHOW" }, token);
    expect(noShow.status).toBe(200);
    expect(noShow.body).toMatchObject({ id: past, status: "NO_SHOW" });
    expect(noShow.body.pets[0].status).toBe("NO_SHOW");
    const p = await row(past);
    expect(p.status).toBe("NO_SHOW");
    expect(p.segments.every((s) => !s.occupies)).toBe(true);
    expect(p.petVisits.every((v) => v.status === "NO_SHOW")).toBe(true);
    expect(await ctx.prisma.outboxEvent.count()).toBe(0);
    const audit = await ctx.prisma.auditLog.findFirstOrThrow({ where: { action: "appointment.no_show" } });
    expect(audit).toMatchObject({ actorType: "STAFF", actorId: f.staffB, entityId: past, before: { status: "BOOKED" } });
    expect(audit.after).toMatchObject({ status: "NO_SHOW" });
    expect((await status(past, { action: "NO_SHOW" }, token)).status).toBe(409);

    expect((await status(id, { action: "COMPLETE" }, token)).status).toBe(400);
    expect((await status(id, { action: "CANCEL" }, await staff("EMPLOYEE", f.staffA))).status).toBe(403);
    expect((await status("0194b2a0-0000-7000-8000-000000000000", { action: "CANCEL" }, token)).status).toBe(404);
  });

  it("walk-in with a free groomer now → 201 WALK_IN starting within one slot interval; with every groomer busy for the next hour → 409 detail NO_SLOT_NOW", async () => {
    // "Now" is 10:07 on FROM (New York): FROM is today.
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(wallTimeToUtc(FROM, "10:07", TZ));
    const token = await staff();

    const res = await walkIn({ customerId: f.customerId, pets: [savedPet(), newPet()] }, token);
    expect(res.status).toBe(201);
    expect(StaffAppointmentViewSchema.strict().parse(res.body)).toEqual(res.body);
    expect(res.body).toMatchObject({ status: "BOOKED", source: "WALK_IN", createdByStaffId: f.staffB });
    expect(wall(res.body.startsAt)).toBe("10:00");
    expect(new Date(res.body.startsAt).getTime()).toBeLessThanOrEqual(Date.now() + 15 * 60_000);
    expect(await ctx.prisma.pet.count({ where: { customerId: f.customerId, name: "Luna" } })).toBe(1);
    expect(await ctx.prisma.outboxEvent.count({ where: { type: "appointment.booked" } })).toBe(1);
    const audit = await ctx.prisma.auditLog.findFirstOrThrow({ where: { action: "appointment.create" } });
    expect(audit.after).toMatchObject({ source: "WALK_IN", override: false });

    // The only bather is now busy until 12:00 (the walk-in above): nothing within one interval of now.
    const none = await walkIn({ customerId: f.customerId, pets: [savedPet()] }, token);
    expect(none.status).toBe(409);
    expect(none.body).toMatchObject({ code: "SLOT_TAKEN", detail: "NO_SLOT_NOW" });
    expect(await ctx.prisma.appointment.count()).toBe(1);
  });

  it("GET as EMPLOYEE with a segment → 200; without → 404; RECEPTION → 200; unknown → 404", async () => {
    const token = await staff();
    const id = await bookSaved(token, "08:00");
    const mine = await get(id, await staff("EMPLOYEE", f.staffA));
    expect(mine.status).toBe(200);
    expect(StaffAppointmentViewSchema.strict().parse(mine.body)).toEqual(mine.body);
    expect(mine.body.id).toBe(id);
    const theirs = await get(id, await staff("EMPLOYEE", f.staffB));
    expect(theirs.status).toBe(404);
    expect(theirs.body.code).toBe("NOT_FOUND");
    expect((await get(id, token)).status).toBe(200);
    expect((await get("0194b2a0-0000-7000-8000-000000000000", token)).status).toBe(404);
  });
});
