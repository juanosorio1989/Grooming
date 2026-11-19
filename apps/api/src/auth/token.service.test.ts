import { createPrivateKey, generateKeyPairSync } from "node:crypto";
import { UnauthorizedException } from "@nestjs/common";
import { SignJWT, decodeProtectedHeader, decodeJwt } from "jose";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AccessClaims } from "@grooming/contracts";
import { testEnv } from "../../test/support/test-env.js";
import { TokenService } from "./token.service.js";

const env = testEnv();
const service = new TokenService(env);

const staffClaims: AccessClaims = {
  sub: "0194b2a0-0000-7000-8000-000000000001",
  typ: "staff",
  org: "0194b2a0-0000-7000-8000-0000000000aa",
  role: "OWNER",
};

async function expect401(p: Promise<unknown>): Promise<void> {
  const err = await p.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(UnauthorizedException);
  expect((err as UnauthorizedException).getResponse()).toMatchObject({ code: "UNAUTHORIZED" });
}

/** Signs arbitrary claims with the service's own key, bypassing `issueAccess` checks. */
function signRaw(payload: Record<string, unknown>, audience = "grooming"): Promise<string> {
  const key = createPrivateKey({ key: Buffer.from(env.JWT_PRIVATE_KEY_B64, "base64"), format: "der", type: "pkcs8" });
  return new SignJWT(payload)
    .setProtectedHeader({ alg: "EdDSA", kid: env.JWT_KEY_ID })
    .setIssuer("grooming-api")
    .setAudience(audience)
    .setIssuedAt()
    .setExpirationTime("15m")
    .sign(key);
}

afterEach(() => {
  vi.useRealTimers();
});

describe("TokenService access tokens", () => {
  it("round-trips claims", async () => {
    const { token, expiresAt } = await service.issueAccess(staffClaims);
    expect(await service.verifyAccess(token)).toEqual(staffClaims);
    expect(expiresAt.getTime()).toBe(decodeJwt(token).exp! * 1000);
  });

  it("lives 15 minutes, EdDSA with kid, iss and aud", async () => {
    const { token } = await service.issueAccess(staffClaims);
    const payload = decodeJwt(token);
    expect(payload.exp! - payload.iat!).toBe(900);
    expect(payload.iss).toBe("grooming-api");
    expect(payload.aud).toBe("grooming");
    expect(decodeProtectedHeader(token)).toMatchObject({ alg: "EdDSA", kid: "k1" });
  });

  it("rejects a token signed by a different Ed25519 key", async () => {
    const other = generateKeyPairSync("ed25519").privateKey.export({ format: "der", type: "pkcs8" }).toString("base64");
    const { token } = await new TokenService(testEnv({ JWT_PRIVATE_KEY_B64: other })).issueAccess(staffClaims);
    await expect401(service.verifyAccess(token));
  });

  it("rejects an expired token", async () => {
    const { token } = await service.issueAccess(staffClaims);
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.now() + 16 * 60_000);
    await expect401(service.verifyAccess(token));
  });

  it("rejects garbage", async () => {
    await expect401(service.verifyAccess("not.a.jwt"));
  });

  it("issueAccess refuses typ/role mismatches in both directions", async () => {
    await expect(service.issueAccess({ ...staffClaims, typ: "customer", role: "OWNER" })).rejects.toThrow();
    await expect(service.issueAccess({ ...staffClaims, typ: "staff", role: "CUSTOMER" })).rejects.toThrow();
  });

  it("verifyAccess rejects a customer token with a staff role", async () => {
    const { sub, org } = staffClaims;
    await expect401(service.verifyAccess(await signRaw({ sub, org, typ: "customer", role: "OWNER" })));
  });

  it("verifyAccess rejects a staff token with the CUSTOMER role", async () => {
    const { sub, org } = staffClaims;
    await expect401(service.verifyAccess(await signRaw({ sub, org, typ: "staff", role: "CUSTOMER" })));
  });

  it("verifyAccess rejects claims that fail AccessClaimsSchema", async () => {
    await expect401(service.verifyAccess(await signRaw({ sub: "x", org: staffClaims.org, typ: "staff", role: "OWNER" })));
  });
});

describe("TokenService MFA tokens", () => {
  const { sub: staffId, org: orgId } = staffClaims;

  it("round-trips and lives 5 minutes", async () => {
    const { token, expiresAt } = await service.issueMfa(staffId, orgId, "verify");
    const payload = decodeJwt(token);
    expect(payload.exp! - payload.iat!).toBe(300);
    expect(payload.aud).toBe("grooming-mfa");
    expect(payload.typ).toBe("mfa");
    expect(expiresAt.getTime()).toBe(payload.exp! * 1000);
    expect(await service.verifyMfa(token, "verify")).toEqual({ staffId, orgId });
  });

  it("an MFA token is not an access token", async () => {
    const { token } = await service.issueMfa(staffId, orgId, "verify");
    await expect401(service.verifyAccess(token));
  });

  it("an access token is not an MFA token", async () => {
    const { token } = await service.issueAccess(staffClaims);
    await expect401(service.verifyMfa(token, "verify"));
  });

  it("an enroll token does not pass as verify", async () => {
    const { token } = await service.issueMfa(staffId, orgId, "enroll");
    await expect401(service.verifyMfa(token, "verify"));
    expect(await service.verifyMfa(token, "enroll")).toEqual({ staffId, orgId });
  });

  it("an MFA-audience token with typ other than mfa is rejected", async () => {
    await expect401(service.verifyMfa(await signRaw({ sub: staffId, org: orgId, typ: "staff", purpose: "verify" }, "grooming-mfa"), "verify"));
  });
});
