import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { GOOGLE_JWKS } from "../../../src/auth/google/google-jwks.js";
import { createIntegrationApp, resetState } from "../app.js";
import { createTestGoogle, TEST_GOOGLE_CLIENT_ID, type TestGoogle } from "../google.js";
import { seedFixture, type Fixture } from "../helpers.js";

type Ctx = Awaited<ReturnType<typeof createIntegrationApp>>;
type Agent = ReturnType<typeof request.agent>;

function setCookies(res: request.Response): string[] {
  const raw = res.headers["set-cookie"] as unknown;
  return Array.isArray(raw) ? (raw as string[]) : typeof raw === "string" ? [raw] : [];
}

function cookieNamed(res: request.Response, name: string): string | undefined {
  return setCookies(res).find((c) => c.startsWith(`${name}=`));
}

describe("Google sign-in (fake JWKS)", () => {
  let ctx: Ctx;
  let off: Ctx;
  let f: Fixture;
  let google: TestGoogle;
  const server = () => ctx.app.getHttpServer();

  /** A fresh browser: a supertest agent that keeps cookies. */
  const browser = () => request.agent(server());
  const getNonce = async (agent: Agent): Promise<string> => {
    const res = await agent.post("/v1/auth/google/nonce").send({});
    expect(res.status).toBe(200);
    return res.body.nonce as string;
  };
  const signIn = (agent: Agent, idToken: string) =>
    agent.post("/v1/auth/google").set("x-token-transport", "body").send({ idToken });

  const createCustomer = (data: { phone: string; name?: string | null; email?: string; deleted?: boolean }) =>
    ctx.prisma.customer.create({
      data: {
        organizationId: f.orgId,
        phoneE164: data.phone,
        name: data.name === undefined ? "Ana Pérez" : data.name,
        email: data.email ?? null,
        locale: "en",
        createdVia: "ONLINE",
        deletedAt: data.deleted ? new Date() : null,
      },
    });
  const linkIdentity = (customerId: string, email = "old@gmail.com") =>
    ctx.prisma.customerIdentity.create({
      data: { organizationId: f.orgId, customerId, provider: "GOOGLE", subject: "g-sub-1", email },
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
  });
  beforeEach(async () => {
    await ctx.redis.flushdb();
    await ctx.prisma.auditLog.deleteMany();
    await ctx.prisma.refreshToken.deleteMany();
    await ctx.prisma.customerIdentity.deleteMany();
    await ctx.prisma.customer.deleteMany({ where: { id: { not: f.customerId } } });
  });
  afterAll(async () => {
    await ctx?.close();
    await off?.close();
  });

  it("nonce sets gr_gnonce (HttpOnly, SameSite=Strict, Path=/v1) and returns a nonce", async () => {
    const res = await request(server()).post("/v1/auth/google/nonce").send({});
    expect(res.status).toBe(200);
    expect(typeof res.body.nonce).toBe("string");
    expect(res.body.nonce.length).toBeGreaterThanOrEqual(32);
    const cookie = cookieNamed(res, "gr_gnonce");
    expect(cookie).toBeDefined();
    expect(cookie).toMatch(/; Path=\/v1(;|$)/);
    expect(cookie).toMatch(/; HttpOnly/);
    expect(cookie).toMatch(/; SameSite=Strict/);
    expect(cookie).toMatch(/; Max-Age=600/);
    // The cookie holds the binding value, not the nonce.
    expect(cookie).not.toContain(res.body.nonce);
  });

  it("unknown sub → 200 PHONE_REQUIRED with linkTicket, name and givenName, and a gr_glink cookie on Path=/v1/auth", async () => {
    const agent = browser();
    const nonce = await getNonce(agent);
    const res = await signIn(agent, await google.sign({ nonce }));
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      status: "PHONE_REQUIRED",
      linkTicket: expect.any(String),
      name: "Ana Pérez",
      givenName: "Ana",
    });
    const cookie = cookieNamed(res, "gr_glink");
    expect(cookie).toBeDefined();
    expect(cookie).toMatch(/; Path=\/v1\/auth(;|$)/);
    expect(cookie).toMatch(/; HttpOnly/);
    expect(cookie).toMatch(/; SameSite=Strict/);
    expect(await ctx.prisma.customerIdentity.count()).toBe(0);
    expect(await ctx.prisma.refreshToken.count()).toBe(0);
  });

  it("PHONE_REQUIRED omits name and givenName when the token has neither", async () => {
    const agent = browser();
    const nonce = await getNonce(agent);
    const res = await signIn(agent, await google.sign({ nonce, name: undefined, given_name: undefined }));
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: "PHONE_REQUIRED", linkTicket: expect.any(String) });
  });

  it("linked sub → 200 SIGNED_IN with isNew false; identity email refreshed; audit auth.customer.login", async () => {
    const customer = await createCustomer({ phone: "+13055550120" });
    await linkIdentity(customer.id);
    const agent = browser();
    const nonce = await getNonce(agent);
    const res = await signIn(agent, await google.sign({ nonce }));
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      status: "SIGNED_IN",
      accessToken: expect.any(String),
      accessTokenExpiresAt: expect.any(String),
      refreshToken: expect.any(String),
      isNew: false,
    });
    const identity = await ctx.prisma.customerIdentity.findFirstOrThrow({ where: { customerId: customer.id } });
    expect(identity.email).toBe("owner@gmail.com");
    const audits = await ctx.prisma.auditLog.findMany({ where: { action: "auth.customer.login" } });
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({
      actorType: "CUSTOMER",
      actorId: customer.id,
      entity: "customer",
      entityId: customer.id,
      after: { method: "google", isNew: false },
    });
    expect(await ctx.prisma.refreshToken.count({ where: { subjectType: "CUSTOMER", subjectId: customer.id } })).toBe(1);
  });

  it("linked customer with no name → SIGNED_IN with isNew true; the web transport sets gr_refresh", async () => {
    const customer = await createCustomer({ phone: "+13055550121", name: null });
    await linkIdentity(customer.id);
    const agent = browser();
    const nonce = await getNonce(agent);
    const res = await agent.post("/v1/auth/google").send({ idToken: await google.sign({ nonce }) });
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("SIGNED_IN");
    expect(res.body.isNew).toBe(true);
    expect(res.body.refreshToken).toBeUndefined();
    expect(cookieNamed(res, "gr_refresh")).toBeDefined();
  });

  describe("401 for each failure", () => {
    const cases: [string, (agent: Agent, nonce: string) => Promise<request.Response>][] = [
      ["signature by the other key", async (a, nonce) => signIn(a, await google.sign({ nonce }, { key: "other" }))],
      ["wrong aud", async (a, nonce) => signIn(a, await google.sign({ nonce, aud: "someone-else.apps.googleusercontent.com" }))],
      ["wrong iss", async (a, nonce) => signIn(a, await google.sign({ nonce, iss: "https://evil.example.com" }))],
      ["expired", async (a, nonce) => signIn(a, await google.sign({ nonce }, { expiresInSec: -60 }))],
      ["email_verified false", async (a, nonce) => signIn(a, await google.sign({ nonce, email_verified: false }))],
      ["nonce missing from token", async (a) => signIn(a, await google.sign({}))],
      ["nonce not issued", async (a) => signIn(a, await google.sign({ nonce: "never-issued-nonce-value" }))],
      [
        "nonce reused (second sign-in with the same token)",
        async (a, nonce) => {
          const token = await google.sign({ nonce });
          expect((await signIn(a, token)).status).toBe(200);
          return signIn(a, token);
        },
      ],
      [
        "no gr_gnonce cookie",
        async (_a, nonce) =>
          request(server())
            .post("/v1/auth/google")
            .send({ idToken: await google.sign({ nonce }) }),
      ],
      [
        "cookie from another agent",
        async (_a, nonce) => {
          const other = browser();
          await getNonce(other);
          return signIn(other, await google.sign({ nonce }));
        },
      ],
      ["a garbage token", async (a) => signIn(a, "not-a-jwt")],
    ];

    it.each(cases)("%s", async (_label, run) => {
      const customer = await createCustomer({ phone: "+13055550130" });
      await linkIdentity(customer.id);
      const agent = browser();
      const nonce = await getNonce(agent);
      const res = await run(agent, nonce);
      expect(res.status).toBe(401);
      expect(res.headers["content-type"]).toMatch(/^application\/problem\+json/);
      expect(res.body.code).toBe("UNAUTHORIZED");
    });
  });

  it("a failed token check does not consume the nonce", async () => {
    const agent = browser();
    const nonce = await getNonce(agent);
    expect((await signIn(agent, await google.sign({ nonce }, { key: "other" }))).status).toBe(401);
    expect((await signIn(agent, await google.sign({ nonce }))).status).toBe(200);
  });

  it("linked customer soft-deleted → 401 and no refresh_token row created", async () => {
    const customer = await createCustomer({ phone: "+13055550140", deleted: true });
    await linkIdentity(customer.id);
    const agent = browser();
    const nonce = await getNonce(agent);
    const res = await signIn(agent, await google.sign({ nonce }));
    expect(res.status).toBe(401);
    expect(res.body.code).toBe("UNAUTHORIZED");
    expect(await ctx.prisma.refreshToken.count()).toBe(0);
    expect(await ctx.prisma.auditLog.count({ where: { action: "auth.customer.login" } })).toBe(0);
  });

  it("an existing customer with the same email as the Google account → PHONE_REQUIRED, no identity row", async () => {
    await createCustomer({ phone: "+13055550150", email: "owner@gmail.com" });
    const agent = browser();
    const nonce = await getNonce(agent);
    const res = await signIn(agent, await google.sign({ nonce }));
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("PHONE_REQUIRED");
    expect(await ctx.prisma.customerIdentity.count()).toBe(0);
    expect(await ctx.prisma.refreshToken.count()).toBe(0);
  });

  it("feature off → 404 on /auth/google/nonce and /auth/google", async () => {
    const nonceRes = await request(off.app.getHttpServer()).post("/v1/auth/google/nonce").send({});
    expect(nonceRes.status).toBe(404);
    expect(nonceRes.body.code).toBe("NOT_FOUND");
    expect(cookieNamed(nonceRes, "gr_gnonce")).toBeUndefined();
    const signInRes = await request(off.app.getHttpServer())
      .post("/v1/auth/google")
      .send({ idToken: await google.sign({ nonce: "x" }) });
    expect(signInRes.status).toBe(404);
    expect(signInRes.body.code).toBe("NOT_FOUND");
  });

  it("rejects a body with unknown fields (400 VALIDATION_FAILED)", async () => {
    const res = await request(server()).post("/v1/auth/google").send({ idToken: "x", extra: 1 });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe("VALIDATION_FAILED");
  });

  it("11th /auth/google from one IP in 10 min → 429 RATE_LIMITED", async () => {
    for (let i = 0; i < 10; i++) {
      const res = await request(server()).post("/v1/auth/google").send({ idToken: "not-a-jwt" });
      expect(res.status).toBe(401);
    }
    const res = await request(server()).post("/v1/auth/google").send({ idToken: "not-a-jwt" });
    expect(res.status).toBe(429);
    expect(res.body.code).toBe("RATE_LIMITED");
  });

  it("31st /auth/google/nonce from one IP in 10 min → 429 RATE_LIMITED", async () => {
    for (let i = 0; i < 30; i++) {
      expect((await request(server()).post("/v1/auth/google/nonce").send({})).status).toBe(200);
    }
    const res = await request(server()).post("/v1/auth/google/nonce").send({});
    expect(res.status).toBe(429);
    expect(res.body.code).toBe("RATE_LIMITED");
  });

  it("no audit row or Redis key contains the sub, the token or the nonce", async () => {
    const customer = await createCustomer({ phone: "+13055550160" });
    await linkIdentity(customer.id);
    const secrets: string[] = ["g-sub-1"];

    const linked = browser();
    const n1 = await getNonce(linked);
    const t1 = await google.sign({ nonce: n1 });
    secrets.push(n1, t1);
    expect((await signIn(linked, t1)).body.status).toBe("SIGNED_IN");

    const unlinked = browser();
    const n2 = await getNonce(unlinked);
    const t2 = await google.sign({ nonce: n2, sub: "g-sub-2" });
    secrets.push("g-sub-2", n2, t2);
    const pr = await signIn(unlinked, t2);
    expect(pr.body.status).toBe("PHONE_REQUIRED");
    secrets.push(pr.body.linkTicket as string);

    const pending = browser();
    secrets.push(await getNonce(pending));

    const rows = await ctx.prisma.$queryRaw<{ row: string }[]>`SELECT row_to_json(a)::text AS row FROM audit_log a`;
    expect(rows.length).toBeGreaterThan(0);
    const keys = await ctx.redis.keys("*");
    expect(keys.some((k) => k.startsWith("gauth:ticket:"))).toBe(true);
    expect(keys.some((k) => k.startsWith("gauth:nonce:"))).toBe(true);
    for (const s of secrets) {
      for (const r of rows) expect(r.row).not.toContain(s);
      for (const k of keys) expect(k).not.toContain(s);
    }
  });
});
