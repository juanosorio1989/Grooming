import request from "supertest";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Encryptor } from "../../../src/auth/crypto/encryption.js";
import { createIntegrationApp, resetState } from "../app.js";
import { createPetVisit, seedFixture, type Fixture } from "../helpers.js";
import { staffToken } from "../tokens.js";

describe("staff pet merge", () => {
  let ctx: Awaited<ReturnType<typeof createIntegrationApp>>;
  let f: Fixture;
  let other: Fixture;
  let owner: string;
  let reception: string;
  let employee: string;
  /** Target is the fixture pet (Max, DOG, coatType CURLY); source is a duplicate of the same customer. */
  let target: string;
  let source: string;
  const merge = (from: string, into: string, token: string) =>
    request(ctx.app.getHttpServer()).post(`/v1/staff/pets/${from}/merge`).set("Authorization", `Bearer ${token}`).send({ intoPetId: into });

  async function media(petId: string, kind: "PET_PHOTO" | "VACCINE_CARD" = "PET_PHOTO") {
    return ctx.prisma.media.create({
      data: { organizationId: f.orgId, kind, objectKey: `pets/${petId}/${Math.random()}`, contentType: "image/jpeg", petId, uploadedByType: "STAFF" },
    });
  }
  const visitCount = (ids: string[]) => ctx.prisma.petVisit.count({ where: { petId: { in: ids } } });

  beforeEach(async () => {
    ctx = await createIntegrationApp();
    await resetState(ctx.prisma, ctx.redis);
    f = await seedFixture(ctx.prisma);
    other = await seedFixture(ctx.prisma, { slug: "other-salon" });
    owner = await staffToken(ctx.app, { sub: f.staffA, org: f.orgId, role: "OWNER" });
    reception = await staffToken(ctx.app, { sub: f.staffA, org: f.orgId, role: "RECEPTION" });
    employee = await staffToken(ctx.app, { sub: f.staffA, org: f.orgId, role: "EMPLOYEE" });
    target = f.petId;
    await ctx.prisma.pet.update({ where: { id: target }, data: { allergies: ["Chicken"], coatType: null, temperament: ["CALM"] } });
    const enc = ctx.app.get(Encryptor);
    source = (
      await ctx.prisma.pet.create({
        data: {
          organizationId: f.orgId,
          customerId: f.customerId,
          name: "Maxi",
          species: "DOG",
          breed: "Poodle mix",
          coatType: "DOUBLE",
          allergies: ["chicken", "Beef"],
          temperament: ["NERVOUS", "CALM"],
          vetName: "Dr. Vet",
          medicalNotesEnc: enc.encrypt("Hip dysplasia"),
        },
      })
    ).id;
  });
  afterEach(async () => {
    await ctx?.close();
  });

  it("moves visits, media and vaccines, dedupes vaccines, fills empty fields, soft-deletes the source, audits", async () => {
    await createPetVisit(ctx.prisma, { ...f, petId: source });
    const m = await media(source);
    await ctx.prisma.petVaccine.createMany({
      data: [
        { organizationId: f.orgId, petId: target, type: "RABIES", expiresOn: new Date("2027-01-01") },
        { organizationId: f.orgId, petId: source, type: "RABIES", expiresOn: new Date("2028-01-01") },
        { organizationId: f.orgId, petId: source, type: "DHPP", expiresOn: new Date("2027-06-01") },
      ],
    });

    const res = await merge(source, target, reception);
    expect(res.status).toBe(200);
    expect(res.body.id).toBe(target);
    expect(res.body.name).toBe("Max");
    expect(res.body.breed).toBe("Poodle");
    expect(res.body.coatType).toBe("DOUBLE");
    expect(res.body.vetName).toBe("Dr. Vet");
    expect(res.body.medicalNotes).toBe("Hip dysplasia");
    expect(res.body.weightG).toBe(19_000);
    expect(res.body.allergies).toEqual(["Chicken", "Beef"]);
    expect(res.body.temperament).toEqual(["CALM", "NERVOUS"]);
    const vaccines = (res.body.vaccines as { type: string; expiresOn: string }[]).map((v) => `${v.type}:${v.expiresOn}`).sort();
    expect(vaccines).toEqual(["DHPP:2027-06-01", "RABIES:2028-01-01"]);

    expect(await ctx.prisma.petVisit.count({ where: { petId: target } })).toBe(1);
    expect(await ctx.prisma.petVisit.count({ where: { petId: source } })).toBe(0);
    expect((await ctx.prisma.media.findUniqueOrThrow({ where: { id: m.id } })).petId).toBe(target);
    expect(await ctx.prisma.petVaccine.count({ where: { petId: source } })).toBe(0);
    expect(await ctx.prisma.petVaccine.count({ where: { petId: target } })).toBe(2);

    const src = await ctx.prisma.pet.findUniqueOrThrow({ where: { id: source } });
    expect(src.deletedAt).not.toBeNull();
    const list = await request(ctx.app.getHttpServer()).get(`/v1/staff/pets?customerId=${f.customerId}`).set("Authorization", `Bearer ${owner}`);
    expect(list.body.map((p: { id: string }) => p.id)).toEqual([target]);
    expect((await request(ctx.app.getHttpServer()).get(`/v1/staff/pets/${source}`).set("Authorization", `Bearer ${owner}`)).status).toBe(404);

    const audit = await ctx.prisma.auditLog.findFirstOrThrow({ where: { organizationId: f.orgId, action: "pet.merge" } });
    expect(audit.entity).toBe("pet");
    expect(audit.entityId).toBe(target);
    expect(audit.actorType).toBe("STAFF");
    const after = audit.after as Record<string, unknown>;
    expect(after).toMatchObject({ sourcePetId: source, movedVisits: 1, movedMedia: 1, movedVaccines: 2, droppedVaccines: 1 });
    expect(after.filledFields).toEqual(expect.arrayContaining(["coatType", "medicalNotes", "vetName"]));
    expect(after.filledFields).not.toContain("name");
    expect(JSON.stringify(audit)).not.toContain("Hip dysplasia");
  });

  it("a verified duplicate vaccine wins a tie on expiry", async () => {
    await ctx.prisma.petVaccine.create({ data: { organizationId: f.orgId, petId: target, type: "RABIES", expiresOn: new Date("2027-01-01") } });
    const verified = await ctx.prisma.petVaccine.create({
      data: { organizationId: f.orgId, petId: source, type: "RABIES", expiresOn: new Date("2027-01-01"), verifiedAt: new Date(), verifiedByStaffId: f.staffA },
    });
    const res = await merge(source, target, owner);
    expect(res.status).toBe(200);
    expect(res.body.vaccines).toHaveLength(1);
    expect(res.body.vaccines[0]).toMatchObject({ id: verified.id, verified: true });
  });

  it("rejects invalid merges with 409 PET_MERGE_INVALID, unknown or foreign pets with 404, EMPLOYEE with 403", async () => {
    const same = await merge(target, target, owner);
    expect(same.status).toBe(409);
    expect(same.body.code).toBe("PET_MERGE_INVALID");

    const customer2 = await ctx.prisma.customer.create({
      data: { organizationId: f.orgId, phoneE164: "+13055550199", name: "Bob", locale: "en", createdVia: "ONLINE" },
    });
    const otherOwnerPet = await ctx.prisma.pet.create({ data: { organizationId: f.orgId, customerId: customer2.id, name: "Rex", species: "DOG", breed: "Lab" } });
    const diff = await merge(otherOwnerPet.id, target, owner);
    expect(diff.status).toBe(409);
    expect(diff.body.code).toBe("PET_MERGE_INVALID");
    expect(diff.body.detail).toMatch(/customer/i);

    const cat = await ctx.prisma.pet.create({ data: { organizationId: f.orgId, customerId: f.customerId, name: "Kitty", species: "CAT", breed: "Tabby" } });
    const species = await merge(target, cat.id, owner);
    expect(species.status).toBe(409);
    expect(species.body.code).toBe("PET_MERGE_INVALID");
    expect(species.body.detail).toMatch(/species/i);

    await ctx.prisma.pet.update({ where: { id: cat.id }, data: { species: "DOG", deletedAt: new Date() } });
    const deleted = await merge(cat.id, target, owner);
    expect(deleted.status).toBe(409);
    expect(deleted.body.code).toBe("PET_MERGE_INVALID");

    expect((await merge(other.petId, target, owner)).status).toBe(404);
    expect((await merge(source, "0190a000-0000-7000-8000-000000000000", owner)).status).toBe(404);
    expect((await merge(source, target, employee)).status).toBe(403);
    expect((await merge("not-a-uuid", target, owner)).status).toBe(400);
    const extra = await request(ctx.app.getHttpServer())
      .post(`/v1/staff/pets/${source}/merge`)
      .set("Authorization", `Bearer ${owner}`)
      .send({ intoPetId: target, extra: 1 });
    expect(extra.status).toBe(400);

    // Nothing moved by the rejected attempts.
    expect((await ctx.prisma.pet.findUniqueOrThrow({ where: { id: source } })).deletedAt).toBeNull();
    expect(await ctx.prisma.auditLog.count({ where: { action: "pet.merge" } })).toBe(0);
  });

  it("concurrent A->B and B->A: exactly one succeeds, the other is 409, no visit is lost", async () => {
    await createPetVisit(ctx.prisma, { ...f, petId: source });
    await createPetVisit(ctx.prisma, { ...f, petId: source });
    await createPetVisit(ctx.prisma, f);
    const before = await visitCount([source, target]);
    expect(before).toBe(3);

    const [a, b] = await Promise.all([merge(source, target, owner), merge(target, source, reception)]);
    expect([a.status, b.status].sort()).toEqual([200, 409]);
    const loser = a.status === 409 ? a : b;
    expect(loser.body.code).toBe("PET_MERGE_INVALID");

    expect(await visitCount([source, target])).toBe(before);
    const live = await ctx.prisma.pet.findMany({ where: { id: { in: [source, target] }, deletedAt: null } });
    expect(live).toHaveLength(1);
    expect(await ctx.prisma.petVisit.count({ where: { petId: live[0]!.id } })).toBe(before);
    expect(await ctx.prisma.auditLog.count({ where: { action: "pet.merge" } })).toBe(1);
  });
});
