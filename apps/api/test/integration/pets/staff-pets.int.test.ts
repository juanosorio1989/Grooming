import request from "supertest";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createIntegrationApp, resetState } from "../app.js";
import { seedFixture, type Fixture } from "../helpers.js";
import { staffToken } from "../tokens.js";

describe("staff pets", () => {
  let ctx: Awaited<ReturnType<typeof createIntegrationApp>>;
  let f: Fixture;
  let other: Fixture;
  let owner: string;
  let reception: string;
  let employeeA: string;
  const call = (method: "get" | "post" | "patch" | "delete", path: string, token: string) =>
    request(ctx.app.getHttpServer())[method](path).set("Authorization", `Bearer ${token}`);

  /** Inserts a segment for `staffId` on a visit of the fixture pet, `offsetMs` from now. */
  async function segmentAt(staffId: string, offsetMs: number, status: "BOOKED" | "CANCELLED" = "BOOKED") {
    const appt = await ctx.prisma.appointment.create({
      data: { organizationId: f.orgId, locationId: f.locationId, customerId: f.customerId, status, source: "ONLINE", bookingMode: "DROP_OFF" },
    });
    const pv = await ctx.prisma.petVisit.create({
      data: { organizationId: f.orgId, appointmentId: appt.id, petId: f.petId, status: "BOOKED", sizeClassAtBooking: "M", priceCentsQuoted: 4000 },
    });
    const startsAt = new Date(Date.now() + offsetMs);
    return ctx.prisma.appointmentSegment.create({
      data: {
        organizationId: f.orgId, appointmentId: appt.id, petVisitId: pv.id, stage: "BATH", serviceId: f.serviceId, staffUserId: staffId,
        startsAt, endsAt: new Date(startsAt.getTime() + 60_000), blockEndsAt: new Date(startsAt.getTime() + 60_000), durationMin: 1, priceCents: 4000,
      },
    });
  }

  beforeEach(async () => {
    ctx = await createIntegrationApp();
    await resetState(ctx.prisma, ctx.redis);
    f = await seedFixture(ctx.prisma);
    other = await seedFixture(ctx.prisma, { slug: "other-salon" });
    owner = await staffToken(ctx.app, { sub: f.staffA, org: f.orgId, role: "OWNER" });
    reception = await staffToken(ctx.app, { sub: f.staffA, org: f.orgId, role: "RECEPTION" });
    employeeA = await staffToken(ctx.app, { sub: f.staffA, org: f.orgId, role: "EMPLOYEE" });
    await ctx.prisma.pet.update({ where: { id: f.petId }, data: { medicalNotesEnc: ctx.app.get((await import("../../../src/auth/crypto/encryption.js")).Encryptor).encrypt("Heart murmur") } });
  });
  afterEach(async () => {
    await ctx?.close();
  });

  it("RECEPTION creates for the fixture customer; unknown/foreign customer is 404; EMPLOYEE is 403", async () => {
    const res = await call("post", "/v1/staff/pets", reception).send({ customerId: f.customerId, name: "Luna", species: "CAT", breed: "Tabby", weightG: 4_000, medicalNotes: "Asthma" });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ customerId: f.customerId, name: "Luna", sizeClass: "S", medicalNotes: "Asthma" });
    const audit = await ctx.prisma.auditLog.findFirstOrThrow({ where: { organizationId: f.orgId, action: "pet.create", entityId: res.body.id } });
    expect(audit.actorType).toBe("STAFF");
    expect(JSON.stringify(audit)).not.toContain("Asthma");
    expect((await call("post", "/v1/staff/pets", owner).send({ customerId: other.customerId, name: "X", species: "DOG", breed: "Y" })).status).toBe(404);
    expect((await call("post", "/v1/staff/pets", employeeA).send({ customerId: f.customerId, name: "X", species: "DOG", breed: "Y" })).status).toBe(403);
    expect((await call("patch", `/v1/staff/pets/${f.petId}`, employeeA).send({ name: "Q" })).status).toBe(403);
  });

  it("OWNER/RECEPTION list by customer and q, read decrypted notes, edit; other org is 404", async () => {
    const all = await call("get", `/v1/staff/pets?customerId=${f.customerId}`, reception);
    expect(all.body.map((p: { id: string }) => p.id)).toEqual([f.petId]);
    expect((await call("get", "/v1/staff/pets?q=poo", owner)).body).toHaveLength(1);
    expect((await call("get", "/v1/staff/pets?q=zzz", owner)).body).toEqual([]);
    expect((await call("get", `/v1/staff/pets/${f.petId}`, reception)).body.medicalNotes).toBe("Heart murmur");
    const upd = await call("patch", `/v1/staff/pets/${f.petId}`, reception).send({ weightG: 30_000 });
    expect(upd.body.sizeClass).toBe("L");
    expect((await call("get", `/v1/staff/pets/${other.petId}`, owner)).status).toBe(404);
    expect((await call("patch", `/v1/staff/pets/${other.petId}`, owner).send({ name: "Q" })).status).toBe(404);
  });

  it("EMPLOYEE sees a pet only with a non-cancelled segment today", async () => {
    expect((await call("get", "/v1/staff/pets", employeeA)).body).toEqual([]);
    expect((await call("get", `/v1/staff/pets/${f.petId}`, employeeA)).status).toBe(404);
    await segmentAt(f.staffA, -86_400_000 * 2);
    expect((await call("get", `/v1/staff/pets/${f.petId}`, employeeA)).status).toBe(404);
    await segmentAt(f.staffA, -120_000, "CANCELLED");
    expect((await call("get", `/v1/staff/pets/${f.petId}`, employeeA)).status).toBe(404);
    expect((await call("get", "/v1/staff/pets", employeeA)).body).toEqual([]);
    await segmentAt(f.staffB, 0);
    expect((await call("get", `/v1/staff/pets/${f.petId}`, employeeA)).status).toBe(404);
    await segmentAt(f.staffA, 120_000);
    const got = await call("get", `/v1/staff/pets/${f.petId}`, employeeA);
    expect(got.status).toBe(200);
    expect(got.body.medicalNotes).toBe("Heart murmur");
    expect((await call("get", "/v1/staff/pets", employeeA)).body.map((p: { id: string }) => p.id)).toEqual([f.petId]);
    expect((await call("get", `/v1/staff/pets/${f.petId}/vaccines`, employeeA)).status).toBe(200);
    expect((await call("post", `/v1/staff/pets/${f.petId}/vaccines`, employeeA).send({ type: "RABIES", expiresOn: "2027-01-01" })).status).toBe(403);
  });

  it("vaccines: create, update, verify (audit), delete; owner edit later clears verification", async () => {
    const v = await call("post", `/v1/staff/pets/${f.petId}/vaccines`, reception).send({ type: "DHPP", expiresOn: "2027-05-01" });
    expect(v.status).toBe(201);
    expect(v.body.verified).toBe(false);
    const ver = await call("post", `/v1/staff/pets/${f.petId}/vaccines/${v.body.id}/verify`, reception);
    expect(ver.status).toBe(200);
    expect(ver.body.verified).toBe(true);
    expect(ver.body.verifiedAt).toBeTruthy();
    const row = await ctx.prisma.petVaccine.findUniqueOrThrow({ where: { id: v.body.id } });
    expect(row.verifiedByStaffId).toBe(f.staffA);
    expect(await ctx.prisma.auditLog.count({ where: { organizationId: f.orgId, action: "pet_vaccine.verify", entityId: v.body.id } })).toBe(1);
    const upd = await call("patch", `/v1/staff/pets/${f.petId}/vaccines/${v.body.id}`, owner).send({ expiresOn: "2028-05-01" });
    expect(upd.body.expiresOn).toBe("2028-05-01");
    expect((await call("get", `/v1/staff/pets/${f.petId}/vaccines`, owner)).body).toHaveLength(1);
    expect((await call("delete", `/v1/staff/pets/${f.petId}/vaccines/${v.body.id}`, owner)).status).toBe(204);
    expect(await ctx.prisma.petVaccine.count({ where: { organizationId: f.orgId, petId: f.petId } })).toBe(0);
    expect((await call("post", `/v1/staff/pets/${f.petId}/vaccines/${v.body.id}/verify`, owner)).status).toBe(404);
    expect((await call("post", `/v1/staff/pets/${other.petId}/vaccines`, owner).send({ type: "DHPP", expiresOn: "2027-05-01" })).status).toBe(404);
  });
});
