import request from "supertest";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createIntegrationApp, resetState } from "../app.js";
import { bookSegment, seedFixture, type Fixture } from "../helpers.js";
import { customerToken, staffToken } from "../tokens.js";

describe("customers", () => {
  let ctx: Awaited<ReturnType<typeof createIntegrationApp>>;
  let f: Fixture;
  let other: Fixture;
  let owner: string;
  let reception: string;
  let employeeB: string;
  const call = (method: "get" | "patch" | "post", path: string, token?: string) => {
    const req = request(ctx.app.getHttpServer())[method](path);
    return token ? req.set("Authorization", `Bearer ${token}`) : req;
  };

  beforeEach(async () => {
    ctx = await createIntegrationApp();
    await resetState(ctx.prisma, ctx.redis);
    f = await seedFixture(ctx.prisma);
    other = await seedFixture(ctx.prisma, { slug: "other-salon" });
    owner = await staffToken(ctx.app, { sub: f.staffA, org: f.orgId, role: "OWNER" });
    reception = await staffToken(ctx.app, { sub: f.staffA, org: f.orgId, role: "RECEPTION" });
    employeeB = await staffToken(ctx.app, { sub: f.staffB, org: f.orgId, role: "EMPLOYEE" });
  });
  afterEach(async () => {
    await ctx?.close();
  });

  it("searches by name and by phone digits, ordered by name, scoped to the org", async () => {
    await ctx.prisma.customer.create({ data: { organizationId: f.orgId, phoneE164: "+13055550200", name: "Bea", locale: "en", createdVia: "ONLINE" } });
    const byName = await call("get", "/v1/staff/customers?q=ANA", reception);
    expect(byName.status).toBe(200);
    expect(byName.body.map((c: { id: string }) => c.id)).toEqual([f.customerId]);
    expect(byName.body[0]).toMatchObject({ name: "Ana", phone: "+13055550100", locale: "es", emergencyPhone: null });
    expect(byName.body[0].privateNotes).toBeNull();
    const byPhone = await call("get", "/v1/staff/customers?q=0100", owner);
    expect(byPhone.body.map((c: { id: string }) => c.id)).toEqual([f.customerId]);
    const all = await call("get", "/v1/staff/customers", owner);
    expect(all.body.map((c: { name: string }) => c.name)).toEqual(["Ana", "Bea"]);
    expect(all.body.some((c: { id: string }) => c.id === other.customerId)).toBe(false);
  });

  it("EMPLOYEE finds only customers with a segment assigned to them within +-30 days", async () => {
    expect((await call("get", "/v1/staff/customers?q=ana", employeeB)).body).toEqual([]);
    // Fixture segments are on 2026-12-01; run the check against a segment near "now".
    const now = Date.now();
    const visit = await ctx.prisma.appointment.create({
      data: { organizationId: f.orgId, locationId: f.locationId, customerId: f.customerId, status: "BOOKED", source: "ONLINE", bookingMode: "DROP_OFF" },
    });
    const pv = await ctx.prisma.petVisit.create({
      data: { organizationId: f.orgId, appointmentId: visit.id, petId: f.petId, status: "BOOKED", sizeClassAtBooking: "M", priceCentsQuoted: 4000 },
    });
    const seg = (staffUserId: string, offsetDays: number) =>
      ctx.prisma.appointmentSegment.create({
        data: {
          organizationId: f.orgId, appointmentId: visit.id, petVisitId: pv.id, stage: "BATH", serviceId: f.serviceId, staffUserId,
          startsAt: new Date(now + offsetDays * 86_400_000), endsAt: new Date(now + offsetDays * 86_400_000 + 3_600_000),
          blockEndsAt: new Date(now + offsetDays * 86_400_000 + 3_600_000), durationMin: 60, priceCents: 4000,
        },
      });
    await seg(f.staffA, 5);
    await seg(f.staffB, 90);
    expect((await call("get", "/v1/staff/customers?q=ana", employeeB)).body).toEqual([]);
    await seg(f.staffB, -10);
    const found = await call("get", "/v1/staff/customers?q=ana", employeeB);
    expect(found.body.map((c: { id: string }) => c.id)).toEqual([f.customerId]);
    expect(found.body[0]).not.toHaveProperty("privateNotes");
    expect((await call("get", `/v1/staff/customers/${f.customerId}`, employeeB)).status).toBe(200);
    await bookSegment(ctx.prisma, f, { staffUserId: f.staffA, startsAt: "09:00", endsAt: "10:00" });
  });

  it("EMPLOYEE scope ignores segments on a cancelled appointment", async () => {
    const now = Date.now();
    const visit = await ctx.prisma.appointment.create({
      data: { organizationId: f.orgId, locationId: f.locationId, customerId: f.customerId, status: "CANCELLED", source: "ONLINE", bookingMode: "DROP_OFF" },
    });
    const pv = await ctx.prisma.petVisit.create({
      data: { organizationId: f.orgId, appointmentId: visit.id, petId: f.petId, status: "BOOKED", sizeClassAtBooking: "M", priceCentsQuoted: 4000 },
    });
    await ctx.prisma.appointmentSegment.create({
      data: {
        organizationId: f.orgId, appointmentId: visit.id, petVisitId: pv.id, stage: "BATH", serviceId: f.serviceId, staffUserId: f.staffB,
        startsAt: new Date(now + 86_400_000), endsAt: new Date(now + 86_400_000 + 3_600_000),
        blockEndsAt: new Date(now + 86_400_000 + 3_600_000), durationMin: 60, priceCents: 4000,
      },
    });
    expect((await call("get", "/v1/staff/customers?q=ana", employeeB)).body).toEqual([]);
    expect((await call("get", `/v1/staff/customers/${f.customerId}`, employeeB)).status).toBe(404);
  });

  it("creates with createdVia RECEPTION and audit; duplicate phone is 409 with the existing id", async () => {
    const res = await call("post", "/v1/staff/customers", reception).send({ name: "Cy", phone: "+13055550300", locale: "en", email: "Cy@Test.dev" });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ name: "Cy", phone: "+13055550300", email: "cy@test.dev", locale: "en" });
    const row = await ctx.prisma.customer.findUniqueOrThrow({ where: { id: res.body.id } });
    expect(row.createdVia).toBe("RECEPTION");
    expect(row.organizationId).toBe(f.orgId);
    expect(await ctx.prisma.auditLog.count({ where: { organizationId: f.orgId, action: "customer.create", entityId: res.body.id } })).toBe(1);
    const dup = await call("post", "/v1/staff/customers", owner).send({ name: "Dup", phone: "+13055550100", locale: "en" });
    expect(dup.status).toBe(409);
    expect(dup.body).toMatchObject({ code: "CONFLICT", detail: f.customerId });
    expect((await call("post", "/v1/staff/customers", employeeB).send({ name: "Z", phone: "+13055550400", locale: "en" })).status).toBe(403);
    expect((await call("post", "/v1/staff/customers", owner).send({ name: "Z", phone: "bad", locale: "en" })).status).toBe(400);
  });

  it("PATCH encrypts private notes; GET decrypts for OWNER/RECEPTION; audit hides the text", async () => {
    const res = await call("patch", `/v1/staff/customers/${f.customerId}`, owner).send({ privateNotes: "Bites groomers", name: "Ana M", emergencyPhone: "+13055550999" });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ name: "Ana M", privateNotes: "Bites groomers", emergencyPhone: "+13055550999" });
    const row = await ctx.prisma.customer.findUniqueOrThrow({ where: { id: f.customerId } });
    expect(row.privateNotesEnc).toBeTruthy();
    expect(row.privateNotesEnc).not.toContain("Bites");
    expect((await call("get", `/v1/staff/customers/${f.customerId}`, reception)).body.privateNotes).toBe("Bites groomers");
    const audit = await ctx.prisma.auditLog.findFirstOrThrow({ where: { organizationId: f.orgId, action: "customer.update", entityId: f.customerId } });
    expect(JSON.stringify(audit)).not.toContain("Bites");
    expect(audit.after).toMatchObject({ privateNotesChanged: true });
    expect((await call("patch", `/v1/staff/customers/${f.customerId}`, employeeB).send({ name: "Q" })).status).toBe(403);
    expect((await call("patch", `/v1/staff/customers/${f.customerId}`, owner).send({ phone: "+13055550777" })).status).toBe(400);
    expect((await call("patch", `/v1/staff/customers/${other.customerId}`, owner).send({ name: "Q" })).status).toBe(404);
    expect((await call("get", `/v1/staff/customers/${other.customerId}`, owner)).status).toBe(404);
  });

  it("/me: GET, PATCH locale with CUSTOMER audit, staff token 403, deleted customer 404", async () => {
    const token = await customerToken(ctx.app, { sub: f.customerId, org: f.orgId });
    const got = await call("get", "/v1/me", token);
    expect(got.status).toBe(200);
    expect(got.body).toMatchObject({ id: f.customerId, locale: "es", name: "Ana" });
    expect(got.body).not.toHaveProperty("privateNotes");
    const res = await call("patch", "/v1/me", token).send({ locale: "en" });
    expect(res.status).toBe(200);
    expect(res.body.locale).toBe("en");
    expect((await ctx.prisma.customer.findUniqueOrThrow({ where: { id: f.customerId } })).locale).toBe("en");
    expect(await ctx.prisma.auditLog.count({ where: { organizationId: f.orgId, action: "customer.update", actorType: "CUSTOMER", actorId: f.customerId } })).toBe(1);
    expect((await call("patch", "/v1/me", token).send({ privateNotes: "x" })).status).toBe(400);
    expect((await call("get", "/v1/me", owner)).status).toBe(403);
    expect((await call("get", "/v1/me")).status).toBe(401);
    await ctx.prisma.customer.update({ where: { id: f.customerId }, data: { deletedAt: new Date() } });
    expect((await call("get", "/v1/me", token)).status).toBe(404);
  });
});
