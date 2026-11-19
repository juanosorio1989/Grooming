import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { sha256Hex } from "../../../src/auth/crypto/tokens.js";
import { generateTotpSecret } from "../../../src/auth/crypto/totp.js";
import { RefreshTokenService } from "../../../src/auth/refresh-token.service.js";
import { TokenService } from "../../../src/auth/token.service.js";
import { ConsoleMailer } from "../../../src/mail/console.mailer.js";
import { MAILER } from "../../../src/mail/mailer.js";
import { createIntegrationApp, resetState } from "../app.js";
import { createStaff, seedFixture, type Fixture } from "../helpers.js";

type Ctx = Awaited<ReturnType<typeof createIntegrationApp>>;

const OWNER_PASSWORD = "owner password long enough";
const NEW_PASSWORD = "a-long-password-1";
const BODY = { "x-token-transport": "body" };
const OTHER_ORG_STAFF = "0194b2a0-0000-7000-8000-0000000000ff";

/** The `token` query parameter of a link. */
const tokenOf = (link: string) => new URL(link).searchParams.get("token")!;
/** The first URL in an email text. */
const linkIn = (text: string) => /https?:\/\/\S+/.exec(text)![0];

describe("staff invite / password reset links and owner actions", () => {
  let ctx: Ctx;
  let f: Fixture;
  let ownerId: string;
  const server = () => ctx.app.getHttpServer();
  const mailer = () => ctx.app.get<ConsoleMailer>(MAILER);
  const tokens = () => ctx.app.get(TokenService);

  const ownerToken = async () =>
    (await tokens().issueAccess({ sub: ownerId, typ: "staff", org: f.orgId, role: "OWNER" })).token;
  const asStaff = (path: string, token: string) =>
    request(server()).post(`/v1/staff/employees/${path}`).set("Authorization", `Bearer ${token}`).send({});
  const auth = (path: string, body: object) =>
    request(server()).post(`/v1/auth/staff/${path}`).set(BODY).send(body);
  const login = (email: string, password: string) => auth("login", { email, password });

  /** OWNER invites `staffId` and returns the link from the email. */
  const invite = async (staffId: string) => {
    const before = mailer().sent.length;
    const res = await asStaff(`${staffId}/invite`, await ownerToken());
    expect(res.status).toBe(204);
    expect(mailer().sent.length).toBe(before + 1);
    return linkIn(mailer().sent.at(-1)!.text);
  };

  beforeAll(async () => {
    ctx = await createIntegrationApp();
    await resetState(ctx.prisma, ctx.redis);
    f = await seedFixture(ctx.prisma);
  });
  beforeEach(async () => {
    await ctx.redis.flushdb();
    await ctx.prisma.auditLog.deleteMany();
    await ctx.prisma.refreshToken.deleteMany();
    await ctx.prisma.staffUser.deleteMany({ where: { id: { notIn: [f.staffA, f.staffB] } } });
    mailer().sent.length = 0;
    ownerId = (
      await createStaff(ctx.prisma, f, {
        email: "owner@salon.com",
        role: "OWNER",
        password: OWNER_PASSWORD,
        totpSecret: generateTotpSecret(),
      })
    ).id;
  });
  afterAll(async () => {
    await ctx?.close();
  });

  const newReception = async () => {
    const s = await createStaff(ctx.prisma, f, { email: "ana@salon.com", role: "RECEPTION", canLogin: false });
    await ctx.prisma.staffUser.update({ where: { id: s.id }, data: { locale: "es" } });
    return s.id;
  };

  describe("owner invite", () => {
    it("emails a 72 h invite link in the staff locale and stores only its hash", async () => {
      const staffId = await newReception();
      const res = await asStaff(`${staffId}/invite`, await ownerToken());
      expect(res.status).toBe(204);
      expect(mailer().sent).toHaveLength(1);
      const msg = mailer().sent[0]!;
      expect(msg.to).toBe("ana@salon.com");
      expect(msg.subject).toBe("Te invitaron a Grooming");
      expect(msg.text).toContain("72 horas");
      const link = linkIn(msg.text);
      expect(link.startsWith("http://localhost:3000/es/staff/invite?token=")).toBe(true);

      const rows = await ctx.prisma.staffAuthToken.findMany({ where: { staffUserId: staffId } });
      expect(rows).toHaveLength(1);
      expect(rows[0]!.purpose).toBe("INVITE");
      expect(rows[0]!.tokenHash).toBe(sha256Hex(tokenOf(link)));
      expect(rows[0]!.tokenHash).not.toBe(tokenOf(link));
      const ttlH = (rows[0]!.expiresAt.getTime() - Date.now()) / 3600_000;
      expect(ttlH).toBeGreaterThan(71.9);
      expect(ttlH).toBeLessThanOrEqual(72);

      const audit = await ctx.prisma.auditLog.findMany({ where: { action: "staff.invite" } });
      expect(audit).toHaveLength(1);
      expect(audit[0]!.actorType).toBe("STAFF");
      expect(audit[0]!.actorId).toBe(ownerId);
      expect(audit[0]!.entityId).toBe(staffId);
      expect(JSON.stringify(audit)).not.toContain(tokenOf(link));
    });

    it("RECEPTION is 403; another org's id is 404; a staff with a password is 409; a bad id is 400", async () => {
      const staffId = await newReception();
      const reception = (await tokens().issueAccess({ sub: staffId, typ: "staff", org: f.orgId, role: "RECEPTION" }))
        .token;
      expect((await asStaff(`${staffId}/invite`, reception)).status).toBe(403);

      const missing = await asStaff(`${OTHER_ORG_STAFF}/invite`, await ownerToken());
      expect(missing.status).toBe(404);
      expect(missing.body.code).toBe("NOT_FOUND");

      const withPw = await createStaff(ctx.prisma, f, { email: "pw@salon.com", role: "EMPLOYEE", password: NEW_PASSWORD });
      const conflict = await asStaff(`${withPw.id}/invite`, await ownerToken());
      expect(conflict.status).toBe(409);
      expect(conflict.body.code).toBe("CONFLICT");

      const noEmail = await ctx.prisma.staffUser.create({
        data: { organizationId: f.orgId, role: "EMPLOYEE", locale: "en" },
      });
      const noEmailRes = await asStaff(`${noEmail.id}/invite`, await ownerToken());
      expect(noEmailRes.status).toBe(409);
      expect(noEmailRes.body.detail).toBe("Staff member has no email");

      const bad = await asStaff("not-a-uuid/invite", await ownerToken());
      expect(bad.status).toBe(400);
      expect(mailer().sent).toHaveLength(0);
    });
  });

  describe("invite accept", () => {
    it("sets the password, enables login and answers ENROLL_REQUIRED; login then needs enrollment", async () => {
      const staffId = await newReception();
      const link = await invite(staffId);
      const res = await auth("invite/accept", { token: tokenOf(link), password: NEW_PASSWORD });
      expect(res.status).toBe(200);
      expect(res.body.status).toBe("ENROLL_REQUIRED");
      expect(res.body.mfaToken).toEqual(expect.any(String));
      await expect(tokens().verifyMfa(res.body.mfaToken, "enroll")).resolves.toMatchObject({ staffId });

      const row = await ctx.prisma.staffUser.findUniqueOrThrow({ where: { id: staffId } });
      expect(row.canLogin).toBe(true);
      expect(row.passwordHash).toMatch(/^\$argon2id\$/);

      const l = await login("ana@salon.com", NEW_PASSWORD);
      expect(l.status).toBe(200);
      expect(l.body.status).toBe("ENROLL_REQUIRED");

      const audit = await ctx.prisma.auditLog.findMany({ where: { action: "auth.staff.invite_accepted" } });
      expect(audit).toHaveLength(1);
      expect(JSON.stringify(audit)).not.toContain(NEW_PASSWORD);
    });

    it("accepting an invite clears a login lockout on that email", async () => {
      const staffId = await newReception();
      for (let i = 0; i < 5; i++) expect((await login("ana@salon.com", "wrong password here")).status).toBe(401);
      expect((await login("ana@salon.com", "wrong password here")).status).toBe(429);
      const link = await invite(staffId);
      expect((await auth("invite/accept", { token: tokenOf(link), password: NEW_PASSWORD })).status).toBe(200);
      const l = await login(" Ana@Salon.com ", NEW_PASSWORD);
      expect(l.status).toBe(200);
      expect(l.body.status).toBe("ENROLL_REQUIRED");
    });

    it("used, expired, unknown and superseded links are 400 LINK_INVALID", async () => {
      const staffId = await newReception();
      const first = await invite(staffId);
      const second = await invite(staffId);

      const superseded = await auth("invite/accept", { token: tokenOf(first), password: NEW_PASSWORD });
      expect(superseded.status).toBe(400);
      expect(superseded.body.code).toBe("LINK_INVALID");

      const unknown = await auth("invite/accept", { token: "x".repeat(43), password: NEW_PASSWORD });
      expect(unknown.status).toBe(400);
      expect(unknown.body.code).toBe("LINK_INVALID");

      await ctx.prisma.staffAuthToken.update({
        where: { tokenHash: sha256Hex(tokenOf(second)) },
        data: { expiresAt: new Date(Date.now() - 1000) },
      });
      const expired = await auth("invite/accept", { token: tokenOf(second), password: NEW_PASSWORD });
      expect(expired.status).toBe(400);
      expect(expired.body.code).toBe("LINK_INVALID");

      const third = await invite(staffId);
      expect((await auth("invite/accept", { token: tokenOf(third), password: NEW_PASSWORD })).status).toBe(200);
      const reused = await auth("invite/accept", { token: tokenOf(third), password: NEW_PASSWORD });
      expect(reused.status).toBe(400);
      expect(reused.body.code).toBe("LINK_INVALID");
    });

    it("a reset link is not an invite link; an inactive staff's link is LINK_INVALID", async () => {
      const staffId = await newReception();
      const link = await invite(staffId);
      await ctx.prisma.staffUser.update({ where: { id: staffId }, data: { active: false } });
      const inactive = await auth("invite/accept", { token: tokenOf(link), password: NEW_PASSWORD });
      expect(inactive.status).toBe(400);
      expect(inactive.body.code).toBe("LINK_INVALID");

      const reset = await auth("password/reset", { token: tokenOf(link), password: NEW_PASSWORD });
      expect(reset.status).toBe(400);
      expect(reset.body.code).toBe("LINK_INVALID");
    });

    it("an 11-char password is 400 VALIDATION_FAILED and does not spend the link", async () => {
      const staffId = await newReception();
      const link = await invite(staffId);
      const res = await auth("invite/accept", { token: tokenOf(link), password: "short-pw-11" });
      expect(res.status).toBe(400);
      expect(res.body.code).toBe("VALIDATION_FAILED");
      expect((await auth("invite/accept", { token: tokenOf(link), password: NEW_PASSWORD })).status).toBe(200);
    });

    it("an enrolled staff accepting an invite gets MFA_REQUIRED", async () => {
      const staffId = await newReception();
      const link = await invite(staffId);
      await ctx.prisma.staffUser.update({
        where: { id: staffId },
        data: { totpSecretEnc: "x", totpEnrolledAt: new Date() },
      });
      const res = await auth("invite/accept", { token: tokenOf(link), password: NEW_PASSWORD });
      expect(res.status).toBe(200);
      expect(res.body.status).toBe("MFA_REQUIRED");
    });

    it("the 11th accept from one IP within 15 min is 429", async () => {
      for (let i = 0; i < 10; i++) {
        expect((await auth("invite/accept", { token: "y".repeat(43), password: NEW_PASSWORD })).status).toBe(400);
      }
      const res = await auth("invite/accept", { token: "y".repeat(43), password: NEW_PASSWORD });
      expect(res.status).toBe(429);
      expect(res.body.code).toBe("RATE_LIMITED");
    });
  });

  describe("password forgot / reset", () => {
    const withPassword = () =>
      createStaff(ctx.prisma, f, { email: "ana@salon.com", role: "EMPLOYEE", password: OWNER_PASSWORD });

    it("forgot trims and lowercases the email and sends one 1 h reset link; unknown email sends nothing", async () => {
      const staff = await withPassword();
      const res = await auth("password/forgot", { email: " ANA@salon.com " });
      expect(res.status).toBe(204);
      expect(mailer().sent).toHaveLength(1);
      const msg = mailer().sent[0]!;
      expect(msg.to).toBe("ana@salon.com");
      expect(msg.subject).toBe("Reset your Grooming password");
      expect(msg.text).toContain("1 hour");
      const link = linkIn(msg.text);
      expect(link.startsWith("http://localhost:3000/en/staff/reset?token=")).toBe(true);
      const row = await ctx.prisma.staffAuthToken.findUniqueOrThrow({ where: { tokenHash: sha256Hex(tokenOf(link)) } });
      expect(row.staffUserId).toBe(staff.id);
      expect(row.purpose).toBe("PASSWORD_RESET");
      const ttlMin = (row.expiresAt.getTime() - Date.now()) / 60_000;
      expect(ttlMin).toBeGreaterThan(59.9);
      expect(ttlMin).toBeLessThanOrEqual(60);

      const unknown = await auth("password/forgot", { email: "nobody@salon.com" });
      expect(unknown.status).toBe(204);
      expect(mailer().sent).toHaveLength(1);
    });

    it("no email for a staff without a password or with login disabled", async () => {
      await newReception();
      expect((await auth("password/forgot", { email: "ana@salon.com" })).status).toBe(204);
      expect(mailer().sent).toHaveLength(0);
    });

    it("the 4th forgot for one email within an hour is 204 and sends nothing", async () => {
      await withPassword();
      for (let i = 0; i < 4; i++) expect((await auth("password/forgot", { email: "ana@salon.com" })).status).toBe(204);
      expect(mailer().sent).toHaveLength(3);
    });

    it("the 11th forgot from one IP within 15 min is 429", async () => {
      for (let i = 0; i < 10; i++) {
        expect((await auth("password/forgot", { email: `n${i}@salon.com` })).status).toBe(204);
      }
      const res = await auth("password/forgot", { email: "n10@salon.com" });
      expect(res.status).toBe(429);
      expect(res.body.code).toBe("RATE_LIMITED");
    });

    it("reset sets the new password, revokes sessions and spends the link", async () => {
      const staff = await withPassword();
      const refresh = await ctx.app.get(RefreshTokenService).create({ type: "STAFF", id: staff.id }, {
        ip: null,
        userAgent: null,
      });
      await auth("password/forgot", { email: "ana@salon.com" });
      const token = tokenOf(linkIn(mailer().sent[0]!.text));

      const res = await auth("password/reset", { token, password: NEW_PASSWORD });
      expect(res.status).toBe(204);

      expect((await login("ana@salon.com", OWNER_PASSWORD)).status).toBe(401);
      expect((await login("ana@salon.com", NEW_PASSWORD)).status).toBe(200);
      const refreshed = await request(server()).post("/v1/auth/refresh").set(BODY).send({ refreshToken: refresh.token });
      expect(refreshed.status).toBe(401);
      const live = await ctx.prisma.refreshToken.count({ where: { subjectId: staff.id, revokedAt: null } });
      expect(live).toBe(0);

      const audit = await ctx.prisma.auditLog.findMany({ where: { action: "auth.staff.password_reset" } });
      expect(audit).toHaveLength(1);
      expect(JSON.stringify(audit)).not.toContain(NEW_PASSWORD);

      const reused = await auth("password/reset", { token, password: "another-long-password" });
      expect(reused.status).toBe(400);
      expect(reused.body.code).toBe("LINK_INVALID");
    });
  });

  describe("lockout and password reset", () => {
    it("a locked-out staff who resets the password can log in with the new one", async () => {
      await createStaff(ctx.prisma, f, { email: "ana@salon.com", role: "EMPLOYEE", password: OWNER_PASSWORD });
      for (let i = 0; i < 5; i++) expect((await login("ana@salon.com", "wrong password here")).status).toBe(401);
      expect((await login("ana@salon.com", OWNER_PASSWORD)).status).toBe(429);

      await auth("password/forgot", { email: "ana@salon.com" });
      const token = tokenOf(linkIn(mailer().sent[0]!.text));
      expect((await auth("password/reset", { token, password: NEW_PASSWORD })).status).toBe(204);

      expect((await login("ana@salon.com", NEW_PASSWORD)).status).toBe(200);
    });
  });

  describe("owner reset-2fa", () => {
    it("clears TOTP and recovery codes, revokes sessions, audits; self-reset is 403", async () => {
      const emp = await createStaff(ctx.prisma, f, {
        email: "emp@salon.com",
        role: "EMPLOYEE",
        password: NEW_PASSWORD,
        totpSecret: generateTotpSecret(),
      });
      await ctx.prisma.staffRecoveryCode.create({ data: { staffUserId: emp.id, codeHash: "h" } });
      const refresh = await ctx.app.get(RefreshTokenService).create({ type: "STAFF", id: emp.id }, {
        ip: null,
        userAgent: null,
      });
      expect((await login("emp@salon.com", NEW_PASSWORD)).body.status).toBe("MFA_REQUIRED");

      const res = await asStaff(`${emp.id}/reset-2fa`, await ownerToken());
      expect(res.status).toBe(204);

      expect((await login("emp@salon.com", NEW_PASSWORD)).body.status).toBe("ENROLL_REQUIRED");
      const refreshed = await request(server()).post("/v1/auth/refresh").set(BODY).send({ refreshToken: refresh.token });
      expect(refreshed.status).toBe(401);
      const row = await ctx.prisma.staffUser.findUniqueOrThrow({ where: { id: emp.id } });
      expect(row.totpSecretEnc).toBeNull();
      expect(row.totpEnrolledAt).toBeNull();
      expect(await ctx.prisma.staffRecoveryCode.count({ where: { staffUserId: emp.id } })).toBe(0);

      const audit = await ctx.prisma.auditLog.findMany({ where: { action: "staff.reset_2fa" } });
      expect(audit).toHaveLength(1);
      expect(audit[0]!.actorId).toBe(ownerId);
      expect(audit[0]!.entityId).toBe(emp.id);
      expect(audit[0]!.before).toEqual({ totpEnrolled: true });

      const self = await asStaff(`${ownerId}/reset-2fa`, await ownerToken());
      expect(self.status).toBe(403);
      expect(self.body.code).toBe("FORBIDDEN");

      const missing = await asStaff(`${OTHER_ORG_STAFF}/reset-2fa`, await ownerToken());
      expect(missing.status).toBe(404);
    });
  });
});
