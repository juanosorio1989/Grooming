import request from "supertest";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createIntegrationApp, resetState } from "../app.js";
import { seedFixture, type Fixture } from "../helpers.js";
import { customerToken } from "../tokens.js";

describe("me pets", () => {
  let ctx: Awaited<ReturnType<typeof createIntegrationApp>>;
  let f: Fixture;
  let token: string;
  let otherPetId: string;
  const call = (method: "get" | "post" | "patch" | "delete", path: string, t: string | null = token) => {
    const req = request(ctx.app.getHttpServer())[method](path);
    return t ? req.set("Authorization", `Bearer ${t}`) : req;
  };
  const dog = { name: "Rex", species: "DOG", breed: "Lab" };

  beforeEach(async () => {
    ctx = await createIntegrationApp();
    await resetState(ctx.prisma, ctx.redis);
    f = await seedFixture(ctx.prisma);
    token = await customerToken(ctx.app, { sub: f.customerId, org: f.orgId });
    const c2 = await ctx.prisma.customer.create({ data: { organizationId: f.orgId, phoneE164: "+13055550200", name: "Bea", locale: "en", createdVia: "ONLINE" } });
    const p2 = await ctx.prisma.pet.create({ data: { organizationId: f.orgId, customerId: c2.id, name: "Zed", species: "CAT", breed: "Siamese" } });
    otherPetId = p2.id;
  });
  afterEach(async () => {
    await ctx?.close();
  });

  it("derives sizeClass from weight; stores the sent sizeClass without weight; derived wins", async () => {
    const a = await call("post", "/v1/me/pets").send({ ...dog, weightG: 19_000 });
    expect(a.status).toBe(201);
    expect(a.body).toMatchObject({ customerId: f.customerId, sizeClass: "M", weightG: 19_000, vaccines: [], medicalNotes: null });
    expect(a.body.weightMeasuredAt).toBeTruthy();
    const b = await call("post", "/v1/me/pets").send({ ...dog, sizeClass: "XL" });
    expect(b.body).toMatchObject({ sizeClass: "XL", weightG: null, weightMeasuredAt: null });
    const c = await call("post", "/v1/me/pets").send({ ...dog, weightG: 5_000, sizeClass: "XL" });
    expect(c.body.sizeClass).toBe("S");
    expect((await call("post", "/v1/me/pets").send({ ...dog, extra: 1 })).status).toBe(400);
    expect((await call("post", "/v1/me/pets").send({ ...dog, temperament: ["CALM", "CALM"] })).status).toBe(400);
  });

  it("other customer's pet and vaccines are 404 for read, edit and delete", async () => {
    const v = await ctx.prisma.petVaccine.create({ data: { organizationId: f.orgId, petId: otherPetId, type: "RABIES", expiresOn: new Date("2027-01-01") } });
    expect((await call("get", `/v1/me/pets/${otherPetId}`)).status).toBe(404);
    expect((await call("patch", `/v1/me/pets/${otherPetId}`).send({ name: "Q" })).status).toBe(404);
    expect((await call("delete", `/v1/me/pets/${otherPetId}`)).status).toBe(404);
    expect((await call("get", `/v1/me/pets/${otherPetId}/vaccines`)).status).toBe(404);
    expect((await call("post", `/v1/me/pets/${otherPetId}/vaccines`).send({ type: "DHPP", expiresOn: "2027-01-01" })).status).toBe(404);
    expect((await call("patch", `/v1/me/pets/${otherPetId}/vaccines/${v.id}`).send({ type: "DHPP" })).status).toBe(404);
    expect((await call("delete", `/v1/me/pets/${otherPetId}/vaccines/${v.id}`)).status).toBe(404);
    // own pet, foreign vaccine id
    expect((await call("patch", `/v1/me/pets/${f.petId}/vaccines/${v.id}`).send({ type: "DHPP" })).status).toBe(404);
    expect((await ctx.prisma.petVaccine.findUniqueOrThrow({ where: { id: v.id } })).type).toBe("RABIES");
    expect((await call("get", "/v1/me/pets")).body.map((p: { id: string }) => p.id)).toEqual([f.petId]);
  });

  it("the 21st pet is 409; DELETE soft-deletes and hides it", async () => {
    for (let i = 0; i < 19; i++) expect((await call("post", "/v1/me/pets").send({ ...dog, name: `P${i}` })).status).toBe(201);
    const full = await call("post", "/v1/me/pets").send(dog);
    expect(full.status).toBe(409);
    expect(full.body.code).toBe("CONFLICT");
    expect((await call("delete", `/v1/me/pets/${f.petId}`)).status).toBe(204);
    expect((await call("get", `/v1/me/pets/${f.petId}`)).status).toBe(404);
    expect((await call("get", "/v1/me/pets")).body.some((p: { id: string }) => p.id === f.petId)).toBe(false);
    expect((await ctx.prisma.pet.findUniqueOrThrow({ where: { id: f.petId } })).deletedAt).not.toBeNull();
    expect((await call("post", "/v1/me/pets").send(dog)).status).toBe(201);
  });

  it("medical notes are encrypted at rest and round-trip; audit never holds the text", async () => {
    const res = await call("post", "/v1/me/pets").send({ ...dog, medicalNotes: "Hip dysplasia", vetPhone: "+13055550999", allergies: ["chicken"], temperament: ["NERVOUS"] });
    expect(res.body).toMatchObject({ medicalNotes: "Hip dysplasia", vetPhone: "+13055550999", allergies: ["chicken"], temperament: ["NERVOUS"] });
    const row = await ctx.prisma.pet.findUniqueOrThrow({ where: { id: res.body.id } });
    expect(row.medicalNotesEnc).toBeTruthy();
    expect(row.medicalNotesEnc).not.toContain("Hip");
    expect(row.vetPhoneE164).toBe("+13055550999");
    expect((await call("get", `/v1/me/pets/${res.body.id}`)).body.medicalNotes).toBe("Hip dysplasia");
    const upd = await call("patch", `/v1/me/pets/${res.body.id}`).send({ medicalNotes: "Arthritis", name: "Rexy" });
    expect(upd.body).toMatchObject({ name: "Rexy", medicalNotes: "Arthritis" });
    const cleared = await call("patch", `/v1/me/pets/${res.body.id}`).send({ medicalNotes: null });
    expect(cleared.body.medicalNotes).toBeNull();
    const rows = await ctx.prisma.auditLog.findMany({ where: { organizationId: f.orgId, entityId: res.body.id, actorType: "CUSTOMER" }, orderBy: { at: "asc" } });
    expect(rows.map((r) => r.action)).toEqual(["pet.create", "pet.update", "pet.update"]);
    const json = JSON.stringify(rows);
    expect(json).not.toContain("Hip");
    expect(json).not.toContain("Arthritis");
    expect(rows[0]?.after).toMatchObject({ medicalNotesChanged: true });
    expect(rows[1]?.after).toMatchObject({ medicalNotesChanged: true });
    const plain = await call("patch", `/v1/me/pets/${res.body.id}`).send({ name: "R" });
    expect(plain.status).toBe(200);
    const last = await ctx.prisma.auditLog.findFirstOrThrow({ where: { organizationId: f.orgId, entityId: res.body.id }, orderBy: { at: "desc" } });
    expect(last.after).toMatchObject({ medicalNotesChanged: false });
  });

  it("vaccines CRUD; an owner edit of a verified vaccine clears verification; audit with CUSTOMER actor", async () => {
    const created = await call("post", `/v1/me/pets/${f.petId}/vaccines`).send({ type: "RABIES", expiresOn: "2027-03-01" });
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({ type: "RABIES", expiresOn: "2027-03-01", verified: false, verifiedAt: null, cardMediaId: null });
    await ctx.prisma.petVaccine.update({ where: { id: created.body.id }, data: { verifiedAt: new Date(), verifiedByStaffId: f.staffA } });
    expect((await call("get", `/v1/me/pets/${f.petId}/vaccines`)).body[0]).toMatchObject({ verified: true });
    expect((await call("get", `/v1/me/pets/${f.petId}`)).body.vaccines).toHaveLength(1);
    const upd = await call("patch", `/v1/me/pets/${f.petId}/vaccines/${created.body.id}`).send({ expiresOn: "2028-03-01" });
    expect(upd.status).toBe(200);
    expect(upd.body).toMatchObject({ expiresOn: "2028-03-01", verified: false, verifiedAt: null });
    const row = await ctx.prisma.petVaccine.findUniqueOrThrow({ where: { id: created.body.id } });
    expect(row.verifiedByStaffId).toBeNull();
    expect((await call("delete", `/v1/me/pets/${f.petId}/vaccines/${created.body.id}`)).status).toBe(204);
    expect((await call("get", `/v1/me/pets/${f.petId}/vaccines`)).body).toEqual([]);
    const actions = (await ctx.prisma.auditLog.findMany({ where: { organizationId: f.orgId, entity: "pet_vaccine", actorType: "CUSTOMER", actorId: f.customerId }, orderBy: { at: "asc" } })).map((r) => r.action);
    expect(actions).toEqual(["pet_vaccine.create", "pet_vaccine.update", "pet_vaccine.delete"]);
  });

  it("requires a customer token", async () => {
    expect((await call("get", "/v1/me/pets", null)).status).toBe(401);
  });
});
