import { ConflictException, Injectable, NotFoundException } from "@nestjs/common";
import { Prisma, type Pet, type PetVaccine } from "@prisma/client";
import {
  MAX_PETS_PER_CUSTOMER,
  type AccessClaims,
  type PetInput,
  type PetPatch,
  type PetView,
  type StaffPetCreate,
  type StaffPetQuery,
  type VaccineInput,
  type VaccinePatch,
  type VaccineView,
} from "@grooming/contracts";
import { sizeClassFromWeight } from "@grooming/pricing";
import { AuditService } from "../audit/audit.service.js";
import { Encryptor } from "../auth/crypto/encryption.js";
import { LocationService } from "../location/location.service.js";
import { PrismaService } from "../prisma/prisma.service.js";
import { TenancyService } from "../tenancy/tenancy.service.js";
import { PetAccessService } from "./pet-access.service.js";

const MAX_RESULTS = 100;
const isoDate = (d: Date): string => d.toISOString().slice(0, 10);
const toDate = (s: string): Date => new Date(`${s}T00:00:00Z`);

/**
 * Keys of the pet audit snapshot (`auditShape`) that are free text or identify the animal or its
 * owner. `DELETE /me` strips exactly these from the pet and pet_vaccine audit rows of the customer's
 * pets; keep the list in sync with `view`. (`medicalNotes` is never written; listed defensively.)
 */
export const PET_AUDIT_PII_KEYS = [
  "name",
  "breed",
  "breedCode",
  "birthDate",
  "behaviorNotes",
  "vetName",
  "vetPhone",
  "allergies",
  "temperament",
  "medicalNotes",
] as const;

export type PetRow = Pet & { vaccines: PetVaccine[] };
export const withVaccines = { vaccines: { orderBy: [{ expiresOn: "asc" }, { id: "asc" }] } } satisfies Prisma.PetInclude;

/** Who is calling: an owner is confined to their own pets, staff to the organization. */
export interface PetActor {
  type: "CUSTOMER" | "STAFF";
  claims: AccessClaims;
}

function vaccineView(v: PetVaccine): VaccineView {
  return {
    id: v.id,
    type: v.type,
    expiresOn: isoDate(v.expiresOn),
    cardMediaId: v.cardMediaId,
    verified: v.verifiedAt !== null,
    verifiedAt: v.verifiedAt ? v.verifiedAt.toISOString() : null,
  };
}

@Injectable()
export class PetsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly tenancy: TenancyService,
    private readonly audit: AuditService,
    private readonly encryptor: Encryptor,
    private readonly location: LocationService,
    private readonly access: PetAccessService,
  ) {}

  /** Public so `PetMergeService` can return the merged target in the same shape. */
  view(p: PetRow): PetView {
    return {
      id: p.id,
      customerId: p.customerId,
      name: p.name,
      species: p.species,
      breed: p.breed,
      breedCode: p.breedCode,
      birthDate: p.birthDate ? isoDate(p.birthDate) : null,
      sex: p.sex,
      neutered: p.neutered,
      weightG: p.weightG,
      weightMeasuredAt: p.weightMeasuredAt ? p.weightMeasuredAt.toISOString() : null,
      sizeClass: p.sizeClass,
      coatType: p.coatType,
      temperament: p.temperament,
      allergies: p.allergies,
      medicalNotes: p.medicalNotesEnc ? this.encryptor.decrypt(p.medicalNotesEnc) : null,
      behaviorNotes: p.behaviorNotes,
      vetName: p.vetName,
      vetPhone: p.vetPhoneE164,
      photoMediaId: p.photoMediaId,
      vaccines: p.vaccines.map(vaccineView),
    };
  }

  /** Audit snapshot: never contains the notes text. */
  private auditShape(p: PetRow) {
    const rest: Partial<PetView> = this.view(p);
    delete rest.medicalNotes;
    delete rest.vaccines;
    return { ...rest, hasMedicalNotes: p.medicalNotesEnc !== null };
  }

  private async fields(body: PetInput | PetPatch, existing: Pet | null): Promise<Prisma.PetUncheckedUpdateInput> {
    const data: Prisma.PetUncheckedUpdateInput = {};
    if (body.name !== undefined) data.name = body.name;
    if (body.species !== undefined) data.species = body.species;
    if (body.breed !== undefined) data.breed = body.breed;
    if (body.breedCode !== undefined) data.breedCode = body.breedCode;
    if (body.birthDate !== undefined) data.birthDate = body.birthDate ? toDate(body.birthDate) : null;
    if (body.sex !== undefined) data.sex = body.sex;
    if (body.neutered !== undefined) data.neutered = body.neutered;
    if (body.coatType !== undefined) data.coatType = body.coatType;
    if (body.temperament !== undefined) data.temperament = body.temperament;
    if (body.allergies !== undefined) data.allergies = body.allergies;
    if (body.behaviorNotes !== undefined) data.behaviorNotes = body.behaviorNotes;
    if (body.vetName !== undefined) data.vetName = body.vetName;
    if (body.vetPhone !== undefined) data.vetPhoneE164 = body.vetPhone;
    if (body.medicalNotes !== undefined) {
      data.medicalNotesEnc = body.medicalNotes ? this.encryptor.encrypt(body.medicalNotes) : null;
    }
    // Size rule: a weight derives the size class (a sent sizeClass is ignored); without one the owner's pick is stored.
    if (body.weightG !== undefined) {
      if (body.weightG === null) {
        data.weightG = null;
        data.weightMeasuredAt = null;
        if (body.sizeClass !== undefined) data.sizeClass = body.sizeClass;
      } else {
        const { settings } = await this.location.getDefault();
        data.weightG = body.weightG;
        data.weightMeasuredAt = new Date();
        data.sizeClass = sizeClassFromWeight(body.weightG, settings.sizeThresholdsLb);
      }
    } else if (body.sizeClass !== undefined && existing?.weightG == null) {
      data.sizeClass = body.sizeClass;
    }
    return data;
  }

  /** Finds a live pet in the organization; owners only their own; EMPLOYEE only under the "today" scope. Else 404. */
  private async load(db: Prisma.TransactionClient | PrismaService, actor: PetActor, id: string): Promise<PetRow> {
    const organizationId = await this.tenancy.getOrgId();
    const row = await db.pet.findFirst({
      where: { id, organizationId, deletedAt: null, ...(actor.type === "CUSTOMER" ? { customerId: actor.claims.sub } : {}) },
      include: withVaccines,
    });
    if (!row) throw new NotFoundException("Pet not found");
    if (actor.type === "STAFF" && actor.claims.role === "EMPLOYEE" && !(await this.access.employeeCanSee(actor.claims.sub, id, new Date()))) {
      throw new NotFoundException("Pet not found");
    }
    return row;
  }

  private audRecord(
    actor: PetActor,
    orgId: string,
    action: string,
    entity: string,
    entityId: string,
    before: object | null,
    after: object | null,
    ip: string | null,
    tx: Prisma.TransactionClient,
  ) {
    return this.audit.record(
      { orgId, actorType: actor.type, actorId: actor.claims.sub, action, entity, entityId, before, after, ip },
      tx,
    );
  }

  async list(actor: PetActor, q: StaffPetQuery): Promise<PetView[]> {
    const organizationId = await this.tenancy.getOrgId();
    const and: Prisma.PetWhereInput[] = [];
    const term = q.q?.trim();
    if (term) and.push({ OR: [{ name: { contains: term, mode: "insensitive" } }, { breed: { contains: term, mode: "insensitive" } }] });
    if (actor.type === "STAFF" && actor.claims.role === "EMPLOYEE") {
      and.push(await this.access.employeeTodayWhere(actor.claims.sub, new Date()));
    }
    const rows = await this.prisma.pet.findMany({
      where: {
        organizationId,
        deletedAt: null,
        ...(actor.type === "CUSTOMER" ? { customerId: actor.claims.sub } : q.customerId ? { customerId: q.customerId } : {}),
        ...(and.length ? { AND: and } : {}),
      },
      include: withVaccines,
      orderBy: [{ name: "asc" }, { id: "asc" }],
      take: MAX_RESULTS,
    });
    return rows.map((r) => this.view(r));
  }

  async get(actor: PetActor, id: string): Promise<PetView> {
    return this.view(await this.load(this.prisma, actor, id));
  }

  async create(actor: PetActor, customerId: string, body: PetInput, ip: string | null): Promise<PetView> {
    return this.prisma.$transaction(async (tx) => this.view(await this.insert(tx, actor, customerId, body, ip)));
  }

  /**
   * `create` inside the caller's transaction (used by booking confirm): same
   * size rule, the same customer lock and pet cap (409 CONFLICT), and the
   * `pet.create` audit row. 404 when the customer is missing or deleted.
   */
  async createInTx(tx: Prisma.TransactionClient, actor: PetActor, customerId: string, body: PetInput, ip: string | null): Promise<{ id: string }> {
    const row = await this.insert(tx, actor, customerId, body, ip);
    return { id: row.id };
  }

  private async insert(tx: Prisma.TransactionClient, actor: PetActor, customerId: string, body: PetInput, ip: string | null): Promise<PetRow> {
    const orgId = await this.tenancy.getOrgId();
    const data = await this.fields(body, null);
    // Locking the customer row serializes concurrent creates so the cap cannot be exceeded.
    const locked = await tx.$queryRaw<{ id: string }[]>`
      SELECT id FROM customer WHERE id = ${customerId}::uuid AND organization_id = ${orgId}::uuid AND deleted_at IS NULL FOR UPDATE`;
    if (locked.length === 0) throw new NotFoundException("Customer not found");
    const count = await tx.pet.count({ where: { organizationId: orgId, customerId, deletedAt: null } });
    if (count >= MAX_PETS_PER_CUSTOMER) {
      throw new ConflictException({ code: "CONFLICT", message: `A customer can have at most ${MAX_PETS_PER_CUSTOMER} pets` });
    }
    const row = await tx.pet.create({
      data: {
        ...(data as Prisma.PetUncheckedCreateInput),
        organizationId: orgId,
        customerId,
        name: body.name,
        species: body.species,
        breed: body.breed,
      },
      include: withVaccines,
    });
    await this.audRecord(actor, orgId, "pet.create", "pet", row.id, null, { ...this.auditShape(row), medicalNotesChanged: body.medicalNotes !== undefined }, ip, tx);
    return row;
  }

  async createStaff(actor: PetActor, body: StaffPetCreate, ip: string | null): Promise<PetView> {
    const { customerId, ...input } = body;
    return this.create(actor, customerId, input, ip);
  }

  async patch(actor: PetActor, id: string, body: PetPatch, ip: string | null): Promise<PetView> {
    const orgId = await this.tenancy.getOrgId();
    return this.prisma.$transaction(async (tx) => {
      const before = await this.load(tx, actor, id);
      const data = await this.fields(body, before);
      const row = await tx.pet.update({ where: { id }, data, include: withVaccines });
      await this.audRecord(actor, orgId, "pet.update", "pet", id, this.auditShape(before), { ...this.auditShape(row), medicalNotesChanged: body.medicalNotes !== undefined }, ip, tx);
      return this.view(row);
    });
  }

  async remove(actor: PetActor, id: string, ip: string | null): Promise<void> {
    const orgId = await this.tenancy.getOrgId();
    await this.prisma.$transaction(async (tx) => {
      const before = await this.load(tx, actor, id);
      const row = await tx.pet.update({ where: { id }, data: { deletedAt: new Date() }, include: withVaccines });
      await this.audRecord(actor, orgId, "pet.delete", "pet", id, this.auditShape(before), { deleted: true, id: row.id }, ip, tx);
    });
  }

  // ------------------------------------------------------------ vaccines

  async listVaccines(actor: PetActor, petId: string): Promise<VaccineView[]> {
    return (await this.load(this.prisma, actor, petId)).vaccines.map(vaccineView);
  }

  private async loadVaccine(tx: Prisma.TransactionClient, petId: string, vid: string): Promise<PetVaccine> {
    const organizationId = await this.tenancy.getOrgId();
    const v = await tx.petVaccine.findFirst({ where: { id: vid, petId, organizationId } });
    if (!v) throw new NotFoundException("Vaccine not found");
    return v;
  }

  async createVaccine(actor: PetActor, petId: string, body: VaccineInput, ip: string | null): Promise<VaccineView> {
    const orgId = await this.tenancy.getOrgId();
    return this.prisma.$transaction(async (tx) => {
      await this.load(tx, actor, petId);
      const row = await tx.petVaccine.create({
        data: { organizationId: orgId, petId, type: body.type, expiresOn: toDate(body.expiresOn) },
      });
      await this.audRecord(actor, orgId, "pet_vaccine.create", "pet_vaccine", row.id, null, { petId, ...vaccineView(row) }, ip, tx);
      return vaccineView(row);
    });
  }

  async patchVaccine(actor: PetActor, petId: string, vid: string, body: VaccinePatch, ip: string | null): Promise<VaccineView> {
    const orgId = await this.tenancy.getOrgId();
    return this.prisma.$transaction(async (tx) => {
      await this.load(tx, actor, petId);
      const before = await this.loadVaccine(tx, petId, vid);
      const row = await tx.petVaccine.update({
        where: { id: vid },
        data: {
          ...(body.type !== undefined ? { type: body.type } : {}),
          ...(body.expiresOn !== undefined ? { expiresOn: toDate(body.expiresOn) } : {}),
          // An owner edit invalidates the staff verification.
          ...(actor.type === "CUSTOMER" ? { verifiedAt: null, verifiedByStaffId: null } : {}),
        },
      });
      await this.audRecord(actor, orgId, "pet_vaccine.update", "pet_vaccine", vid, { petId, ...vaccineView(before) }, { petId, ...vaccineView(row) }, ip, tx);
      return vaccineView(row);
    });
  }

  async removeVaccine(actor: PetActor, petId: string, vid: string, ip: string | null): Promise<void> {
    const orgId = await this.tenancy.getOrgId();
    await this.prisma.$transaction(async (tx) => {
      await this.load(tx, actor, petId);
      const before = await this.loadVaccine(tx, petId, vid);
      await tx.petVaccine.delete({ where: { id: vid } });
      await this.audRecord(actor, orgId, "pet_vaccine.delete", "pet_vaccine", vid, { petId, ...vaccineView(before) }, null, ip, tx);
    });
  }

  async verifyVaccine(actor: PetActor, petId: string, vid: string, ip: string | null): Promise<VaccineView> {
    const orgId = await this.tenancy.getOrgId();
    return this.prisma.$transaction(async (tx) => {
      await this.load(tx, actor, petId);
      const before = await this.loadVaccine(tx, petId, vid);
      const row = await tx.petVaccine.update({ where: { id: vid }, data: { verifiedAt: new Date(), verifiedByStaffId: actor.claims.sub } });
      await this.audRecord(actor, orgId, "pet_vaccine.verify", "pet_vaccine", vid, { petId, ...vaccineView(before) }, { petId, ...vaccineView(row) }, ip, tx);
      return vaccineView(row);
    });
  }
}
