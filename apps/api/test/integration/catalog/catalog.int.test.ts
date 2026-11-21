import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createIntegrationApp, resetState } from "../app.js";
import { createStaff, seedFixture, type Fixture } from "../helpers.js";
import { staffToken } from "../tokens.js";

const body = (over: Record<string, unknown> = {}) => ({
  name: { en: "Full groom", es: "Corte completo" },
  species: "DOG",
  stage: "GROOM",
  isMain: true,
  requiredSkill: "GROOMER",
  bufferAfterMin: 10,
  onlineBookable: true,
  ...over,
});

describe("categories, services and price matrix", () => {
  let ctx: Awaited<ReturnType<typeof createIntegrationApp>>;
  let f: Fixture;
  let owner: string;
  let reception: string;
  let employee: string;
  const call = (method: "get" | "patch" | "post" | "delete" | "put", path: string, token?: string) => {
    const req = request(ctx.app.getHttpServer())[method](path);
    return token ? req.set("Authorization", `Bearer ${token}`) : req;
  };

  beforeAll(async () => {
    ctx = await createIntegrationApp();
    await resetState(ctx.prisma, ctx.redis);
    f = await seedFixture(ctx.prisma);
    owner = await staffToken(ctx.app, { sub: f.staffA, org: f.orgId, role: "OWNER" });
    reception = await staffToken(ctx.app, { sub: f.staffA, org: f.orgId, role: "RECEPTION" });
    employee = await staffToken(ctx.app, { sub: f.staffA, org: f.orgId, role: "EMPLOYEE" });
  });
  // Each test starts from the fixture's single BATH/DOG service on the tub type, with no categories or audit rows.
  beforeEach(async () => {
    await ctx.prisma.service.deleteMany({ where: { id: { not: f.serviceId } } });
    await ctx.prisma.service.update({ where: { id: f.serviceId }, data: { active: true, resourceTypeId: f.resourceTypeId } });
    await ctx.prisma.servicePrice.deleteMany();
    await ctx.prisma.serviceCategory.deleteMany();
    await ctx.prisma.resourceType.deleteMany({ where: { id: { notIn: [f.resourceTypeId, f.kennelTypeId] }, organizationId: f.orgId } });
    await ctx.prisma.auditLog.deleteMany();
  });
  afterAll(async () => {
    await ctx?.close();
  });

  const audits = (action: string) => ctx.prisma.auditLog.count({ where: { action } });

  it("category CRUD: audit rows, services keep working after delete with categoryId null", async () => {
    const c = await call("post", "/v1/staff/categories", owner).send({ name: { en: "Baths", es: "Baños" }, sort: 2 });
    expect(c.status).toBe(201);
    expect(c.body).toMatchObject({ name: { en: "Baths", es: "Baños" }, sort: 2 });
    const p = await call("patch", `/v1/staff/categories/${c.body.id}`, owner).send({ sort: 5 });
    expect(p.body.sort).toBe(5);
    const s = await call("post", "/v1/staff/services", owner).send(body({ categoryId: c.body.id }));
    expect(s.status).toBe(201);
    expect((await call("get", "/v1/staff/categories", employee)).body).toHaveLength(1);
    expect((await call("delete", `/v1/staff/categories/${c.body.id}`, owner)).status).toBe(204);
    expect((await call("get", `/v1/staff/services/${s.body.id}`, employee)).body.categoryId).toBeNull();
    expect((await call("post", "/v1/staff/categories", reception).send({ name: { en: "x", es: "x" } })).status).toBe(403);
    expect(await audits("category.create")).toBe(1);
    expect(await audits("category.update")).toBe(1);
    expect(await audits("category.delete")).toBe(1);
  });

  it("creates a service, PUT matrix with 8 rows, GET returns them; audits", async () => {
    const s = await call("post", "/v1/staff/services", owner).send(body());
    expect(s.status).toBe(201);
    expect(s.body).toMatchObject({ stage: "GROOM", active: true, prices: [], resourceTypeId: null, categoryId: null });
    const rows = (["S", "M", "L", "XL"] as const).flatMap((sizeClass, i) => [
      { sizeClass, coatType: null, durationMin: 60 + i * 15, priceCents: 5000 + i * 1000 },
      { sizeClass, coatType: "CURLY", durationMin: 90 + i * 15, priceCents: 7000 + i * 1000 },
    ]);
    const put = await call("put", `/v1/staff/services/${s.body.id}/prices`, owner).send(rows);
    expect(put.status).toBe(200);
    const got = await call("get", `/v1/staff/services/${s.body.id}/prices`, employee);
    expect(got.body).toHaveLength(8);
    expect(got.body).toEqual(expect.arrayContaining(rows));
    const view = await call("get", `/v1/staff/services/${s.body.id}`, reception);
    expect(view.body.prices).toHaveLength(8);
    expect(await audits("service.create")).toBe(1);
    expect(await audits("service_price.replace")).toBe(1);
    const log = await ctx.prisma.auditLog.findFirstOrThrow({ where: { action: "service_price.replace" } });
    expect((log.before as { rows: unknown[] }).rows).toHaveLength(0);
    expect((log.after as { rows: unknown[] }).rows).toHaveLength(8);
  });

  it("invalid PUT is 400 and old rows remain; duplicate (M, null) is 400; [] clears", async () => {
    const s = await call("post", "/v1/staff/services", owner).send(body());
    const url = `/v1/staff/services/${s.body.id}/prices`;
    const ok = [{ sizeClass: "M", coatType: null, durationMin: 60, priceCents: 5000 }];
    expect((await call("put", url, owner).send(ok)).status).toBe(200);
    const bad = await call("put", url, owner).send([{ sizeClass: "S", coatType: null, durationMin: 0, priceCents: 100 }]);
    expect(bad.status).toBe(400);
    expect((await call("get", url, owner)).body).toEqual(ok);
    const dup = await call("put", url, owner).send([...ok, { ...ok[0], priceCents: 6000 }]);
    expect(dup.status).toBe(400);
    expect((await call("get", url, owner)).body).toEqual(ok);
    expect((await call("put", url, owner).send([])).status).toBe(200);
    expect((await call("get", url, owner)).body).toEqual([]);
    expect((await call("put", url, reception).send([])).status).toBe(403);
  });

  it("second BATH DOG service on a different resource type is 409 STAGE_RESOURCE_MISMATCH naming the other", async () => {
    const other = await ctx.prisma.resourceType.create({ data: { organizationId: f.orgId, name: { en: "Table", es: "Mesa" }, kind: "STATION" } });
    const res = await call("post", "/v1/staff/services", owner).send(body({ stage: "BATH", requiredSkill: "BATHER", resourceTypeId: other.id }));
    expect(res.status).toBe(409);
    expect(res.body.code).toBe("STAGE_RESOURCE_MISMATCH");
    expect(res.body.detail).toContain(f.serviceId);
    expect(await ctx.prisma.service.count()).toBe(1);
    // same type is fine
    const ok = await call("post", "/v1/staff/services", owner).send(body({ stage: "BATH", requiredSkill: "BATHER", resourceTypeId: f.resourceTypeId }));
    expect(ok.status).toBe(201);
    // PATCH into a conflict is 409, other species does not conflict
    const cat = await call("post", "/v1/staff/services", owner).send(body({ stage: "BATH", species: "CAT", requiredSkill: "BATHER", resourceTypeId: other.id }));
    expect(cat.status).toBe(201);
    const patch = await call("patch", `/v1/staff/services/${cat.body.id}`, owner).send({ species: "ANY" });
    expect(patch.status).toBe(409);
    expect(patch.body.code).toBe("STAGE_RESOURCE_MISMATCH");
  });

  it("a KENNEL resourceTypeId is 400", async () => {
    const res = await call("post", "/v1/staff/services", owner).send(body({ resourceTypeId: f.kennelTypeId }));
    expect(res.status).toBe(400);
    const s = await call("post", "/v1/staff/services", owner).send(body());
    const patch = await call("patch", `/v1/staff/services/${s.body.id}`, owner).send({ resourceTypeId: f.kennelTypeId });
    expect(patch.status).toBe(400);
  });

  it("deactivate hides from the default list, includeInactive shows it, PATCH updates; audits", async () => {
    const s = await call("post", "/v1/staff/services", owner).send(body());
    const p = await call("patch", `/v1/staff/services/${s.body.id}`, owner).send({ bufferAfterMin: 20, description: { en: "d", es: "d" } });
    expect(p.status).toBe(200);
    expect(p.body).toMatchObject({ bufferAfterMin: 20, description: { en: "d", es: "d" } });
    expect((await call("delete", `/v1/staff/services/${s.body.id}`, owner)).status).toBe(204);
    const ids = (r: { body: { id: string }[] }) => r.body.map((x) => x.id);
    expect(ids(await call("get", "/v1/staff/services", employee))).not.toContain(s.body.id);
    expect(ids(await call("get", "/v1/staff/services?includeInactive=true", employee))).toContain(s.body.id);
    expect(await audits("service.update")).toBe(1);
    expect(await audits("service.deactivate")).toBe(1);
    // inactive services do not block the stage rule
    const other = await ctx.prisma.resourceType.create({ data: { organizationId: f.orgId, name: { en: "T", es: "T" }, kind: "STATION" } });
    const again = await call("post", "/v1/staff/services", owner).send(body({ resourceTypeId: other.id }));
    expect(again.status).toBe(201);
  });

  it("RBAC: RECEPTION POST is 403, EMPLOYEE GET is 200, anonymous is 401; unknown keys 400; other org 404", async () => {
    expect((await call("post", "/v1/staff/services", reception).send(body())).status).toBe(403);
    expect((await call("get", "/v1/staff/services", employee)).status).toBe(200);
    expect((await call("get", "/v1/staff/services")).status).toBe(401);
    expect((await call("post", "/v1/staff/services", owner).send({ ...body(), extra: 1 })).status).toBe(400);
    const other = await seedFixture(ctx.prisma, { slug: "other-salon" });
    expect((await call("get", `/v1/staff/services/${other.serviceId}`, owner)).status).toBe(404);
    expect((await call("put", `/v1/staff/services/${other.serviceId}/prices`, owner).send([])).status).toBe(404);
  });

  it("changing requiredSkill is 400 while an assigned employee lacks the new skill, 200 once they have it", async () => {
    const svc = await call("post", "/v1/staff/services", owner).send(body({ stage: "GROOM", requiredSkill: "GROOMER", resourceTypeId: null }));
    expect(svc.status).toBe(201);
    const person = await createStaff(ctx.prisma, f, { email: "skill.check@example.com", role: "EMPLOYEE", canLogin: false });
    await ctx.prisma.employeeProfile.create({ data: { staffUserId: person.id, displayName: "Sk", skills: ["GROOMER"] } });
    await ctx.prisma.employeeService.create({ data: { staffUserId: person.id, serviceId: svc.body.id } });

    const bad = await call("patch", `/v1/staff/services/${svc.body.id}`, owner).send({ requiredSkill: "BATHER" });
    expect(bad.status).toBe(400);
    expect(bad.body.code).toBe("VALIDATION_FAILED");
    expect((await ctx.prisma.service.findUniqueOrThrow({ where: { id: svc.body.id } })).requiredSkill).toBe("GROOMER");

    await ctx.prisma.employeeProfile.update({ where: { staffUserId: person.id }, data: { skills: ["GROOMER", "BATHER"] } });
    const ok = await call("patch", `/v1/staff/services/${svc.body.id}`, owner).send({ requiredSkill: "BATHER" });
    expect(ok.status).toBe(200);
    expect(ok.body.requiredSkill).toBe("BATHER");
  });
});
