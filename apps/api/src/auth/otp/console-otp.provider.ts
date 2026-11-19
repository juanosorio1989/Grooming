import { randomInt, timingSafeEqual } from "node:crypto";
import { Logger } from "@nestjs/common";
import type { Redis } from "ioredis";
import { sha256Hex } from "../crypto/tokens.js";
import { hashKeyPart } from "../../rate-limit/rate-limit.service.js";
import type { OtpProvider } from "./otp-provider.js";

const TTL_SEC = 600;

/**
 * DEV ONLY: logs the code instead of sending it (`loadEnv` refuses this
 * provider in production). Stores only `sha256Hex(code)` in Redis at
 * `otp:console:<hashKeyPart(phone)>` for 10 minutes; a successful check deletes it.
 */
export class ConsoleOtpProvider implements OtpProvider {
  private readonly logger = new Logger(ConsoleOtpProvider.name);

  constructor(private readonly redis: Redis) {}

  /** Channel and locale are irrelevant: nothing is sent. */
  async start(phone: string): Promise<void> {
    const code = String(randomInt(0, 1_000_000)).padStart(6, "0");
    await this.redis.set(this.key(phone), sha256Hex(code), "EX", TTL_SEC);
    this.logger.log(`OTP for ${phone}: ${code}`);
  }

  async check(phone: string, code: string): Promise<boolean> {
    const key = this.key(phone);
    const stored = await this.redis.get(key);
    if (!stored) return false;
    const a = Buffer.from(stored);
    const b = Buffer.from(sha256Hex(code));
    const ok = a.length === b.length && timingSafeEqual(a, b);
    if (ok) await this.redis.del(key);
    return ok;
  }

  private key(phone: string): string {
    return `otp:console:${hashKeyPart(phone)}`;
  }
}
