import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createIntegrationApp, resetState } from "../app.js";
import { seedFixture, type Fixture } from "../helpers.js";

describe("public reads", () => {
  let ctx: Awaited<ReturnType<typeof createIntegrationApp>>;
  let f: Fixture;
  const get = (path: string) => request(ctx.app.getHttpServer()).get(path);
  let hidden: { inactive: string; offline: string; empBookable: string; empOff: string; empNoSkill: string; empInactive: string };

  beforeAll(async () => {
    ctx = await createIntegrationApp();
    await resetState(ctx.prisma, ctx.redis);
    f = await seedFixture(ctx.prisma);
    const p = ctx.prisma;
    const base = { organizationId: f.orgId, species: "DOG" as const, stage: "GROOM" as const, isMain: false, requiredSkill: "GROOMER" as const };
    const cat = await p.serviceCategory.create({ data: { organizationId: f.orgId, name: { en: "Baths", es: "Baños" }, sort: 1 } });
    await p.service.update({ where: { id: f.serviceId }, data: { categoryId: cat.id } });
    await p.servicePrice.create({ data: { organizationId: f.orgId, serviceId: f.serviceId, sizeClass: "M", coatType: null, durationMin: 30, priceCents: 4000 } });
    const inactive = await p.service.create({ data: { ...base, name: { en: "Inactive", es: "Inactivo" }, active: false } });
    const offline = await p.service.create({ data: { ...base, name: { en: "Offline", es: "Sin línea" }, onlineBookable: false } });
    await p.locationHours.create({ data: { locationId: f.locationId, weekday: 1, opens: new Date("1970-01-01T09:00:00Z"), closes: new Date("1970-01-01T00:00:00Z") } });

    const mk = async (email: string, profile: { displayName: string; bookableOnline: boolean; skills: ("BATHER" | "GROOMER")[] }, active = true) => {
      const u = await p.staffUser.create({ data: { organizationId: f.orgId, email, role: "EMPLOYEE", locale: "en", active } });
      await p.employeeProfile.create({ data: { staffUserId: u.id, bio: { en: "Hi", es: "Hola" }, ...profile } });
      await p.employeeService.create({ data: { staffUserId: u.id, serviceId: f.serviceId } });
      return u.id;
    };
    const link = async (staffUserId: string) => {
      await p.employeeService.createMany({ data: [inactive.id, offline.id].map((serviceId) => ({ staffUserId, serviceId })) });
    };
    hidden = {
      inactive: inactive.id,
      offline: offline.id,
      empBookable: await mk("pub-ok@test.dev", { displayName: "Visible Vic", bookableOnline: true, skills: ["GROOMER"] }),
      empOff: await mk("pub-off@test.dev", { displayName: "Off Olga", bookableOnline: false, skills: ["GROOMER"] }),
      empNoSkill: await mk("pub-noskill@test.dev", { displayName: "NoSkill Nick", bookableOnline: true, skills: [] }),
      empInactive: await mk("pub-inactive@test.dev", { displayName: "Gone Gus", bookableOnline: true, skills: ["BATHER"] }, false),
    };
    await link(hidden.empBookable);
  });
  afterAll(async () => {
    await ctx?.close();
  });

  it("locations: no token, only the public fields, hours with 24:00", async () => {
    const r = await get("/v1/public/locations");
    expect(r.status).toBe(200);
    expect(r.body).toHaveLength(1);
    expect(Object.keys(r.body[0]).sort()).toEqual(["address", "defaultBookingMode", "hours", "id", "name", "phone", "timezone"]);
    expect(r.body[0].defaultBookingMode).toBe("DROP_OFF");
    expect(r.body[0].hours).toEqual([{ weekday: 1, opens: "09:00", closes: "24:00" }]);
  });

  it("services: hides inactive and non-online services, includes prices and categories", async () => {
    const r = await get("/v1/public/services");
    expect(r.status).toBe(200);
    const ids = r.body.services.map((s: { id: string }) => s.id);
    expect(ids).toContain(f.serviceId);
    expect(ids).not.toContain(hidden.inactive);
    expect(ids).not.toContain(hidden.offline);
    const s = r.body.services.find((x: { id: string }) => x.id === f.serviceId);
    expect(s.prices).toEqual([{ sizeClass: "M", coatType: null, durationMin: 30, priceCents: 4000 }]);
    expect(s).not.toHaveProperty("active");
    expect(r.body.categories).toEqual([expect.objectContaining({ name: { en: "Baths", es: "Baños" }, sort: 1 })]);
  });

  it("employees: only active, bookable-online staff with skills; no email or role", async () => {
    const r = await get("/v1/public/employees");
    expect(r.status).toBe(200);
    expect(r.body.map((e: { id: string }) => e.id)).toEqual([hidden.empBookable]);
    expect(r.body[0]).toEqual({ id: hidden.empBookable, displayName: "Visible Vic", bio: { en: "Hi", es: "Hola" }, photoUrl: null, skills: ["GROOMER"], serviceIds: [f.serviceId] });
    expect(JSON.stringify(r.body)).not.toContain("email");
    expect(JSON.stringify(r.body)).not.toContain("role");
  });

  it("breeds: cache header, species filter, sorted by en, bad species 400", async () => {
    const all = await get("/v1/public/breeds");
    expect(all.status).toBe(200);
    expect(all.headers["cache-control"]).toBe("public, max-age=86400");
    const en = all.body.map((b: { en: string }) => b.en);
    expect(en).toEqual([...en].sort((a: string, b: string) => a.localeCompare(b)));
    const cats = await get("/v1/public/breeds?species=CAT");
    expect(cats.body.length).toBeGreaterThanOrEqual(12);
    expect(cats.body.every((b: { species: string }) => b.species === "CAT")).toBe(true);
    expect((await get("/v1/public/breeds?species=COW")).status).toBe(400);
  });
});
