import request from "supertest";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createIntegrationApp, resetState } from "../app.js";
import { seedFixture, type Fixture } from "../helpers.js";
import { staffToken } from "../tokens.js";

describe("time off", () => {
  let ctx: Awaited<ReturnType<typeof createIntegrationApp>>;
  let f: Fixture;
  let other: Fixture;
  let owner: string;
  let reception: string;
  let employeeB: string;
  const call = (method: "get" | "patch" | "post" | "delete", path: string, token?: string) => {
    const req = request(ctx.app.getHttpServer())[method](path);
    return token ? req.set("Authorization", `Bearer ${token}`) : req;
  };
  const body = (staffUserId: string, over: Record<string, unknown> = {}) => ({
    staffUserId,
    startsAt: "2026-12-24T14:00:00.000Z",
    endsAt: "2026-12-26T14:00:00.000Z",
    kind: "VACATION",
    ...over,
  });

  beforeEach(async () => {
    ctx = await createIntegrationApp();
    await resetState(ctx.prisma, ctx.redis);
    f = await seedFixture(ctx.prisma);
    other = await seedFixture(ctx.prisma, { slug: "other-salon" });
    owner = await staffToken(ctx.app, { sub: f.staffA, org: f.orgId, role: "OWNER" });
    reception = await staffToken(ctx.app, { sub: f.staffA, org: f.orgId, role: "RECEPTION" });
    employeeB = await staffToken(ctx.app, { sub: f.staffB, org: f.orgId, role: "EMPLOYEE" });
  });
  afterEach(async () => {
    await ctx?.close();
  });

  it("RECEPTION creates for staffB; EMPLOYEE lists own (200) but not another person's (403)", async () => {
    const res = await call("post", "/v1/staff/time-off", reception).send(body(f.staffB, { note: "Holiday" }));
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ staffUserId: f.staffB, kind: "VACATION", note: "Holiday", startsAt: "2026-12-24T14:00:00.000Z" });
    const row = await ctx.prisma.timeOff.findUniqueOrThrow({ where: { id: res.body.id } });
    expect(row.organizationId).toBe(f.orgId);
    expect(row.locationId).toBeNull();
    await call("post", "/v1/staff/time-off", owner).send(body(f.staffA, { kind: "BLOCK" }));

    const own = await call("get", `/v1/staff/time-off?staffUserId=${f.staffB}`, employeeB);
    expect(own.status).toBe(200);
    expect(own.body).toHaveLength(1);
    const implicit = await call("get", "/v1/staff/time-off", employeeB);
    expect(implicit.body.map((r: { staffUserId: string }) => r.staffUserId)).toEqual([f.staffB]);
    expect((await call("get", `/v1/staff/time-off?staffUserId=${f.staffA}`, employeeB)).status).toBe(403);
    expect((await call("post", "/v1/staff/time-off", employeeB).send(body(f.staffB))).status).toBe(403);
    expect(await ctx.prisma.auditLog.count({ where: { organizationId: f.orgId, action: "time_off.create" } })).toBe(2);
  });

  it("filters by staffUserId and overlap window", async () => {
    await call("post", "/v1/staff/time-off", owner).send(body(f.staffB));
    await call("post", "/v1/staff/time-off", owner).send(body(f.staffB, { startsAt: "2027-02-01T00:00:00.000Z", endsAt: "2027-02-02T00:00:00.000Z", kind: "BLOCK" }));
    await call("post", "/v1/staff/time-off", owner).send(body(f.staffA));
    expect((await call("get", "/v1/staff/time-off", owner)).body).toHaveLength(3);
    expect((await call("get", `/v1/staff/time-off?staffUserId=${f.staffB}`, reception)).body).toHaveLength(2);
    const win = await call("get", `/v1/staff/time-off?staffUserId=${f.staffB}&from=2026-12-25T00:00:00Z&to=2026-12-31T00:00:00Z`, owner);
    expect(win.body).toHaveLength(1);
    expect(win.body[0].kind).toBe("VACATION");
  });

  it("endsAt <= startsAt is 400 on create and patch", async () => {
    const same = "2026-12-24T14:00:00.000Z";
    expect((await call("post", "/v1/staff/time-off", owner).send(body(f.staffB, { endsAt: same }))).status).toBe(400);
    expect((await call("post", "/v1/staff/time-off", owner).send(body(f.staffB, { endsAt: "2026-12-01T00:00:00.000Z" }))).status).toBe(400);
    expect((await call("post", "/v1/staff/time-off", owner).send(body(f.staffB, { note: "x".repeat(201) }))).status).toBe(400);
    const id = (await call("post", "/v1/staff/time-off", owner).send(body(f.staffB))).body.id as string;
    expect((await call("patch", `/v1/staff/time-off/${id}`, owner).send({ endsAt: "2026-12-01T00:00:00.000Z" })).status).toBe(400);
    expect((await call("patch", `/v1/staff/time-off/${id}`, owner).send({ startsAt: "2027-01-01T00:00:00.000Z" })).status).toBe(400);
    expect((await call("patch", `/v1/staff/time-off/${id}`, owner).send({ staffUserId: f.staffA })).status).toBe(400);
  });

  it("PATCH and DELETE with audit", async () => {
    const id = (await call("post", "/v1/staff/time-off", owner).send(body(f.staffB))).body.id as string;
    const patched = await call("patch", `/v1/staff/time-off/${id}`, reception).send({ kind: "BLOCK", note: "Dentist", endsAt: "2026-12-25T14:00:00.000Z" });
    expect(patched.status).toBe(200);
    expect(patched.body).toMatchObject({ kind: "BLOCK", note: "Dentist", endsAt: "2026-12-25T14:00:00.000Z" });
    expect((await call("patch", `/v1/staff/time-off/${id}`, employeeB).send({ note: "x" })).status).toBe(403);
    expect((await call("delete", `/v1/staff/time-off/${id}`, employeeB)).status).toBe(403);
    expect((await call("delete", `/v1/staff/time-off/${id}`, reception)).status).toBe(204);
    expect(await ctx.prisma.timeOff.count({ where: { id } })).toBe(0);
    expect((await call("delete", `/v1/staff/time-off/${id}`, reception)).status).toBe(404);
    for (const a of ["time_off.create", "time_off.update", "time_off.delete"]) {
      expect(await ctx.prisma.auditLog.count({ where: { organizationId: f.orgId, action: a } })).toBe(1);
    }
  });

  it("another organization's person or row is 404", async () => {
    expect((await call("post", "/v1/staff/time-off", owner).send(body(other.staffA))).status).toBe(404);
    const foreign = await ctx.prisma.timeOff.create({
      data: { organizationId: other.orgId, staffUserId: other.staffA, startsAt: new Date("2026-12-24T00:00:00Z"), endsAt: new Date("2026-12-25T00:00:00Z"), kind: "BLOCK" },
    });
    expect((await call("patch", `/v1/staff/time-off/${foreign.id}`, owner).send({ note: "x" })).status).toBe(404);
    expect((await call("delete", `/v1/staff/time-off/${foreign.id}`, owner)).status).toBe(404);
    expect((await call("get", "/v1/staff/time-off", owner)).body).toHaveLength(0);
  });
});
