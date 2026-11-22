import { Inject, Injectable, NotFoundException, UnauthorizedException } from "@nestjs/common";
import type { Request, Response } from "express";
import type { GoogleNonceResponse, GoogleSignInResponse } from "@grooming/contracts";
import { AuditService } from "../../audit/audit.service.js";
import { ENV, type Env } from "../../config/env.js";
import { PrismaService } from "../../prisma/prisma.service.js";
import { RateLimitService } from "../../rate-limit/rate-limit.service.js";
import { TenancyService } from "../../tenancy/tenancy.service.js";
import { requestMeta } from "../request-meta.js";
import { SessionService } from "../session.service.js";
import { BrowserBindingStore } from "./browser-binding.store.js";
import { GoogleIdTokenVerifier } from "./google-id-token.js";

/** Rate limits: [limit, window seconds]. */
const NONCE_PER_IP = [30, 600] as const;
const SIGNIN_PER_IP = [10, 600] as const;
const SIGNIN_PER_SUB = [10, 600] as const;

const unauthorized = () => new UnauthorizedException({ code: "UNAUTHORIZED" });

/**
 * Owner sign-in with Google. A linked Google account signs in like a phone
 * code; an unlinked one gets a browser-bound link ticket and must verify a
 * phone (`/auth/otp/verify`). An email match never links or signs in anyone.
 * The `sub`, the token, the nonce and the ticket never reach logs or audit.
 */
@Injectable()
export class GoogleAuthService {
  constructor(
    @Inject(ENV) private readonly env: Env,
    private readonly verifier: GoogleIdTokenVerifier,
    private readonly bindings: BrowserBindingStore,
    private readonly rateLimit: RateLimitService,
    private readonly tenancy: TenancyService,
    private readonly sessions: SessionService,
    private readonly audit: AuditService,
    private readonly prisma: PrismaService,
  ) {}

  get enabled(): boolean {
    return this.env.GOOGLE_OAUTH_CLIENT_IDS.length > 0;
  }

  /** 404 NOT_FOUND when GOOGLE_OAUTH_CLIENT_IDS is empty. */
  assertEnabled(): void {
    if (!this.enabled) throw new NotFoundException({ code: "NOT_FOUND" });
  }

  async nonce(req: Request, res: Response): Promise<GoogleNonceResponse> {
    this.assertEnabled();
    await this.rateLimit.enforce(`gauth:nonce:ip:${this.ipKey(req)}`, ...NONCE_PER_IP);
    return { nonce: await this.bindings.createNonce(res) };
  }

  async signIn(idToken: string, req: Request, res: Response): Promise<GoogleSignInResponse> {
    this.assertEnabled();
    await this.rateLimit.enforce(`gauth:signin:ip:${this.ipKey(req)}`, ...SIGNIN_PER_IP);
    const claims = await this.verifier.verify(idToken);
    if (!(await this.bindings.consumeNonce(claims.nonce, req, res))) throw unauthorized();
    await this.rateLimit.enforce(`gauth:signin:sub:${this.rateLimit.hashKeyPart(claims.sub)}`, ...SIGNIN_PER_SUB);

    const orgId = await this.tenancy.getOrgId();
    const identity = await this.prisma.customerIdentity.findUnique({
      where: { organizationId_provider_subject: { organizationId: orgId, provider: "GOOGLE", subject: claims.sub } },
      select: { id: true, customerId: true, customer: { select: { name: true, deletedAt: true } } },
    });

    if (!identity) {
      const linkTicket = await this.bindings.createTicket(
        { orgId, sub: claims.sub, email: claims.email, name: claims.name ?? claims.givenName },
        res,
      );
      return {
        status: "PHONE_REQUIRED",
        linkTicket,
        ...(claims.name ? { name: claims.name } : {}),
        ...(claims.givenName ? { givenName: claims.givenName } : {}),
      };
    }
    if (identity.customer.deletedAt) throw unauthorized();

    const customerId = identity.customerId;
    const isNew = identity.customer.name === null;
    await this.prisma.customerIdentity.update({ where: { id: identity.id }, data: { email: claims.email } });
    await this.audit.record({
      orgId,
      actorType: "CUSTOMER",
      actorId: customerId,
      action: "auth.customer.login",
      entity: "customer",
      entityId: customerId,
      after: { method: "google", isNew },
      ip: requestMeta(req).ip,
    });
    const tokens = await this.sessions.start({ type: "CUSTOMER", id: customerId }, req, res);
    return { status: "SIGNED_IN", ...tokens, isNew };
  }

  private ipKey(req: Request): string {
    return this.rateLimit.hashKeyPart(requestMeta(req).ip ?? "unknown");
  }
}
