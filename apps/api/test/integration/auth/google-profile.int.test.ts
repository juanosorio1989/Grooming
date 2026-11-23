import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { GOOGLE_JWKS } from "../../../src/auth/google/google-jwks.js";
import { createIntegrationApp, resetState } from "../app.js";
import { createTestGoogle, TEST_GOOGLE_CLIENT_ID, type TestGoogle } from "../google.js";
import { seedFixture, type Fixture } from "../helpers.js";
import { customerToken, staffToken } from "../tokens.js";

type Ctx = Awaited<ReturnType<typeof createIntegrationApp>>;
type Agent = ReturnType<typeof request.agent>;

const PATH = "/v1/me/identities/google";

describe("Profile link/unlink of a Google account", () => {
  let ctx: Ctx;
  let off: Ctx;
  let f: Fixture;
  let google: TestGoogle;
  let token: string;
  const browser = () => request.agent(ctx.app.getHttpServer());

  /** Fetches a nonce on this agent (sets `gr_gnonce`) and returns a signed ID token carrying it. */
  const idTokenFor = async (agent: Agent, sub = "g-sub-1", email = "owner@gmail.com"): Promise<string> => {
    const nonceRes = await agent.post("/v1/auth/google/nonce").send({});
    expect(nonceRes.status).toBe(200);
    return google.sign({ nonce: nonceRes.body.nonce as string, sub, email });
  };

  /** The nonce comes first: an agent attaches its cookies when the request is created. */
  const link = async (agent: Agent, sub?: string, email?: string) => {
    const idToken = await idTokenFor(agent, sub, email);
    return agent.post(PATH).set("Authorization", `Bearer ${token}`).send({ idToken });
  };

  const otherCustomer = () =>
    ctx.prisma.customer.create({
      data: { organizationId: f.orgId, phoneE164: "+13055550299", name: "Other", locale: "en", createdVia: "ONLINE" },
    });

  beforeAll(async () => {
    google = await createTestGoogle();
    ctx = await createIntegrationApp({
      env: { GOOGLE_OAUTH_CLIENT_IDS: TEST_GOOGLE_CLIENT_ID },
      override: (b) => b.overrideProvider(GOOGLE_JWKS).useValue(google.jwks),
    });
    off = await createIntegrationApp({
      override: (b) => b.overrideProvider(GOOGLE_JWKS).useValue(google.jwks),
    });
    // Seeded once: TenancyService caches the org id for the app's lifetime.
    await resetState(ctx.prisma, ctx.redis);
    f = await seedFixture(ctx.prisma);
    token = await customerToken(ctx.app, { sub: f.customerId, org: f.orgId });
  });
  beforeEach(async () => {
    await ctx.redis.flushdb();
    await ctx.prisma.auditLog.deleteMany();
    await ctx.prisma.outboxEvent.deleteMany();
    await ctx.prisma.customerIdentity.deleteMany();
    await ctx.prisma.customer.deleteMany({ where: { id: { not: f.customerId } } });
  });
  afterAll(async () => {
    await ctx?.close();
    await off?.close();
  });

  it("link with nonce cookie → 204; GET /me identities [{provider:\"GOOGLE\",email:\"owner@gmail.com\"}]; outbox row written", async () => {
    const before = await request(ctx.app.getHttpServer()).get("/v1/me").set("Authorization", `Bearer ${token}`);
    expect(before.body.identities).toEqual([]);

    const res = await link(browser());
    expect(res.status).toBe(204);

    const me = await request(ctx.app.getHttpServer()).get("/v1/me").set("Authorization", `Bearer ${token}`);
    expect(me.status).toBe(200);
    expect(me.body.identities).toEqual([{ provider: "GOOGLE", email: "owner@gmail.com" }]);

    const patched = await request(ctx.app.getHttpServer())
      .patch("/v1/me")
      .set("Authorization", `Bearer ${token}`)
      .send({ locale: "es" });
    expect(patched.status).toBe(200);
    expect(patched.body.identities).toEqual([{ provider: "GOOGLE", email: "owner@gmail.com" }]);

    const rows = await ctx.prisma.outboxEvent.findMany();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ type: "customer.identity_linked", payload: { customerId: f.customerId } });
    const audits = await ctx.prisma.auditLog.findMany({ where: { action: "auth.customer.identity_linked" } });
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({ actorType: "CUSTOMER", actorId: f.customerId, after: { provider: "GOOGLE" } });
    expect(JSON.stringify(audits)).not.toContain("g-sub-1");
  });

  it("link outbox payload equals {customerId, googleEmail, notifyEmail}", async () => {
    const before = await ctx.prisma.customer.findUniqueOrThrow({ where: { id: f.customerId }, select: { email: true } });
    const res = await link(browser());
    expect(res.status).toBe(204);
    const rows = await ctx.prisma.outboxEvent.findMany();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.payload).toEqual({ customerId: f.customerId, googleEmail: "owner@gmail.com", notifyEmail: before.email });
  });

  it("link without the gr_gnonce cookie → 401", async () => {
    const idToken = await idTokenFor(browser());
    const res = await request(ctx.app.getHttpServer())
      .post(PATH)
      .set("Authorization", `Bearer ${token}`)
      .send({ idToken });
    expect(res.status).toBe(401);
    expect(await ctx.prisma.customerIdentity.count()).toBe(0);
  });

  it("a soft-deleted customer cannot link → 404 NOT_FOUND, no identity or outbox rows", async () => {
    await ctx.prisma.customer.update({ where: { id: f.customerId }, data: { deletedAt: new Date() } });
    try {
      const res = await link(browser());
      expect(res.status).toBe(404);
      expect(res.body.code).toBe("NOT_FOUND");
      expect(await ctx.prisma.customerIdentity.count({ where: { customerId: f.customerId } })).toBe(0);
      expect(await ctx.prisma.outboxEvent.count()).toBe(0);
    } finally {
      await ctx.prisma.customer.update({ where: { id: f.customerId }, data: { deletedAt: null } });
    }
  });

  it("link the same account again → 204, no second outbox row", async () => {
    expect((await link(browser())).status).toBe(204);
    expect((await link(browser(), "g-sub-1", "new@gmail.com")).status).toBe(204);
    expect(await ctx.prisma.outboxEvent.count()).toBe(1);
    expect(await ctx.prisma.customerIdentity.count()).toBe(1);
    expect((await ctx.prisma.customerIdentity.findFirstOrThrow()).email).toBe("new@gmail.com");
  });

  it("409 IDENTITY_TAKEN when the sub belongs to another customer, and when this customer has another Google account; the two response bodies are deep-equal", async () => {
    const other = await otherCustomer();
    await ctx.prisma.customerIdentity.create({
      data: { organizationId: f.orgId, customerId: other.id, provider: "GOOGLE", subject: "g-sub-taken", email: "x@gmail.com" },
    });
    const bySub = await link(browser(), "g-sub-taken");
    expect(bySub.status).toBe(409);
    expect(bySub.body.code).toBe("IDENTITY_TAKEN");

    expect((await link(browser(), "g-sub-mine")).status).toBe(204);
    const byCustomer = await link(browser(), "g-sub-second");
    expect(byCustomer.status).toBe(409);
    expect(byCustomer.body.code).toBe("IDENTITY_TAKEN");

    expect(byCustomer.body).toEqual(bySub.body);
    expect(await ctx.prisma.customerIdentity.count()).toBe(2);
  });

  it("unlink → 204 and audit identity_unlinked; unlink with nothing linked → 204 and no audit row", async () => {
    expect((await link(browser())).status).toBe(204);
    const res = await request(ctx.app.getHttpServer()).delete(PATH).set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(204);
    expect(await ctx.prisma.customerIdentity.count()).toBe(0);
    const audits = await ctx.prisma.auditLog.findMany({ where: { action: "auth.customer.identity_unlinked" } });
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({
      organizationId: f.orgId,
      actorType: "CUSTOMER",
      actorId: f.customerId,
      entity: "customer",
      entityId: f.customerId,
      after: { provider: "GOOGLE" },
    });

    const again = await request(ctx.app.getHttpServer()).delete(PATH).set("Authorization", `Bearer ${token}`);
    expect(again.status).toBe(204);
    expect(await ctx.prisma.auditLog.count({ where: { action: "auth.customer.identity_unlinked" } })).toBe(1);
  });

  it("unlink leaves another customer's identity alone", async () => {
    const other = await otherCustomer();
    await ctx.prisma.customerIdentity.create({
      data: { organizationId: f.orgId, customerId: other.id, provider: "GOOGLE", subject: "g-sub-other", email: "x@gmail.com" },
    });
    expect((await request(ctx.app.getHttpServer()).delete(PATH).set("Authorization", `Bearer ${token}`)).status).toBe(204);
    expect(await ctx.prisma.customerIdentity.count()).toBe(1);
    expect(await ctx.prisma.auditLog.count({ where: { action: "auth.customer.identity_unlinked" } })).toBe(0);
  });

  it("staff token → 403; no token → 401; feature off → 404 for POST and DELETE", async () => {
    const staff = await staffToken(ctx.app, { sub: f.staffA, org: f.orgId, role: "OWNER" });
    const server = ctx.app.getHttpServer();
    expect((await request(server).post(PATH).set("Authorization", `Bearer ${staff}`).send({ idToken: "x" })).status).toBe(403);
    expect((await request(server).delete(PATH).set("Authorization", `Bearer ${staff}`)).status).toBe(403);
    expect((await request(server).post(PATH).send({ idToken: "x" })).status).toBe(401);
    expect((await request(server).delete(PATH)).status).toBe(401);

    const offToken = await customerToken(off.app, { sub: f.customerId, org: f.orgId });
    const offServer = off.app.getHttpServer();
    const post = await request(offServer).post(PATH).set("Authorization", `Bearer ${offToken}`).send({ idToken: "x" });
    expect(post.status).toBe(404);
    expect(post.body.code).toBe("NOT_FOUND");
    const del = await request(offServer).delete(PATH).set("Authorization", `Bearer ${offToken}`);
    expect(del.status).toBe(404);
    expect(del.body.code).toBe("NOT_FOUND");
  });

  it("6th POST in an hour → 429", async () => {
    for (let i = 0; i < 5; i++) expect((await link(browser())).status).toBe(204);
    const res = await link(browser());
    expect(res.status).toBe(429);
    expect(res.body.code).toBe("RATE_LIMITED");
  });

  it("6th DELETE in an hour → 429", async () => {
    const server = ctx.app.getHttpServer();
    for (let i = 0; i < 5; i++) expect((await request(server).delete(PATH).set("Authorization", `Bearer ${token}`)).status).toBe(204);
    const res = await request(server).delete(PATH).set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(429);
    expect(res.body.code).toBe("RATE_LIMITED");
  });
});
