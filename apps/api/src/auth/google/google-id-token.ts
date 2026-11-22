import { Inject, Injectable, Logger, UnauthorizedException } from "@nestjs/common";
import { errors as joseErrors, jwtVerify, type JWTPayload, type JWTVerifyGetKey } from "jose";
import { ENV, type Env } from "../../config/env.js";
import { GOOGLE_JWKS } from "./google-jwks.js";

/** The verified claims the API uses. `sub` and `nonce` are secrets: never log or audit them. */
export interface GoogleClaims {
  sub: string;
  email: string;
  nonce: string;
  name: string | null;
  givenName: string | null;
}

const GOOGLE_ISSUERS = ["https://accounts.google.com", "accounts.google.com"];

const unauthorized = () => new UnauthorizedException({ code: "UNAUTHORIZED" });

const nonEmpty = (v: unknown): v is string => typeof v === "string" && v !== "";
const optionalString = (v: unknown): string | null => (nonEmpty(v) ? v : null);

/** Verifies Google ID tokens: RS256 signature, issuer, audience (any configured client ID), expiry, verified email, nonce present. */
@Injectable()
export class GoogleIdTokenVerifier {
  private readonly logger = new Logger(GoogleIdTokenVerifier.name);

  constructor(
    @Inject(GOOGLE_JWKS) private readonly jwks: JWTVerifyGetKey,
    @Inject(ENV) private readonly env: Env,
  ) {}

  /** 401 UNAUTHORIZED on any failure. */
  async verify(idToken: string): Promise<GoogleClaims> {
    let payload: JWTPayload;
    try {
      ({ payload } = await jwtVerify(idToken, this.jwks, {
        issuer: GOOGLE_ISSUERS,
        audience: this.env.GOOGLE_OAUTH_CLIENT_IDS,
        algorithms: ["RS256"],
      }));
    } catch (err) {
      // Only the error class/code is logged: never the token or its claims.
      const code = err instanceof joseErrors.JOSEError ? err.code : "UNKNOWN";
      this.logger.warn(`Google ID token rejected: ${code}`);
      throw unauthorized();
    }
    if (payload.email_verified !== true || !nonEmpty(payload.email) || !nonEmpty(payload.sub) || !nonEmpty(payload.nonce)) {
      this.logger.warn("Google ID token rejected: missing or unverified claims");
      throw unauthorized();
    }
    return {
      sub: payload.sub,
      email: payload.email,
      nonce: payload.nonce,
      name: optionalString(payload.name),
      givenName: optionalString(payload.given_name),
    };
  }
}
