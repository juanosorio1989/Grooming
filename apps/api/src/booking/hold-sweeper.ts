import { Inject, Injectable, Logger, type OnApplicationBootstrap, type OnApplicationShutdown } from "@nestjs/common";
import { ENV, type Env } from "../config/env.js";
import { PrismaService } from "../prisma/prisma.service.js";
import { HoldReleaseService } from "./hold-release.service.js";

/**
 * Releases expired holds of every organization every `HOLD_SWEEPER_INTERVAL_MS`
 * (0 = never starts; tests call `sweepOnce`). The timer is unref'd so it never
 * keeps the process alive. Booking writes also release their organization's
 * expired holds, so the sweeper only keeps the calendar tidy between writes.
 */
@Injectable()
export class HoldSweeper implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly logger = new Logger(HoldSweeper.name);
  private timer: NodeJS.Timeout | undefined;
  private running = false;

  constructor(
    @Inject(ENV) private readonly env: Env,
    private readonly prisma: PrismaService,
    private readonly release: HoldReleaseService,
  ) {}

  onApplicationBootstrap(): void {
    const ms = this.env.HOLD_SWEEPER_INTERVAL_MS;
    if (ms <= 0) return;
    this.timer = setInterval(() => void this.tick(), ms);
    this.timer.unref();
  }

  onApplicationShutdown(): void {
    if (this.timer !== undefined) clearInterval(this.timer);
    this.timer = undefined;
  }

  /** One batch (at most 500 holds, all organizations) in one transaction. Returns the count released. */
  async sweepOnce(now: Date = new Date()): Promise<number> {
    return this.prisma.$transaction((tx) => this.release.releaseExpired(tx, now));
  }

  /** The interval body: skips while a sweep runs, logs errors and never throws. */
  async tick(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      const count = await this.sweepOnce();
      if (count > 0) this.logger.log(`Released ${count} expired hold(s)`);
    } catch (err) {
      this.logger.error(`Hold sweep failed: ${(err as Error).message}`);
    } finally {
      this.running = false;
    }
  }
}
