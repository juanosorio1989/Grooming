import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createIntegrationApp, resetState } from "../app.js";
import { seedFixture, type Fixture } from "../helpers.js";
import { staffToken } from "../tokens.js";

describe("resource types and resources", () => {
  let ctx: Awaited<ReturnType<typeof createIntegrationApp>>;
  let f: Fixture;
  let other: Fixture;
  let owner: string;
  let reception: string;
  let employee: string;
  const call = (method: "get" | "patch" | "post" | "delete", path: string, token?: string) => {
    const req = request(ctx.app.getHttpServer())[method](path);
    return token ? req.set("Authorization", `Bearer ${token}`) : req;
  };

  beforeAll(async () => {
    ctx = await createIntegrationApp();
    await resetState(ctx.prisma, ctx.redis);
    f = await seedFixture(ctx.prisma);
    other = await seedFixture(ctx.prisma, { slug: "other-salon" });
    owner = await staffToken(ctx.app, { sub: f.staffA, org: f.orgId, role: "OWNER" });
    reception = await staffToken(ctx.app, { sub: f.staffA, org: f.orgId, role: "RECEPTION" });
    employee = await staffToken(ctx.app, { sub: f.staffA, org: f.orgId, role: "EMPLOYEE" });
  });
  afterAll(async () => {
    await ctx?.close();
  });

  it("creates a type and two resources, lists with filters, and audits", async () => {
    const t = await call("post", "/v1/staff/resource-types", owner).send({ name: { en: "Dryer", es: "Secador" }, kind: "STATION" });
    expect(t.status).toBe(201);
    expect(t.body).toMatchObject({ name: { en: "Dryer", es: "Secador" }, kind: "STATION", resourceCount: 0 });
    for (const name of ["Dryer B", "Dryer A"]) {
      const r = await call("post", "/v1/staff/resources", owner).send({ resourceTypeId: t.body.id, name });
      expect(r.status).toBe(201);
      expect(r.body).toMatchObject({ name, resourceTypeId: t.body.id, kind: "STATION", active: true });
    }
    const created = await ctx.prisma.resource.findFirstOrThrow({ where: { name: "Dryer A" } });
    expect(created.locationId).toBe(f.locationId);

    const kennels = await call("get", "/v1/staff/resources?kind=KENNEL", reception);
    expect(kennels.status).toBe(200);
    expect(kennels.body.map((r: { name: string }) => r.name)).toEqual(["Kennel 1", "Kennel 2"]);
    expect(kennels.body.every((r: { kind: string }) => r.kind === "KENNEL")).toBe(true);

    const all = await call("get", "/v1/staff/resources", employee);
    expect(all.body).toHaveLength(6);
    const dryers = all.body.filter((r: { resourceTypeId: string }) => r.resourceTypeId === t.body.id).map((r: { name: string }) => r.name);
    expect(dryers).toEqual(["Dryer A", "Dryer B"]);

    const types = await call("get", "/v1/staff/resource-types", employee);
    expect(types.status).toBe(200);
    expect(types.body.find((x: { id: string }) => x.id === t.body.id)).toMatchObject({ resourceCount: 2 });
    expect(await ctx.prisma.auditLog.count({ where: { action: "resource_type.create" } })).toBe(1);
    expect(await ctx.prisma.auditLog.count({ where: { action: "resource.create" } })).toBe(2);
  });

  it("PATCH type renames; kind is immutable (400)", async () => {
    const res = await call("patch", `/v1/staff/resource-types/${f.resourceTypeId}`, owner).send({ name: { en: "Tub", es: "Bañera" } });
    expect(res.status).toBe(200);
    expect(res.body.name.es).toBe("Bañera");
    const bad = await call("patch", `/v1/staff/resource-types/${f.resourceTypeId}`, owner).send({ kind: "KENNEL" });
    expect(bad.status).toBe(400);
    const bad2 = await call("patch", `/v1/staff/resource-types/${f.resourceTypeId}`, owner).send({ name: { en: "Tub", es: "Tina" }, kind: "KENNEL" });
    expect(bad2.status).toBe(400);
    expect(await ctx.prisma.auditLog.count({ where: { action: "resource_type.update" } })).toBe(1);
  });

  it("delete: type with resources is 409 IN_USE, type used by a service is 409, unused type is 204", async () => {
    const used = await call("delete", `/v1/staff/resource-types/${f.resourceTypeId}`, owner);
    expect(used.status).toBe(409);
    expect(used.body.code).toBe("IN_USE");

    const svcType = await ctx.prisma.resourceType.create({ data: { organizationId: f.orgId, name: { en: "S", es: "S" }, kind: "STATION" } });
    await ctx.prisma.service.updateMany({ where: { id: f.serviceId }, data: { resourceTypeId: svcType.id } });
    const bySvc = await call("delete", `/v1/staff/resource-types/${svcType.id}`, owner);
    expect(bySvc.status).toBe(409);
    expect(bySvc.body.code).toBe("IN_USE");
    await ctx.prisma.service.updateMany({ where: { id: f.serviceId }, data: { resourceTypeId: f.resourceTypeId } });

    const fresh = await call("post", "/v1/staff/resource-types", owner).send({ name: { en: "Table", es: "Mesa" }, kind: "STATION" });
    const del = await call("delete", `/v1/staff/resource-types/${fresh.body.id}`, owner);
    expect(del.status).toBe(204);
    expect(await ctx.prisma.auditLog.count({ where: { action: "resource_type.delete" } })).toBe(1);
  });

  it("DELETE deactivates a resource; hidden by default, shown with includeInactive", async () => {
    const del = await call("delete", `/v1/staff/resources/${f.resource2}`, owner);
    expect(del.status).toBe(204);
    const row = await ctx.prisma.resource.findUniqueOrThrow({ where: { id: f.resource2 } });
    expect(row.active).toBe(false);
    const def = await call("get", "/v1/staff/resources", owner);
    expect(def.body.map((r: { id: string }) => r.id)).not.toContain(f.resource2);
    const inc = await call("get", "/v1/staff/resources?includeInactive=true", owner);
    expect(inc.body.find((r: { id: string }) => r.id === f.resource2)).toMatchObject({ active: false });
    expect(await ctx.prisma.auditLog.count({ where: { action: "resource.deactivate" } })).toBe(1);
  });

  it("duplicate active name is 409; a deactivated name can be reused; reactivating a clash is 409", async () => {
    const dup = await call("post", "/v1/staff/resources", owner).send({ resourceTypeId: f.resourceTypeId, name: "Tub 1" });
    expect(dup.status).toBe(409);
    expect(dup.body.code).toBe("CONFLICT");
    const reuse = await call("post", "/v1/staff/resources", owner).send({ resourceTypeId: f.resourceTypeId, name: "Tub 2" });
    expect(reuse.status).toBe(201);
    const react = await call("patch", `/v1/staff/resources/${f.resource2}`, owner).send({ active: true });
    expect(react.status).toBe(409);
    const rename = await call("patch", `/v1/staff/resources/${reuse.body.id}`, owner).send({ name: "Tub 1" });
    expect(rename.status).toBe(409);
    const ok = await call("patch", `/v1/staff/resources/${reuse.body.id}`, owner).send({ name: "Tub 3" });
    expect(ok.status).toBe(200);
    expect(ok.body.name).toBe("Tub 3");
    expect(await ctx.prisma.auditLog.count({ where: { action: "resource.update" } })).toBe(1);
  });

  it("validates input", async () => {
    expect((await call("post", "/v1/staff/resources", owner).send({ resourceTypeId: f.resourceTypeId, name: "" })).status).toBe(400);
    expect((await call("post", "/v1/staff/resources", owner).send({ resourceTypeId: f.resourceTypeId, name: "x".repeat(61) })).status).toBe(400);
    expect((await call("patch", "/v1/staff/resources/not-a-uuid", owner).send({ name: "A" })).status).toBe(400);
    expect((await call("get", "/v1/staff/resources?kind=BOGUS", owner)).status).toBe(400);
  });

  it("enforces roles", async () => {
    expect((await call("post", "/v1/staff/resources", employee).send({ resourceTypeId: f.resourceTypeId, name: "Nope" })).status).toBe(403);
    expect((await call("post", "/v1/staff/resource-types", reception).send({ name: { en: "A", es: "A" }, kind: "KENNEL" })).status).toBe(403);
    expect((await call("delete", `/v1/staff/resources/${f.kennel1}`, employee)).status).toBe(403);
    expect((await call("get", "/v1/staff/resources")).status).toBe(401);
  });

  it("rows of another organization are 404", async () => {
    expect((await call("patch", `/v1/staff/resources/${other.resource1}`, owner).send({ name: "X" })).status).toBe(404);
    expect((await call("delete", `/v1/staff/resources/${other.resource1}`, owner)).status).toBe(404);
    expect((await call("patch", `/v1/staff/resource-types/${other.resourceTypeId}`, owner).send({ name: { en: "a", es: "a" } })).status).toBe(404);
    expect((await call("delete", `/v1/staff/resource-types/${other.resourceTypeId}`, owner)).status).toBe(404);
    expect((await call("post", "/v1/staff/resources", owner).send({ resourceTypeId: other.resourceTypeId, name: "Y" })).status).toBe(404);
    const list = await call("get", "/v1/staff/resources?includeInactive=true", owner);
    expect(list.body.map((r: { id: string }) => r.id)).not.toContain(other.resource1);
  });
});
