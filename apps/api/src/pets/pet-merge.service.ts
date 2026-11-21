import { ConflictException, Injectable, NotFoundException } from "@nestjs/common";
import { Prisma, type PetVaccine } from "@prisma/client";
import type { PetView } from "@grooming/contracts";
import { AuditService } from "../audit/audit.service.js";
import { PrismaService } from "../prisma/prisma.service.js";
import { TenancyService } from "../tenancy/tenancy.service.js";
import { PetsService, withVaccines, type PetActor, type PetRow } from "./pets.service.js";

const invalid = (detail: string) => new ConflictException({ code: "PET_MERGE_INVALID", message: detail });

/** True when Postgres aborted the transaction to resolve a lock or serialization conflict. */
export function isTxConflict(err: unknown): boolean {
  if (typeof err !== "object" || err === null) return false;
  const e = err as { code?: unknown; meta?: { code?: unknown }; message?: unknown };
  if (e.code === "P2034") return true;
  if (e.meta?.code === "40001" || e.meta?.code === "40P01") return true;
  return typeof e.message === "string" && /\b(40001|40P01)\b|deadlock detected|could not serialize/.test(e.message);
}

const isBlank = (v: unknown) => v === null || v === undefined || v === "";

/** Winner of two same-type vaccines: later expiry, then verified, then the first argument (the target's). */
function better(a: PetVaccine, b: PetVaccine): PetVaccine {
  const diff = a.expiresOn.getTime() - b.expiresOn.getTime();
  if (diff !== 0) return diff > 0 ? a : b;
  if ((a.verifiedAt !== null) !== (b.verifiedAt !== null)) return a.verifiedAt !== null ? a : b;
  return a;
}

/**
 * Merges a duplicate pet (source) into another pet (target) of the same customer and species, in one transaction:
 * visits, media and vaccines move to the target, empty target fields are filled from the source, and the source is
 * soft-deleted. Both pet rows are locked `FOR UPDATE` in id order so concurrent merges of the same pair serialize.
 */
@Injectable()
export class PetMergeService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly tenancy: TenancyService,
    private readonly audit: AuditService,
    private readonly pets: PetsService,
  ) {}

  async merge(actor: PetActor, sourceId: string, targetId: string, ip: string | null): Promise<PetView> {
    if (sourceId === targetId) throw invalid("A pet cannot be merged into itself");
    const orgId = await this.tenancy.getOrgId();
    try {
      return await this.prisma.$transaction((tx) => this.run(tx, actor, orgId, sourceId, targetId, ip));
    } catch (err) {
      if (isTxConflict(err)) throw invalid("A concurrent change touched one of these pets; reload and retry");
      throw err;
    }
  }

  private async run(
    tx: Prisma.TransactionClient,
    actor: PetActor,
    orgId: string,
    sourceId: string,
    targetId: string,
    ip: string | null,
  ): Promise<PetView> {
    // Lock in id order (ORDER BY runs before the row locks) so A->B and B->A cannot deadlock.
    const locked = await tx.$queryRaw<{ id: string }[]>`
      SELECT id FROM pet
      WHERE id IN (${sourceId}::uuid, ${targetId}::uuid) AND organization_id = ${orgId}::uuid
      ORDER BY id FOR UPDATE`;
    if (locked.length !== 2) throw new NotFoundException("Pet not found");

    // Read after the locks: under READ COMMITTED this sees any merge that committed while we waited.
    const rows = await tx.pet.findMany({ where: { id: { in: [sourceId, targetId] }, organizationId: orgId }, include: withVaccines });
    const source = rows.find((r) => r.id === sourceId);
    const target = rows.find((r) => r.id === targetId);
    if (!source || !target) throw new NotFoundException("Pet not found");
    if (source.deletedAt || target.deletedAt) throw invalid("Both pets must not be deleted");
    if (source.customerId !== target.customerId) throw invalid("Both pets must belong to the same customer");
    if (source.species !== target.species) throw invalid("Both pets must be the same species");

    const movedVisits = (await tx.petVisit.updateMany({ where: { organizationId: orgId, petId: sourceId }, data: { petId: targetId } })).count;
    const movedMedia = (await tx.media.updateMany({ where: { organizationId: orgId, petId: sourceId }, data: { petId: targetId } })).count;
    const { moved: movedVaccines, dropped: droppedVaccines } = await this.mergeVaccines(tx, source, target);

    const { data, filledFields } = this.fill(source, target);
    await tx.pet.update({ where: { id: sourceId }, data: { deletedAt: new Date() } });
    const merged = await tx.pet.update({ where: { id: targetId }, data, include: withVaccines });

    await this.audit.record(
      {
        orgId,
        actorType: actor.type,
        actorId: actor.claims.sub,
        action: "pet.merge",
        entity: "pet",
        entityId: targetId,
        before: null,
        after: { sourcePetId: sourceId, movedVisits, movedMedia, movedVaccines, droppedVaccines, filledFields },
        ip,
      },
      tx,
    );
    return this.pets.view(merged);
  }

  /** For each vaccine type present on both pets one row survives (see `better`); the rest are deleted. */
  private async mergeVaccines(tx: Prisma.TransactionClient, source: PetRow, target: PetRow): Promise<{ moved: number; dropped: number }> {
    const drop: string[] = [];
    for (const type of new Set(source.vaccines.map((v) => v.type))) {
      const group = [...target.vaccines, ...source.vaccines].filter((v) => v.type === type);
      if (!target.vaccines.some((v) => v.type === type)) continue;
      const winner = group.reduce(better);
      for (const v of group) if (v.id !== winner.id) drop.push(v.id);
    }
    if (drop.length) await tx.petVaccine.deleteMany({ where: { id: { in: drop } } });
    const moved = (await tx.petVaccine.updateMany({ where: { organizationId: source.organizationId, petId: source.id }, data: { petId: target.id } })).count;
    return { moved, dropped: drop.length };
  }

  /** Target fields that are null or empty take the source value; temperament and allergies are unioned. */
  private fill(source: PetRow, target: PetRow): { data: Prisma.PetUncheckedUpdateInput; filledFields: string[] } {
    const data: Prisma.PetUncheckedUpdateInput = {};
    const filledFields: string[] = [];
    // [column, name in PetView / filledFields]
    const simple = [
      ["breedCode", "breedCode"],
      ["birthDate", "birthDate"],
      ["sex", "sex"],
      ["neutered", "neutered"],
      ["coatType", "coatType"],
      ["medicalNotesEnc", "medicalNotes"],
      ["behaviorNotes", "behaviorNotes"],
      ["vetName", "vetName"],
      ["vetPhoneE164", "vetPhone"],
      ["photoMediaId", "photoMediaId"],
    ] as const;
    for (const [col, name] of simple) {
      if (isBlank(target[col]) && !isBlank(source[col])) {
        (data as Record<string, unknown>)[col] = source[col];
        filledFields.push(name);
      }
    }
    // Weight, its timestamp and the derived size class travel together.
    if (target.weightG === null && source.weightG !== null) {
      data.weightG = source.weightG;
      data.weightMeasuredAt = source.weightMeasuredAt;
      data.sizeClass = source.sizeClass;
      filledFields.push("weightG", "weightMeasuredAt", "sizeClass");
    } else if (target.weightG === null && target.sizeClass === null && source.sizeClass !== null) {
      data.sizeClass = source.sizeClass;
      filledFields.push("sizeClass");
    }
    const temperament = [...target.temperament, ...source.temperament.filter((t) => !target.temperament.includes(t))];
    if (temperament.length !== target.temperament.length) {
      data.temperament = temperament;
      filledFields.push("temperament");
    }
    const seen = new Set(target.allergies.map((a) => a.toLowerCase()));
    const allergies = [...target.allergies];
    for (const a of source.allergies) {
      if (!seen.has(a.toLowerCase())) {
        seen.add(a.toLowerCase());
        allergies.push(a);
      }
    }
    if (allergies.length !== target.allergies.length) {
      data.allergies = allergies;
      filledFields.push("allergies");
    }
    return { data, filledFields };
  }
}
