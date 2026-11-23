import { UnauthorizedException } from "@nestjs/common";
import type { PetRequest, PlannedSegment, Slot } from "@grooming/availability";
import type { ServicePriceRow } from "@grooming/pricing";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { HoldReleaseService } from "../../../src/booking/hold-release.service.js";
import { PetRequestResolver } from "../../../src/booking/pet-requests.js";
import { PlanWriter, type PlanWrite } from "../../../src/booking/plan-writer.js";
import { assertActiveCustomer } from "../../../src/customers/active-customer.js";
import { createIntegrationApp, resetState } from "../app.js";
import { at, seedFixture, type Fixture } from "../helpers.js";

const MIN = 60_000;
const ms = (hhmm: string) => at(hhmm).getTime();

describe("booking core", () => {
  let ctx: Awaited<ReturnType<typeof createIntegrationApp>>;
  let f: Fixture;
  let writer: PlanWriter;
  let release: HoldReleaseService;
  let prices: ServicePriceRow[];
  let pet2: string;

  beforeEach(async () => {
    ctx = await createIntegrationApp();
    await resetState(ctx.prisma, ctx.redis);
    f = await seedFixture(ctx.prisma);
    writer = ctx.app.get(PlanWriter);
    release = ctx.app.get(HoldReleaseService);
    // The matrix: M any coat 4500 / 60 min, M CURLY 5200 / 75 min.
    await ctx.prisma.servicePrice.createMany({
      data: [
        { organizationId: f.orgId, serviceId: f.serviceId, sizeClass: "M", coatType: null, durationMin: 60, priceCents: 4500 },
        { organizationId: f.orgId, serviceId: f.serviceId, sizeClass: "M", coatType: "CURLY", durationMin: 75, priceCents: 5200 },
      ],
    });
    prices = [
      { serviceId: f.serviceId, sizeClass: "M", coatType: null, durationMin: 60, priceCents: 4500 },
      { serviceId: f.serviceId, sizeClass: "M", coatType: "CURLY", durationMin: 75, priceCents: 5200 },
    ];
    const p = await ctx.prisma.pet.create({
      data: { organizationId: f.orgId, customerId: f.customerId, name: "Rex", species: "DOG", breed: "Lab", sizeClass: "M", coatType: "SMOOTH" },
    });
    pet2 = p.id;
  });
  afterEach(async () => {
    await ctx?.close();
  });

  const request = (petId: string, coatType: PetRequest["coatType"], preferredGroomerId = "ANY"): PetRequest => ({
    petId, species: "DOG", sizeClass: "M", coatType, serviceIds: [f.serviceId], preferredGroomerId,
  });

  /** One bath on staffA / resource1, plus a kennel segment from `dropOff` to `pickup` in drop-off mode. */
  function petPlan(petId: string, bath: [string, string], kennel: { id: string; from: string; to: string } | null, price = 4500) {
    const segments: PlannedSegment[] = [
      {
        petId, stage: "BATH", serviceIds: [f.serviceId], employeeId: f.staffA, resourceId: f.resource1,
        start: ms(bath[0]), end: ms(bath[1]), blockEnd: ms(bath[1]), durationMin: (ms(bath[1]) - ms(bath[0])) / MIN, priceCents: price,
      },
    ];
    if (kennel) {
      segments.push({
        petId, stage: "KENNEL", serviceIds: [], employeeId: null, resourceId: kennel.id,
        start: ms(kennel.from), end: ms(kennel.to), blockEnd: ms(kennel.to), durationMin: (ms(kennel.to) - ms(kennel.from)) / MIN, priceCents: 0,
      });
    }
    return { petId, priceCents: price, segments };
  }

  /** Two pets dropped off at 13:00; baths 13:15-14:30 (Max, curly) and 14:30-15:30 (Rex); kennels until 17:00. */
  function twoPetSlot(): Slot {
    return {
      start: ms("13:00"),
      readyAt: ms("15:30"),
      bookingMode: "DROP_OFF",
      pets: [
        petPlan(f.petId, ["13:15", "14:30"], { id: f.kennel1, from: "13:00", to: "17:00" }, 5200),
        petPlan(pet2, ["14:30", "15:30"], { id: f.kennel2, from: "13:00", to: "17:00" }),
      ],
    };
  }

  async function createAppointment(
    over: { status?: "HELD" | "BOOKED"; holdExpiresAt?: Date | null; orgId?: string; locationId?: string; customerId?: string | null } = {},
  ) {
    return ctx.prisma.appointment.create({
      data: {
        organizationId: over.orgId ?? f.orgId,
        locationId: over.locationId ?? f.locationId,
        customerId: over.customerId === undefined ? f.customerId : over.customerId,
        status: over.status ?? "BOOKED",
        source: "ONLINE",
        bookingMode: "DROP_OFF",
        dropOffAt: at("13:00"),
        estimatedReadyAt: at("15:30"),
        holdExpiresAt: over.holdExpiresAt ?? null,
      },
    });
  }

  const write = (over: Partial<PlanWrite> = {}): PlanWrite => ({
    orgId: f.orgId,
    locationId: f.locationId,
    slot: twoPetSlot(),
    pets: [request(f.petId, "CURLY", f.staffA), request(pet2, "SMOOTH")],
    petIds: [f.petId, pet2],
    pendingPets: [null, null],
    prices,
    ...over,
  });

  describe("PlanWriter", () => {
    it("insert for a two-pet drop-off plan writes 2 visits with positions, kennels, KENNEL segments without staff and matrix prices", async () => {
      const appt = await createAppointment();
      await ctx.prisma.$transaction((tx) => writer.insert(tx, appt.id, write()));

      const visits = await ctx.prisma.petVisit.findMany({
        where: { appointmentId: appt.id },
        orderBy: { position: "asc" },
        include: { services: true, segments: { orderBy: { startsAt: "asc" } } },
      });
      expect(visits.map((v) => [v.position, v.petId, v.kennelResourceId])).toEqual([
        [0, f.petId, f.kennel1],
        [1, pet2, f.kennel2],
      ]);
      expect(visits[0]).toMatchObject({
        status: "BOOKED", sizeClassAtBooking: "M", coatTypeAtBooking: "CURLY", preferredGroomerId: f.staffA, priceCentsQuoted: 5200, pendingPet: null,
      });
      expect(visits[1]).toMatchObject({ coatTypeAtBooking: "SMOOTH", preferredGroomerId: null, priceCentsQuoted: 4500 });
      // pet_visit_service comes from the matrix: curly row for Max, any-coat row for Rex.
      expect(visits[0]?.services.map((s) => [s.serviceId, s.priceCents, s.durationMin])).toEqual([[f.serviceId, 5200, 75]]);
      expect(visits[1]?.services.map((s) => [s.serviceId, s.priceCents, s.durationMin])).toEqual([[f.serviceId, 4500, 60]]);

      for (const v of visits) {
        const kennels = v.segments.filter((s) => s.stage === "KENNEL");
        expect(kennels).toHaveLength(1);
        expect(kennels[0]).toMatchObject({ staffUserId: null, serviceId: null, resourceId: v.kennelResourceId, occupies: true });
        const bath = v.segments.find((s) => s.stage === "BATH");
        expect(bath).toMatchObject({ staffUserId: f.staffA, serviceId: f.serviceId, resourceId: f.resource1, organizationId: f.orgId });
      }
      expect(visits[0]?.segments.find((s) => s.stage === "BATH")).toMatchObject({
        startsAt: at("13:15"), endsAt: at("14:30"), blockEndsAt: at("14:30"), durationMin: 75, priceCents: 5200,
      });
    });

    it("insert with a pending pet stores pending_pet and pet_id null", async () => {
      const appt = await createAppointment({ status: "HELD", holdExpiresAt: new Date(Date.now() + 5 * MIN), customerId: null });
      const pending = { ref: "new-1", species: "DOG" as const, name: "Luna", breed: "Beagle", breedCode: null, weightG: 12_000 };
      const slot: Slot = { ...twoPetSlot(), pets: [petPlan("new-1", ["13:15", "14:15"], { id: f.kennel1, from: "13:00", to: "17:00" })], readyAt: ms("14:15") };
      await ctx.prisma.$transaction((tx) =>
        writer.insert(tx, appt.id, write({ slot, pets: [request("new-1", "SMOOTH")], petIds: [null], pendingPets: [pending] })),
      );
      const visit = await ctx.prisma.petVisit.findFirstOrThrow({ where: { appointmentId: appt.id } });
      expect(visit.petId).toBeNull();
      expect(visit.pendingPet).toEqual(pending);
      expect(visit.position).toBe(0);
    });

    it("insert of a plan overlapping another booking → 23P01, nothing written", async () => {
      const a = await createAppointment();
      await ctx.prisma.$transaction((tx) => writer.insert(tx, a.id, write()));
      const b = await createAppointment();
      await expect(ctx.prisma.$transaction((tx) => writer.insert(tx, b.id, write()))).rejects.toThrow(/23P01/);
      expect(await ctx.prisma.petVisit.count({ where: { appointmentId: b.id } })).toBe(0);
    });

    it("replace leaves no old segment and returns the old and new startsAt", async () => {
      const appt = await createAppointment();
      await ctx.prisma.$transaction((tx) => writer.insert(tx, appt.id, write()));
      const oldIds = (await ctx.prisma.appointmentSegment.findMany({ where: { appointmentId: appt.id } })).map((s) => s.id);

      // One hour later; overlaps the old times, so the old rows must be gone before the insert.
      const shift = (s: Slot): Slot => ({
        ...s,
        start: s.start + 60 * MIN,
        readyAt: s.readyAt + 60 * MIN,
        pets: s.pets.map((p) => ({
          ...p,
          segments: p.segments.map((g) => ({ ...g, start: g.start + 60 * MIN, end: g.end + 60 * MIN, blockEnd: g.blockEnd + 60 * MIN })),
        })),
      });
      const moved = shift(twoPetSlot());
      // The kennel swaps for the second pet; prices refresh from a changed matrix.
      moved.pets[1]!.segments[1]!.resourceId = f.kennel1;
      moved.pets[0]!.segments[1]!.resourceId = f.kennel2;
      const newPrices = prices.map((p) => (p.coatType === null ? { ...p, priceCents: 4800 } : p));
      moved.pets[1]!.priceCents = 4800;

      const result = await ctx.prisma.$transaction((tx) =>
        writer.replace(tx, appt.id, { orgId: f.orgId, locationId: f.locationId, slot: moved, pets: write().pets, prices: newPrices }),
      );
      expect(result).toEqual({
        before: { startsAt: at("13:00").toISOString(), readyAt: at("15:30").toISOString() },
        after: { startsAt: at("14:00").toISOString(), readyAt: at("16:30").toISOString() },
      });

      const segs = await ctx.prisma.appointmentSegment.findMany({ where: { appointmentId: appt.id } });
      expect(segs).toHaveLength(4);
      expect(segs.some((s) => oldIds.includes(s.id))).toBe(false);
      expect(segs.some((s) => s.startsAt.getTime() === at("13:00").getTime())).toBe(false);

      const visits = await ctx.prisma.petVisit.findMany({ where: { appointmentId: appt.id }, orderBy: { position: "asc" }, include: { services: true } });
      expect(visits.map((v) => v.kennelResourceId)).toEqual([f.kennel2, f.kennel1]);
      expect(visits[1]).toMatchObject({ priceCentsQuoted: 4800 });
      expect(visits[1]?.services[0]?.priceCents).toBe(4800);
      const appointment = await ctx.prisma.appointment.findUniqueOrThrow({ where: { id: appt.id } });
      expect(appointment.dropOffAt).toEqual(at("14:00"));
      expect(appointment.estimatedReadyAt).toEqual(at("16:30"));
    });

    it("replace matches the same visits as fromAppointment (CANCELLED skipped, position order) and keeps a cancelled visit's rows", async () => {
      const appt = await createAppointment();
      await ctx.prisma.$transaction((tx) => writer.insert(tx, appt.id, write()));
      const first = await ctx.prisma.petVisit.findFirstOrThrow({ where: { appointmentId: appt.id, position: 0 } });
      await ctx.prisma.petVisit.update({ where: { id: first.id }, data: { status: "CANCELLED" } });
      await ctx.prisma.appointmentSegment.updateMany({ where: { petVisitId: first.id }, data: { occupies: false } });
      const resolved = await ctx.app.get(PetRequestResolver).fromAppointment(appt.id);

      const slot: Slot = {
        start: ms("09:00"),
        readyAt: ms("10:00"),
        bookingMode: "DROP_OFF",
        pets: [petPlan(pet2, ["09:15", "10:00"], { id: f.kennel2, from: "09:00", to: "12:00" })],
      };
      await ctx.prisma.$transaction((tx) =>
        writer.replace(tx, appt.id, { orgId: f.orgId, locationId: f.locationId, slot, pets: resolved.pets, prices }),
      );

      const second = await ctx.prisma.petVisit.findFirstOrThrow({ where: { appointmentId: appt.id, position: 1 }, include: { segments: true } });
      expect(second.segments.map((s) => s.startsAt.toISOString()).sort()).toEqual([at("09:00").toISOString(), at("09:15").toISOString()]);
      expect(await ctx.prisma.appointmentSegment.count({ where: { petVisitId: first.id } })).toBe(2);
    });
  });

  describe("PetRequestResolver.fromAppointment", () => {
    it("rebuilds the pet requests in position order from the visits", async () => {
      const appt = await createAppointment();
      await ctx.prisma.$transaction((tx) => writer.insert(tx, appt.id, write()));
      const resolved = await ctx.app.get(PetRequestResolver).fromAppointment(appt.id);
      expect(resolved.customerId).toBe(f.customerId);
      expect(resolved.pets).toEqual([request(f.petId, "CURLY", f.staffA), request(pet2, "SMOOTH")]);
      expect([...resolved.labels.entries()]).toEqual([
        [f.petId, { petId: f.petId }],
        [pet2, { petId: pet2 }],
      ]);
    });

    it("skips CANCELLED visits", async () => {
      const appt = await createAppointment();
      await ctx.prisma.$transaction((tx) => writer.insert(tx, appt.id, write()));
      await ctx.prisma.petVisit.updateMany({ where: { appointmentId: appt.id, position: 0 }, data: { status: "CANCELLED" } });
      const resolved = await ctx.app.get(PetRequestResolver).fromAppointment(appt.id);
      expect(resolved.pets).toEqual([request(pet2, "SMOOTH")]);
      expect([...resolved.labels.keys()]).toEqual([pet2]);
    });

    it("unknown appointment → 404", async () => {
      await expect(ctx.app.get(PetRequestResolver).fromAppointment("0194b2a0-0000-7000-8000-000000000000")).rejects.toMatchObject({ status: 404 });
    });
  });

  describe("HoldReleaseService", () => {
    /** An appointment with one bath (and kennel) at the given hour, on its own resources so rows never overlap. */
    async function withPlan(appt: { id: string }, hour: string, fx: Fixture = f) {
      const end = `${String(Number(hour.slice(0, 2)) + 1).padStart(2, "0")}:00`;
      const slot: Slot = {
        start: ms(hour), readyAt: ms(end), bookingMode: "DROP_OFF",
        pets: [{
          petId: fx.petId, priceCents: 4500,
          segments: [
            { petId: fx.petId, stage: "BATH", serviceIds: [fx.serviceId], employeeId: fx.staffA, resourceId: fx.resource1, start: ms(hour), end: ms(end), blockEnd: ms(end), durationMin: 60, priceCents: 4500 },
            { petId: fx.petId, stage: "KENNEL", serviceIds: [], employeeId: null, resourceId: fx.kennel1, start: ms(hour), end: ms(end), blockEnd: ms(end), durationMin: 60, priceCents: 0 },
          ],
        }],
      };
      await ctx.prisma.$transaction((tx) =>
        writer.insert(tx, appt.id, {
          orgId: fx.orgId, locationId: fx.locationId, slot, pets: [{ ...request(fx.petId, "SMOOTH"), serviceIds: [fx.serviceId] }],
          petIds: [fx.petId], pendingPets: [null],
          prices: [{ serviceId: fx.serviceId, sizeClass: "M", coatType: null, durationMin: 60, priceCents: 4500 }],
        }),
      );
    }

    it("releaseExpired releases only expired HELD rows and frees their segments", async () => {
      const now = new Date();
      const expired = await createAppointment({ status: "HELD", holdExpiresAt: new Date(now.getTime() - MIN) });
      const fresh = await createAppointment({ status: "HELD", holdExpiresAt: new Date(now.getTime() + 5 * MIN) });
      const booked = await createAppointment({ status: "BOOKED" });
      await withPlan(expired, "09:00");
      await withPlan(fresh, "10:00");
      await withPlan(booked, "11:00");

      const count = await ctx.prisma.$transaction((tx) => release.releaseExpired(tx, now));
      expect(count).toBe(1);

      const rows = await ctx.prisma.appointment.findMany({ include: { segments: true, petVisits: true } });
      const byId = new Map(rows.map((r) => [r.id, r]));
      expect(byId.get(expired.id)).toMatchObject({ status: "CANCELLED", cancelledAt: now, cancelReason: "HOLD_EXPIRED", cancelledBy: "SYSTEM" });
      expect(byId.get(expired.id)?.segments.every((s) => !s.occupies)).toBe(true);
      expect(byId.get(expired.id)?.petVisits.every((v) => v.status === "CANCELLED")).toBe(true);
      for (const id of [fresh.id, booked.id]) {
        expect(byId.get(id)?.status).not.toBe("CANCELLED");
        expect(byId.get(id)?.segments.every((s) => s.occupies)).toBe(true);
        expect(byId.get(id)?.petVisits.every((v) => v.status === "BOOKED")).toBe(true);
      }
    });

    it("releaseExpired with orgId skips other organizations", async () => {
      const f2 = await seedFixture(ctx.prisma, { slug: "other-salon" });
      const past = new Date(Date.now() - MIN);
      const mine = await createAppointment({ status: "HELD", holdExpiresAt: past });
      const theirs = await createAppointment({ status: "HELD", holdExpiresAt: past, orgId: f2.orgId, locationId: f2.locationId, customerId: f2.customerId });
      await withPlan(mine, "09:00");
      await withPlan(theirs, "09:00", f2);

      expect(await ctx.prisma.$transaction((tx) => release.releaseExpired(tx, new Date(), f.orgId))).toBe(1);
      const other = await ctx.prisma.appointment.findUniqueOrThrow({ where: { id: theirs.id }, include: { segments: true } });
      expect(other.status).toBe("HELD");
      expect(other.segments.every((s) => s.occupies)).toBe(true);
      expect(await ctx.prisma.$transaction((tx) => release.releaseExpired(tx, new Date()))).toBe(1);
    });

    it("release frees one HELD appointment with the given reason and actor; false when it is not HELD", async () => {
      const hold = await createAppointment({ status: "HELD", holdExpiresAt: new Date(Date.now() + 5 * MIN) });
      const booked = await createAppointment({ status: "BOOKED" });
      await withPlan(hold, "09:00");
      await withPlan(booked, "10:00");

      expect(await ctx.prisma.$transaction((tx) => release.release(tx, hold.id, "HOLD_RELEASED", "CUSTOMER"))).toBe(true);
      expect(await ctx.prisma.$transaction((tx) => release.release(tx, booked.id, "HOLD_RELEASED", "CUSTOMER"))).toBe(false);
      expect(await ctx.prisma.$transaction((tx) => release.release(tx, hold.id, "HOLD_RELEASED", "CUSTOMER"))).toBe(false);

      const row = await ctx.prisma.appointment.findUniqueOrThrow({ where: { id: hold.id }, include: { segments: true, petVisits: true } });
      expect(row).toMatchObject({ status: "CANCELLED", cancelReason: "HOLD_RELEASED", cancelledBy: "CUSTOMER" });
      expect(row.cancelledAt).not.toBeNull();
      expect(row.segments.every((s) => !s.occupies)).toBe(true);
      expect(row.petVisits.every((v) => v.status === "CANCELLED")).toBe(true);
      const other = await ctx.prisma.appointment.findUniqueOrThrow({ where: { id: booked.id }, include: { segments: true } });
      expect(other.status).toBe("BOOKED");
      expect(other.segments.every((s) => s.occupies)).toBe(true);
    });
  });

  describe("assertActiveCustomer", () => {
    it("active → resolves (also with a lock in a transaction); soft-deleted, unknown or another org's → 401", async () => {
      await expect(assertActiveCustomer(ctx.prisma, f.orgId, f.customerId)).resolves.toBeUndefined();
      await expect(ctx.prisma.$transaction((tx) => assertActiveCustomer(tx, f.orgId, f.customerId, "share"))).resolves.toBeUndefined();
      await expect(ctx.prisma.$transaction((tx) => assertActiveCustomer(tx, f.orgId, f.customerId, "update"))).resolves.toBeUndefined();

      const f2 = await seedFixture(ctx.prisma, { slug: "other-salon" });
      await expect(assertActiveCustomer(ctx.prisma, f.orgId, f2.customerId)).rejects.toBeInstanceOf(UnauthorizedException);
      await expect(assertActiveCustomer(ctx.prisma, f.orgId, "0194b2a0-0000-7000-8000-000000000000")).rejects.toBeInstanceOf(UnauthorizedException);

      await ctx.prisma.customer.update({ where: { id: f.customerId }, data: { deletedAt: new Date() } });
      await expect(assertActiveCustomer(ctx.prisma, f.orgId, f.customerId)).rejects.toBeInstanceOf(UnauthorizedException);
      await expect(
        ctx.prisma.$transaction((tx) => assertActiveCustomer(tx, f.orgId, f.customerId, "share")),
      ).rejects.toBeInstanceOf(UnauthorizedException);
    });
  });
});
