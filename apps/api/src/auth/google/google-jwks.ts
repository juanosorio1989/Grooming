import { createRemoteJWKSet, type JWTVerifyGetKey } from "jose";

/** DI token for the key set that verifies Google ID tokens (tests override it with a local set). */
export const GOOGLE_JWKS = Symbol("GOOGLE_JWKS");

export const GOOGLE_JWKS_URL = "https://www.googleapis.com/oauth2/v3/certs";

/** Remote key set; `jose` caches the keys and refetches on an unknown `kid`. */
export function googleJwksFactory(): JWTVerifyGetKey {
  return createRemoteJWKSet(new URL(GOOGLE_JWKS_URL));
}
