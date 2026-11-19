import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { TenancyService } from "../../src/tenancy/tenancy.service.js";
import { seedFixture } from "./helpers.js";
import { createIntegrationApp, resetState } from "./app.js";

describe("TenancyService", () => {
  let ctx: Awaited<ReturnType<typeof createIntegrationApp>>;

  beforeEach(async () => {
    ctx = await createIntegrationApp();
    await resetState(ctx.prisma, ctx.redis);
  });
  afterEach(async () => {
    await ctx?.close();
  });

  it("returns the DEFAULT_ORG_SLUG organization id and caches it", async () => {
    const f = await seedFixture(ctx.prisma);
    const tenancy = ctx.app.get(TenancyService);
    expect(await tenancy.getOrgId()).toBe(f.orgId);
    await resetState(ctx.prisma, ctx.redis);
    expect(await tenancy.getOrgId()).toBe(f.orgId);
  });

  it("rejects when the organization is missing", async () => {
    await expect(ctx.app.get(TenancyService).getOrgId()).rejects.toThrow(/test-salon not found/);
  });
});
