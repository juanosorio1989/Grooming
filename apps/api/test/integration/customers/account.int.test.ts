import request from "supertest";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MeExportSchema } from "@grooming/contracts";
import { Encryptor } from "../../../src/auth/crypto/encryption.js";
import { GOOGLE_JWKS } from "../../../src/auth/google/google-jwks.js";
import { IdentityLinkService } from "../../../src/auth/google/identity-link.service.js";
import { createIntegrationApp, resetState } from "../app.js";
import { FROM, local, seedBookableTuesday } from "../bookable-day.js";
import { createTestGoogle, TEST_GOOGLE_CLIENT_ID, type TestGoogle } from "../google.js";
import { seedFixture, type Fixture } from "../helpers.js";
import { customerToken } from "../tokens.js";

const DAY = 86_400_000;
const PII_KEYS = ["name", "phone", "email", "emergencyPhone"];

type SlotView = { startsAt: string; readyAt: string; bookingMode: string; pets: { petId?: string; ref?: string }[] };
type Ctx = Awaited<ReturnType<typeof createIntegrationApp>>;

describe("/v1/me/export and DELETE /v1/me", () => {
  let ctx: Ctx;
  let f: Fixture;
  let google: TestGoogle;

  // A fresh app per test: TenancyService and LocationService cache the seeded org and location.
  beforeEach(async () => {
    google ??= await createTestGoogle();
    ctx = await createIntegrationApp({
      env: { TRUST_PROXY: "1", GOOGLE_OAUTH_CLIENT_IDS: TEST_GOOGLE_CLIENT_ID },
      override: (b) => b.overrideProvider(GOOGLE_JWKS).useValue(google.jwks),
    });
    await resetState(ctx.prisma, ctx.redis);
    f = await seedFixture(ctx.prisma);
    await seedBookableTuesday(ctx.prisma, f);
    await ctx.prisma.service.update({ where: { id: f.serviceId }, data: { bookingMode: "WAIT" } });
  });

  afterEach(async () => {
    await ctx?.close();
  });

  const server = () => ctx.app.getHttpServer();
  const auth = <T extends request.Test>(req: T, token?: string) => (token ? req.set("Authorization", `Bearer ${token}`) : req);
  const ownerToken = () => customerToken(ctx.app, { sub: f.customerId, org: f.orgId });
  const savedPet = () => ({ petId: f.petId, serviceIds: [f.serviceId] });
  const exportMe = (token?: string) => auth(request(server()).get("/v1/me/export"), token);
  const deleteMe = (token?: string) => auth(request(server()).delete("/v1/me"), token);

  async function slots(token: string | undefined, pets: unknown[] = [savedPet()]): Promise<SlotView[]> {
    const res = await auth(request(server()).get("/v1/availability").set("X-Forwarded-For", "203.0.113.30").query({ from: FROM, pets: JSON.stringify(pets) }), token);
    expect(res.status).toBe(200);
    return res.body.slots as SlotView[];
  }
  const hold = (body: unknown, token?: string) =>
    auth(request(server()).post("/v1/holds").set("X-Forwarded-For", "203.0.113.20").send(body as object), token);
  const confirm = (holdId: string, token: string) => auth(request(server()).post("/v1/appointments").send({ holdId }), token);

  /** Holds and confirms the fixture's pet on the slot starting at `startsAt`. */
  async function book(token: string, startsAt: string): Promise<string> {
    const slot = (await slots(token)).find((s) => s.startsAt === startsAt);
    expect(slot).toBeDefined();
    const h = await hold({ pets: [savedPet()], slot }, token);
    expect(h.status).toBe(201);
    const c = await confirm(h.body.holdId as string, token);
    expect(c.status).toBe(201);
    return c.body.id as string;
  }

  /** A COMPLETED drop-off appointment of the fixture's pet ten days ago; returns its visit. */
  async function pastVisit(): Promise<{ appointmentId: string; visitId: string }> {
    const appt = await ctx.prisma.appointment.create({
      data: {
        organizationId: f.orgId,
        locationId: f.locationId,
        customerId: f.customerId,
        status: "COMPLETED",
        source: "ONLINE",
        bookingMode: "DROP_OFF",
        dropOffAt: new Date(Date.now() - 10 * DAY),
        completedAt: new Date(Date.now() - 10 * DAY),
      },
    });
    const visit = await ctx.prisma.petVisit.create({
      data: {
        organizationId: f.orgId,
        appointmentId: appt.id,
        petId: f.petId,
        position: 0,
        status: "PICKED_UP",
        sizeClassAtBooking: "M",
        coatTypeAtBooking: "SMOOTH",
        priceCentsQuoted: 4000,
      },
    });
    return { appointmentId: appt.id, visitId: visit.id };
  }

  const media = (kind: "PET_PHOTO" | "VACCINE_CARD" | "BEFORE", key: string, visitId: string | null = null, petId = f.petId) =>
    ctx.prisma.media.create({
      data: {
        organizationId: f.orgId,
        kind,
        objectKey: key,
        contentType: "image/jpeg",
        petId,
        visitId,
        uploadedByType: kind === "BEFORE" ? "STAFF" : "CUSTOMER",
        status: "READY",
      },
    });

  /** Pet photo, a vaccine with a card, and full pet details on the fixture's pet. */
  async function richPet() {
    const photo = await media("PET_PHOTO", `pets/${f.petId}/photo.jpg`);
    const card = await media("VACCINE_CARD", `pets/${f.petId}/rabies.jpg`);
    await ctx.prisma.pet.update({
      where: { id: f.petId },
      data: {
        photoMediaId: photo.id,
        breedCode: "poodle",
        birthDate: new Date("2020-03-01T00:00:00Z"),
        medicalNotesEnc: ctx.app.get(Encryptor).encrypt("Allergic to soap"),
        behaviorNotes: "Bites at the dryer",
        vetName: "Dr. Vet",
        vetPhoneE164: "+13055550123",
        allergies: ["chicken"],
        temperament: ["NERVOUS"],
      },
    });
    const vaccine = await ctx.prisma.petVaccine.create({
      data: { organizationId: f.orgId, petId: f.petId, type: "RABIES", expiresOn: new Date("2027-05-01T00:00:00Z"), cardMediaId: card.id },
    });
    return { photo, card, vaccine };
  }

  async function otherCustomer() {
    const other = await ctx.prisma.customer.create({
      data: { organizationId: f.orgId, phoneE164: "+13055550199", name: "Bo", email: "bo@test.dev", locale: "en", createdVia: "ONLINE" },
    });
    return { id: other.id, token: await customerToken(ctx.app, { sub: other.id, org: f.orgId }) };
  }

  it("export lists the customer, a linked identity with linkedAt, consents, pets with vaccines, appointments and media rows; 6th export in an hour → 429", async () => {
    const token = await ownerToken();
    const { photo, card, vaccine } = await richPet();
    const identity = await ctx.prisma.customerIdentity.create({
      data: { organizationId: f.orgId, customerId: f.customerId, provider: "GOOGLE", subject: "g-sub-export", email: "ana@gmail.com" },
    });
    await ctx.prisma.notificationConsent.create({
      data: { organizationId: f.orgId, customerId: f.customerId, channel: "WHATSAPP", granted: true, source: "BOOKING_FORM" },
    });
    const booked = await book(token, local("08:00"));
    const past = await pastVisit();
    const before = await media("BEFORE", `visits/${past.visitId}/before.jpg`, past.visitId);
    // Another customer's data is never exported.
    const other = await otherCustomer();
    await ctx.prisma.customerIdentity.create({
      data: { organizationId: f.orgId, customerId: other.id, provider: "GOOGLE", subject: "g-sub-other", email: "bo@gmail.com" },
    });

    const res = await exportMe(token);
    expect(res.status).toBe(200);
    expect(MeExportSchema.strict().parse(res.body)).toEqual(res.body);
    expect(Date.parse(res.body.exportedAt)).toBeGreaterThan(Date.now() - 60_000);
    expect(res.body.customer).toMatchObject({ id: f.customerId, name: "Ana", phone: "+13055550100", locale: "es" });
    expect(res.body.customer).not.toHaveProperty("privateNotes");
    expect(res.body.identities).toEqual([{ provider: "GOOGLE", email: "ana@gmail.com", linkedAt: identity.createdAt.toISOString() }]);
    expect(JSON.stringify(res.body)).not.toContain("g-sub-export");
    expect(res.body.consents).toEqual([expect.objectContaining({ channel: "WHATSAPP", granted: true, source: "BOOKING_FORM" })]);
    expect(res.body.pets).toHaveLength(1);
    expect(res.body.pets[0]).toMatchObject({ id: f.petId, name: "Max", photoMediaId: photo.id, behaviorNotes: "Bites at the dryer", medicalNotes: "Allergic to soap" });
    expect(res.body.pets[0].vaccines).toEqual([expect.objectContaining({ id: vaccine.id, type: "RABIES", cardMediaId: card.id })]);
    expect(res.body.appointments.map((a: { id: string }) => a.id).sort()).toEqual([booked, past.appointmentId].sort());
    expect(res.body.media.map((m: { id: string }) => m.id).sort()).toEqual([photo.id, card.id, before.id].sort());
    expect(res.body.media.find((m: { id: string }) => m.id === before.id)).toEqual({
      id: before.id,
      kind: "BEFORE",
      petId: f.petId,
      createdAt: before.createdAt.toISOString(),
    });

    for (let i = 2; i <= 5; i++) expect((await exportMe(token)).status).toBe(200);
    const limited = await exportMe(token);
    expect(limited.status).toBe(429);
    expect(limited.body.code).toBe("RATE_LIMITED");
    // The limit is per customer.
    expect((await exportMe(other.token)).status).toBe(200);
    expect((await exportMe()).status).toBe(401);
  });

  it("DELETE /me → 204; customer anonymized and deletedAt set; the same token → 401 on GET /me; refresh token revoked", async () => {
    const token = await ownerToken();
    await ctx.prisma.customer.update({
      where: { id: f.customerId },
      data: { email: "ana@test.dev", emergencyPhoneE164: "+13055550111", privateNotesEnc: "enc:notes" },
    });
    await ctx.prisma.notificationConsent.create({
      data: { organizationId: f.orgId, customerId: f.customerId, channel: "SMS", granted: true, source: "PROFILE" },
    });
    const refreshRow = (subjectId: string, hash: string) =>
      ctx.prisma.refreshToken.create({
        data: { subjectType: "CUSTOMER", subjectId, familyId: subjectId, tokenHash: hash, expiresAt: new Date(Date.now() + DAY) },
      });
    const mine = await refreshRow(f.customerId, "hash-mine");
    const other = await otherCustomer();
    const theirs = await refreshRow(other.id, "hash-theirs");

    const res = await deleteMe(token);
    expect(res.status).toBe(204);

    const c = await ctx.prisma.customer.findUniqueOrThrow({ where: { id: f.customerId } });
    expect(c).toMatchObject({ name: null, email: null, emergencyPhoneE164: null, privateNotesEnc: null, phoneE164: `deleted:${f.customerId}` });
    expect(c.deletedAt).not.toBeNull();
    // Consents stay as evidence.
    expect(await ctx.prisma.notificationConsent.count({ where: { customerId: f.customerId } })).toBe(1);

    expect((await auth(request(server()).get("/v1/me"), token)).status).toBe(401);
    expect((await auth(request(server()).patch("/v1/me").send({ locale: "en" }), token)).status).toBe(401);
    expect((await exportMe(token)).status).toBe(401);
    expect((await deleteMe(token)).status).toBe(401);
    expect((await auth(request(server()).get("/v1/me/appointments"), token)).status).toBe(401);

    expect((await ctx.prisma.refreshToken.findUniqueOrThrow({ where: { id: mine.id } })).revokedAt).not.toBeNull();
    expect((await ctx.prisma.refreshToken.findUniqueOrThrow({ where: { id: theirs.id } })).revokedAt).toBeNull();
    // Other customers keep working.
    expect((await auth(request(server()).get("/v1/me"), other.token)).status).toBe(200);

    const audits = await ctx.prisma.auditLog.findMany({ where: { action: "customer.delete" } });
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({
      organizationId: f.orgId,
      actorType: "CUSTOMER",
      actorId: f.customerId,
      entity: "customer",
      entityId: f.customerId,
      after: { petsDeleted: 1, appointmentsCancelled: 0 },
    });
  });

  it("pets soft-deleted and anonymized; vaccines and PET_PHOTO media rows gone; one media.purge outbox row with their keys; a BEFORE media row of a past visit stays", async () => {
    const token = await ownerToken();
    const { photo, card } = await richPet();
    const past = await pastVisit();
    const before = await media("BEFORE", `visits/${past.visitId}/before.jpg`, past.visitId);
    // A pet the owner already removed is anonymized too, keeping its deletion time.
    const removedAt = new Date(Date.now() - 5 * DAY);
    const removed = await ctx.prisma.pet.create({
      data: { organizationId: f.orgId, customerId: f.customerId, name: "Old", species: "CAT", breed: "Siamese", vetName: "Dr. Cat", deletedAt: removedAt },
    });
    const other = await otherCustomer();
    const otherPet = await ctx.prisma.pet.create({
      data: { organizationId: f.orgId, customerId: other.id, name: "Bo dog", species: "DOG", breed: "Lab" },
    });
    const otherPhoto = await media("PET_PHOTO", `pets/${otherPet.id}/photo.jpg`, null, otherPet.id);

    expect((await deleteMe(token)).status).toBe(204);

    const pet = await ctx.prisma.pet.findUniqueOrThrow({ where: { id: f.petId } });
    expect(pet).toMatchObject({
      name: "Deleted pet",
      breed: "-",
      breedCode: null,
      birthDate: null,
      medicalNotesEnc: null,
      behaviorNotes: null,
      vetName: null,
      vetPhoneE164: null,
      allergies: [],
      temperament: [],
      photoMediaId: null,
    });
    expect(pet.deletedAt).not.toBeNull();
    const old = await ctx.prisma.pet.findUniqueOrThrow({ where: { id: removed.id } });
    expect(old).toMatchObject({ name: "Deleted pet", breed: "-", vetName: null, deletedAt: removedAt });

    expect(await ctx.prisma.petVaccine.count({ where: { petId: f.petId } })).toBe(0);
    expect(await ctx.prisma.media.count({ where: { id: { in: [photo.id, card.id] } } })).toBe(0);
    expect(await ctx.prisma.media.findUnique({ where: { id: before.id } })).not.toBeNull();
    expect(await ctx.prisma.media.findUnique({ where: { id: otherPhoto.id } })).not.toBeNull();
    // The visit stays for the shop, detached through the anonymized pet.
    expect((await ctx.prisma.petVisit.findUniqueOrThrow({ where: { id: past.visitId } })).petId).toBe(f.petId);

    const purge = await ctx.prisma.outboxEvent.findMany({ where: { type: "media.purge" } });
    expect(purge).toHaveLength(1);
    expect(purge[0]!.organizationId).toBe(f.orgId);
    expect(((purge[0]!.payload as { objectKeys: string[] }).objectKeys).sort()).toEqual([photo.objectKey, card.objectKey].sort());

    expect((await ctx.prisma.pet.findUniqueOrThrow({ where: { id: otherPet.id } })).name).toBe("Bo dog");
    const audit = await ctx.prisma.auditLog.findFirstOrThrow({ where: { action: "customer.delete" } });
    expect(audit.after).toEqual({ petsDeleted: 1, appointmentsCancelled: 0 });
  });

  it("no PET_PHOTO or VACCINE_CARD media → no media.purge outbox row", async () => {
    expect((await deleteMe(await ownerToken())).status).toBe(204);
    expect(await ctx.prisma.outboxEvent.count({ where: { type: "media.purge" } })).toBe(0);
  });

  it("a future BOOKED appointment → CANCELLED reason ACCOUNT_DELETED, occupies false; a COMPLETED one unchanged", async () => {
    const token = await ownerToken();
    const future = await book(token, local("08:00"));
    const inShop = await book(token, local("10:00"));
    await ctx.prisma.appointment.update({ where: { id: inShop }, data: { status: "IN_SHOP", checkedInAt: new Date() } });
    const started = await book(token, local("12:00"));
    await ctx.prisma.appointment.update({ where: { id: started }, data: { bookingMode: "DROP_OFF", dropOffAt: new Date(Date.now() - DAY) } });
    const past = await pastVisit();
    const live = await hold({ pets: [savedPet()], slot: (await slots(token)).find((s) => s.startsAt === local("14:00")) }, token);
    expect(live.status).toBe(201);
    const holdId = live.body.holdId as string;
    await ctx.prisma.outboxEvent.deleteMany();
    const snapshot = (id: string) =>
      ctx.prisma.appointment.findUniqueOrThrow({ where: { id }, include: { petVisits: true, segments: true } });
    const completedBefore = await snapshot(past.appointmentId);
    const inShopBefore = await snapshot(inShop);
    const startedBefore = await snapshot(started);

    expect((await deleteMe(token)).status).toBe(204);

    const cancelled = await snapshot(future);
    expect(cancelled).toMatchObject({ status: "CANCELLED", cancelReason: "ACCOUNT_DELETED", cancelledBy: "CUSTOMER", manageVersion: 1 });
    expect(cancelled.cancelledAt).not.toBeNull();
    expect(cancelled.segments.length).toBeGreaterThan(0);
    expect(cancelled.segments.every((s) => !s.occupies)).toBe(true);
    expect(cancelled.petVisits.every((v) => v.status === "CANCELLED")).toBe(true);

    const released = await snapshot(holdId);
    expect(released).toMatchObject({ status: "CANCELLED", cancelReason: "HOLD_RELEASED", cancelledBy: "CUSTOMER" });
    expect(released.segments.every((s) => !s.occupies)).toBe(true);

    expect(await snapshot(past.appointmentId)).toEqual(completedBefore);
    expect(await snapshot(inShop)).toEqual(inShopBefore);
    expect(await snapshot(started)).toEqual(startedBefore);

    // Only the booking produces an appointment.cancelled row; the hold does not.
    const events = await ctx.prisma.outboxEvent.findMany({ where: { type: "appointment.cancelled" } });
    expect(events.map((e) => (e.payload as { appointmentId: string }).appointmentId)).toEqual([future]);
    const cancels = await ctx.prisma.auditLog.findMany({ where: { action: "appointment.cancel" } });
    expect(cancels.map((a) => a.entityId)).toEqual([future]);
    expect(cancels[0]!.after).toEqual({ status: "CANCELLED", cancelledBy: "CUSTOMER" });
    const audit = await ctx.prisma.auditLog.findFirstOrThrow({ where: { action: "customer.delete" } });
    expect(audit.after).toEqual({ petsDeleted: 1, appointmentsCancelled: 1 });
  });

  it("identity rows deleted; an unprocessed customer.identity_linked outbox row deleted; a processed one kept", async () => {
    const token = await ownerToken();
    const other = await otherCustomer();
    await ctx.prisma.customerIdentity.create({
      data: { organizationId: f.orgId, customerId: f.customerId, provider: "GOOGLE", subject: "g-sub-1", email: "ana@gmail.com" },
    });
    await ctx.prisma.customerIdentity.create({
      data: { organizationId: f.orgId, customerId: other.id, provider: "GOOGLE", subject: "g-sub-2", email: "bo@gmail.com" },
    });
    const event = (customerId: string, processedAt: Date | null) =>
      ctx.prisma.outboxEvent.create({
        data: { organizationId: f.orgId, type: "customer.identity_linked", payload: { customerId, googleEmail: "x@gmail.com", notifyEmail: null }, processedAt },
      });
    const pending = await event(f.customerId, null);
    const processed = await event(f.customerId, new Date());
    const otherPending = await event(other.id, null);

    expect((await deleteMe(token)).status).toBe(204);

    expect(await ctx.prisma.customerIdentity.count({ where: { customerId: f.customerId } })).toBe(0);
    expect(await ctx.prisma.customerIdentity.count({ where: { customerId: other.id } })).toBe(1);
    expect(await ctx.prisma.outboxEvent.findUnique({ where: { id: pending.id } })).toBeNull();
    expect(await ctx.prisma.outboxEvent.findUnique({ where: { id: processed.id } })).not.toBeNull();
    expect(await ctx.prisma.outboxEvent.findUnique({ where: { id: otherPending.id } })).not.toBeNull();
  });

  it("audit rows for customer.update of this customer no longer contain name, phone or email", async () => {
    const token = await ownerToken();
    const patched = await auth(request(server()).patch("/v1/me").send({ name: "Ana Maria", email: "ana@test.dev", emergencyPhone: "+13055550111" }), token);
    expect(patched.status).toBe(200);
    const other = await otherCustomer();
    expect((await auth(request(server()).patch("/v1/me").send({ name: "Bo B" }), other.token)).status).toBe(200);

    expect((await deleteMe(token)).status).toBe(204);

    const rows = await ctx.prisma.auditLog.findMany({ where: { entity: "customer", entityId: f.customerId, action: "customer.update" } });
    expect(rows).toHaveLength(1);
    for (const r of rows) {
      for (const side of [r.before, r.after] as Record<string, unknown>[]) {
        for (const k of PII_KEYS) expect(side).not.toHaveProperty(k);
        // Non-PII keys stay.
        expect(side).toMatchObject({ id: f.customerId, locale: "es" });
      }
    }
    expect(JSON.stringify(rows)).not.toMatch(/Ana|ana@test\.dev|\+1305555011/);
    const theirs = await ctx.prisma.auditLog.findFirstOrThrow({ where: { entity: "customer", entityId: other.id, action: "customer.update" } });
    expect(theirs.after).toMatchObject({ name: "Bo B", email: "bo@test.dev" });
  });

  it("DELETE /me racing POST /appointments (Promise.all) → afterwards no BOOKED appointment and no new pet belongs to the deleted customer", async () => {
    const token = await ownerToken();
    const newPet = { ref: "new-1", species: "DOG", sizeClass: "M", coatType: "CURLY", serviceIds: [f.serviceId], name: "Rex", breed: "Poodle" };
    const { ref, species, sizeClass, coatType, serviceIds } = newPet;
    const [slot] = await slots(undefined, [{ ref, species, sizeClass, coatType, serviceIds }]);
    const h = await hold({ pets: [newPet], slot });
    expect(h.status).toBe(201);

    const [del, conf] = await Promise.all([deleteMe(token), confirm(h.body.holdId as string, token)]);
    expect(del.status).toBe(204);
    expect([201, 401, 404]).toContain(conf.status);

    expect(await ctx.prisma.appointment.count({ where: { customerId: f.customerId, status: "BOOKED" } })).toBe(0);
    expect(await ctx.prisma.pet.count({ where: { customerId: f.customerId, deletedAt: null } })).toBe(0);
    expect(await ctx.prisma.pet.count({ where: { customerId: f.customerId, name: "Rex" } })).toBe(0);
  });

  it("DELETE /me racing POST /me/identities/google → no identity row remains", async () => {
    const token = await ownerToken();
    const agent = request.agent(server());
    const nonceRes = await agent.post("/v1/auth/google/nonce").send({});
    expect(nonceRes.status).toBe(200);
    const idToken = await google.sign({ nonce: nonceRes.body.nonce as string, sub: "g-race", email: "race@gmail.com" });

    const [del, link] = await Promise.all([deleteMe(token), agent.post("/v1/me/identities/google").set("Authorization", `Bearer ${token}`).send({ idToken })]);
    expect(del.status).toBe(204);
    expect([204, 404, 409]).toContain(link.status);

    expect(await ctx.prisma.customerIdentity.count({ where: { customerId: f.customerId } })).toBe(0);
    expect(await ctx.prisma.outboxEvent.count({ where: { type: "customer.identity_linked", processedAt: null } })).toBe(0);
  });

  it("linkInTx on a deleted customer → TAKEN, no identity, audit or outbox row", async () => {
    expect((await deleteMe(await ownerToken())).status).toBe(204);
    await ctx.prisma.outboxEvent.deleteMany();
    const links = ctx.app.get(IdentityLinkService);
    const outcome = await ctx.prisma.$transaction((tx) =>
      links.linkInTx(tx, { orgId: f.orgId, customerId: f.customerId, sub: "g-late", email: "late@gmail.com", name: "Late", notify: true, actorIp: null }),
    );
    expect(outcome).toBe("TAKEN");
    expect(await ctx.prisma.customerIdentity.count()).toBe(0);
    expect(await ctx.prisma.outboxEvent.count()).toBe(0);
    expect(await ctx.prisma.auditLog.count({ where: { action: "auth.customer.identity_linked" } })).toBe(0);
  });
});
