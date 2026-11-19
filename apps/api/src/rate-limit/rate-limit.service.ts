import { createHash } from "node:crypto";
import { HttpException, HttpStatus, Inject, Injectable } from "@nestjs/common";
import type { Redis } from "ioredis";
import { REDIS } from "../redis/redis.module.js";

export interface RateLimitResult {
  allowed: boolean;
  remaining: number;
  retryAfterSec: number;
}

/** First 16 hex chars of sha256(value), for putting identifiers (phone, email, ip) into Redis keys. */
export function hashKeyPart(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 16);
}

/**
 * Fixed-window counters in Redis (`rl:<key>`). The window starts at the first
 * hit and is not extended by later hits (`EXPIRE ... NX`). Callers build keys
 * from a scope plus `hashKeyPart(phone|email|ip)` so raw identifiers never
 * reach Redis.
 */
@Injectable()
export class RateLimitService {
  constructor(@Inject(REDIS) private readonly redis: Redis) {}

  async consume(key: string, limit: number, windowSec: number): Promise<RateLimitResult> {
    const k = `rl:${key}`;
    const res = await this.redis.multi().incr(k).expire(k, windowSec, "NX").ttl(k).exec();
    if (!res) throw new Error("Rate limit transaction aborted");
    for (const [err] of res) if (err) throw err;
    const count = Number(res[0]![1]);
    const ttl = Number(res[2]![1]);
    const allowed = count <= limit;
    return {
      allowed,
      remaining: Math.max(0, limit - count),
      retryAfterSec: allowed ? 0 : Math.max(1, ttl > 0 ? ttl : windowSec),
    };
  }

  /** Consumes one hit and throws 429 `RATE_LIMITED` when over the limit. */
  async enforce(key: string, limit: number, windowSec: number): Promise<void> {
    const { allowed } = await this.consume(key, limit, windowSec);
    if (!allowed) {
      throw new HttpException(
        { code: "RATE_LIMITED", message: "Too many attempts, try again later" },
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }
  }

  /** True when the key has already used its `limit` in the current window. Does not increment. */
  async peek(key: string, limit: number): Promise<boolean> {
    const v = await this.redis.get(`rl:${key}`);
    return v !== null && Number(v) >= limit;
  }

  async reset(key: string): Promise<void> {
    await this.redis.del(`rl:${key}`);
  }

  /** First 16 hex chars of sha256(value), for putting identifiers into keys. */
  hashKeyPart(value: string): string {
    return hashKeyPart(value);
  }
}
