import { ForbiddenException, Inject, Injectable, UnauthorizedException } from "@nestjs/common";
import type { CookieOptions, Request, Response } from "express";
import { AUTH_HEADERS, type AccessClaims, type TokenResponse } from "@grooming/contracts";
import { ENV, type Env } from "../config/env.js";
import { PrismaService } from "../prisma/prisma.service.js";
import { RefreshTokenService } from "./refresh-token.service.js";
import { requestMeta, type Subject } from "./request-meta.js";
import { TokenService } from "./token.service.js";

export const REFRESH_COOKIE = "gr_refresh";
export const REFRESH_COOKIE_PATH = "/v1/auth";

const unauthorized = () => new UnauthorizedException({ code: "UNAUTHORIZED" });

/** Where the refresh token was read from on refresh/logout. */
type Presented = { token: string; via: Transport } | null;
type Transport = "cookie" | "body";

/**
 * Starts, refreshes and ends sessions. Transport: a request with header
 * `x-token-transport: body` gets the refresh token in the JSON body and no
 * cookie (native); every other request, and every refresh whose token came
 * from the cookie, gets it only as the `gr_refresh` cookie. A cookie-borne refresh token is honoured only with header
 * `x-grooming-csrf: 1` (forces a CORS preflight); a body token needs no
 * CSRF header because browsers never send it implicitly.
 */
@Injectable()
export class SessionService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly tokens: TokenService,
    private readonly refreshTokens: RefreshTokenService,
    @Inject(ENV) private readonly env: Env,
  ) {}

  /** Issues an access + refresh token for an eligible subject (401 otherwise). */
  async start(subject: Subject, req: Request, res: Response): Promise<TokenResponse> {
    const claims = await this.loadClaims(subject);
    if (!claims) throw unauthorized();
    const refresh = await this.refreshTokens.create(subject, requestMeta(req));
    return this.respond(claims, refresh, this.requestedTransport(req), res);
  }

  async refresh(req: Request, res: Response): Promise<TokenResponse> {
    const presented = this.presentedToken(req);
    if (!presented) throw unauthorized();
    try {
      const rotated = await this.refreshTokens.rotate(presented.token, requestMeta(req));
      const claims = await this.loadClaims(rotated.subject);
      if (!claims) {
        await this.refreshTokens.revokeAllFor(rotated.subject);
        throw unauthorized();
      }
      // A cookie-borne token never comes back in JSON, whatever the header says:
      // page script could otherwise read a fresh refresh token (HttpOnly bypass).
      const transport = presented.via === "cookie" ? "cookie" : this.requestedTransport(req);
      return await this.respond(claims, rotated, transport, res);
    } catch (err) {
      if (presented.via === "cookie" && err instanceof UnauthorizedException) this.clearCookie(res);
      throw err;
    }
  }

  /** Revokes the presented token's family and clears the cookie. 204 even for unknown or missing tokens. */
  async logout(req: Request, res: Response): Promise<void> {
    const presented = this.presentedToken(req);
    if (presented) await this.refreshTokens.revokeFamilyOf(presented.token);
    this.clearCookie(res);
  }

  /** Body token first; else the cookie, which requires the CSRF header (403 `FORBIDDEN`). */
  private presentedToken(req: Request): Presented {
    const body = (req.body ?? {}) as { refreshToken?: unknown };
    if (typeof body.refreshToken === "string" && body.refreshToken !== "") {
      return { token: body.refreshToken, via: "body" };
    }
    const cookies = (req.cookies ?? {}) as Record<string, unknown>;
    const cookie = cookies[REFRESH_COOKIE];
    if (typeof cookie !== "string" || cookie === "") return null;
    if (req.get(AUTH_HEADERS.csrf) !== "1") throw new ForbiddenException({ code: "FORBIDDEN" });
    return { token: cookie, via: "cookie" };
  }

  /** Current claims, or null when the subject may no longer hold a session. */
  private async loadClaims(subject: Subject): Promise<AccessClaims | null> {
    if (subject.type === "CUSTOMER") {
      const customer = await this.prisma.customer.findUnique({
        where: { id: subject.id },
        select: { organizationId: true, deletedAt: true },
      });
      if (!customer || customer.deletedAt) return null;
      return { sub: subject.id, typ: "customer", org: customer.organizationId, role: "CUSTOMER" };
    }
    const staff = await this.prisma.staffUser.findUnique({
      where: { id: subject.id },
      select: { organizationId: true, role: true, active: true, canLogin: true },
    });
    if (!staff || !staff.active || !staff.canLogin) return null;
    return { sub: subject.id, typ: "staff", org: staff.organizationId, role: staff.role };
  }

  private requestedTransport(req: Request): Transport {
    return req.get(AUTH_HEADERS.tokenTransport) === "body" ? "body" : "cookie";
  }

  private async respond(
    claims: AccessClaims,
    refresh: { token: string; expiresAt: Date },
    transport: Transport,
    res: Response,
  ): Promise<TokenResponse> {
    const access = await this.tokens.issueAccess(claims);
    const body: TokenResponse = { accessToken: access.token, accessTokenExpiresAt: access.expiresAt.toISOString() };
    if (transport === "body") return { ...body, refreshToken: refresh.token };
    res.cookie(REFRESH_COOKIE, refresh.token, { ...this.cookieOptions(), expires: refresh.expiresAt });
    return body;
  }

  private clearCookie(res: Response): void {
    res.clearCookie(REFRESH_COOKIE, this.cookieOptions());
  }

  private cookieOptions(): CookieOptions {
    return {
      httpOnly: true,
      sameSite: "lax",
      path: REFRESH_COOKIE_PATH,
      secure: this.env.COOKIE_SECURE,
      ...(this.env.COOKIE_DOMAIN ? { domain: this.env.COOKIE_DOMAIN } : {}),
    };
  }
}
