import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { createIntegrationApp, resetState } from "./app.js";
import { seedFixture, type Fixture } from "./helpers.js";
import { LOCATION_CACHE_TTL_MS, LocationService } from "../../src/location/location.service.js";

describe("LocationService cache TTL", () => {
  let ctx: Awaited<ReturnType<typeof createIntegrationApp>>;
  let f: Fixture;
  beforeAll(async () => {
    ctx = await createIntegrationApp();
    await resetState(ctx.prisma, ctx.redis);
    f = await seedFixture(ctx.prisma);
  });
  afterEach(() => {
    vi.useRealTimers();
  });
  afterAll(async () => {
    await ctx?.close();
  });

  it("serves the cached value before the TTL and refetches after it", async () => {
    const svc = ctx.app.get(LocationService);
    svc.invalidate();
    const first = await svc.getDefault();
    await ctx.prisma.location.update({ where: { id: f.locationId }, data: { timezone: "America/Chicago" } });

    expect((await svc.getDefault()).timezone).toBe(first.timezone);

    const real = Date.now();
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(real + LOCATION_CACHE_TTL_MS - 1000);
    expect((await svc.getDefault()).timezone).toBe(first.timezone);
    vi.setSystemTime(real + LOCATION_CACHE_TTL_MS + 1000);
    expect((await svc.getDefault()).timezone).toBe("America/Chicago");
  });
});
