import { ConflictException } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { describe, expect, it } from "vitest";
import type { PetVaccine } from "@prisma/client";
import { PetMergeService, planVaccineDedupe } from "./pet-merge.service.js";

const known = (code: string, meta?: Record<string, unknown>) =>
  new Prisma.PrismaClientKnownRequestError("boom", { code, clientVersion: "6", ...(meta ? { meta } : {}) });

describe("PetMergeService.merge", () => {
  const actor = { type: "STAFF" as const, claims: { sub: "s", role: "OWNER" } as never };
  const make = (err: unknown) =>
    new PetMergeService(
      { $transaction: () => Promise.reject(err) } as never,
      { getOrgId: async () => "org" } as never,
      {} as never,
      {} as never,
    );

  it("maps a deadlock abort to 409 PET_MERGE_INVALID", async () => {
    const err = await make(known("P2010", { code: "40P01" })).merge(actor, "a", "b", null).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ConflictException);
    expect((err as ConflictException).getResponse()).toMatchObject({ code: "PET_MERGE_INVALID" });
  });
  it("rethrows unrelated errors", async () => {
    const boom = new Error("connection reset");
    await expect(make(boom).merge(actor, "a", "b", null)).rejects.toBe(boom);
  });
});

describe("planVaccineDedupe", () => {
  const v = (id: string, expiresOn: string, extra: Partial<PetVaccine> = {}): PetVaccine =>
    ({ id, type: "RABIES", expiresOn: new Date(`${expiresOn}T00:00:00Z`), verifiedAt: null, cardMediaId: null, ...extra }) as PetVaccine;

  it("never pairs rows with different expiry or type", () => {
    const plan = planVaccineDedupe([v("t1", "2025-01-01"), v("t2", "2027-01-01")], [v("s1", "2026-01-01"), v("s2", "2027-01-01", { type: "DHPP" })]);
    expect(plan).toEqual({ drop: [], cardCopies: [] });
  });
  it("keeps the target row when neither or both are verified", () => {
    expect(planVaccineDedupe([v("t", "2027-01-01")], [v("s", "2027-01-01")]).drop.map((d) => d.id)).toEqual(["s"]);
    const both = { verifiedAt: new Date() };
    expect(planVaccineDedupe([v("t", "2027-01-01", both)], [v("s", "2027-01-01", both)]).drop.map((d) => d.id)).toEqual(["s"]);
  });
  it("keeps a verified source row over an unverified target row and copies the card", () => {
    const plan = planVaccineDedupe([v("t", "2027-01-01", { cardMediaId: "card" })], [v("s", "2027-01-01", { verifiedAt: new Date() })]);
    expect(plan.drop.map((d) => d.id)).toEqual(["t"]);
    expect(plan.cardCopies).toEqual([{ id: "s", cardMediaId: "card" }]);
  });
  it("does not overwrite the kept row's own card", () => {
    const plan = planVaccineDedupe([v("t", "2027-01-01", { cardMediaId: "mine" })], [v("s", "2027-01-01", { cardMediaId: "theirs" })]);
    expect(plan.cardCopies).toEqual([]);
  });
  it("pairs one-to-one: two identical source rows against one target row drop only one", () => {
    const plan = planVaccineDedupe([v("t", "2027-01-01")], [v("s1", "2027-01-01"), v("s2", "2027-01-01")]);
    expect(plan.drop.map((d) => d.id)).toEqual(["s1"]);
  });
});
