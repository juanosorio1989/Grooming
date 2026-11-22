import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { sha256Hex } from "../../../src/auth/crypto/tokens.js";
import { GOOGLE_JWKS } from "../../../src/auth/google/google-jwks.js";
import { createIntegrationApp, resetState } from "../app.js";
import { createTestGoogle, TEST_GOOGLE_CLIENT_ID, type TestGoogle } from "../google.js";
import { seedFixture, type Fixture } from "../helpers.js";

type Ctx = Awaited<ReturnType<typeof createIntegrationApp>>;
type Agent = ReturnType<typeof request.agent>;

const PHONE = "+13055550200";
const PHONE_2 = "+13055550201";

function setCookies(res: request.Response): string[] {
  const raw = res.headers["set-cookie"] as unknown;
  return Array.isArray(raw) ? (raw as string[]) : typeof raw === "string" ? [raw] : [];
}

/** Value of a cookie set by the response (`name=value; ...`), or undefined. */
function cookieValue(res: request.Response, name: string): string | undefined {
  const c = setCookies(res).find((x) => x.startsWith(`${name}=`));
  return c?.slice(name.length + 1).split(";")[0];
}

describe("Google link ticket on /auth/otp/verify", () => {
  let ctx: Ctx;
  let off: Ctx;
  let f: Fixture;
  let google: TestGoogle;
  const server = () => ctx.app.getHttpServer();
  const browser = () => request.agent(server());

  /** Nonce, then an unlinked Google sign-in: returns the ticket and the `gr_glink` cookie value. */
  const getTicket = async (agent: Agent, sub = "g-sub-1"): Promise<{ ticket: string; cookie: string }> => {
    const nonceRes = await agent.post("/v1/auth/google/nonce").send({});
    expect(nonceRes.status).toBe(200);
    const res = await agent
      .post("/v1/auth/google")
      .set("x-token-transport", "body")
      .send({ idToken: await google.sign({ nonce: nonceRes.body.nonce as string, sub }) });
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("PHONE_REQUIRED");
    const cookie = cookieValue(res, "gr_glink");
    expect(cookie).toBeDefined();
    return { ticket: res.body.linkTicket as string, cookie: cookie! };
  };

  const verify = (agent: Agent, body: { phone: string; code?: string; linkTicket?: string }) =>
    agent.post("/v1/auth/otp/verify").set("x-token-transport", "body").send({ code: "000000", ...body });

  const createCustomer = (data: { phone: string; name?: string | null; email?: string | null }) =>
    ctx.prisma.customer.create({
      data: {
        organizationId: f.orgId,
        phoneE164: data.phone,
        name: data.name === undefined ? "Existing Name" : data.name,
        email: data.email ?? null,
        locale: "en",
        createdVia: "ONLINE",
      },
    });

  const expectSignedIn = (res: request.Response) => {
    expect(res.status).toBe(200);
    expect(res.body.accessToken).toEqual(expect.any(String));
    expect(res.body.refreshToken).toEqual(expect.any(String));
  };

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
    await ctx.prisma.outboxEvent.deleteMany();
    await ctx.prisma.customerIdentity.deleteMany();
    await ctx.prisma.customer.deleteMany({ where: { id: { not: f.customerId } } });
    await ctx.prisma.organization.deleteMany({ where: { id: { not: f.orgId } } });
  });
  afterAll(async () => {
    await ctx?.close();
    await off?.close();
  });

  it("wrong code with a ticket → 400 OTP_INVALID; the same ticket still links on the next valid verify", async () => {
    const agent = browser();
    const { ticket } = await getTicket(agent);
    const bad = await verify(agent, { phone: PHONE, code: "111111", linkTicket: ticket });
    expect(bad.status).toBe(400);
    expect(bad.body.code).toBe("OTP_INVALID");
    const good = await verify(agent, { phone: PHONE, linkTicket: ticket });
    expectSignedIn(good);
    expect(good.body.identityLinked).toBe(true);
  });

  it("valid code, new phone → signed in, identity row, name and email from Google, no outbox row", async () => {
    const agent = browser();
    const { ticket } = await getTicket(agent);
    const res = await verify(agent, { phone: PHONE, linkTicket: ticket });
    expectSignedIn(res);
    expect(res.body.identityLinked).toBe(true);
    const customer = await ctx.prisma.customer.findFirstOrThrow({ where: { organizationId: f.orgId, phoneE164: PHONE } });
    expect(customer.name).toBe("Ana Pérez");
    expect(customer.email).toBe("owner@gmail.com");
    const identities = await ctx.prisma.customerIdentity.findMany();
    expect(identities).toHaveLength(1);
    expect(identities[0]).toMatchObject({
      organizationId: f.orgId,
      customerId: customer.id,
      provider: "GOOGLE",
      subject: "g-sub-1",
      email: "owner@gmail.com",
    });
    expect(await ctx.prisma.outboxEvent.count()).toBe(0);
  });

  it("existing customer with an email keeps it; outbox row carries notifyEmail = the old email", async () => {
    const customer = await createCustomer({ phone: PHONE, email: "old@example.com" });
    const agent = browser();
    const { ticket } = await getTicket(agent);
    const res = await verify(agent, { phone: PHONE, linkTicket: ticket });
    expectSignedIn(res);
    expect(res.body.identityLinked).toBe(true);
    const after = await ctx.prisma.customer.findUniqueOrThrow({ where: { id: customer.id } });
    expect(after.email).toBe("old@example.com");
    const rows = await ctx.prisma.outboxEvent.findMany();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      organizationId: f.orgId,
      type: "customer.identity_linked",
      processedAt: null,
      payload: { customerId: customer.id, googleEmail: "owner@gmail.com", notifyEmail: "old@example.com" },
    });
  });

  it("existing customer with no email → outbox notifyEmail null and customer.email set to the Google email", async () => {
    const customer = await createCustomer({ phone: PHONE, email: null });
    const agent = browser();
    const { ticket } = await getTicket(agent);
    const res = await verify(agent, { phone: PHONE, linkTicket: ticket });
    expect(res.body.identityLinked).toBe(true);
    const after = await ctx.prisma.customer.findUniqueOrThrow({ where: { id: customer.id } });
    expect(after.email).toBe("owner@gmail.com");
    const rows = await ctx.prisma.outboxEvent.findMany();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.payload).toEqual({ customerId: customer.id, googleEmail: "owner@gmail.com", notifyEmail: null });
  });

  it("existing customer with a name keeps it", async () => {
    const customer = await createCustomer({ phone: PHONE, name: "Existing Name" });
    const agent = browser();
    const { ticket } = await getTicket(agent);
    const res = await verify(agent, { phone: PHONE, linkTicket: ticket });
    expect(res.body.identityLinked).toBe(true);
    expect(res.body.isNew).toBe(false);
    const after = await ctx.prisma.customer.findUniqueOrThrow({ where: { id: customer.id } });
    expect(after.name).toBe("Existing Name");
  });

  it("sub already linked to this customer → identityLinked true, identity email refreshed, no outbox row", async () => {
    // The ticket is minted while the sub is unlinked; the link appears before the verify (e.g. from another tab).
    const agent = browser();
    const { ticket } = await getTicket(agent);
    const customer = await createCustomer({ phone: PHONE });
    await ctx.prisma.customerIdentity.create({
      data: { organizationId: f.orgId, customerId: customer.id, provider: "GOOGLE", subject: "g-sub-1", email: "prev@gmail.com" },
    });
    const res = await verify(agent, { phone: PHONE, linkTicket: ticket });
    expectSignedIn(res);
    expect(res.body.identityLinked).toBe(true);
    const identities = await ctx.prisma.customerIdentity.findMany();
    expect(identities).toHaveLength(1);
    expect(identities[0]!.email).toBe("owner@gmail.com");
    expect(await ctx.prisma.outboxEvent.count()).toBe(0);
    expect(await ctx.prisma.auditLog.count({ where: { action: "auth.customer.identity_linked" } })).toBe(0);
  });

  describe("unusable ticket → signed in by phone, identityLinked false, no identity row", () => {
    const cases: [string, () => Promise<request.Response>][] = [
      [
        "expired ticket (Redis key deleted)",
        async () => {
          const agent = browser();
          const { ticket } = await getTicket(agent);
          await ctx.redis.del(`gauth:ticket:${sha256Hex(ticket)}`);
          return verify(agent, { phone: PHONE, linkTicket: ticket });
        },
      ],
      [
        "reused ticket (cookie re-sent explicitly)",
        async () => {
          const agent = browser();
          const { ticket, cookie } = await getTicket(agent);
          const first = await verify(agent, { phone: PHONE_2, linkTicket: ticket });
          expect(first.body.identityLinked).toBe(true);
          await ctx.prisma.customerIdentity.deleteMany();
          return request(server())
            .post("/v1/auth/otp/verify")
            .set("x-token-transport", "body")
            .set("Cookie", `gr_glink=${cookie}`)
            .send({ phone: PHONE, code: "000000", linkTicket: ticket });
        },
      ],
      [
        "no gr_glink cookie",
        async () => {
          const { ticket } = await getTicket(browser());
          return request(server())
            .post("/v1/auth/otp/verify")
            .set("x-token-transport", "body")
            .send({ phone: PHONE, code: "000000", linkTicket: ticket });
        },
      ],
      [
        "cookie from another agent",
        async () => {
          const { ticket } = await getTicket(browser());
          const other = browser();
          await getTicket(other, "g-sub-other");
          return verify(other, { phone: PHONE, linkTicket: ticket });
        },
      ],
      [
        "ticket minted for another organization",
        async () => {
          const otherOrg = await ctx.prisma.organization.create({
            data: { name: "Other Grooming", slug: "other-salon", defaultLocale: "en" },
          });
          const agent = browser();
          const { ticket } = await getTicket(agent);
          const key = `gauth:ticket:${sha256Hex(ticket)}`;
          const stored = JSON.parse((await ctx.redis.get(key))!) as Record<string, unknown>;
          await ctx.redis.set(key, JSON.stringify({ ...stored, orgId: otherOrg.id }), "EX", 600);
          return verify(agent, { phone: PHONE, linkTicket: ticket });
        },
      ],
    ];

    it.each(cases)("%s", async (_label, run) => {
      const res = await run();
      expectSignedIn(res);
      expect(res.body.identityLinked).toBe(false);
      const customer = await ctx.prisma.customer.findFirstOrThrow({ where: { organizationId: f.orgId, phoneE164: PHONE } });
      expect(await ctx.prisma.customerIdentity.count({ where: { customerId: customer.id } })).toBe(0);
      expect(await ctx.prisma.customerIdentity.count({ where: { subject: "g-sub-1" } })).toBe(0);
    });
  });

  it("sub linked to another customer meanwhile → identityLinked false", async () => {
    const agent = browser();
    const { ticket } = await getTicket(agent);
    const other = await createCustomer({ phone: PHONE_2 });
    await ctx.prisma.customerIdentity.create({
      data: { organizationId: f.orgId, customerId: other.id, provider: "GOOGLE", subject: "g-sub-1", email: "owner@gmail.com" },
    });
    const res = await verify(agent, { phone: PHONE, linkTicket: ticket });
    expectSignedIn(res);
    expect(res.body.identityLinked).toBe(false);
    const identities = await ctx.prisma.customerIdentity.findMany();
    expect(identities).toHaveLength(1);
    expect(identities[0]!.customerId).toBe(other.id);
    expect(await ctx.prisma.outboxEvent.count()).toBe(0);
  });

  it("customer already has another Google account → identityLinked false", async () => {
    const customer = await createCustomer({ phone: PHONE });
    await ctx.prisma.customerIdentity.create({
      data: { organizationId: f.orgId, customerId: customer.id, provider: "GOOGLE", subject: "g-sub-x", email: "x@gmail.com" },
    });
    const agent = browser();
    const { ticket } = await getTicket(agent);
    const res = await verify(agent, { phone: PHONE, linkTicket: ticket });
    expectSignedIn(res);
    expect(res.body.identityLinked).toBe(false);
    const identities = await ctx.prisma.customerIdentity.findMany();
    expect(identities).toHaveLength(1);
    expect(identities[0]!.subject).toBe("g-sub-x");
    expect(await ctx.prisma.outboxEvent.count()).toBe(0);
  });

  it("two concurrent verifies (different phones, same sub) → both 200, one identity row, one identityLinked true", async () => {
    const a = browser();
    const b = browser();
    const ta = await getTicket(a);
    const tb = await getTicket(b);
    const [ra, rb] = await Promise.all([
      verify(a, { phone: PHONE, linkTicket: ta.ticket }),
      verify(b, { phone: PHONE_2, linkTicket: tb.ticket }),
    ]);
    expectSignedIn(ra);
    expectSignedIn(rb);
    expect([ra.body.identityLinked, rb.body.identityLinked].filter((x) => x === true)).toHaveLength(1);
    expect([ra.body.identityLinked, rb.body.identityLinked].filter((x) => x === false)).toHaveLength(1);
    expect(await ctx.prisma.customerIdentity.count({ where: { subject: "g-sub-1" } })).toBe(1);
  });

  it("feature off → linkTicket ignored, response has no identityLinked key", async () => {
    const res = await request(off.app.getHttpServer())
      .post("/v1/auth/otp/verify")
      .set("x-token-transport", "body")
      .send({ phone: PHONE, code: "000000", linkTicket: "some-ticket-value" });
    expectSignedIn(res);
    expect(res.body).not.toHaveProperty("identityLinked");
    expect(await ctx.prisma.customerIdentity.count()).toBe(0);
  });

  it("no linkTicket → response has no identityLinked key", async () => {
    const res = await verify(browser(), { phone: PHONE });
    expectSignedIn(res);
    expect(res.body).not.toHaveProperty("identityLinked");
  });

  it("a misspelled linkTicket key → 400 VALIDATION_FAILED", async () => {
    const res = await request(server())
      .post("/v1/auth/otp/verify")
      .send({ phone: PHONE, code: "000000", linkticket: "x" });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe("VALIDATION_FAILED");
  });

  it("link writes audit auth.customer.identity_linked with after {provider:\"GOOGLE\"} and no secret", async () => {
    const customer = await createCustomer({ phone: PHONE, email: "old@example.com" });
    const agent = browser();
    const { ticket, cookie } = await getTicket(agent);
    const res = await verify(agent, { phone: PHONE, linkTicket: ticket });
    expect(res.body.identityLinked).toBe(true);
    const audits = await ctx.prisma.auditLog.findMany({ where: { action: "auth.customer.identity_linked" } });
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({
      organizationId: f.orgId,
      actorType: "CUSTOMER",
      actorId: customer.id,
      entity: "customer",
      entityId: customer.id,
      after: { provider: "GOOGLE" },
    });
    const rows = await ctx.prisma.$queryRaw<{ row: string }[]>`SELECT row_to_json(a)::text AS row FROM audit_log a`;
    for (const r of rows) {
      for (const s of ["g-sub-1", ticket, cookie]) expect(r.row).not.toContain(s);
    }
  });
});
