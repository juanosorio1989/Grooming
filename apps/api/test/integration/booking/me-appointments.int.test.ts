import request from "supertest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AppointmentViewSchema } from "@grooming/contracts";
import { AvailabilityContextLoader } from "../../../src/availability/context-loader.js";
import { AppointmentsService } from "../../../src/booking/appointments.service.js";
import { createIntegrationApp, resetState } from "../app.js";
import { FROM, local, seedBookableTuesday } from "../bookable-day.js";
import { seedFixture, type Fixture } from "../helpers.js";
import { customerToken } from "../tokens.js";

const HOUR = 3_600_000;

type SlotView = { startsAt: string; readyAt: string; bookingMode: string; pets: { petId?: string; ref?: string }[] };

describe("/v1/me/appointments (owner list, detail, cancel, reschedule)", () => {
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
  const savedPet = () => ({ petId: f.petId, serviceIds: [f.serviceId] });
  const setWait = () => ctx.prisma.service.update({ where: { id: f.serviceId }, data: { bookingMode: "WAIT" } });

  async function otherCustomer() {
    const other = await ctx.prisma.customer.create({
      data: { organizationId: f.orgId, phoneE164: "+13055550199", name: "Bo", locale: "en", createdVia: "ONLINE" },
    });
    const pet = await ctx.prisma.pet.create({
      data: { organizationId: f.orgId, customerId: other.id, name: "Bo dog", species: "DOG", breed: "Lab", sizeClass: "M", coatType: "CURLY" },
    });
    return { id: other.id, petId: pet.id, token: await customerToken(ctx.app, { sub: other.id, org: f.orgId }) };
  }

  const availability = (q: Record<string, string>, token?: string) =>
    auth(request(server()).get("/v1/availability").set("X-Forwarded-For", "203.0.113.30").query({ from: FROM, ...q }), token);
  async function slots(token: string, pets: unknown[] = [savedPet()]): Promise<SlotView[]> {
    const res = await availability({ pets: JSON.stringify(pets) }, token);
    expect(res.status).toBe(200);
    return res.body.slots as SlotView[];
  }
  const hold = (body: unknown, token: string) =>
    auth(request(server()).post("/v1/holds").set("X-Forwarded-For", "203.0.113.20").send(body as object), token);

  /** Holds and confirms `pets` (default: the fixture's saved pet) on the slot starting at `startsAt` (default: the first). */
  async function book(token: string, startsAt?: string, pets: { petId: string; serviceIds: string[] }[] = [savedPet()]): Promise<string> {
    const all = await slots(token, pets);
    const slot = startsAt === undefined ? all[0] : all.find((s) => s.startsAt === startsAt);
    expect(slot).toBeDefined();
    const h = await hold({ pets, slot }, token);
    expect(h.status).toBe(201);
    const c = await auth(request(server()).post("/v1/appointments").send({ holdId: h.body.holdId }), token);
    expect(c.status).toBe(201);
    return c.body.id as string;
  }

  const list = (token: string | undefined, scope?: string) =>
    auth(request(server()).get("/v1/me/appointments").query(scope ? { scope } : {}), token);
  const detail = (id: string, token?: string) => auth(request(server()).get(`/v1/me/appointments/${id}`), token);
  const cancel = (id: string, token?: string) => auth(request(server()).post(`/v1/me/appointments/${id}/cancel`), token);
  const reschedule = (id: string, slot: unknown, token?: string) =>
    auth(request(server()).post(`/v1/me/appointments/${id}/reschedule`).send({ slot } as object), token);
  const row = (id: string) =>
    ctx.prisma.appointment.findUniqueOrThrow({ where: { id }, include: { petVisits: true, segments: { orderBy: { startsAt: "asc" } } } });

  it("list upcoming shows a BOOKED appointment with pets, services and segments; past shows a CANCELLED one; HELD never listed", async () => {
    await setWait();
    const token = await ownerToken();
    const later = await book(token, local("10:00"));
    const first = await book(token, local("08:00"));
    const gone = await book(token, local("12:00"));
    expect((await cancel(gone, token)).status).toBe(200);
    // A BOOKED appointment that started 13 h ago is past.
    const old = await book(token, local("14:00"));
    await ctx.prisma.appointment.update({ where: { id: old }, data: { bookingMode: "DROP_OFF", dropOffAt: new Date(Date.now() - 13 * HOUR) } });
    // A live hold and a released hold of the same customer.
    const all = await slots(token);
    const live = await hold({ pets: [savedPet()], slot: all.find((s) => s.startsAt === local("15:00")) }, token);
    expect(live.status).toBe(201);
    const released = await hold({ pets: [savedPet()], slot: all.find((s) => s.startsAt === local("16:00")) }, token);
    expect(released.status).toBe(201);
    expect((await auth(request(server()).delete(`/v1/holds/${released.body.holdId}`), token)).status).toBe(204);
    // Another customer's booking is not listed.
    const other = await otherCustomer();
    await book(other.token, local("09:00"), [{ petId: other.petId, serviceIds: [f.serviceId] }]);

    const upcoming = await list(token);
    expect(upcoming.status).toBe(200);
    expect(upcoming.body.map((a: { id: string }) => a.id)).toEqual([first, later]);
    for (const a of upcoming.body) expect(AppointmentViewSchema.strict().parse(a)).toEqual(a);
    expect(upcoming.body[0]).toMatchObject({ status: "BOOKED", startsAt: local("08:00"), bookingMode: "WAIT" });
    expect(upcoming.body[0].pets[0]).toMatchObject({ petId: f.petId, petName: "Max", status: "BOOKED" });
    expect(upcoming.body[0].pets[0].services).toEqual([{ serviceId: f.serviceId, priceCents: 4500, durationMin: 60 }]);
    expect(upcoming.body[0].pets[0].segments[0]).toMatchObject({ stage: "BATH", employeeId: f.staffA, startsAt: local("08:00"), endsAt: local("09:00") });

    const past = await list(token, "past");
    expect(past.status).toBe(200);
    // Descending by start: the cancelled one (next Tuesday) before the one that started 13 h ago.
    expect(past.body.map((a: { id: string }) => a.id)).toEqual([gone, old]);
    expect(past.body[0]).toMatchObject({ status: "CANCELLED" });
    expect(past.body[0].cancelledAt).not.toBeNull();

    expect((await detail(first, token)).body).toEqual(upcoming.body[0]);
    expect((await detail(live.body.holdId, token)).status).toBe(404);
    expect((await detail(released.body.holdId, token)).status).toBe(404);
    expect((await list(token, "soon")).status).toBe(400);
    expect((await list(undefined)).status).toBe(401);
  });

  it("detail of another customer's or an unknown appointment → 404; deleted customer → 401 on every route", async () => {
    const token = await ownerToken();
    const id = await book(token);
    const other = await otherCustomer();
    expect((await detail(id, other.token)).status).toBe(404);
    expect((await detail("0194b2a0-0000-7000-8000-000000000000", token)).status).toBe(404);
    expect((await detail("not-a-uuid", token)).status).toBe(400);
    const target = (await slots(token))[1]!;

    await ctx.prisma.customer.update({ where: { id: f.customerId }, data: { deletedAt: new Date() } });
    for (const res of [await list(token), await detail(id, token), await cancel(id, token), await reschedule(id, target, token)]) {
      expect(res.status).toBe(401);
      expect(res.body.code).toBe("UNAUTHORIZED");
    }
    expect((await row(id)).status).toBe("BOOKED");
  });

  it("cancel 3 days ahead (window 24 h) → 200 CANCELLED; segments occupies false; visits CANCELLED; manageVersion +1; outbox appointment.cancelled", async () => {
    const token = await ownerToken();
    const id = await book(token);
    await ctx.prisma.outboxEvent.deleteMany();
    const res = await cancel(id, token);
    expect(res.status).toBe(200);
    expect(AppointmentViewSchema.strict().parse(res.body)).toEqual(res.body);
    expect(res.body).toMatchObject({ id, status: "CANCELLED" });
    expect(res.body.pets[0].status).toBe("CANCELLED");

    const r = await row(id);
    expect(r).toMatchObject({ status: "CANCELLED", cancelledBy: "CUSTOMER", cancelReason: null, manageVersion: 1 });
    expect(r.cancelledAt).not.toBeNull();
    expect(r.segments.length).toBeGreaterThan(0);
    expect(r.segments.every((s) => !s.occupies)).toBe(true);
    expect(r.petVisits.every((v) => v.status === "CANCELLED")).toBe(true);

    const outbox = await ctx.prisma.outboxEvent.findMany();
    expect(outbox).toHaveLength(1);
    expect(outbox[0]).toMatchObject({ organizationId: f.orgId, type: "appointment.cancelled", payload: { appointmentId: id } });
    const audit = await ctx.prisma.auditLog.findFirstOrThrow({ where: { action: "appointment.cancel" } });
    expect(audit).toMatchObject({ actorType: "CUSTOMER", actorId: f.customerId, entity: "appointment", entityId: id, before: { status: "BOOKED" } });
    // No free-text reason in the audit (staff reasons can hold anything); it lives in cancel_reason.
    expect(audit.after).toEqual({ status: "CANCELLED", cancelledBy: "CUSTOMER" });

    // The slot is free again.
    expect((await slots(token))[0]?.startsAt).toBe(res.body.startsAt);
  });

  it("cancel 2 h ahead → 409 OUTSIDE_CANCEL_WINDOW; cancel twice → 409 CONFLICT; another customer's → 404", async () => {
    const token = await ownerToken();
    const id = await book(token);
    const other = await otherCustomer();
    const theirs = await cancel(id, other.token);
    expect(theirs.status).toBe(404);
    expect(theirs.body.code).toBe("NOT_FOUND");

    expect((await cancel(id, token)).status).toBe(200);
    const twice = await cancel(id, token);
    expect(twice.status).toBe(409);
    expect(twice.body.code).toBe("CONFLICT");
    expect(await ctx.prisma.outboxEvent.count({ where: { type: "appointment.cancelled" } })).toBe(1);

    const soon = await book(token);
    // Drop-off mode: startsAt is the drop-off time.
    await ctx.prisma.appointment.update({ where: { id: soon }, data: { dropOffAt: new Date(Date.now() + 2 * HOUR) } });
    const late = await cancel(soon, token);
    expect(late.status).toBe(409);
    expect(late.body.code).toBe("OUTSIDE_CANCEL_WINDOW");
    expect((await row(soon)).status).toBe("BOOKED");
  });

  it("availability?excludeAppointmentId lists a slot overlapping the appointment's own time; reschedule to it → 200, new segment times, old segments gone, outbox appointment.changed, audit before/after startsAt", async () => {
    await setWait();
    const token = await ownerToken();
    const id = await book(token, local("08:00"));
    const oldIds = (await row(id)).segments.map((s) => s.id);
    // Without the exclusion the only bather is busy 08:00-09:00.
    expect((await slots(token)).some((s) => s.startsAt === local("08:15"))).toBe(false);

    const res = await availability({ excludeAppointmentId: id }, token);
    expect(res.status).toBe(200);
    const target = (res.body.slots as SlotView[]).find((s) => s.startsAt === local("08:15"));
    expect(target).toBeDefined();
    expect(target!.pets[0]).toMatchObject({ petId: f.petId });

    await ctx.prisma.outboxEvent.deleteMany();
    const moved = await reschedule(id, target, token);
    expect(moved.status).toBe(200);
    expect(AppointmentViewSchema.strict().parse(moved.body)).toEqual(moved.body);
    expect(moved.body).toMatchObject({ id, status: "BOOKED", startsAt: local("08:15"), estimatedReadyAt: local("09:15") });

    const r = await row(id);
    expect(r.manageVersion).toBe(1);
    expect(r.segments.map((s) => [s.startsAt.toISOString(), s.endsAt.toISOString()])).toEqual([[local("08:15"), local("09:15")]]);
    expect(r.segments.some((s) => oldIds.includes(s.id))).toBe(false);
    expect(r.segments.every((s) => s.occupies)).toBe(true);

    const outbox = await ctx.prisma.outboxEvent.findMany();
    expect(outbox).toHaveLength(1);
    expect(outbox[0]).toMatchObject({ type: "appointment.changed", payload: { appointmentId: id } });
    const audit = await ctx.prisma.auditLog.findFirstOrThrow({ where: { action: "appointment.reschedule" } });
    expect(audit).toMatchObject({
      actorType: "CUSTOMER",
      actorId: f.customerId,
      entityId: id,
      before: { startsAt: local("08:00"), readyAt: local("09:00") },
      after: { startsAt: local("08:15"), readyAt: local("09:15"), override: false },
    });
  });

  it("reschedule onto a time held meanwhile by another customer → 409 SLOT_TAKEN and the original segments still exist unchanged", async () => {
    await setWait();
    const token = await ownerToken();
    const id = await book(token, local("08:00"));
    const original = (await row(id)).segments;
    const res = await availability({ excludeAppointmentId: id }, token);
    const target = (res.body.slots as SlotView[]).find((s) => s.startsAt === local("10:00"))!;

    const other = await otherCustomer();
    const otherPets = [{ petId: other.petId, serviceIds: [f.serviceId] }];
    const theirSlot = (await slots(other.token, otherPets)).find((s) => s.startsAt === local("10:00"));
    expect((await hold({ pets: otherPets, slot: theirSlot }, other.token)).status).toBe(201);

    // Re-checked with validatePlan: the hold is busy.
    const checked = await reschedule(id, target, token);
    expect(checked.status).toBe(409);
    expect(checked.body.code).toBe("SLOT_TAKEN");
    expect((await row(id)).segments).toEqual(original);

    // A stale context (the hold not seen) passes validatePlan; the exclusion constraint (23P01) still rejects
    // the write and the transaction rolls back, so the deleted old segments come back.
    const loader = ctx.app.get(AvailabilityContextLoader);
    const load = loader.load.bind(loader);
    vi.spyOn(loader, "load").mockImplementation(async (...args) => {
      const out = await load(...args);
      return { ...out, context: { ...out.context, busy: [] } };
    });
    const raced = await reschedule(id, target, token);
    expect(raced.status).toBe(409);
    expect(raced.body.code).toBe("SLOT_TAKEN");
    const after = await row(id);
    expect(after.segments).toEqual(original);
    expect(after.manageVersion).toBe(0);
    expect(await ctx.prisma.outboxEvent.count({ where: { type: "appointment.changed" } })).toBe(0);
  });

  it("two pets, visit 0 cancelled, reschedule later → startsAt (view, detail, list) is the new slot start, not the cancelled visit's old time", async () => {
    await setWait();
    const token = await ownerToken();
    const rex = await ctx.prisma.pet.create({
      data: { organizationId: f.orgId, customerId: f.customerId, name: "Rex", species: "DOG", breed: "Lab", sizeClass: "M", coatType: "CURLY" },
    });
    const id = await book(token, local("08:00"), [savedPet(), { petId: rex.id, serviceIds: [f.serviceId] }]);
    const first = await ctx.prisma.petVisit.findFirstOrThrow({ where: { appointmentId: id, position: 0 } });
    await ctx.prisma.petVisit.update({ where: { id: first.id }, data: { status: "CANCELLED" } });
    await ctx.prisma.appointmentSegment.updateMany({ where: { petVisitId: first.id }, data: { occupies: false } });

    const res = await availability({ excludeAppointmentId: id }, token);
    expect(res.status).toBe(200);
    const target = (res.body.slots as SlotView[]).find((s) => s.startsAt === local("11:00"))!;
    expect(target.pets.map((p) => p.petId)).toEqual([rex.id]);
    const moved = await reschedule(id, target, token);
    expect(moved.status).toBe(200);
    expect(moved.body.startsAt).toBe(local("11:00"));
    expect((await detail(id, token)).body.startsAt).toBe(local("11:00"));
    expect((await list(token)).body.map((a: { startsAt: string }) => a.startsAt)).toEqual([local("11:00")]);
    // The cancelled visit keeps its old rows (not occupying).
    expect(await ctx.prisma.appointmentSegment.count({ where: { petVisitId: first.id, occupies: false } })).toBe(1);
  });

  it("replaceSlot (staff move path) on a CANCELLED appointment → 409 CONFLICT before any slot check; unknown → 404", async () => {
    const token = await ownerToken();
    const id = await book(token);
    const slot = (await slots(token))[1]!;
    expect((await cancel(id, token)).status).toBe(200);
    const svc = ctx.app.get(AppointmentsService);
    const opts = { mode: "STAFF", override: false, action: "appointment.move", actorType: "STAFF", actorId: f.staffA, ip: null } as const;
    await expect(svc.replaceSlot(id, slot as never, opts)).rejects.toMatchObject({ status: 409, response: { code: "CONFLICT" } });
    await expect(svc.replaceSlot("0194b2a0-0000-7000-8000-000000000000", slot as never, opts)).rejects.toMatchObject({ status: 404 });
  });

  it("reschedule: 2 h ahead → 409 OUTSIDE_CANCEL_WINDOW; cancelled → 409 CONFLICT; another customer's → 404; slot of other pets → 400", async () => {
    await setWait();
    const token = await ownerToken();
    const id = await book(token, local("08:00"));
    const target = ((await availability({ excludeAppointmentId: id }, token)).body.slots as SlotView[])[2]!;
    const other = await otherCustomer();
    expect((await reschedule(id, target, other.token)).status).toBe(404);

    const wrong = { ...target, pets: [{ ...target.pets[0], petId: other.petId }] };
    const bad = await reschedule(id, wrong, token);
    expect(bad.status).toBe(400);
    expect(bad.body.code).toBe("VALIDATION_FAILED");
    expect((await auth(request(server()).post(`/v1/me/appointments/${id}/reschedule`).send({ slot: target, extra: 1 }), token)).status).toBe(400);

    const original = await ctx.prisma.appointment.findUniqueOrThrow({ where: { id } });
    await ctx.prisma.appointment.update({ where: { id }, data: { bookingMode: "DROP_OFF", dropOffAt: new Date(Date.now() + 2 * HOUR) } });
    const late = await reschedule(id, target, token);
    expect(late.status).toBe(409);
    expect(late.body.code).toBe("OUTSIDE_CANCEL_WINDOW");
    await ctx.prisma.appointment.update({ where: { id }, data: { bookingMode: original.bookingMode, dropOffAt: original.dropOffAt } });

    expect((await cancel(id, token)).status).toBe(200);
    const gone = await reschedule(id, target, token);
    expect(gone.status).toBe(409);
    expect(gone.body.code).toBe("CONFLICT");
  });

  it("availability with excludeAppointmentId and pets → 400; anonymous → 401; another customer's appointment → 404; a cancelled one → 404; deleted customer → 401", async () => {
    const token = await ownerToken();
    const id = await book(token);
    const both = await availability({ excludeAppointmentId: id, pets: JSON.stringify([savedPet()]) }, token);
    expect(both.status).toBe(400);
    expect(both.body.code).toBe("VALIDATION_FAILED");

    const anonymous = await availability({ excludeAppointmentId: id });
    expect(anonymous.status).toBe(401);
    expect(anonymous.body.code).toBe("UNAUTHORIZED");

    const other = await otherCustomer();
    const theirs = await availability({ excludeAppointmentId: id }, other.token);
    expect(theirs.status).toBe(404);
    expect(theirs.body.code).toBe("NOT_FOUND");
    expect((await availability({ excludeAppointmentId: "0194b2a0-0000-7000-8000-000000000000" }, token)).status).toBe(404);

    expect((await cancel(id, token)).status).toBe(200);
    expect((await availability({ excludeAppointmentId: id }, token)).status).toBe(404);

    const live = await book(token);
    await ctx.prisma.customer.update({ where: { id: f.customerId }, data: { deletedAt: new Date() } });
    const deleted = await availability({ excludeAppointmentId: live }, token);
    expect(deleted.status).toBe(401);
    expect(deleted.body.code).toBe("UNAUTHORIZED");
  });
});
