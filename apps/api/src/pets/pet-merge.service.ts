import { ConflictException, Injectable, NotFoundException } from "@nestjs/common";
import { Prisma, type PetVaccine } from "@prisma/client";
import type { PetView } from "@grooming/contracts";
import { AuditService } from "../audit/audit.service.js";
import { isTxConflict } from "../common/pg-error.js";
import { PrismaService } from "../prisma/prisma.service.js";
import { TenancyService } from "../tenancy/tenancy.service.js";
import { PetsService, withVaccines, type PetActor, type PetRow } from "./pets.service.js";

const invalid = (detail: string) => new ConflictException({ code: "PET_MERGE_INVALID", message: detail });

const isBlank = (v: unknown) => v === null || v === undefined || v === "";

/** Audit snapshot of a vaccine row the merge deleted. */
export interface DroppedVaccine {
  id: string;
  type: PetVaccine["type"];
  expiresOn: string;
  verifiedAt: string | null;
  cardMediaId: string | null;
}

export interface VaccineDedupePlan {
  /** Rows to delete (one per exact-duplicate pair). */
  drop: PetVaccine[];
  /** Kept rows that take the dropped row's card because they had none. */
  cardCopies: { id: string; cardMediaId: string }[];
}

const vaccineKey = (v: PetVaccine) => `${v.type}|${v.expiresOn.toISOString().slice(0, 10)}`;

/**
 * Pairs each source vaccine with at most one target vaccine of the same `type` AND `expiresOn` (exact duplicate).
 * The verified row of a pair survives; when both or neither are verified the target's survives. Rows that differ in
 * `expiresOn` are history and are never paired.
 */
export function planVaccineDedupe(target: PetVaccine[], source: PetVaccine[]): VaccineDedupePlan {
  const pool = new Map<string, PetVaccine[]>();
  for (const t of target) pool.set(vaccineKey(t), [...(pool.get(vaccineKey(t)) ?? []), t]);
  const plan: VaccineDedupePlan = { drop: [], cardCopies: [] };
  for (const s of source) {
    const t = pool.get(vaccineKey(s))?.shift();
    if (!t) continue;
    const keepSource = s.verifiedAt !== null && t.verifiedAt === null;
    const [kept, dropped] = keepSource ? [s, t] : [t, s];
    plan.drop.push(dropped);
    if (kept.cardMediaId === null && dropped.cardMediaId !== null) plan.cardCopies.push({ id: kept.id, cardMediaId: dropped.cardMediaId });
  }
  return plan;
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

  /** Moves every source vaccine to the target; only exact duplicates are dropped (see `planVaccineDedupe`). */
  private async mergeVaccines(tx: Prisma.TransactionClient, source: PetRow, target: PetRow): Promise<{ moved: number; dropped: DroppedVaccine[] }> {
    const plan = planVaccineDedupe(target.vaccines, source.vaccines);
    if (plan.drop.length) await tx.petVaccine.deleteMany({ where: { id: { in: plan.drop.map((v) => v.id) } } });
    for (const c of plan.cardCopies) await tx.petVaccine.update({ where: { id: c.id }, data: { cardMediaId: c.cardMediaId } });
    const moved = (await tx.petVaccine.updateMany({ where: { organizationId: source.organizationId, petId: source.id }, data: { petId: target.id } })).count;
    const dropped = plan.drop.map((v) => ({
      id: v.id,
      type: v.type,
      expiresOn: v.expiresOn.toISOString().slice(0, 10),
      verifiedAt: v.verifiedAt ? v.verifiedAt.toISOString() : null,
      cardMediaId: v.cardMediaId,
    }));
    return { moved, dropped };
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
