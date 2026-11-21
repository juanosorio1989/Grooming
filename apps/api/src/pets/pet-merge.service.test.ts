import { ConflictException } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { describe, expect, it } from "vitest";
import { PetMergeService, isTxConflict } from "./pet-merge.service.js";

const known = (code: string, meta?: Record<string, unknown>) =>
  new Prisma.PrismaClientKnownRequestError("boom", { code, clientVersion: "6", ...(meta ? { meta } : {}) });

describe("isTxConflict", () => {
  it("recognizes write-conflict, serialization and deadlock aborts", () => {
    expect(isTxConflict(known("P2034"))).toBe(true);
    expect(isTxConflict(known("P2010", { code: "40P01" }))).toBe(true);
    expect(isTxConflict(known("P2010", { code: "40001" }))).toBe(true);
    expect(isTxConflict(new Error('Raw query failed. Code: `40P01`. Message: `deadlock detected`'))).toBe(true);
  });
  it("ignores other errors", () => {
    expect(isTxConflict(known("P2002"))).toBe(false);
    expect(isTxConflict(new Error("connection reset"))).toBe(false);
    expect(isTxConflict(null)).toBe(false);
  });
});

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
