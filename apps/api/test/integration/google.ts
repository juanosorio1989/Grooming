import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT, type JWTPayload, type JWTVerifyGetKey } from "jose";

export const TEST_GOOGLE_CLIENT_ID = "test-client.apps.googleusercontent.com";

/** Claims of a Google ID token as the tests build them. */
export interface GoogleTokenClaims extends JWTPayload {
  iss: string;
  aud: string;
  sub: string;
  email: string;
  email_verified: boolean;
  name: string;
  given_name: string;
  exp: number;
  nonce: string;
}

export interface TestGoogle {
  /** Local JWKS holding only the main test key; integration apps override `GOOGLE_JWKS` with it. */
  jwks: JWTVerifyGetKey;
  /** Signs an RS256 ID token. `key: "other"` signs with a second key that is not in `jwks`. */
  sign(claims: Partial<GoogleTokenClaims>, opts?: { key?: "other"; expiresInSec?: number }): Promise<string>;
}

const KID = "test-key-1";

/** Fake Google signer: an RS256 key pair exposed through `createLocalJWKSet`, plus a stray key for bad signatures. */
export async function createTestGoogle(): Promise<TestGoogle> {
  const main = await generateKeyPair("RS256");
  const other = await generateKeyPair("RS256");
  const publicJwk = { ...(await exportJWK(main.publicKey)), kid: KID, alg: "RS256", use: "sig" };
  const jwks = createLocalJWKSet({ keys: [publicJwk] });

  return {
    jwks,
    async sign(claims, opts = {}) {
      const now = Math.floor(Date.now() / 1000);
      const payload: Partial<GoogleTokenClaims> = {
        iss: "https://accounts.google.com",
        aud: TEST_GOOGLE_CLIENT_ID,
        sub: "g-sub-1",
        email: "owner@gmail.com",
        email_verified: true,
        name: "Ana Pérez",
        given_name: "Ana",
        iat: now,
        exp: now + (opts.expiresInSec ?? 3600),
        ...claims,
      };
      const key = opts.key === "other" ? other.privateKey : main.privateKey;
      return new SignJWT(payload).setProtectedHeader({ alg: "RS256", kid: KID, typ: "JWT" }).sign(key);
    },
  };
}
