import { Controller, Get, Module } from "@nestjs/common";
import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { AccessClaims, Locale } from "@grooming/contracts";
import { CustomerAuth, Principal } from "../../../src/auth/decorators.js";
import {
  OTP_PROVIDER,
  OtpInvalidRecipientError,
  OtpProviderRateLimitedError,
  OtpProviderUnavailableError,
  type OtpProvider,
} from "../../../src/auth/otp/otp-provider.js";
import { createIntegrationApp, resetState } from "../app.js";
import { seedFixture, type Fixture } from "../helpers.js";

@Controller("test/otp")
class OtpTestController {
  @CustomerAuth()
  @Get("me")
  me(@Principal() principal: AccessClaims) {
    return principal;
  }
}

@Module({ controllers: [OtpTestController] })
class OtpTestModule {}

type Ctx = Awaited<ReturnType<typeof createIntegrationApp>>;

const NEW_PHONE = "+13055550111";

describe("customer phone OTP (fake provider)", () => {
  let ctx: Ctx;
  let f: Fixture;
  const server = () => ctx.app.getHttpServer();
  const start = (phone: string, locale: Locale = "es") =>
    request(server()).post("/v1/auth/otp/start").send({ phone, locale });
  const verify = (body: { phone: string; code: string; locale?: Locale }) =>
    request(server()).post("/v1/auth/otp/verify").set("x-token-transport", "body").send(body);

  beforeAll(async () => {
    ctx = await createIntegrationApp({ imports: [OtpTestModule] });
    // Seeded once: TenancyService caches the org id for the app's lifetime.
    await resetState(ctx.prisma, ctx.redis);
    f = await seedFixture(ctx.prisma);
  });
  beforeEach(async () => {
    await ctx.redis.flushdb();
    await ctx.prisma.auditLog.deleteMany();
    await ctx.prisma.refreshToken.deleteMany();
    await ctx.prisma.customer.deleteMany({ where: { id: { not: f.customerId } } });
  });
  afterAll(async () => {
    await ctx?.close();
  });

  it("start answers 200 with channel whatsapp", async () => {
    const res = await start("+13055550100");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ channel: "whatsapp" });
  });

  it("start rejects a non-US phone with VALIDATION_FAILED on path phone", async () => {
    const res = await start("+443055550100");
    expect(res.status).toBe(400);
    expect(res.headers["content-type"]).toMatch(/^application\/problem\+json/);
    expect(res.body.code).toBe("VALIDATION_FAILED");
    expect(res.body.errors[0].path).toBe("phone");
    expect(res.body.detail).toBe("Only US phone numbers are supported");
  });

  it.each([
    ["one digit short", "+1305555010"],
    ["area code starting with 0", "+10055550100"],
    ["area code starting with 1", "+11055550100"],
    ["exchange starting with 1", "+13051550100"],
    ["one digit long", "+130555501000"],
  ])("start rejects a malformed +1 number (%s) with VALIDATION_FAILED on phone", async (_label, phone) => {
    const res = await start(phone);
    expect(res.status).toBe(400);
    expect(res.body.code).toBe("VALIDATION_FAILED");
    expect(res.body.errors[0].path).toBe("phone");
  });

  it("verify rejects a malformed +1 number with VALIDATION_FAILED on phone", async () => {
    const res = await verify({ phone: "+1305555010", code: "000000" });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe("VALIDATION_FAILED");
    expect(res.body.errors[0].path).toBe("phone");
  });

  it("start rejects a non-E.164 phone with VALIDATION_FAILED", async () => {
    const res = await start("305-555-0100");
    expect(res.status).toBe(400);
    expect(res.body.code).toBe("VALIDATION_FAILED");
  });

  it("the 4th start for the same phone within 10 min is 429 RATE_LIMITED", async () => {
    for (let i = 0; i < 3; i++) expect((await start(NEW_PHONE)).status).toBe(200);
    const res = await start(NEW_PHONE);
    expect(res.status).toBe(429);
    expect(res.body.code).toBe("RATE_LIMITED");
    // Another phone is not affected.
    expect((await start("+13055550122")).status).toBe(200);
  });

  it("the 11th start from one IP within an hour is 429", async () => {
    for (let i = 0; i < 10; i++) expect((await start(`+130555502${String(i).padStart(2, "0")}`)).status).toBe(200);
    const res = await start("+13055550299");
    expect(res.status).toBe(429);
    expect(res.body.code).toBe("RATE_LIMITED");
  });

  it("rate-limit keys never contain the raw phone", async () => {
    await start(NEW_PHONE);
    const keys = await ctx.redis.keys("*");
    expect(keys.length).toBeGreaterThan(0);
    for (const k of keys) expect(k).not.toContain("3055550111");
  });

  it("verify with a wrong code is 400 OTP_INVALID and creates nothing", async () => {
    const res = await verify({ phone: NEW_PHONE, code: "123456" });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe("OTP_INVALID");
    expect(await ctx.prisma.customer.count({ where: { phoneE164: NEW_PHONE } })).toBe(0);
  });

  it("verify creates the customer, audits the login and returns a working token", async () => {
    const res = await verify({ phone: NEW_PHONE, code: "000000", locale: "es" });
    expect(res.status).toBe(200);
    expect(res.body.isNew).toBe(true);
    expect(typeof res.body.accessToken).toBe("string");
    expect(typeof res.body.refreshToken).toBe("string");

    const customer = await ctx.prisma.customer.findUniqueOrThrow({
      where: { organizationId_phoneE164: { organizationId: f.orgId, phoneE164: NEW_PHONE } },
    });
    expect(customer.locale).toBe("es");
    expect(customer.phoneVerifiedAt).toBeInstanceOf(Date);
    expect(customer.createdVia).toBe("ONLINE");
    expect(customer.name).toBeNull();
    expect(await ctx.prisma.notificationConsent.count({ where: { customerId: customer.id } })).toBe(0);

    const audit = await ctx.prisma.auditLog.findMany({ where: { action: "auth.customer.login" } });
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({ actorType: "CUSTOMER", actorId: customer.id, entity: "customer", entityId: customer.id });
    expect(audit[0]!.after).toEqual({ isNew: true });

    const me = await request(server()).get("/v1/test/otp/me").set("Authorization", `Bearer ${res.body.accessToken}`);
    expect(me.status).toBe(200);
    expect(me.body).toMatchObject({ sub: customer.id, typ: "customer", role: "CUSTOMER", org: f.orgId });
  });

  it("verify without a locale uses the organization's default locale", async () => {
    const res = await verify({ phone: NEW_PHONE, code: "000000" });
    expect(res.status).toBe(200);
    const customer = await ctx.prisma.customer.findFirstOrThrow({ where: { phoneE164: NEW_PHONE } });
    expect(customer.locale).toBe("en");
  });

  it("a second verify after setting the name is isNew false, still one customer row", async () => {
    expect((await verify({ phone: NEW_PHONE, code: "000000", locale: "es" })).body.isNew).toBe(true);
    await ctx.prisma.customer.updateMany({ where: { phoneE164: NEW_PHONE }, data: { name: "Bea" } });
    const res = await verify({ phone: NEW_PHONE, code: "000000", locale: "en" });
    expect(res.status).toBe(200);
    expect(res.body.isNew).toBe(false);
    const rows = await ctx.prisma.customer.findMany({ where: { phoneE164: NEW_PHONE } });
    expect(rows).toHaveLength(1);
    // An existing customer's locale is not overwritten by the request.
    expect(rows[0]!.locale).toBe("es");
  });

  it("verify for a soft-deleted customer is 401 UNAUTHORIZED and leaves the row untouched", async () => {
    await ctx.prisma.customer.create({
      data: { organizationId: f.orgId, phoneE164: NEW_PHONE, locale: "en", createdVia: "ONLINE", deletedAt: new Date() },
    });
    const res = await verify({ phone: NEW_PHONE, code: "000000" });
    expect(res.status).toBe(401);
    expect(res.body.code).toBe("UNAUTHORIZED");
    const row = await ctx.prisma.customer.findFirstOrThrow({ where: { phoneE164: NEW_PHONE } });
    expect(row.phoneVerifiedAt).toBeNull();
    expect(await ctx.prisma.auditLog.count({ where: { action: "auth.customer.login" } })).toBe(0);
  });

  it("verify rejects a non-US phone with VALIDATION_FAILED", async () => {
    const res = await verify({ phone: "+443055550100", code: "000000" });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe("VALIDATION_FAILED");
    expect(await ctx.prisma.customer.count({ where: { phoneE164: "+443055550100" } })).toBe(0);
  });

  it("the 6th verify for the same phone within 10 min is 429", async () => {
    for (let i = 0; i < 5; i++) expect((await verify({ phone: NEW_PHONE, code: "123456" })).status).toBe(400);
    const res = await verify({ phone: NEW_PHONE, code: "000000" });
    expect(res.status).toBe(429);
    expect(res.body.code).toBe("RATE_LIMITED");
  });
});

describe("customer phone OTP channel fallback", () => {
  let ctx: Ctx | undefined;

  const withProvider = async (provider: OtpProvider) => {
    ctx = await createIntegrationApp({ override: (b) => b.overrideProvider(OTP_PROVIDER).useValue(provider) });
    await resetState(ctx.prisma, ctx.redis);
    await seedFixture(ctx.prisma);
    return ctx;
  };
  const start = (c: Ctx) =>
    request(c.app.getHttpServer()).post("/v1/auth/otp/start").send({ phone: NEW_PHONE, locale: "en" });

  afterAll(async () => {
    await ctx?.close();
  });

  it("falls back to sms when whatsapp throws", async () => {
    const channels: string[] = [];
    const c = await withProvider({
      start: async (_phone, channel) => {
        channels.push(channel);
        if (channel === "whatsapp") throw new Error("whatsapp down");
      },
      check: async () => false,
    });
    const res = await start(c);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ channel: "sms" });
    expect(channels).toEqual(["whatsapp", "sms"]);
    await c.close();
    ctx = undefined;
  });

  it("falls back to sms when whatsapp is unavailable", async () => {
    const channels: string[] = [];
    const c = await withProvider({
      start: async (_phone, channel) => {
        channels.push(channel);
        if (channel === "whatsapp") throw new OtpProviderUnavailableError("whatsapp: 503");
      },
      check: async () => false,
    });
    const res = await start(c);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ channel: "sms" });
    expect(channels).toEqual(["whatsapp", "sms"]);
    await c.close();
    ctx = undefined;
  });

  it("an invalid recipient on whatsapp (channel config error) falls back to sms", async () => {
    const channels: string[] = [];
    const c = await withProvider({
      start: async (_phone, channel) => {
        channels.push(channel);
        if (channel === "whatsapp") throw new OtpInvalidRecipientError("start: 400");
      },
      check: async () => false,
    });
    const res = await start(c);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ channel: "sms" });
    expect(channels).toEqual(["whatsapp", "sms"]);
    await c.close();
    ctx = undefined;
  });

  it("an invalid recipient on sms is 400 VALIDATION_FAILED on phone", async () => {
    const channels: string[] = [];
    const c = await withProvider({
      start: async (_phone, channel) => {
        channels.push(channel);
        if (channel === "whatsapp") throw new OtpProviderUnavailableError("whatsapp: 503");
        throw new OtpInvalidRecipientError("start: 400");
      },
      check: async () => false,
    });
    const res = await start(c);
    expect(res.status).toBe(400);
    expect(res.body.code).toBe("VALIDATION_FAILED");
    expect(res.body.errors[0].path).toBe("phone");
    expect(channels).toEqual(["whatsapp", "sms"]);
    await c.close();
    ctx = undefined;
  });

  it("a provider rate limit on start is 429 RATE_LIMITED and never tries sms", async () => {
    const channels: string[] = [];
    const c = await withProvider({
      start: async (_phone, channel) => {
        channels.push(channel);
        throw new OtpProviderRateLimitedError("start: 429");
      },
      check: async () => false,
    });
    const res = await start(c);
    expect(res.status).toBe(429);
    expect(res.body.code).toBe("RATE_LIMITED");
    expect(channels).toEqual(["whatsapp"]);
    await c.close();
    ctx = undefined;
  });

  it("a provider rate limit on verify is 429 RATE_LIMITED", async () => {
    const c = await withProvider({
      start: async () => undefined,
      check: async () => {
        throw new OtpProviderRateLimitedError("check: 429");
      },
    });
    const res = await request(c.app.getHttpServer())
      .post("/v1/auth/otp/verify")
      .set("x-token-transport", "body")
      .send({ phone: NEW_PHONE, code: "123456" });
    expect(res.status).toBe(429);
    expect(res.body.code).toBe("RATE_LIMITED");
    await c.close();
    ctx = undefined;
  });

  it("verify answers 503 when the provider check is unavailable", async () => {
    const c = await withProvider({
      start: async () => undefined,
      check: async () => {
        throw new OtpProviderUnavailableError("check: 503");
      },
    });
    const res = await request(c.app.getHttpServer())
      .post("/v1/auth/otp/verify")
      .set("x-token-transport", "body")
      .send({ phone: NEW_PHONE, code: "123456" });
    expect(res.status).toBe(503);
    await c.close();
    ctx = undefined;
  });

  it("answers 503 when both channels throw", async () => {
    const c = await withProvider({
      start: async () => {
        throw new Error("provider down");
      },
      check: async () => false,
    });
    const res = await start(c);
    expect(res.status).toBe(503);
    expect(res.headers["content-type"]).toMatch(/^application\/problem\+json/);
    expect(res.text).not.toContain("provider down");
  });
});
