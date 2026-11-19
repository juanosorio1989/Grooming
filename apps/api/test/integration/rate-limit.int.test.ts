import { HttpException } from "@nestjs/common";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { RateLimitService } from "../../src/rate-limit/rate-limit.service.js";
import { createIntegrationApp, resetState } from "./app.js";

describe("RateLimitService (real Redis)", () => {
  let ctx: Awaited<ReturnType<typeof createIntegrationApp>>;
  let rl: RateLimitService;

  beforeAll(async () => {
    ctx = await createIntegrationApp();
    rl = ctx.app.get(RateLimitService);
  });
  beforeEach(async () => {
    await resetState(ctx.prisma, ctx.redis);
  });
  afterAll(async () => {
    await ctx?.close();
  });

  it("allows up to the limit, then blocks with retryAfterSec within the window", async () => {
    for (let i = 0; i < 3; i++) {
      const r = await rl.consume("t", 3, 60);
      expect(r.allowed).toBe(true);
      expect(r.remaining).toBe(2 - i);
    }
    const blocked = await rl.consume("t", 3, 60);
    expect(blocked.allowed).toBe(false);
    expect(blocked.remaining).toBe(0);
    expect(blocked.retryAfterSec).toBeGreaterThanOrEqual(1);
    expect(blocked.retryAfterSec).toBeLessThanOrEqual(60);
  });

  it("enforce rejects past the limit with 429 RATE_LIMITED", async () => {
    for (let i = 0; i < 3; i++) await rl.enforce("t", 3, 60);
    const err = await rl.enforce("t", 3, 60).then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(HttpException);
    expect((err as HttpException).getStatus()).toBe(429);
    expect((err as HttpException).getResponse()).toMatchObject({ code: "RATE_LIMITED" });
  });

  it("peek reports blocked without incrementing", async () => {
    expect(await rl.peek("t", 2)).toBe(false);
    await rl.consume("t", 2, 60);
    expect(await rl.peek("t", 2)).toBe(false);
    await rl.consume("t", 2, 60);
    expect(await rl.peek("t", 2)).toBe(true);
    expect(await rl.peek("t", 2)).toBe(true);
    expect(await ctx.redis.get("rl:t")).toBe("2");
  });

  it("reset clears the counter", async () => {
    for (let i = 0; i < 4; i++) await rl.consume("t", 3, 60);
    await rl.reset("t");
    expect((await rl.consume("t", 3, 60)).allowed).toBe(true);
  });

  it("the window expires", async () => {
    await rl.consume("t", 1, 1);
    expect((await rl.consume("t", 1, 1)).allowed).toBe(false);
    await new Promise((r) => setTimeout(r, 1100));
    expect((await rl.consume("t", 1, 1)).allowed).toBe(true);
  });

  it("hashKeyPart is the first 16 hex chars of sha256", () => {
    expect(rl.hashKeyPart("abc")).toBe("ba7816bf8f01cfea");
  });
});
