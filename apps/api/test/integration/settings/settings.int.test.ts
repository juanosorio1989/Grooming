import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { LocationSettings } from "@grooming/contracts";
import { LocationService } from "../../../src/location/location.service.js";
import { createIntegrationApp, resetState } from "../app.js";
import { FIXTURE_SETTINGS, seedFixture, type Fixture } from "../helpers.js";
import { staffToken } from "../tokens.js";

const SETTINGS = FIXTURE_SETTINGS;

describe("staff settings, hours and closures", () => {
  let ctx: Awaited<ReturnType<typeof createIntegrationApp>>;
  let f: Fixture;
  let owner: string;
  let reception: string;
  const call = (method: "get" | "patch" | "put" | "post" | "delete", path: string, token?: string) => {
    const req = request(ctx.app.getHttpServer())[method](path);
    return token ? req.set("Authorization", `Bearer ${token}`) : req;
  };

  beforeAll(async () => {
    ctx = await createIntegrationApp();
    await resetState(ctx.prisma, ctx.redis);
    f = await seedFixture(ctx.prisma);
    owner = await staffToken(ctx.app, { sub: f.staffA, org: f.orgId, role: "OWNER" });
    reception = await staffToken(ctx.app, { sub: f.staffA, org: f.orgId, role: "RECEPTION" });
  });
  afterAll(async () => {
    await ctx?.close();
  });

  it("GET settings works for OWNER and RECEPTION", async () => {
    for (const t of [owner, reception]) {
      const res = await call("get", "/v1/staff/settings", t);
      expect(res.status).toBe(200);
      expect(res.body.location).toMatchObject({ id: f.locationId, name: "Main", timezone: "America/New_York" });
      expect(res.body.settings).toEqual(SETTINGS);
      expect(res.body.hours).toEqual([]);
    }
    expect((await call("get", "/v1/staff/settings")).status).toBe(401);
  });

  it("PATCH is OWNER only", async () => {
    const res = await call("patch", "/v1/staff/settings", reception).send({ settings: { holdMinutes: 10 } });
    expect(res.status).toBe(403);
  });

  it("rejects an invalid threshold set and changes nothing", async () => {
    const res = await call("patch", "/v1/staff/settings", owner).send({ settings: { sizeThresholdsLb: { S: 40, M: 30, L: 80 } } });
    expect(res.status).toBe(400);
    const loc = await ctx.prisma.location.findUniqueOrThrow({ where: { id: f.locationId } });
    expect(loc.settings).toEqual(SETTINGS);
    expect(await ctx.prisma.auditLog.count({ where: { action: "settings.update" } })).toBe(0);
  });

  it("PATCH thresholds re-derives pet size classes, writes one audit row, and refreshes LocationService", async () => {
    const noWeight = await ctx.prisma.pet.create({
      data: { organizationId: f.orgId, customerId: f.customerId, name: "Nox", species: "DOG", breed: "Mutt", sizeClass: "S", coatType: "SMOOTH" },
    });
    const res = await call("patch", "/v1/staff/settings", owner).send({
      location: { phone: "+13055550111" },
      settings: { sizeThresholdsLb: { S: 10, M: 40, L: 80 } },
    });
    expect(res.status).toBe(200);
    expect(res.body.settings.sizeThresholdsLb).toEqual({ S: 10, M: 40, L: 80 });
    expect(res.body.location.phone).toBe("+13055550111");

    expect((await ctx.prisma.pet.findUniqueOrThrow({ where: { id: f.petId } })).sizeClass).toBe("L");
    expect((await ctx.prisma.pet.findUniqueOrThrow({ where: { id: noWeight.id } })).sizeClass).toBe("S");

    const audits = await ctx.prisma.auditLog.findMany({ where: { action: "settings.update" } });
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({
      entity: "settings",
      entityId: f.locationId,
      actorId: f.staffA,
      before: { settings: { sizeThresholdsLb: { S: 20, M: 50, L: 90 } }, location: { phone: null } },
      after: { settings: { sizeThresholdsLb: { S: 10, M: 40, L: 80 } }, location: { phone: "+13055550111" } },
    });

    // invalidate() after commit: the cached default location sees the new settings.
    const loc = await ctx.app.get(LocationService).getDefault();
    expect((loc.settings as LocationSettings).sizeThresholdsLb).toEqual({ S: 10, M: 40, L: 80 });
  });

  it("PUT hours stores 24:00 as 00:00 and reads it back as 24:00", async () => {
    const res = await call("put", "/v1/staff/settings/hours", owner).send([
      { weekday: 1, opens: "08:00", closes: "24:00" },
      { weekday: 2, opens: "09:00", closes: "17:30" },
    ]);
    expect(res.status).toBe(200);
    expect(res.body).toContainEqual({ weekday: 1, opens: "08:00", closes: "24:00" });
    const rows = await ctx.prisma.locationHours.findMany({ where: { locationId: f.locationId, weekday: 1 } });
    expect(rows[0]?.closes.toISOString()).toBe("1970-01-01T00:00:00.000Z");
    const get = await call("get", "/v1/staff/settings", reception);
    expect(get.body.hours).toEqual([
      { weekday: 1, opens: "08:00", closes: "24:00" },
      { weekday: 2, opens: "09:00", closes: "17:30" },
    ]);
    expect(await ctx.prisma.auditLog.count({ where: { action: "location_hours.replace" } })).toBe(1);
  });

  it("PUT hours rejects overlapping ranges and RECEPTION", async () => {
    const overlap = await call("put", "/v1/staff/settings/hours", owner).send([
      { weekday: 1, opens: "08:00", closes: "12:00" },
      { weekday: 1, opens: "11:00", closes: "14:00" },
    ]);
    expect(overlap.status).toBe(400);
    expect((await call("put", "/v1/staff/settings/hours", reception).send([])).status).toBe(403);
    expect(await ctx.prisma.locationHours.count({ where: { locationId: f.locationId } })).toBe(2);
  });

  it("closures: create, list by range, delete, validation, tenancy", async () => {
    const bad = await call("post", "/v1/staff/closures", owner).send({ startsAt: "2026-12-25T10:00:00Z", endsAt: "2026-12-25T10:00:00Z" });
    expect(bad.status).toBe(400);
    expect((await call("post", "/v1/staff/closures", reception).send({ startsAt: "2026-12-25T00:00:00Z", endsAt: "2026-12-26T00:00:00Z" })).status).toBe(403);

    const created = await call("post", "/v1/staff/closures", owner).send({ startsAt: "2026-12-25T00:00:00Z", endsAt: "2026-12-26T00:00:00Z", reason: "Christmas" });
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({ startsAt: "2026-12-25T00:00:00.000Z", endsAt: "2026-12-26T00:00:00.000Z", reason: "Christmas" });
    const id = created.body.id as string;

    const inRange = await call("get", "/v1/staff/closures?from=2026-12-20T00:00:00Z&to=2026-12-30T00:00:00Z", reception);
    expect(inRange.status).toBe(200);
    expect(inRange.body).toHaveLength(1);
    const outRange = await call("get", "/v1/staff/closures?from=2027-01-01T00:00:00Z", owner);
    expect(outRange.body).toHaveLength(0);

    // Another organization's closure is 404.
    const other = await ctx.prisma.organization.create({ data: { name: "Other", slug: "other", defaultLocale: "en" } });
    const otherLoc = await ctx.prisma.location.create({ data: { organizationId: other.id, name: "X", timezone: "America/New_York", settings: {} } });
    const foreign = await ctx.prisma.locationClosure.create({ data: { locationId: otherLoc.id, startsAt: new Date("2026-12-25T00:00:00Z"), endsAt: new Date("2026-12-26T00:00:00Z") } });
    expect((await call("delete", `/v1/staff/closures/${foreign.id}`, owner)).status).toBe(404);
    expect(await ctx.prisma.locationClosure.count({ where: { id: foreign.id } })).toBe(1);
    expect((await call("delete", "/v1/staff/closures/not-a-uuid", owner)).status).toBe(400);

    expect((await call("delete", `/v1/staff/closures/${id}`, owner)).status).toBe(204);
    expect(await ctx.prisma.locationClosure.count({ where: { id } })).toBe(0);
    expect(await ctx.prisma.auditLog.count({ where: { action: "closure.create" } })).toBe(1);
    expect(await ctx.prisma.auditLog.count({ where: { action: "closure.delete" } })).toBe(1);
  });
});
