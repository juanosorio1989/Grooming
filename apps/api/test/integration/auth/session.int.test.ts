import { Controller, Module, Param, Post, Req, Res } from "@nestjs/common";
import type { Request, Response } from "express";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { TokenResponse } from "@grooming/contracts";
import { AuditService } from "../../../src/audit/audit.service.js";
import { AuthModule } from "../../../src/auth/auth.module.js";
import { sha256Hex } from "../../../src/auth/crypto/tokens.js";
import { Public } from "../../../src/auth/decorators.js";
import { SessionService } from "../../../src/auth/session.service.js";
import { TokenService } from "../../../src/auth/token.service.js";
import { createIntegrationApp, resetState } from "../app.js";
import { seedFixture, type Fixture } from "../helpers.js";

/** Test-only: starts a session for any seeded subject (real logins arrive in later tasks). */
@Controller("test/login")
class TestLoginController {
  constructor(private readonly sessions: SessionService) {}

  @Public()
  @Post(":kind/:id")
  login(
    @Param("kind") kind: string,
    @Param("id") id: string,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<TokenResponse> {
    return this.sessions.start({ type: kind === "staff" ? "STAFF" : "CUSTOMER", id }, req, res);
  }
}

@Module({ imports: [AuthModule], controllers: [TestLoginController] })
class TestLoginModule {}

const CSRF = { "x-grooming-csrf": "1" };
const BODY = { "x-token-transport": "body" };

function setCookies(res: request.Response): string[] {
  const raw = res.headers["set-cookie"] as unknown;
  return Array.isArray(raw) ? (raw as string[]) : typeof raw === "string" ? [raw] : [];
}

function refreshCookie(res: request.Response): string | undefined {
  return setCookies(res).find((c) => c.startsWith("gr_refresh="));
}

/** The raw refresh token from the `gr_refresh` cookie. */
function cookieToken(res: request.Response): string {
  const c = refreshCookie(res);
  if (!c) throw new Error("no gr_refresh cookie");
  return decodeURIComponent(c.split(";")[0]!.slice("gr_refresh=".length));
}

describe("sessions: refresh rotation, transports, logout", () => {
  let ctx: Awaited<ReturnType<typeof createIntegrationApp>>;
  let f: Fixture;
  const server = () => ctx.app.getHttpServer();

  const login = (kind: "staff" | "customer", id: string, headers: Record<string, string> = {}) =>
    request(server()).post(`/v1/test/login/${kind}/${id}`).set(headers);
  const refreshWithCookie = (token: string, headers: Record<string, string> = CSRF) =>
    request(server()).post("/v1/auth/refresh").set("Cookie", `gr_refresh=${token}`).set(headers);
  const refreshWithBody = (token: string) =>
    request(server()).post("/v1/auth/refresh").set(BODY).send({ refreshToken: token });
  const row = (token: string) => ctx.prisma.refreshToken.findUnique({ where: { tokenHash: sha256Hex(token) } });

  // A fresh app per test: TenancyService caches the org id, and every test re-seeds the org.
  beforeEach(async () => {
    ctx = await createIntegrationApp({ imports: [TestLoginModule] });
    await resetState(ctx.prisma, ctx.redis);
    f = await seedFixture(ctx.prisma);
    await ctx.prisma.staffUser.update({ where: { id: f.staffA }, data: { canLogin: true, role: "RECEPTION" } });
  });
  afterEach(async () => {
    await ctx?.close();
  });

  it("cookie transport sets an HttpOnly Lax cookie scoped to /v1/auth and keeps the token out of the body", async () => {
    const res = await login("customer", f.customerId);
    expect(res.status).toBe(201);
    const cookie = refreshCookie(res)!;
    expect(cookie).toMatch(/HttpOnly/i);
    expect(cookie).toMatch(/SameSite=Lax/i);
    expect(cookie).toMatch(/Path=\/v1\/auth/);
    expect(cookie).not.toMatch(/Secure/i); // COOKIE_SECURE is false in test
    expect(res.body.refreshToken).toBeUndefined();
    const claims = await ctx.app.get(TokenService).verifyAccess(res.body.accessToken);
    expect(claims).toEqual({ sub: f.customerId, typ: "customer", org: f.orgId, role: "CUSTOMER" });
    expect(new Date(res.body.accessTokenExpiresAt).getTime()).toBeGreaterThan(Date.now());
  });

  it("stores only the sha256 of the refresh token, with request metadata", async () => {
    const res = await login("customer", f.customerId, { "user-agent": "x".repeat(400) });
    const token = cookieToken(res);
    const rows = await ctx.prisma.refreshToken.findMany();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.tokenHash).toBe(sha256Hex(token));
    expect(JSON.stringify(rows)).not.toContain(token);
    expect(rows[0]!.userAgent).toHaveLength(255);
  });

  it("refresh with cookie + CSRF header rotates within the same family and keeps expires_at", async () => {
    const first = await login("customer", f.customerId);
    const a = cookieToken(first);
    const res = await refreshWithCookie(a);
    expect(res.status).toBe(200);
    expect(res.body.accessToken).toEqual(expect.any(String));
    expect(res.body.refreshToken).toBeUndefined();
    const b = cookieToken(res);
    expect(b).not.toBe(a);
    const [rowA, rowB] = [await row(a), await row(b)];
    expect(rowA!.rotatedAt).not.toBeNull();
    expect(rowB!.rotatedAt).toBeNull();
    expect(rowB!.familyId).toBe(rowA!.familyId);
    expect(rowB!.expiresAt.getTime()).toBe(rowA!.expiresAt.getTime());
  });

  it("refresh with cookie but without the CSRF header is 403 FORBIDDEN", async () => {
    const a = cookieToken(await login("customer", f.customerId));
    const res = await refreshWithCookie(a, {});
    expect(res.status).toBe(403);
    expect(res.headers["content-type"]).toMatch(/^application\/problem\+json/);
    expect(res.body.code).toBe("FORBIDDEN");
    expect((await row(a))!.rotatedAt).toBeNull();
  });

  it("refresh with no token at all is 401", async () => {
    const res = await request(server()).post("/v1/auth/refresh").set(CSRF);
    expect(res.status).toBe(401);
    expect(res.body.code).toBe("UNAUTHORIZED");
  });

  it("body transport returns the refresh token in the body and sets no cookie", async () => {
    const res = await login("customer", f.customerId, BODY);
    expect(res.status).toBe(201);
    expect(res.body.refreshToken).toEqual(expect.any(String));
    expect(setCookies(res)).toHaveLength(0);
    const next = await refreshWithBody(res.body.refreshToken);
    expect(next.status).toBe(200);
    expect(next.body.refreshToken).toEqual(expect.any(String));
    expect(next.body.refreshToken).not.toBe(res.body.refreshToken);
    expect(setCookies(next)).toHaveLength(0);
  });

  it("reuse of a rotated token revokes the whole family and writes an audit row", async () => {
    const a = (await login("customer", f.customerId, BODY)).body.refreshToken as string;
    const b = (await refreshWithBody(a)).body.refreshToken as string;
    expect(b).toEqual(expect.any(String));

    const reuse = await refreshWithBody(a);
    expect(reuse.status).toBe(401);
    expect(reuse.body.code).toBe("UNAUTHORIZED");

    const familyId = (await row(a))!.familyId;
    const family = await ctx.prisma.refreshToken.findMany({ where: { familyId } });
    expect(family).toHaveLength(2);
    expect(family.every((r) => r.revokedAt !== null)).toBe(true);

    const audit = await ctx.prisma.auditLog.findMany({ where: { action: "auth.refresh_reuse" } });
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({
      organizationId: f.orgId,
      actorType: "SYSTEM",
      actorId: null,
      entity: "refresh_token_family",
      entityId: familyId,
    });
    expect(JSON.stringify(audit)).not.toContain(a);
    expect(JSON.stringify(audit)).not.toContain(sha256Hex(a));

    // The successor was revoked with the family but never rotated: a plain 401, not reuse (no second audit row).
    expect((await refreshWithBody(b)).status).toBe(401);
    expect(await ctx.prisma.auditLog.count({ where: { action: "auth.refresh_reuse" } })).toBe(1);
  });

  it("two concurrent refreshes with the same token: exactly one wins", async () => {
    const a = (await login("customer", f.customerId, BODY)).body.refreshToken as string;
    const results = await Promise.all([refreshWithBody(a), refreshWithBody(a)]);
    expect(results.map((r) => r.status).sort()).toEqual([200, 401]);
  });

  it("staff refresh lives 12 h, customer refresh 90 d", async () => {
    const staff = cookieToken(await login("staff", f.staffA));
    const customer = cookieToken(await login("customer", f.customerId));
    const near = (d: Date, ms: number) => expect(Math.abs(d.getTime() - (Date.now() + ms))).toBeLessThan(60_000);
    near((await row(staff))!.expiresAt, 12 * 3600_000);
    near((await row(customer))!.expiresAt, 90 * 86400_000);
  });

  it("staff access token carries the staff role", async () => {
    const res = await login("staff", f.staffA);
    const claims = await ctx.app.get(TokenService).verifyAccess(res.body.accessToken);
    expect(claims).toEqual({ sub: f.staffA, typ: "staff", org: f.orgId, role: "RECEPTION" });
  });

  it("refresh after the staff user is deactivated is 401 and revokes the family", async () => {
    const a = cookieToken(await login("staff", f.staffA));
    await ctx.prisma.staffUser.update({ where: { id: f.staffA }, data: { active: false } });
    expect((await refreshWithCookie(a)).status).toBe(401);
    const rows = await ctx.prisma.refreshToken.findMany({ where: { subjectId: f.staffA } });
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((r) => r.revokedAt !== null)).toBe(true);
  });

  it("refresh after the staff user loses can_login is 401 and revokes the family", async () => {
    const a = cookieToken(await login("staff", f.staffA));
    await ctx.prisma.staffUser.update({ where: { id: f.staffA }, data: { canLogin: false } });
    expect((await refreshWithCookie(a)).status).toBe(401);
    const rows = await ctx.prisma.refreshToken.findMany({ where: { subjectId: f.staffA } });
    expect(rows.every((r) => r.revokedAt !== null)).toBe(true);
  });

  it("refresh after the customer is soft-deleted is 401 and revokes the family", async () => {
    const a = cookieToken(await login("customer", f.customerId));
    await ctx.prisma.customer.update({ where: { id: f.customerId }, data: { deletedAt: new Date() } });
    expect((await refreshWithCookie(a)).status).toBe(401);
    const rows = await ctx.prisma.refreshToken.findMany({ where: { subjectId: f.customerId } });
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((r) => r.revokedAt !== null)).toBe(true);
  });

  it("a session cannot start for a staff user who cannot log in", async () => {
    const res = await login("staff", f.staffB);
    expect(res.status).toBe(401);
    expect(await ctx.prisma.refreshToken.count()).toBe(0);
  });

  it("an expired refresh token is 401", async () => {
    const a = cookieToken(await login("customer", f.customerId));
    await ctx.prisma.refreshToken.update({
      where: { tokenHash: sha256Hex(a) },
      data: { expiresAt: new Date(Date.now() - 1000) },
    });
    const res = await refreshWithCookie(a);
    expect(res.status).toBe(401);
    expect(res.body.code).toBe("UNAUTHORIZED");
  });

  it("an unknown refresh token is 401", async () => {
    expect((await refreshWithBody("nope-nope-nope")).status).toBe(401);
  });

  it("logout with cookie + CSRF is 204, clears the cookie and revokes the family", async () => {
    const a = cookieToken(await login("customer", f.customerId));
    const res = await request(server()).post("/v1/auth/logout").set("Cookie", `gr_refresh=${a}`).set(CSRF);
    expect(res.status).toBe(204);
    const cleared = refreshCookie(res)!;
    expect(cleared).toMatch(/^gr_refresh=;/);
    expect(cleared).toMatch(/Path=\/v1\/auth/);
    expect(cleared).toMatch(/Expires=Thu, 01 Jan 1970/);
    expect((await row(a))!.revokedAt).not.toBeNull();
    expect((await refreshWithCookie(a)).status).toBe(401);
  });

  it("logout with cookie but without the CSRF header is 403 and revokes nothing", async () => {
    const a = cookieToken(await login("customer", f.customerId));
    const res = await request(server()).post("/v1/auth/logout").set("Cookie", `gr_refresh=${a}`);
    expect(res.status).toBe(403);
    expect((await row(a))!.revokedAt).toBeNull();
  });

  it("logout with a body token revokes it", async () => {
    const a = (await login("customer", f.customerId, BODY)).body.refreshToken as string;
    const res = await request(server()).post("/v1/auth/logout").set(BODY).send({ refreshToken: a });
    expect(res.status).toBe(204);
    expect((await row(a))!.revokedAt).not.toBeNull();
  });

  it("logout with an unknown token is 204", async () => {
    const res = await request(server()).post("/v1/auth/logout").set(BODY).send({ refreshToken: "unknown-token" });
    expect(res.status).toBe(204);
  });

  it("a cookie-presented token always gets a cookie back, even with x-token-transport: body", async () => {
    const a = cookieToken(await login("customer", f.customerId));
    const res = await refreshWithCookie(a, { ...CSRF, ...BODY });
    expect(res.status).toBe(200);
    expect(res.body.refreshToken).toBeUndefined();
    expect(refreshCookie(res)).toBeDefined();
    expect(cookieToken(res)).not.toBe(a);
  });

  it("a failed (401) cookie refresh clears the cookie", async () => {
    const res = await refreshWithCookie("unknown-token");
    expect(res.status).toBe(401);
    expect(refreshCookie(res)).toMatch(/^gr_refresh=;.*Expires=Thu, 01 Jan 1970/);
  });

  it("refresh after logout is a plain 401: no reuse audit row", async () => {
    const a = cookieToken(await login("customer", f.customerId));
    expect((await request(server()).post("/v1/auth/logout").set("Cookie", `gr_refresh=${a}`).set(CSRF)).status).toBe(204);
    const res = await refreshWithCookie(a);
    expect(res.status).toBe(401);
    expect(await ctx.prisma.auditLog.count({ where: { action: "auth.refresh_reuse" } })).toBe(0);
    expect((await row(a))!.rotatedAt).toBeNull();
  });

  it("when both a cookie and a body token are sent, the body token is rotated", async () => {
    const cookieA = cookieToken(await login("customer", f.customerId));
    const bodyA = (await login("customer", f.customerId, BODY)).body.refreshToken as string;
    const res = await request(server())
      .post("/v1/auth/refresh")
      .set("Cookie", `gr_refresh=${cookieA}`)
      .set({ ...CSRF, ...BODY })
      .send({ refreshToken: bodyA });
    expect(res.status).toBe(200);
    expect((await row(bodyA))!.rotatedAt).not.toBeNull();
    expect((await row(cookieA))!.rotatedAt).toBeNull();
  });
});

describe("refresh reuse when the audit write fails", () => {
  let ctx: Awaited<ReturnType<typeof createIntegrationApp>>;

  beforeEach(async () => {
    ctx = await createIntegrationApp({
      imports: [TestLoginModule],
      override: (b) =>
        b.overrideProvider(AuditService).useValue({
          record: () => Promise.reject(new Error("audit store down")),
        }),
    });
    await resetState(ctx.prisma, ctx.redis);
  });
  afterEach(async () => {
    await ctx?.close();
  });

  it("still answers 401 and the family stays revoked", async () => {
    const f = await seedFixture(ctx.prisma);
    const server = ctx.app.getHttpServer();
    const a = (await request(server).post(`/v1/test/login/customer/${f.customerId}`).set(BODY)).body
      .refreshToken as string;
    expect((await request(server).post("/v1/auth/refresh").set(BODY).send({ refreshToken: a })).status).toBe(200);
    const reuse = await request(server).post("/v1/auth/refresh").set(BODY).send({ refreshToken: a });
    expect(reuse.status).toBe(401);
    const family = await ctx.prisma.refreshToken.findMany();
    expect(family).toHaveLength(2);
    expect(family.every((r) => r.revokedAt !== null)).toBe(true);
  });
});
