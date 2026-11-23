import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HoldSweeper } from "../../../src/booking/hold-sweeper.js";
import type { Env } from "../../../src/config/env.js";
import { createIntegrationApp, resetState } from "../app.js";
import { at, seedFixture, type Fixture } from "../helpers.js";

const MIN = 60_000;

describe("HoldSweeper", () => {
  let ctx: Awaited<ReturnType<typeof createIntegrationApp>>;

  beforeEach(async () => {
    ctx = await createIntegrationApp();
    await resetState(ctx.prisma, ctx.redis);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await ctx?.close();
  });

  /** A HELD appointment with one occupying bath segment at `hour` on 2026-12-01 (UTC). */
  async function heldWithSegment(f: Fixture, holdExpiresAt: Date, hour: string) {
    const appt = await ctx.prisma.appointment.create({
      data: { organizationId: f.orgId, locationId: f.locationId, status: "HELD", source: "ONLINE", bookingMode: "WAIT", holdExpiresAt },
    });
    const visit = await ctx.prisma.petVisit.create({
      data: {
        organizationId: f.orgId, appointmentId: appt.id, petId: f.petId, position: 0, status: "BOOKED",
        sizeClassAtBooking: "M", coatTypeAtBooking: "CURLY", priceCentsQuoted: 4500,
      },
    });
    const end = `${String(Number(hour.slice(0, 2)) + 1).padStart(2, "0")}:00`;
    await ctx.prisma.appointmentSegment.create({
      data: {
        organizationId: f.orgId, appointmentId: appt.id, petVisitId: visit.id, stage: "BATH", serviceId: f.serviceId,
        staffUserId: f.staffA, resourceId: f.resource1, startsAt: at(hour), endsAt: at(end), blockEndsAt: at(end),
        durationMin: 60, priceCents: 4500, occupies: true,
      },
    });
    return appt;
  }

  it("sweepOnce releases two expired holds in two orgs and leaves a fresh hold", async () => {
    const f1 = await seedFixture(ctx.prisma);
    const f2 = await seedFixture(ctx.prisma, { slug: "other-salon" });
    const now = new Date();
    const past = new Date(now.getTime() - MIN);
    const a = await heldWithSegment(f1, past, "09:00");
    const b = await heldWithSegment(f2, past, "09:00");
    const fresh = await heldWithSegment(f1, new Date(now.getTime() + 5 * MIN), "11:00");

    expect(await ctx.app.get(HoldSweeper).sweepOnce(now)).toBe(2);

    for (const id of [a.id, b.id]) {
      const row = await ctx.prisma.appointment.findUniqueOrThrow({ where: { id }, include: { segments: true, petVisits: true } });
      expect(row).toMatchObject({ status: "CANCELLED", cancelReason: "HOLD_EXPIRED", cancelledBy: "SYSTEM" });
      expect(row.segments.every((s) => !s.occupies)).toBe(true);
      expect(row.petVisits.every((v) => v.status === "CANCELLED")).toBe(true);
    }
    const kept = await ctx.prisma.appointment.findUniqueOrThrow({ where: { id: fresh.id }, include: { segments: true } });
    expect(kept.status).toBe("HELD");
    expect(kept.segments.every((s) => s.occupies)).toBe(true);
    expect(await ctx.app.get(HoldSweeper).sweepOnce(now)).toBe(0);
  });

  it("with HOLD_SWEEPER_INTERVAL_MS 0 no interval is registered", async () => {
    const spy = vi.spyOn(globalThis, "setInterval");
    const sweeper = new HoldSweeper({ HOLD_SWEEPER_INTERVAL_MS: 0 } as Env, ctx.prisma, {} as never);
    sweeper.onApplicationBootstrap();
    expect(spy).not.toHaveBeenCalled();
    sweeper.onApplicationShutdown();
  });

  it("with an interval it registers one unref'd timer and clears it on shutdown", async () => {
    const set = vi.spyOn(globalThis, "setInterval");
    const clear = vi.spyOn(globalThis, "clearInterval");
    const sweeper = new HoldSweeper({ HOLD_SWEEPER_INTERVAL_MS: 1500 } as Env, ctx.prisma, {} as never);
    sweeper.onApplicationBootstrap();
    expect(set).toHaveBeenCalledTimes(1);
    expect(set.mock.calls[0]?.[1]).toBe(1500);
    const timer = set.mock.results[0]?.value as NodeJS.Timeout;
    expect(timer.hasRef()).toBe(false);
    sweeper.onApplicationShutdown();
    expect(clear).toHaveBeenCalledWith(timer);
  });

  it("a failing sweep is logged and never thrown out of the interval tick", async () => {
    const failing = { releaseExpired: () => Promise.reject(new Error("db down")) };
    const sweeper = new HoldSweeper({ HOLD_SWEEPER_INTERVAL_MS: 0 } as Env, ctx.prisma, failing as never);
    const log = vi.spyOn(sweeper["logger"], "error").mockImplementation(() => undefined);
    await expect(sweeper.tick()).resolves.toBeUndefined();
    expect(log).toHaveBeenCalledTimes(1);
  });
});
