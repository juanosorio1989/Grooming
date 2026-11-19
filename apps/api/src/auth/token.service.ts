import { createPrivateKey, createPublicKey, type KeyObject } from "node:crypto";
import { Inject, Injectable, UnauthorizedException } from "@nestjs/common";
import { SignJWT, jwtVerify, type JWTPayload } from "jose";
import { AccessClaimsSchema, type AccessClaims } from "@grooming/contracts";
import { ENV, type Env } from "../config/env.js";

export const JWT_ISSUER = "grooming-api";
export const ACCESS_AUDIENCE = "grooming";
export const MFA_AUDIENCE = "grooming-mfa";
export const ACCESS_TTL_SEC = 15 * 60;
export const MFA_TTL_SEC = 5 * 60;

export type MfaPurpose = "verify" | "enroll";

const unauthorized = () => new UnauthorizedException({ code: "UNAUTHORIZED" });

/** `typ: "customer"` ⇔ `role: "CUSTOMER"`; `typ: "staff"` ⇔ a staff role. */
function typMatchesRole(c: AccessClaims): boolean {
  return c.typ === "customer" ? c.role === "CUSTOMER" : c.role !== "CUSTOMER";
}

/**
 * EdDSA (Ed25519) JWTs signed with `JWT_PRIVATE_KEY_B64`, header `kid` = `JWT_KEY_ID`.
 * Access tokens (aud `grooming`, 15 min) and MFA step tokens (aud `grooming-mfa`,
 * `typ: "mfa"`, 5 min) use disjoint audiences, so neither verifies as the other.
 */
@Injectable()
export class TokenService {
  private readonly privateKey: KeyObject;
  private readonly publicKey: KeyObject;
  private readonly kid: string;

  constructor(@Inject(ENV) env: Env) {
    this.privateKey = createPrivateKey({
      key: Buffer.from(env.JWT_PRIVATE_KEY_B64, "base64"),
      format: "der",
      type: "pkcs8",
    });
    this.publicKey = createPublicKey(this.privateKey);
    this.kid = env.JWT_KEY_ID;
  }

  async issueAccess(claims: AccessClaims): Promise<{ token: string; expiresAt: Date }> {
    const parsed = AccessClaimsSchema.parse(claims);
    if (!typMatchesRole(parsed)) throw new Error("Access claims: typ and role do not match");
    const { sub, ...rest } = parsed;
    return this.sign({ ...rest }, sub, ACCESS_AUDIENCE, ACCESS_TTL_SEC);
  }

  /** Throws 401 `UNAUTHORIZED` for any invalid, expired, foreign or malformed token. */
  async verifyAccess(token: string): Promise<AccessClaims> {
    const payload = await this.verify(token, ACCESS_AUDIENCE);
    const parsed = AccessClaimsSchema.safeParse({
      sub: payload.sub,
      typ: payload.typ,
      org: payload.org,
      role: payload.role,
    });
    if (!parsed.success || !typMatchesRole(parsed.data)) throw unauthorized();
    return parsed.data;
  }

  issueMfa(staffId: string, orgId: string, purpose: MfaPurpose): Promise<{ token: string; expiresAt: Date }> {
    return this.sign({ typ: "mfa", org: orgId, purpose }, staffId, MFA_AUDIENCE, MFA_TTL_SEC);
  }

  /** Throws 401 `UNAUTHORIZED` unless the token is a valid MFA token for exactly `purpose`. */
  async verifyMfa(token: string, purpose: MfaPurpose): Promise<{ staffId: string; orgId: string }> {
    const payload = await this.verify(token, MFA_AUDIENCE);
    if (
      payload.typ !== "mfa" ||
      payload.purpose !== purpose ||
      typeof payload.sub !== "string" ||
      typeof payload.org !== "string"
    ) {
      throw unauthorized();
    }
    return { staffId: payload.sub, orgId: payload.org };
  }

  private async sign(
    payload: JWTPayload,
    sub: string,
    audience: string,
    ttlSec: number,
  ): Promise<{ token: string; expiresAt: Date }> {
    const iat = Math.floor(Date.now() / 1000);
    const exp = iat + ttlSec;
    const token = await new SignJWT(payload)
      .setProtectedHeader({ alg: "EdDSA", kid: this.kid })
      .setIssuer(JWT_ISSUER)
      .setAudience(audience)
      .setSubject(sub)
      .setIssuedAt(iat)
      .setExpirationTime(exp)
      .sign(this.privateKey);
    return { token, expiresAt: new Date(exp * 1000) };
  }

  private async verify(token: string, audience: string): Promise<JWTPayload> {
    try {
      const { payload } = await jwtVerify(token, this.publicKey, {
        algorithms: ["EdDSA"],
        issuer: JWT_ISSUER,
        audience,
        requiredClaims: ["sub", "exp", "iat"],
      });
      return payload;
    } catch {
      throw unauthorized();
    }
  }
}
