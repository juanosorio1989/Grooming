import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { hashKeyPart } from "../../../src/rate-limit/rate-limit.service.js";
import { TokenService } from "../../../src/auth/token.service.js";
import { generateTotpSecret } from "../../../src/auth/crypto/totp.js";
import { createIntegrationApp, resetState } from "../app.js";
import { createStaff, seedFixture, type Fixture } from "../helpers.js";

type Ctx = Awaited<ReturnType<typeof createIntegrationApp>>;

const PASSWORD = "correct horse battery staple";
const UNAUTHORIZED_BODY = { code: "UNAUTHORIZED", detail: "Invalid email or password" };
const FAIL_KEY = `rl:login:fail:${hashKeyPart("ana@salon.com")}`;

describe("staff password login", () => {
  let ctx: Ctx;
  let f: Fixture;
  const server = () => ctx.app.getHttpServer();
  const login = (email: string, password: string) =>
    request(server()).post("/v1/auth/staff/login").send({ email, password });

  beforeAll(async () => {
    ctx = await createIntegrationApp();
    // Seeded once: TenancyService caches the org id for the app's lifetime.
    await resetState(ctx.prisma, ctx.redis);
    f = await seedFixture(ctx.prisma);
  });
  beforeEach(async () => {
    await ctx.redis.flushdb();
    await ctx.prisma.auditLog.deleteMany();
    await ctx.prisma.staffUser.deleteMany({ where: { id: { notIn: [f.staffA, f.staffB] } } });
  });
  afterAll(async () => {
    await ctx?.close();
  });

  it("enrolled staff: trimmed, case-insensitive email → 200 MFA_REQUIRED with a verify mfaToken", async () => {
    const staff = await createStaff(ctx.prisma, f, {
      email: "ana@salon.com",
      role: "RECEPTION",
      password: PASSWORD,
      totpSecret: generateTotpSecret(),
    });
    const res = await login(" Ana@Salon.COM ", PASSWORD);
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("MFA_REQUIRED");
    expect(new Date(res.body.mfaTokenExpiresAt).getTime()).toBeGreaterThan(Date.now());
    const claims = await ctx.app.get(TokenService).verifyMfa(res.body.mfaToken, "verify");
    expect(claims).toEqual({ staffId: staff.id, orgId: f.orgId });
  });

  it("not enrolled → ENROLL_REQUIRED with an enroll mfaToken", async () => {
    const staff = await createStaff(ctx.prisma, f, { email: "ana@salon.com", role: "EMPLOYEE", password: PASSWORD });
    const res = await login("ana@salon.com", PASSWORD);
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("ENROLL_REQUIRED");
    const claims = await ctx.app.get(TokenService).verifyMfa(res.body.mfaToken, "enroll");
    expect(claims.staffId).toBe(staff.id);
  });

  it("wrong password, unknown email, inactive and can_login=false all answer the same 401", async () => {
    await createStaff(ctx.prisma, f, { email: "ana@salon.com", role: "EMPLOYEE", password: PASSWORD });
    await createStaff(ctx.prisma, f, { email: "off@salon.com", role: "EMPLOYEE", password: PASSWORD, active: false });
    await createStaff(ctx.prisma, f, { email: "nologin@salon.com", role: "EMPLOYEE", password: PASSWORD, canLogin: false });
    await createStaff(ctx.prisma, f, { email: "nopw@salon.com", role: "EMPLOYEE" });

    const responses = [
      await login("ana@salon.com", "wrong password"),
      await login("nobody@salon.com", PASSWORD),
      await login("off@salon.com", PASSWORD),
      await login("nologin@salon.com", PASSWORD),
      await login("nopw@salon.com", PASSWORD),
    ];
    for (const res of responses) {
      expect(res.status).toBe(401);
      expect(res.headers["content-type"]).toMatch(/^application\/problem\+json/);
      expect(res.body).toMatchObject(UNAUTHORIZED_BODY);
    }
    const bodies = responses.map((r) => JSON.stringify(r.body));
    expect(new Set(bodies).size).toBe(1);
  });

  it("5 wrong passwords lock the email: the correct one is 429 until the failure key is gone", async () => {
    await createStaff(ctx.prisma, f, { email: "ana@salon.com", role: "EMPLOYEE", password: PASSWORD });
    for (let i = 0; i < 5; i++) expect((await login("ana@salon.com", "wrong")).status).toBe(401);
    const locked = await login("ana@salon.com", PASSWORD);
    expect(locked.status).toBe(429);
    expect(locked.body.code).toBe("RATE_LIMITED");
    // A different casing hits the same lock.
    expect((await login("ANA@salon.com", PASSWORD)).status).toBe(429);

    await ctx.redis.del(FAIL_KEY);
    expect((await login("ana@salon.com", PASSWORD)).status).toBe(200);
  });

  it("unknown emails are locked too (no account enumeration through the lockout)", async () => {
    for (let i = 0; i < 5; i++) expect((await login("ghost@salon.com", "x")).status).toBe(401);
    expect((await login("ghost@salon.com", "x")).status).toBe(429);
  });

  it("a parallel burst of wrong passwords for one email gets at most 5 guesses", async () => {
    await createStaff(ctx.prisma, f, { email: "ana@salon.com", role: "EMPLOYEE", password: PASSWORD });
    const responses = await Promise.all(Array.from({ length: 8 }, () => login("ana@salon.com", "wrong")));
    const statuses = responses.map((r) => r.status);
    expect(statuses.filter((s) => s === 401).length).toBeLessThanOrEqual(5);
    expect(statuses.filter((s) => s === 429)).toHaveLength(8 - statuses.filter((s) => s === 401).length);
    expect((await login("ana@salon.com", PASSWORD)).status).toBe(429);
  });

  it("a successful login resets the failure counter", async () => {
    await createStaff(ctx.prisma, f, { email: "ana@salon.com", role: "EMPLOYEE", password: PASSWORD });
    for (let i = 0; i < 4; i++) expect((await login("ana@salon.com", "wrong")).status).toBe(401);
    expect((await login("ana@salon.com", PASSWORD)).status).toBe(200);
    for (let i = 0; i < 4; i++) expect((await login("ana@salon.com", "wrong")).status).toBe(401);
    expect((await login("ana@salon.com", PASSWORD)).status).toBe(200);
  });

  it("limits login attempts per client IP to 30 per 15 minutes", async () => {
    for (let i = 0; i < 30; i++) expect((await login(`u${i}@salon.com`, "x")).status).toBe(401);
    const res = await login("other@salon.com", "x");
    expect(res.status).toBe(429);
    expect(res.body.code).toBe("RATE_LIMITED");
  });

  it("writes auth.staff.login_failed for a known email without the password", async () => {
    const staff = await createStaff(ctx.prisma, f, { email: "ana@salon.com", role: "EMPLOYEE", password: PASSWORD });
    await login("ana@salon.com", "my-wrong-secret-1");
    await login("ana@salon.com", "my-wrong-secret-2");
    const rows = await ctx.prisma.auditLog.findMany({ where: { action: "auth.staff.login_failed" } });
    expect(rows).toHaveLength(2);
    for (const row of rows) {
      expect(row.entity).toBe("staff_user");
      expect(row.entityId).toBe(staff.id);
    }
    const dump = JSON.stringify(rows);
    expect(dump).not.toContain("my-wrong-secret");
    expect(dump).not.toContain(PASSWORD);
  });

  it("never stores the email or IP in plain text in Redis keys", async () => {
    await login("ana@salon.com", "x");
    const keys = await ctx.redis.keys("*");
    expect(keys).toContain(FAIL_KEY);
    expect(keys.join(" ")).not.toContain("ana@salon.com");
  });
});
