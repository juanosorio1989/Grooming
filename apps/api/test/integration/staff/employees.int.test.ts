import request from "supertest";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { RefreshTokenService } from "../../../src/auth/refresh-token.service.js";
import { createIntegrationApp, resetState } from "../app.js";
import { seedFixture, type Fixture } from "../helpers.js";
import { staffToken } from "../tokens.js";

describe("employees, services and working hours", () => {
  let ctx: Awaited<ReturnType<typeof createIntegrationApp>>;
  let f: Fixture;
  let other: Fixture;
  let owner: string;
  let reception: string;
  let employee: string;
  const call = (method: "get" | "patch" | "post" | "put", path: string, token?: string) => {
    const req = request(ctx.app.getHttpServer())[method](path);
    return token ? req.set("Authorization", `Bearer ${token}`) : req;
  };
  const create = (body: Record<string, unknown>, token = owner) => call("post", "/v1/staff/employees", token).send(body);
  const groomer = { displayName: "Gina", role: "EMPLOYEE", email: "gina@test.dev", locale: "en", skills: ["GROOMER"] };

  // Fresh app per test: TenancyService and LocationService cache the org.
  beforeEach(async () => {
    ctx = await createIntegrationApp();
    await resetState(ctx.prisma, ctx.redis);
    f = await seedFixture(ctx.prisma);
    other = await seedFixture(ctx.prisma, { slug: "other-salon" });
    await ctx.prisma.staffUser.update({ where: { id: f.staffA }, data: { role: "OWNER" } });
    owner = await staffToken(ctx.app, { sub: f.staffA, org: f.orgId, role: "OWNER" });
    reception = await staffToken(ctx.app, { sub: f.staffB, org: f.orgId, role: "RECEPTION" });
    employee = await staffToken(ctx.app, { sub: f.staffB, org: f.orgId, role: "EMPLOYEE" });
  });
  afterEach(async () => {
    await ctx?.close();
  });

  it("creates a groomer with profile, staff_location and canLogin false, and audits", async () => {
    const res = await create({ ...groomer, bio: { en: "Hi", es: "Hola" } });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({
      displayName: "Gina", role: "EMPLOYEE", email: "gina@test.dev", locale: "en", active: true, canLogin: false,
      skills: ["GROOMER"], bookableOnline: true, bio: { en: "Hi", es: "Hola" }, serviceIds: [],
    });
    const id = res.body.id as string;
    const user = await ctx.prisma.staffUser.findUniqueOrThrow({ where: { id }, include: { employeeProfile: true, staffLocations: true } });
    expect(user.canLogin).toBe(false);
    expect(user.organizationId).toBe(f.orgId);
    expect(user.employeeProfile?.skills).toEqual(["GROOMER"]);
    expect(user.staffLocations.map((l) => l.locationId)).toEqual([f.locationId]);
    expect(await ctx.prisma.auditLog.count({ where: { organizationId: f.orgId, action: "employee.create", entityId: id } })).toBe(1);
  });

  it("rejects a duplicate email (409), duplicate skills (400) and RECEPTION/EMPLOYEE writes (403)", async () => {
    expect((await create(groomer)).status).toBe(201);
    expect((await create(groomer)).status).toBe(409);
    expect((await create({ ...groomer, email: "x@test.dev", skills: ["GROOMER", "GROOMER"] })).status).toBe(400);
    expect((await create({ ...groomer, email: "y@test.dev" }, reception)).status).toBe(403);
    expect((await create({ ...groomer, email: "z@test.dev" }, employee)).status).toBe(403);
  });

  it("an email in another organization does not clash", async () => {
    await ctx.prisma.staffUser.create({ data: { organizationId: other.orgId, email: "gina@test.dev", role: "EMPLOYEE", locale: "en" } });
    expect((await create(groomer)).status).toBe(201);
  });

  it("PUT services: GROOMER service for a BATHER-only person is 400; matching and inactive/other-org cases", async () => {
    const bather = (await create({ ...groomer, email: "bob@test.dev", skills: ["BATHER"] })).body.id as string;
    const groomSvc = await ctx.prisma.service.create({
      data: { organizationId: f.orgId, name: { en: "Cut", es: "Corte" }, species: "DOG", stage: "GROOM", isMain: true, requiredSkill: "GROOMER" },
    });
    const inactive = await ctx.prisma.service.create({
      data: { organizationId: f.orgId, name: { en: "Old", es: "Viejo" }, species: "DOG", stage: "BATH", isMain: true, requiredSkill: "BATHER", active: false },
    });
    const foreign = await ctx.prisma.service.findFirstOrThrow({ where: { organizationId: other.orgId } });
    const put = (id: string, serviceIds: string[]) => call("put", `/v1/staff/employees/${id}/services`, owner).send({ serviceIds });

    expect((await put(bather, [groomSvc.id])).status).toBe(400);
    expect((await put(bather, [inactive.id])).status).toBe(400);
    expect((await put(bather, [foreign.id])).status).toBe(400);
    const ok = await put(bather, [f.serviceId]);
    expect(ok.status).toBe(200);
    expect(ok.body.serviceIds).toEqual([f.serviceId]);
    const cleared = await put(bather, []);
    expect(cleared.body.serviceIds).toEqual([]);
    expect(await ctx.prisma.employeeService.count({ where: { staffUserId: bather } })).toBe(0);
    expect(await ctx.prisma.auditLog.count({ where: { organizationId: f.orgId, action: "employee_services.replace" } })).toBe(2);
    expect((await put(other.staffA, [])).status).toBe(404);

    // Removing a skill that an assigned service needs is refused.
    await put(bather, [f.serviceId]);
    expect((await call("patch", `/v1/staff/employees/${bather}`, owner).send({ skills: ["GROOMER"] })).status).toBe(400);
  });

  it("working hours round-trip with end 24:00, replace, audit and permissions", async () => {
    const id = (await create(groomer)).body.id as string;
    const rows = [
      { weekday: 2, start: "13:00", end: "17:00" },
      { weekday: 1, start: "09:00", end: "12:00" },
      { weekday: 1, start: "12:00", end: "24:00" },
    ];
    const put = await call("put", `/v1/staff/employees/${id}/working-hours`, owner).send(rows);
    expect(put.status).toBe(200);
    const sorted = [rows[1], rows[2], rows[0]];
    expect(put.body).toEqual(sorted);
    const get = await call("get", `/v1/staff/employees/${id}/working-hours`, reception);
    expect(get.body).toEqual(sorted);
    expect(await ctx.prisma.workingHours.count({ where: { staffUserId: id, locationId: f.locationId } })).toBe(3);

    const replaced = await call("put", `/v1/staff/employees/${id}/working-hours`, owner).send([{ weekday: 3, start: "08:00", end: "10:00" }]);
    expect(replaced.body).toEqual([{ weekday: 3, start: "08:00", end: "10:00" }]);
    expect(await ctx.prisma.workingHours.count({ where: { staffUserId: id } })).toBe(1);
    expect(await ctx.prisma.auditLog.count({ where: { organizationId: f.orgId, action: "working_hours.replace" } })).toBe(2);

    const bad = (body: unknown) => call("put", `/v1/staff/employees/${id}/working-hours`, owner).send(body as object);
    expect((await bad([{ weekday: 7, start: "08:00", end: "10:00" }])).status).toBe(400);
    expect((await bad([{ weekday: 1, start: "10:00", end: "10:00" }])).status).toBe(400);
    expect((await bad(Array.from({ length: 22 }, () => ({ weekday: 1, start: "08:00", end: "09:00" })))).status).toBe(400);
    expect((await call("put", `/v1/staff/employees/${id}/working-hours`, reception).send([])).status).toBe(403);
  });

  it("overlapping ranges on one weekday are 400 and leave the old hours in place", async () => {
    const id = (await create(groomer)).body.id as string;
    await call("put", `/v1/staff/employees/${id}/working-hours`, owner).send([{ weekday: 1, start: "08:00", end: "09:00" }]);
    const res = await call("put", `/v1/staff/employees/${id}/working-hours`, owner).send([
      { weekday: 1, start: "09:00", end: "12:00" },
      { weekday: 1, start: "11:00", end: "14:00" },
    ]);
    expect(res.status).toBe(400);
    expect((await call("get", `/v1/staff/employees/${id}/working-hours`, owner)).body).toEqual([{ weekday: 1, start: "08:00", end: "09:00" }]);
  });

  it("EMPLOYEE reads only their own working hours", async () => {
    await call("put", `/v1/staff/employees/${f.staffB}/working-hours`, owner).send([{ weekday: 4, start: "08:00", end: "16:00" }]);
    expect((await call("get", `/v1/staff/employees/${f.staffB}/working-hours`, employee)).status).toBe(200);
    expect((await call("get", `/v1/staff/employees/${f.staffA}/working-hours`, employee)).status).toBe(403);
    expect((await call("get", `/v1/staff/employees/${other.staffA}/working-hours`, owner)).status).toBe(404);
  });

  it("a role change revokes the person's refresh tokens; a plain edit does not", async () => {
    const id = (await create(groomer)).body.id as string;
    // Refresh requires a login-capable account; the invite flow would set this.
    await ctx.prisma.staffUser.update({ where: { id }, data: { canLogin: true } });
    const refresh = (token: string) => request(ctx.app.getHttpServer()).post("/v1/auth/refresh").set("x-token-transport", "body").send({ refreshToken: token });
    const svc = ctx.app.get(RefreshTokenService);
    const meta = { ip: null, userAgent: null };
    const keep = await svc.create({ type: "STAFF", id }, meta);
    const edit = await call("patch", `/v1/staff/employees/${id}`, owner).send({ displayName: "Gina G" });
    expect(edit.status).toBe(200);
    expect(edit.body.displayName).toBe("Gina G");
    const stillValid = await refresh(keep.token);
    expect(stillValid.status).toBe(200);

    const live = await svc.create({ type: "STAFF", id }, meta);
    const res = await call("patch", `/v1/staff/employees/${id}`, owner).send({ role: "RECEPTION" });
    expect(res.status).toBe(200);
    expect(res.body.role).toBe("RECEPTION");
    expect((await refresh(live.token)).status).toBe(401);
    expect(await ctx.prisma.auditLog.count({ where: { organizationId: f.orgId, action: "employee.update", entityId: id } })).toBe(2);
  });

  it("deactivating a person revokes their refresh tokens", async () => {
    const id = (await create(groomer)).body.id as string;
    const t = await ctx.app.get(RefreshTokenService).create({ type: "STAFF", id }, { ip: null, userAgent: null });
    expect((await call("patch", `/v1/staff/employees/${id}`, owner).send({ active: false })).status).toBe(200);
    const res = await request(ctx.app.getHttpServer()).post("/v1/auth/refresh").set("x-token-transport", "body").send({ refreshToken: t.token });
    expect(res.status).toBe(401);
  });

  it("the last active OWNER cannot be demoted or deactivated; with a second owner it can", async () => {
    const url = `/v1/staff/employees/${f.staffA}`;
    expect((await call("patch", url, owner).send({ role: "RECEPTION" })).status).toBe(409);
    expect((await call("patch", url, owner).send({ active: false })).status).toBe(409);
    expect((await ctx.prisma.staffUser.findUniqueOrThrow({ where: { id: f.staffA } })).role).toBe("OWNER");

    const second = (await create({ ...groomer, role: "OWNER" })).body.id as string;
    expect((await call("patch", url, owner).send({ role: "RECEPTION" })).status).toBe(200);
    // Now the second one is the last owner.
    expect((await call("patch", `/v1/staff/employees/${second}`, owner).send({ active: false })).status).toBe(409);
  });

  it("an inactive OWNER does not count as a second owner", async () => {
    await ctx.prisma.staffUser.create({ data: { organizationId: f.orgId, email: "old@test.dev", role: "OWNER", locale: "en", active: false } });
    expect((await call("patch", `/v1/staff/employees/${f.staffA}`, owner).send({ role: "RECEPTION" })).status).toBe(409);
  });

  it("EMPLOYEE list has no email and hides inactive people; OWNER sees everything with includeInactive", async () => {
    const id = (await create(groomer)).body.id as string;
    await call("patch", `/v1/staff/employees/${id}`, owner).send({ active: false });
    const asEmployee = await call("get", "/v1/staff/employees?includeInactive=true", employee);
    expect(asEmployee.status).toBe(200);
    expect(asEmployee.body.map((e: { id: string }) => e.id).sort()).toEqual([f.staffA, f.staffB].sort());
    for (const e of asEmployee.body) expect("email" in e).toBe(false);
    expect("email" in (await call("get", `/v1/staff/employees/${f.staffA}`, employee)).body).toBe(false);

    const asOwner = await call("get", "/v1/staff/employees", owner);
    expect(asOwner.body).toHaveLength(2);
    expect(asOwner.body[0].email).toBe("a@test.dev");
    const all = await call("get", "/v1/staff/employees?includeInactive=true", reception);
    expect(all.body).toHaveLength(3);
    expect(all.body.every((e: { id: string }) => e.id !== other.staffA)).toBe(true);
    expect((await call("get", `/v1/staff/employees/${other.staffA}`, owner)).status).toBe(404);
    expect((await call("get", "/v1/staff/employees/not-a-uuid", owner)).status).toBe(400);
  });

  it("PATCH email conflict is 409 and unknown keys are 400", async () => {
    const id = (await create(groomer)).body.id as string;
    expect((await call("patch", `/v1/staff/employees/${id}`, owner).send({ email: "a@test.dev" })).status).toBe(409);
    expect((await call("patch", `/v1/staff/employees/${id}`, owner).send({ canLogin: true })).status).toBe(400);
  });
});
