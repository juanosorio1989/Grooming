import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { sha256Hex } from "../../../src/auth/crypto/tokens.js";
import { generateTotpSecret } from "../../../src/auth/crypto/totp.js";
import { RefreshTokenService } from "../../../src/auth/refresh-token.service.js";
import { StaffLinksService } from "../../../src/auth/staff/staff-links.service.js";
import { createIntegrationApp, resetState } from "../app.js";
import { createStaff, seedFixture, type Fixture } from "../helpers.js";

type Ctx = Awaited<ReturnType<typeof createIntegrationApp>>;

describe("create-owner (StaffLinksService.createOrResetOwner)", () => {
  let ctx: Ctx;
  let f: Fixture;
  const links = () => ctx.app.get(StaffLinksService);

  beforeAll(async () => {
    ctx = await createIntegrationApp();
    await resetState(ctx.prisma, ctx.redis);
    f = await seedFixture(ctx.prisma);
  });
  beforeEach(async () => {
    await ctx.prisma.auditLog.deleteMany();
    await ctx.prisma.refreshToken.deleteMany();
    await ctx.prisma.staffUser.deleteMany({ where: { id: { notIn: [f.staffA, f.staffB] } } });
  });
  afterAll(async () => {
    await ctx?.close();
  });

  it("creates an OWNER that can log in and returns an en invite link", async () => {
    const { link, created } = await links().createOrResetOwner(" Boss@Salon.com ", "en");
    expect(created).toBe(true);
    expect(link).toContain("/en/staff/invite?token=");
    const owner = await ctx.prisma.staffUser.findFirstOrThrow({ where: { email: "boss@salon.com" } });
    expect(owner.role).toBe("OWNER");
    expect(owner.canLogin).toBe(true);
    expect(owner.locale).toBe("en");
    expect(owner.organizationId).toBe(f.orgId);
    const token = new URL(link).searchParams.get("token")!;
    const row = await ctx.prisma.staffAuthToken.findUniqueOrThrow({ where: { tokenHash: sha256Hex(token) } });
    expect(row.purpose).toBe("INVITE");
    expect(row.staffUserId).toBe(owner.id);

    const audit = await ctx.prisma.auditLog.findMany({ where: { action: "staff.owner_cli" } });
    expect(audit).toHaveLength(1);
    expect(audit[0]!.actorType).toBe("SYSTEM");
    expect(audit[0]!.actorId).toBeNull();
    expect(JSON.stringify(audit)).not.toContain(token);
  });

  it("the same email again resets the OWNER: password, TOTP, recovery codes and sessions cleared; old link spent", async () => {
    const first = await links().createOrResetOwner("boss@salon.com", "es");
    const owner = await ctx.prisma.staffUser.findFirstOrThrow({ where: { email: "boss@salon.com" } });
    await ctx.prisma.staffUser.update({
      where: { id: owner.id },
      data: { passwordHash: "x", totpSecretEnc: "y", totpEnrolledAt: new Date() },
    });
    await ctx.prisma.staffRecoveryCode.create({ data: { staffUserId: owner.id, codeHash: "h" } });
    await ctx.app.get(RefreshTokenService).create({ type: "STAFF", id: owner.id }, { ip: null, userAgent: null });

    const second = await links().createOrResetOwner("boss@salon.com", "es");
    expect(second.created).toBe(false);
    expect(second.link).toContain("/es/staff/invite?token=");
    const row = await ctx.prisma.staffUser.findUniqueOrThrow({ where: { id: owner.id } });
    expect(row.passwordHash).toBeNull();
    expect(row.totpSecretEnc).toBeNull();
    expect(row.totpEnrolledAt).toBeNull();
    expect(row.canLogin).toBe(true);
    expect(await ctx.prisma.staffRecoveryCode.count({ where: { staffUserId: owner.id } })).toBe(0);
    expect(await ctx.prisma.refreshToken.count({ where: { subjectId: owner.id, revokedAt: null } })).toBe(0);

    const firstRow = await ctx.prisma.staffAuthToken.findUniqueOrThrow({
      where: { tokenHash: sha256Hex(new URL(first.link).searchParams.get("token")!) },
    });
    expect(firstRow.usedAt).not.toBeNull();
  });

  it("creating without a locale defaults to en", async () => {
    const { link } = await links().createOrResetOwner("boss@salon.com");
    expect(link).toContain("/en/staff/invite?token=");
    expect((await ctx.prisma.staffUser.findFirstOrThrow({ where: { email: "boss@salon.com" } })).locale).toBe("en");
  });

  it("resetting without a locale keeps the owner's locale; with one it changes it", async () => {
    await links().createOrResetOwner("boss@salon.com", "es");
    const kept = await links().createOrResetOwner("boss@salon.com");
    expect(kept.created).toBe(false);
    expect(kept.link).toContain("/es/staff/invite?token=");
    expect((await ctx.prisma.staffUser.findFirstOrThrow({ where: { email: "boss@salon.com" } })).locale).toBe("es");

    const changed = await links().createOrResetOwner("boss@salon.com", "en");
    expect(changed.link).toContain("/en/staff/invite?token=");
    expect((await ctx.prisma.staffUser.findFirstOrThrow({ where: { email: "boss@salon.com" } })).locale).toBe("en");
  });

  it("rejects the email of a non-owner staff member", async () => {
    await createStaff(ctx.prisma, f, { email: "emp@salon.com", role: "EMPLOYEE", totpSecret: generateTotpSecret() });
    await expect(links().createOrResetOwner("emp@salon.com", "en")).rejects.toThrow(/non-owner/);
  });
});
