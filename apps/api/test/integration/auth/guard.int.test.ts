import { Controller, Get, Module } from "@nestjs/common";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { AccessClaims } from "@grooming/contracts";
import { CustomerAuth, OptionalCustomerAuth, OptionalCustomerOrStaffAuth, Principal, Public, StaffAuth } from "../../../src/auth/decorators.js";
import { TokenService } from "../../../src/auth/token.service.js";
import { createIntegrationApp, resetState } from "../app.js";
import { seedFixture, type Fixture } from "../helpers.js";

/** Test-only routes, one per policy. */
@Controller("test/guard")
class GuardTestController {
  @Get("undecorated")
  undecorated() {
    return { ok: true };
  }

  @Public()
  @Get("public")
  open() {
    return { ok: true };
  }

  @CustomerAuth()
  @Get("customer")
  customer(@Principal() principal: AccessClaims) {
    return principal;
  }

  @OptionalCustomerAuth()
  @Get("optional-customer")
  optionalCustomer(@Principal() principal: AccessClaims | undefined) {
    return { principal: principal ?? null };
  }

  @OptionalCustomerOrStaffAuth("OWNER")
  @Get("optional-customer-or-owner")
  optionalCustomerOrOwner(@Principal() principal: AccessClaims | undefined) {
    return { principal: principal ?? null };
  }

  @StaffAuth()
  @Get("staff")
  staff(@Principal() principal: AccessClaims) {
    return principal;
  }

  @StaffAuth("OWNER")
  @Get("owner")
  owner() {
    return { ok: true };
  }
}

@Module({ controllers: [GuardTestController] })
class GuardTestModule {}

describe("AccessGuard (fail closed)", () => {
  let ctx: Awaited<ReturnType<typeof createIntegrationApp>>;
  let f: Fixture;
  let tokens: TokenService;
  const get = (path: string, token?: string) => {
    const req = request(ctx.app.getHttpServer()).get(path);
    return token ? req.set("Authorization", `Bearer ${token}`) : req;
  };
  const staffToken = async (role: "OWNER" | "RECEPTION" | "EMPLOYEE", org = f.orgId) =>
    (await tokens.issueAccess({ sub: f.staffA, typ: "staff", org, role })).token;
  const customerToken = async () =>
    (await tokens.issueAccess({ sub: f.customerId, typ: "customer", org: f.orgId, role: "CUSTOMER" })).token;

  beforeAll(async () => {
    ctx = await createIntegrationApp({ imports: [GuardTestModule] });
    tokens = ctx.app.get(TokenService);
    // Seeded once: TenancyService caches the org id for the app's lifetime.
    await resetState(ctx.prisma, ctx.redis);
    f = await seedFixture(ctx.prisma);
  });
  afterAll(async () => {
    await ctx?.close();
  });

  it("an undecorated route is 403 even with a valid OWNER token", async () => {
    const res = await get("/v1/test/guard/undecorated", await staffToken("OWNER"));
    expect(res.status).toBe(403);
    expect(res.headers["content-type"]).toMatch(/^application\/problem\+json/);
    expect(res.body.code).toBe("FORBIDDEN");
    expect((await get("/v1/test/guard/undecorated")).status).toBe(403);
  });

  it("a public route needs no token", async () => {
    expect((await get("/v1/test/guard/public")).status).toBe(200);
  });

  it("customer route: 401 without token, 403 for staff, 200 with Principal for a customer", async () => {
    const none = await get("/v1/test/guard/customer");
    expect(none.status).toBe(401);
    expect(none.body.code).toBe("UNAUTHORIZED");
    expect((await get("/v1/test/guard/customer", await staffToken("OWNER"))).status).toBe(403);
    const ok = await get("/v1/test/guard/customer", await customerToken());
    expect(ok.status).toBe(200);
    expect(ok.body).toEqual({ sub: f.customerId, typ: "customer", org: f.orgId, role: "CUSTOMER" });
  });

  it("optional-customer route: principal with a customer token, null without one; bad token 401, staff 403", async () => {
    const anon = await get("/v1/test/guard/optional-customer");
    expect(anon.status).toBe(200);
    expect(anon.body).toEqual({ principal: null });
    const ok = await get("/v1/test/guard/optional-customer", await customerToken());
    expect(ok.status).toBe(200);
    expect(ok.body).toEqual({ principal: { sub: f.customerId, typ: "customer", org: f.orgId, role: "CUSTOMER" } });
    expect((await get("/v1/test/guard/optional-customer", "garbage")).status).toBe(401);
    const otherOrg = (
      await tokens.issueAccess({ sub: f.customerId, typ: "customer", org: "0194b2a0-0000-7000-8000-0000000000ff", role: "CUSTOMER" })
    ).token;
    expect((await get("/v1/test/guard/optional-customer", otherOrg)).status).toBe(401);
    const basic = await request(ctx.app.getHttpServer())
      .get("/v1/test/guard/optional-customer")
      .set("Authorization", `Basic ${await customerToken()}`);
    expect(basic.status).toBe(401);
    expect((await get("/v1/test/guard/optional-customer", await staffToken("OWNER"))).status).toBe(403);
  });

  it("optional-customer-or-staff route (OWNER): RECEPTION 403, OWNER principal, customer principal, none null; bad token 401", async () => {
    const path = "/v1/test/guard/optional-customer-or-owner";
    const anon = await get(path);
    expect(anon.status).toBe(200);
    expect(anon.body).toEqual({ principal: null });
    const owner = await get(path, await staffToken("OWNER"));
    expect(owner.status).toBe(200);
    expect(owner.body).toEqual({ principal: { sub: f.staffA, typ: "staff", org: f.orgId, role: "OWNER" } });
    const customer = await get(path, await customerToken());
    expect(customer.status).toBe(200);
    expect(customer.body).toEqual({ principal: { sub: f.customerId, typ: "customer", org: f.orgId, role: "CUSTOMER" } });
    const reception = await get(path, await staffToken("RECEPTION"));
    expect(reception.status).toBe(403);
    expect(reception.body.code).toBe("FORBIDDEN");
    expect((await get(path, await staffToken("EMPLOYEE"))).status).toBe(403);
    expect((await get(path, "garbage")).status).toBe(401);
    expect((await get(path, await staffToken("OWNER", "0194b2a0-0000-7000-8000-0000000000ff"))).status).toBe(401);
  });

  it("staff route: any staff role passes, a customer is 403", async () => {
    for (const role of ["OWNER", "RECEPTION", "EMPLOYEE"] as const) {
      const res = await get("/v1/test/guard/staff", await staffToken(role));
      expect(res.status).toBe(200);
      expect(res.body.role).toBe(role);
    }
    expect((await get("/v1/test/guard/staff", await customerToken())).status).toBe(403);
  });

  it("OWNER route: RECEPTION is 403, OWNER is 200", async () => {
    expect((await get("/v1/test/guard/owner", await staffToken("RECEPTION"))).status).toBe(403);
    expect((await get("/v1/test/guard/owner", await staffToken("OWNER"))).status).toBe(200);
  });

  it("a malformed bearer token or a non-Bearer scheme is 401", async () => {
    expect((await get("/v1/test/guard/staff", "garbage")).status).toBe(401);
    const basic = await request(ctx.app.getHttpServer())
      .get("/v1/test/guard/staff")
      .set("Authorization", `Basic ${await staffToken("OWNER")}`);
    expect(basic.status).toBe(401);
  });

  it("a token for another organization is 401", async () => {
    const res = await get("/v1/test/guard/staff", await staffToken("OWNER", "0194b2a0-0000-7000-8000-0000000000ff"));
    expect(res.status).toBe(401);
    expect(res.body.code).toBe("UNAUTHORIZED");
  });

  it("an MFA token is not accepted as a bearer token", async () => {
    const { token } = await tokens.issueMfa(f.staffA, f.orgId, "verify");
    expect((await get("/v1/test/guard/staff", token)).status).toBe(401);
  });

  it("GET /v1/health is public", async () => {
    expect((await get("/v1/health")).status).toBe(200);
  });
});
