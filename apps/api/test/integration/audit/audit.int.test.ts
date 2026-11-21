import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { AuditItem } from "@grooming/contracts";
import { createIntegrationApp, resetState } from "../app.js";
import { seedFixture, type Fixture } from "../helpers.js";
import { staffToken } from "../tokens.js";

describe("GET /v1/staff/audit", () => {
  let ctx: Awaited<ReturnType<typeof createIntegrationApp>>;
  let f: Fixture;
  let owner: string;
  let reception: string;
  const serviceEntityId = "11111111-1111-4111-8111-111111111111";
  const get = (path: string, token?: string) => {
    const req = request(ctx.app.getHttpServer()).get(path);
    return token ? req.set("Authorization", `Bearer ${token}`) : req;
  };

  beforeAll(async () => {
    ctx = await createIntegrationApp();
    await resetState(ctx.prisma, ctx.redis);
    f = await seedFixture(ctx.prisma);
    owner = await staffToken(ctx.app, { sub: f.staffA, org: f.orgId, role: "OWNER" });
    reception = await staffToken(ctx.app, { sub: f.staffA, org: f.orgId, role: "RECEPTION" });
    const base = Date.parse("2026-12-01T10:00:00Z");
    const rows = [
      { entity: "service", entityId: serviceEntityId, action: "service.create" },
      { entity: "resource", entityId: f.resource1, action: "resource.create" },
      { entity: "service", entityId: serviceEntityId, action: "service.update" },
    ];
    for (const [i, r] of rows.entries()) {
      await ctx.prisma.auditLog.create({
        data: { organizationId: f.orgId, actorType: "STAFF", actorId: f.staffA, ...r, ip: "203.0.113.9", at: new Date(base + i * 1000) },
      });
    }
  });
  afterAll(async () => {
    await ctx?.close();
  });

  it("returns items newest first without ip", async () => {
    const res = await get("/v1/staff/audit", owner);
    expect(res.status).toBe(200);
    expect((res.body.items as AuditItem[]).map((i) => i.action)).toEqual(["service.update", "resource.create", "service.create"]);
    expect(res.body.nextBefore).toBeNull();
    for (const item of res.body.items) expect(item).not.toHaveProperty("ip");
  });

  it("filters by entity and entityId", async () => {
    const res = await get(`/v1/staff/audit?entity=service&entityId=${serviceEntityId}`, owner);
    expect(res.body.items).toHaveLength(2);
    const other = await get("/v1/staff/audit?entity=resource", owner);
    expect(other.body.items).toHaveLength(1);
  });

  it("pages with limit and nextBefore without repeats", async () => {
    const seen: string[] = [];
    let url = "/v1/staff/audit?limit=1";
    for (let i = 0; i < 5; i++) {
      const res = await get(url, owner);
      expect(res.status).toBe(200);
      seen.push(...(res.body.items as AuditItem[]).map((it) => it.id));
      if (res.body.nextBefore === null) break;
      url = `/v1/staff/audit?limit=1&before=${encodeURIComponent(res.body.nextBefore)}`;
    }
    expect(seen).toHaveLength(3);
    expect(new Set(seen).size).toBe(3);
  });

  it("rejects an out-of-range limit", async () => {
    expect((await get("/v1/staff/audit?limit=101", owner)).status).toBe(400);
  });

  it("is OWNER only: RECEPTION 403, no token 401", async () => {
    expect((await get("/v1/staff/audit", reception)).status).toBe(403);
    expect((await get("/v1/staff/audit")).status).toBe(401);
  });
});
