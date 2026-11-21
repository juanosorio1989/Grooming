import { ConflictException, Injectable, NotFoundException } from "@nestjs/common";
import { Prisma, type Customer } from "@prisma/client";
import type {
  AccessClaims,
  CustomerCreate,
  CustomerPatch,
  CustomerQuery,
  CustomerView,
  Locale,
  MePatch,
  StaffCustomerView,
} from "@grooming/contracts";
import { AuditService } from "../audit/audit.service.js";
import { Encryptor } from "../auth/crypto/encryption.js";
import { PrismaService } from "../prisma/prisma.service.js";
import { TenancyService } from "../tenancy/tenancy.service.js";

const DAY_MS = 86_400_000;
const MAX_RESULTS = 50;

function toView(c: Customer): CustomerView {
  return {
    id: c.id,
    name: c.name,
    phone: c.phoneE164,
    email: c.email,
    locale: c.locale as Locale,
    emergencyPhone: c.emergencyPhoneE164,
    createdAt: c.createdAt.toISOString(),
  };
}

/** Audit snapshot: never contains the notes text. */
function auditShape(c: Customer) {
  return { ...toView(c), hasPrivateNotes: c.privateNotesEnc !== null };
}

@Injectable()
export class CustomersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly tenancy: TenancyService,
    private readonly audit: AuditService,
    private readonly encryptor: Encryptor,
  ) {}

  private staffView(actor: AccessClaims, c: Customer): StaffCustomerView {
    if (actor.role === "EMPLOYEE") return toView(c);
    return { ...toView(c), privateNotes: c.privateNotesEnc ? this.encryptor.decrypt(c.privateNotesEnc) : null };
  }

  /** EMPLOYEE scope: a segment assigned to them within 30 days back or ahead. */
  private employeeScope(actor: AccessClaims): Prisma.CustomerWhereInput {
    const now = Date.now();
    return {
      appointments: {
        some: {
          status: { not: "CANCELLED" },
          segments: {
            some: {
              staffUserId: actor.sub,
              startsAt: { gte: new Date(now - 30 * DAY_MS), lte: new Date(now + 30 * DAY_MS) },
            },
          },
        },
      },
    };
  }

  async search(actor: AccessClaims, q: CustomerQuery): Promise<StaffCustomerView[]> {
    const organizationId = await this.tenancy.getOrgId();
    const and: Prisma.CustomerWhereInput[] = [];
    const term = q.q?.trim();
    if (term) {
      const digits = term.replace(/\D/g, "");
      and.push({
        OR: [
          { name: { contains: term, mode: "insensitive" } },
          ...(digits ? [{ phoneE164: { contains: digits } }] : []),
        ],
      });
    }
    if (actor.role === "EMPLOYEE") and.push(this.employeeScope(actor));
    const rows = await this.prisma.customer.findMany({
      where: { organizationId, deletedAt: null, ...(and.length ? { AND: and } : {}) },
      orderBy: [{ name: "asc" }, { id: "asc" }],
      take: MAX_RESULTS,
    });
    return rows.map((c) => this.staffView(actor, c));
  }

  async get(actor: AccessClaims, id: string): Promise<StaffCustomerView> {
    const organizationId = await this.tenancy.getOrgId();
    const row = await this.prisma.customer.findFirst({
      where: { id, organizationId, deletedAt: null, ...(actor.role === "EMPLOYEE" ? this.employeeScope(actor) : {}) },
    });
    if (!row) throw new NotFoundException("Customer not found");
    return this.staffView(actor, row);
  }

  async create(actor: AccessClaims, body: CustomerCreate, ip: string | null): Promise<StaffCustomerView> {
    const orgId = await this.tenancy.getOrgId();
    const existing = await this.prisma.customer.findUnique({
      where: { organizationId_phoneE164: { organizationId: orgId, phoneE164: body.phone } },
      select: { id: true },
    });
    if (existing) throw new ConflictException({ code: "CONFLICT", message: existing.id });
    try {
      return await this.prisma.$transaction(async (tx) => {
        const row = await tx.customer.create({
          data: {
            organizationId: orgId,
            phoneE164: body.phone,
            name: body.name,
            locale: body.locale,
            email: body.email ?? null,
            emergencyPhoneE164: body.emergencyPhone ?? null,
            createdVia: "RECEPTION",
          },
        });
        await this.audit.record(
          { orgId, actorType: "STAFF", actorId: actor.sub, action: "customer.create", entity: "customer", entityId: row.id, after: auditShape(row), ip },
          tx,
        );
        return this.staffView(actor, row);
      });
    } catch (e) {
      // Lost a race with a concurrent create of the same phone.
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002") {
        const winner = await this.prisma.customer.findUnique({
          where: { organizationId_phoneE164: { organizationId: orgId, phoneE164: body.phone } },
          select: { id: true },
        });
        if (winner) throw new ConflictException({ code: "CONFLICT", message: winner.id });
      }
      throw e;
    }
  }

  async patch(actor: AccessClaims, id: string, body: CustomerPatch, ip: string | null): Promise<StaffCustomerView> {
    const orgId = await this.tenancy.getOrgId();
    return this.prisma.$transaction(async (tx) => {
      const before = await tx.customer.findFirst({ where: { id, organizationId: orgId, deletedAt: null } });
      if (!before) throw new NotFoundException("Customer not found");
      const notesChanged = body.privateNotes !== undefined;
      const row = await tx.customer.update({
        where: { id },
        data: {
          ...(body.name !== undefined ? { name: body.name } : {}),
          ...(body.email !== undefined ? { email: body.email } : {}),
          ...(body.locale !== undefined ? { locale: body.locale } : {}),
          ...(body.emergencyPhone !== undefined ? { emergencyPhoneE164: body.emergencyPhone } : {}),
          ...(notesChanged ? { privateNotesEnc: body.privateNotes ? this.encryptor.encrypt(body.privateNotes) : null } : {}),
        },
      });
      await this.audit.record(
        {
          orgId, actorType: "STAFF", actorId: actor.sub, action: "customer.update", entity: "customer", entityId: id,
          before: auditShape(before), after: { ...auditShape(row), privateNotesChanged: notesChanged }, ip,
        },
        tx,
      );
      return this.staffView(actor, row);
    });
  }

  async getMe(actor: AccessClaims): Promise<CustomerView> {
    const organizationId = await this.tenancy.getOrgId();
    const row = await this.prisma.customer.findFirst({ where: { id: actor.sub, organizationId, deletedAt: null } });
    if (!row) throw new NotFoundException("Customer not found");
    return toView(row);
  }

  async patchMe(actor: AccessClaims, body: MePatch, ip: string | null): Promise<CustomerView> {
    const orgId = await this.tenancy.getOrgId();
    return this.prisma.$transaction(async (tx) => {
      const before = await tx.customer.findFirst({ where: { id: actor.sub, organizationId: orgId, deletedAt: null } });
      if (!before) throw new NotFoundException("Customer not found");
      const row = await tx.customer.update({
        where: { id: actor.sub },
        data: {
          ...(body.name !== undefined ? { name: body.name } : {}),
          ...(body.email !== undefined ? { email: body.email } : {}),
          ...(body.locale !== undefined ? { locale: body.locale } : {}),
          ...(body.emergencyPhone !== undefined ? { emergencyPhoneE164: body.emergencyPhone } : {}),
        },
      });
      await this.audit.record(
        { orgId, actorType: "CUSTOMER", actorId: actor.sub, action: "customer.update", entity: "customer", entityId: actor.sub, before: auditShape(before), after: auditShape(row), ip },
        tx,
      );
      return toView(row);
    });
  }
}
