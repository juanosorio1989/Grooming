import { createPrivateKey } from "node:crypto";
import { SignJWT } from "jose";
import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { Encryptor } from "../../../src/auth/crypto/encryption.js";
import { generateRecoveryCodes, hashRecoveryCode } from "../../../src/auth/crypto/recovery-codes.js";
import { generateTotpSecret, totpCode } from "../../../src/auth/crypto/totp.js";
import { JWT_ISSUER, MFA_AUDIENCE, TokenService } from "../../../src/auth/token.service.js";
import { testEnv } from "../../support/test-env.js";
import { createIntegrationApp, resetState } from "../app.js";
import { createStaff, seedFixture, type Fixture } from "../helpers.js";

type Ctx = Awaited<ReturnType<typeof createIntegrationApp>>;

const PASSWORD = "correct horse battery staple";
const BODY = { "x-token-transport": "body" };

/** A code for the step after the current one: still inside the ±1 window, but a different step than `now`. */
const nextStepCode = (secret: string) => totpCode(secret, Date.now() + 30_000);
const wrongCode = (secret: string) => {
  const ok = new Set([-30_000, 0, 30_000].map((d) => totpCode(secret, Date.now() + d)));
  for (let i = 0; ; i++) {
    const c = String(i).padStart(6, "0");
    if (!ok.has(c)) return c;
  }
};

describe("staff TOTP enroll, verify, recover", () => {
  let ctx: Ctx;
  let f: Fixture;
  const server = () => ctx.app.getHttpServer();
  const post = (path: string, body: object) =>
    request(server()).post(`/v1/auth/staff/${path}`).set(BODY).send(body);
  const tokens = () => ctx.app.get(TokenService);

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
  });
  afterAll(async () => {
    await ctx?.close();
  });

  const enrollToken = async (staffId: string) => (await tokens().issueMfa(staffId, f.orgId, "enroll")).token;
  const verifyToken = async (staffId: string) => (await tokens().issueMfa(staffId, f.orgId, "verify")).token;

  describe("enroll", () => {
    it("start returns a base32 secret and an otpauth URL; a verify token is 401", async () => {
      const staff = await createStaff(ctx.prisma, f, { email: "ana@salon.com", role: "EMPLOYEE", password: PASSWORD });
      const res = await post("mfa/enroll", { mfaToken: await enrollToken(staff.id) });
      expect(res.status).toBe(200);
      expect(res.body.secret).toMatch(/^[A-Z2-7]{32}$/);
      expect(res.body.otpauthUrl).toMatch(/^otpauth:\/\/totp\/Grooming:/);
      expect(res.body.otpauthUrl).toContain(`secret=${res.body.secret}`);

      const wrongPurpose = await post("mfa/enroll", { mfaToken: await verifyToken(staff.id) });
      expect(wrongPurpose.status).toBe(401);
      expect(wrongPurpose.body.code).toBe("UNAUTHORIZED");
    });

    it("an access token is not accepted as an mfaToken", async () => {
      const staff = await createStaff(ctx.prisma, f, { email: "ana@salon.com", role: "EMPLOYEE", password: PASSWORD });
      const access = await tokens().issueAccess({ sub: staff.id, typ: "staff", org: f.orgId, role: "EMPLOYEE" });
      expect((await post("mfa/enroll", { mfaToken: access.token })).status).toBe(401);
    });

    it("confirm: wrong code is 400 MFA_INVALID; right code enrolls, returns tokens + 10 codes, starts a session", async () => {
      const staff = await createStaff(ctx.prisma, f, { email: "ana@salon.com", role: "EMPLOYEE", password: PASSWORD });
      const mfaToken = await enrollToken(staff.id);
      const { secret } = (await post("mfa/enroll", { mfaToken })).body as { secret: string };

      const bad = await post("mfa/enroll/confirm", { mfaToken, code: wrongCode(secret) });
      expect(bad.status).toBe(400);
      expect(bad.body.code).toBe("MFA_INVALID");

      const ok = await post("mfa/enroll/confirm", { mfaToken, code: totpCode(secret, Date.now()) });
      expect(ok.status).toBe(200);
      expect(ok.body.recoveryCodes).toHaveLength(10);
      expect(new Set(ok.body.recoveryCodes).size).toBe(10);
      expect(ok.body.accessToken).toEqual(expect.any(String));
      expect(ok.body.refreshToken).toEqual(expect.any(String));
      const claims = await tokens().verifyAccess(ok.body.accessToken);
      expect(claims).toEqual({ sub: staff.id, typ: "staff", org: f.orgId, role: "EMPLOYEE" });

      const row = await ctx.prisma.staffUser.findUniqueOrThrow({ where: { id: staff.id } });
      expect(row.totpEnrolledAt).not.toBeNull();
      expect(row.totpSecretEnc).not.toBeNull();
      expect(row.totpSecretEnc).not.toContain(secret);
      const env = testEnv();
      const enc = new Encryptor({ keyId: env.DATA_ENCRYPTION_KEY_ID, keyB64: env.DATA_ENCRYPTION_KEY });
      expect(enc.decrypt(row.totpSecretEnc!)).toBe(secret);

      const codes = await ctx.prisma.staffRecoveryCode.findMany({ where: { staffUserId: staff.id } });
      expect(codes).toHaveLength(10);
      expect(codes.map((c) => c.codeHash).sort()).toEqual(
        (ok.body.recoveryCodes as string[]).map((c) => hashRecoveryCode(c)).sort(),
      );
      expect(JSON.stringify(codes)).not.toContain((ok.body.recoveryCodes as string[])[0]);

      const audit = await ctx.prisma.auditLog.findMany({ where: { action: "auth.staff.mfa_enrolled" } });
      expect(audit).toHaveLength(1);
      expect(JSON.stringify(audit)).not.toContain(secret);
    });

    it("confirm without a pending secret is 409 CONFLICT", async () => {
      const staff = await createStaff(ctx.prisma, f, { email: "ana@salon.com", role: "EMPLOYEE", password: PASSWORD });
      const res = await post("mfa/enroll/confirm", { mfaToken: await enrollToken(staff.id), code: "123456" });
      expect(res.status).toBe(409);
      expect(res.body.code).toBe("CONFLICT");
    });

    it("start after enrollment is 409 CONFLICT", async () => {
      const staff = await createStaff(ctx.prisma, f, {
        email: "ana@salon.com",
        role: "EMPLOYEE",
        password: PASSWORD,
        totpSecret: generateTotpSecret(),
      });
      const res = await post("mfa/enroll", { mfaToken: await enrollToken(staff.id) });
      expect(res.status).toBe(409);
      expect(res.body.code).toBe("CONFLICT");
    });

    it("re-calling start replaces the pending secret", async () => {
      const staff = await createStaff(ctx.prisma, f, { email: "ana@salon.com", role: "EMPLOYEE", password: PASSWORD });
      const mfaToken = await enrollToken(staff.id);
      const first = (await post("mfa/enroll", { mfaToken })).body.secret as string;
      const second = (await post("mfa/enroll", { mfaToken })).body.secret as string;
      expect(second).not.toBe(first);
      const res = await post("mfa/enroll/confirm", { mfaToken, code: totpCode(second, Date.now()) });
      expect(res.status).toBe(200);
    });
  });

  describe("verify", () => {
    it("current code → tokens with the staff role; replay is 400; the 6th attempt is 429", async () => {
      const secret = generateTotpSecret();
      const staff = await createStaff(ctx.prisma, f, { email: "ana@salon.com", role: "RECEPTION", password: PASSWORD, totpSecret: secret });
      const mfaToken = await verifyToken(staff.id);
      const code = totpCode(secret, Date.now());

      const ok = await post("mfa/verify", { mfaToken, code });
      expect(ok.status).toBe(200);
      const claims = await tokens().verifyAccess(ok.body.accessToken);
      expect(claims.role).toBe("RECEPTION");
      expect(claims.sub).toBe(staff.id);
      expect(await ctx.prisma.auditLog.count({ where: { action: "auth.staff.login", entityId: staff.id } })).toBe(1);

      const replay = await post("mfa/verify", { mfaToken, code });
      expect(replay.status).toBe(400);
      expect(replay.body.code).toBe("MFA_INVALID");

      for (let i = 0; i < 3; i++) expect((await post("mfa/verify", { mfaToken, code: wrongCode(secret) })).status).toBe(400);
      const limited = await post("mfa/verify", { mfaToken, code: nextStepCode(secret) });
      expect(limited.status).toBe(429);
      expect(limited.body.code).toBe("RATE_LIMITED");
    });

    it("an enroll token is 401 on verify", async () => {
      const secret = generateTotpSecret();
      const staff = await createStaff(ctx.prisma, f, { email: "ana@salon.com", role: "EMPLOYEE", password: PASSWORD, totpSecret: secret });
      const res = await post("mfa/verify", { mfaToken: await enrollToken(staff.id), code: totpCode(secret, Date.now()) });
      expect(res.status).toBe(401);
    });

    it("an expired mfaToken is 401", async () => {
      const secret = generateTotpSecret();
      const staff = await createStaff(ctx.prisma, f, { email: "ana@salon.com", role: "EMPLOYEE", password: PASSWORD, totpSecret: secret });
      const env = testEnv();
      const key = createPrivateKey({ key: Buffer.from(env.JWT_PRIVATE_KEY_B64, "base64"), format: "der", type: "pkcs8" });
      const now = Math.floor(Date.now() / 1000);
      const expired = await new SignJWT({ typ: "mfa", org: f.orgId, purpose: "verify" })
        .setProtectedHeader({ alg: "EdDSA", kid: env.JWT_KEY_ID })
        .setIssuer(JWT_ISSUER)
        .setAudience(MFA_AUDIENCE)
        .setSubject(staff.id)
        .setIssuedAt(now - 360)
        .setExpirationTime(now - 60)
        .sign(key);
      const res = await post("mfa/verify", { mfaToken: expired, code: totpCode(secret, Date.now()) });
      expect(res.status).toBe(401);
      expect(res.body.code).toBe("UNAUTHORIZED");
    });

    it("a staff user deactivated after login is 401", async () => {
      const secret = generateTotpSecret();
      const staff = await createStaff(ctx.prisma, f, { email: "ana@salon.com", role: "EMPLOYEE", password: PASSWORD, totpSecret: secret });
      const mfaToken = await verifyToken(staff.id);
      await ctx.prisma.staffUser.update({ where: { id: staff.id }, data: { active: false } });
      const res = await post("mfa/verify", { mfaToken, code: totpCode(secret, Date.now()) });
      expect(res.status).toBe(401);
    });
  });

  describe("recover", () => {
    it("a recovery code clears TOTP, revokes sessions and hands out an enroll token; it cannot be reused", async () => {
      const secret = generateTotpSecret();
      const staff = await createStaff(ctx.prisma, f, { email: "ana@salon.com", role: "EMPLOYEE", password: PASSWORD, totpSecret: secret });
      const codes = generateRecoveryCodes();
      await ctx.prisma.staffRecoveryCode.createMany({
        data: codes.map((c) => ({ staffUserId: staff.id, codeHash: hashRecoveryCode(c) })),
      });
      const mfaToken = await verifyToken(staff.id);
      // A live session that recovery must revoke.
      expect((await post("mfa/verify", { mfaToken, code: totpCode(secret, Date.now()) })).status).toBe(200);
      expect(await ctx.prisma.refreshToken.count({ where: { subjectId: staff.id, revokedAt: null } })).toBe(1);

      const res = await post("mfa/recover", { mfaToken, recoveryCode: ` ${codes[3]!.toUpperCase()} ` });
      expect(res.status).toBe(200);
      expect(res.body.status).toBe("ENROLL_REQUIRED");
      expect(res.body.refreshToken).toBeUndefined();
      expect(res.body.accessToken).toBeUndefined();
      expect((await tokens().verifyMfa(res.body.mfaToken, "enroll")).staffId).toBe(staff.id);

      const row = await ctx.prisma.staffUser.findUniqueOrThrow({ where: { id: staff.id } });
      expect(row.totpEnrolledAt).toBeNull();
      expect(row.totpSecretEnc).toBeNull();
      expect(await ctx.prisma.refreshToken.count({ where: { subjectId: staff.id, revokedAt: null } })).toBe(0);
      const left = await ctx.prisma.staffRecoveryCode.findMany({ where: { staffUserId: staff.id } });
      expect(left).toHaveLength(1);
      expect(left[0]!.usedAt).not.toBeNull();
      const audit = await ctx.prisma.auditLog.findMany({ where: { action: "auth.staff.recovery_used" } });
      expect(audit).toHaveLength(1);
      expect(JSON.stringify(audit)).not.toContain(codes[3]!);

      const reuse = await post("mfa/recover", { mfaToken, recoveryCode: codes[3]! });
      expect(reuse.status).toBe(400);
      expect(reuse.body.code).toBe("MFA_INVALID");

      const newToken = res.body.mfaToken as string;
      const { secret: newSecret } = (await post("mfa/enroll", { mfaToken: newToken })).body as { secret: string };
      const confirmed = await post("mfa/enroll/confirm", { mfaToken: newToken, code: totpCode(newSecret, Date.now()) });
      expect(confirmed.status).toBe(200);
      expect(confirmed.body.recoveryCodes).toHaveLength(10);
      expect(await ctx.prisma.staffRecoveryCode.count({ where: { staffUserId: staff.id } })).toBe(10);
    });

    it("an unknown recovery code is 400 MFA_INVALID", async () => {
      const staff = await createStaff(ctx.prisma, f, {
        email: "ana@salon.com",
        role: "EMPLOYEE",
        password: PASSWORD,
        totpSecret: generateTotpSecret(),
      });
      const res = await post("mfa/recover", { mfaToken: await verifyToken(staff.id), recoveryCode: "aaaa-bbbb-cccc-dddd" });
      expect(res.status).toBe(400);
      expect(res.body.code).toBe("MFA_INVALID");
    });
  });

  describe("concurrency", () => {
    it("a code for a replaced pending secret does not enroll the newer secret", async () => {
      const staff = await createStaff(ctx.prisma, f, { email: "ana@salon.com", role: "EMPLOYEE", password: PASSWORD });
      const mfaToken = await enrollToken(staff.id);
      const a = (await post("mfa/enroll", { mfaToken })).body.secret as string;
      const b = (await post("mfa/enroll", { mfaToken })).body.secret as string;
      const res = await post("mfa/enroll/confirm", { mfaToken, code: totpCode(a, Date.now()) });
      expect([400, 409]).toContain(res.status);
      const row = await ctx.prisma.staffUser.findUniqueOrThrow({ where: { id: staff.id } });
      expect(row.totpEnrolledAt).toBeNull();
      expect(await ctx.prisma.staffRecoveryCode.count({ where: { staffUserId: staff.id } })).toBe(0);
      expect(b).not.toBe(a);
    });

    it("two concurrent confirms (different valid steps) enroll exactly once", async () => {
      const staff = await createStaff(ctx.prisma, f, { email: "ana@salon.com", role: "EMPLOYEE", password: PASSWORD });
      const mfaToken = await enrollToken(staff.id);
      const secret = (await post("mfa/enroll", { mfaToken })).body.secret as string;
      const [r1, r2] = await Promise.all([
        post("mfa/enroll/confirm", { mfaToken, code: totpCode(secret, Date.now()) }),
        post("mfa/enroll/confirm", { mfaToken, code: nextStepCode(secret) }),
      ]);
      const statuses = [r1.status, r2.status].sort();
      expect(statuses[0]).toBe(200);
      expect([400, 409]).toContain(statuses[1]);
      expect(await ctx.prisma.staffRecoveryCode.count({ where: { staffUserId: staff.id } })).toBe(10);
      expect(await ctx.prisma.auditLog.count({ where: { action: "auth.staff.mfa_enrolled" } })).toBe(1);
    });

    it("two concurrent recoveries with different valid codes: one succeeds, the other is rejected, never 500", async () => {
      const staff = await createStaff(ctx.prisma, f, {
        email: "ana@salon.com",
        role: "EMPLOYEE",
        password: PASSWORD,
        totpSecret: generateTotpSecret(),
      });
      const codes = generateRecoveryCodes();
      await ctx.prisma.staffRecoveryCode.createMany({
        data: codes.map((c) => ({ staffUserId: staff.id, codeHash: hashRecoveryCode(c) })),
      });
      const mfaToken = await verifyToken(staff.id);
      const [r1, r2] = await Promise.all([
        post("mfa/recover", { mfaToken, recoveryCode: codes[0]! }),
        post("mfa/recover", { mfaToken, recoveryCode: codes[1]! }),
      ]);
      const ok = [r1, r2].filter((r) => r.status === 200);
      const rejected = [r1, r2].filter((r) => r.status !== 200);
      expect(ok).toHaveLength(1);
      expect(ok[0]!.body.status).toBe("ENROLL_REQUIRED");
      expect([400, 401]).toContain(rejected[0]!.status);
      const left = await ctx.prisma.staffRecoveryCode.findMany({ where: { staffUserId: staff.id } });
      expect(left).toHaveLength(1);
      expect(await ctx.prisma.auditLog.count({ where: { action: "auth.staff.recovery_used" } })).toBe(1);
    });
  });

  it("full flow: login → enroll → confirm → login → verify", async () => {
    await createStaff(ctx.prisma, f, { email: "ana@salon.com", role: "OWNER", password: PASSWORD });
    const first = await post("login", { email: "ana@salon.com", password: PASSWORD });
    expect(first.body.status).toBe("ENROLL_REQUIRED");
    const { secret } = (await post("mfa/enroll", { mfaToken: first.body.mfaToken })).body as { secret: string };
    expect((await post("mfa/enroll/confirm", { mfaToken: first.body.mfaToken, code: totpCode(secret, Date.now()) })).status).toBe(200);
    const second = await post("login", { email: "ana@salon.com", password: PASSWORD });
    expect(second.body.status).toBe("MFA_REQUIRED");
    // The confirm code's step is spent; the next step's code is still inside the window.
    const res = await post("mfa/verify", { mfaToken: second.body.mfaToken, code: nextStepCode(secret) });
    expect(res.status).toBe(200);
  });
});
