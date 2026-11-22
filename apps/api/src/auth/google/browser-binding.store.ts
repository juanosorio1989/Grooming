import { timingSafeEqual } from "node:crypto";
import { Inject, Injectable } from "@nestjs/common";
import type { CookieOptions, Request, Response } from "express";
import type { Redis } from "ioredis";
import { ENV, type Env } from "../../config/env.js";
import { REDIS } from "../../redis/redis.module.js";
import { randomToken, sha256Hex } from "../crypto/tokens.js";

export const NONCE_COOKIE = "gr_gnonce";
export const LINK_COOKIE = "gr_glink";
export const BINDING_TTL_SEC = 600;

const NONCE_COOKIE_PATH = "/v1";
const LINK_COOKIE_PATH = "/v1/auth";

/** What a link ticket carries from `/auth/google` to the phone-code verify. `sub` is never logged or audited. */
export interface LinkTicketData {
  orgId: string;
  sub: string;
  email: string;
  name: string | null;
}

/**
 * Single-use Google nonces and link tickets, each bound to the browser that
 * asked for it by a random binding value in an HttpOnly cookie. Redis keys
 * hold only `sha256Hex(nonce|ticket)`; entries live 10 min and are read with
 * `GETDEL`, so every consume deletes them whatever the outcome.
 */
@Injectable()
export class BrowserBindingStore {
  constructor(
    @Inject(REDIS) private readonly redis: Redis,
    @Inject(ENV) private readonly env: Env,
  ) {}

  async createNonce(res: Response): Promise<string> {
    const nonce = randomToken();
    const binding = randomToken();
    await this.redis.set(nonceKey(nonce), binding, "EX", BINDING_TTL_SEC);
    res.cookie(NONCE_COOKIE, binding, this.cookieOptions(NONCE_COOKIE_PATH, true));
    return nonce;
  }

  /** Single use: the Redis entry is deleted on every call. True only if it existed and its binding equals the cookie. */
  async consumeNonce(nonce: string, req: Request, res: Response): Promise<boolean> {
    const stored = await this.redis.getdel(nonceKey(nonce));
    if (stored === null || !bindingMatches(stored, readCookie(req, NONCE_COOKIE))) return false;
    res.clearCookie(NONCE_COOKIE, this.cookieOptions(NONCE_COOKIE_PATH, false));
    return true;
  }

  async createTicket(data: LinkTicketData, res: Response): Promise<string> {
    const ticket = randomToken();
    const binding = randomToken();
    const value = JSON.stringify({ binding, orgId: data.orgId, sub: data.sub, email: data.email, name: data.name });
    await this.redis.set(ticketKey(ticket), value, "EX", BINDING_TTL_SEC);
    res.cookie(LINK_COOKIE, binding, this.cookieOptions(LINK_COOKIE_PATH, true));
    return ticket;
  }

  /** Single use, same rule; null when missing, expired or the cookie does not match. */
  async consumeTicket(ticket: string, req: Request, res: Response): Promise<LinkTicketData | null> {
    const raw = await this.redis.getdel(ticketKey(ticket));
    if (raw === null) return null;
    const stored = parseTicket(raw);
    if (!stored || !bindingMatches(stored.binding, readCookie(req, LINK_COOKIE))) return null;
    res.clearCookie(LINK_COOKIE, this.cookieOptions(LINK_COOKIE_PATH, false));
    return { orgId: stored.orgId, sub: stored.sub, email: stored.email, name: stored.name };
  }

  private cookieOptions(path: string, withMaxAge: boolean): CookieOptions {
    return {
      httpOnly: true,
      sameSite: "strict",
      path,
      secure: this.env.COOKIE_SECURE,
      ...(this.env.COOKIE_DOMAIN ? { domain: this.env.COOKIE_DOMAIN } : {}),
      ...(withMaxAge ? { maxAge: BINDING_TTL_SEC * 1000 } : {}),
    };
  }
}

const nonceKey = (nonce: string) => `gauth:nonce:${sha256Hex(nonce)}`;
const ticketKey = (ticket: string) => `gauth:ticket:${sha256Hex(ticket)}`;

function readCookie(req: Request, name: string): string | null {
  const cookies = (req.cookies ?? {}) as Record<string, unknown>;
  const v = cookies[name];
  return typeof v === "string" && v !== "" ? v : null;
}

/** Constant-time comparison on equal-length buffers; a missing cookie never matches. */
function bindingMatches(stored: string, presented: string | null): boolean {
  if (presented === null) return false;
  const a = Buffer.from(stored, "utf8");
  const b = Buffer.from(presented, "utf8");
  return a.length === b.length && timingSafeEqual(a, b);
}

type StoredTicket = LinkTicketData & { binding: string };

function parseTicket(raw: string): StoredTicket | null {
  try {
    const v = JSON.parse(raw) as Record<string, unknown>;
    const str = (x: unknown): x is string => typeof x === "string" && x !== "";
    if (!str(v.binding) || !str(v.orgId) || !str(v.sub) || !str(v.email)) return null;
    const name = typeof v.name === "string" ? v.name : null;
    return { binding: v.binding, orgId: v.orgId, sub: v.sub, email: v.email, name };
  } catch {
    return null;
  }
}
