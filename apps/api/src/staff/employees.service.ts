import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import type {
  AccessClaims,
  EmployeeCreate,
  EmployeePatch,
  EmployeeQuery,
  EmployeeServicesBody,
  EmployeeView,
  Locale,
  LocalizedText,
  Skill,
  WorkingHoursBody,
} from "@grooming/contracts";
import { AuditService } from "../audit/audit.service.js";
import { RefreshTokenService } from "../auth/refresh-token.service.js";
import { dbTimeToWall, wallToDbTime } from "../common/wall-time.js";
import { LocationService } from "../location/location.service.js";
import { PrismaService } from "../prisma/prisma.service.js";
import { TenancyService } from "../tenancy/tenancy.service.js";

const include = { employeeProfile: true, employeeServices: { select: { serviceId: true } } } satisfies Prisma.StaffUserInclude;
type StaffRow = Prisma.StaffUserGetPayload<{ include: typeof include }>;

function toView(s: StaffRow): EmployeeView {
  return {
    id: s.id,
    displayName: s.employeeProfile?.displayName ?? s.email ?? "Staff",
    role: s.role,
    email: s.email,
    locale: s.locale as Locale,
    active: s.active,
    canLogin: s.canLogin,
    skills: s.employeeProfile?.skills ?? [],
    bookableOnline: s.employeeProfile?.bookableOnline ?? true,
    bio: (s.employeeProfile?.bio as LocalizedText | null | undefined) ?? null,
    serviceIds: s.employeeServices.map((e) => e.serviceId).sort(),
  };
}

const emailTaken = () => new ConflictException({ code: "CONFLICT", message: "A staff member with this email already exists" });
const bad = (message: string) => new BadRequestException({ code: "VALIDATION_FAILED", message });

@Injectable()
export class EmployeesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly tenancy: TenancyService,
    private readonly location: LocationService,
    private readonly audit: AuditService,
    private readonly refreshTokens: RefreshTokenService,
  ) {}

  async list(actor: AccessClaims, q: EmployeeQuery): Promise<EmployeeView[]> {
    const organizationId = await this.tenancy.getOrgId();
    const isEmployee = actor.role === "EMPLOYEE";
    const rows = await this.prisma.staffUser.findMany({
      where: { organizationId, ...(isEmployee || q.includeInactive !== "true" ? { active: true } : {}) },
      include,
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    });
    return rows.map((r) => this.forCaller(actor, toView(r)));
  }

  async get(actor: AccessClaims, id: string): Promise<EmployeeView> {
    const orgId = await this.tenancy.getOrgId();
    const row = await this.find(this.prisma, orgId, id);
    if (actor.role === "EMPLOYEE" && !row.active && row.id !== actor.sub) throw new NotFoundException("Staff member not found");
    return this.forCaller(actor, toView(row));
  }

  async create(actor: AccessClaims, body: EmployeeCreate, ip: string | null): Promise<EmployeeView> {
    const orgId = await this.tenancy.getOrgId();
    const { id: locationId } = await this.location.getDefault();
    try {
      return await this.prisma.$transaction(async (tx) => {
        const user = await tx.staffUser.create({
          data: { organizationId: orgId, email: body.email ?? null, canLogin: false, role: body.role, locale: body.locale },
        });
        await tx.employeeProfile.create({
          data: {
            staffUserId: user.id,
            displayName: body.displayName,
            skills: body.skills,
            bookableOnline: body.bookableOnline,
            bio: body.bio ?? Prisma.DbNull,
          },
        });
        await tx.staffLocation.create({ data: { staffUserId: user.id, locationId } });
        const view = toView(await this.find(tx, orgId, user.id));
        await this.audit.record(
          { orgId, actorType: "STAFF", actorId: actor.sub, action: "employee.create", entity: "staff_user", entityId: user.id, after: view, ip },
          tx,
        );
        return view;
      });
    } catch (err) {
      if (isUniqueViolation(err)) throw emailTaken();
      throw err;
    }
  }

  async patch(actor: AccessClaims, id: string, body: EmployeePatch, ip: string | null): Promise<EmployeeView> {
    const orgId = await this.tenancy.getOrgId();
    try {
      return await this.prisma.$transaction(async (tx) => {
        const beforeRow = await this.find(tx, orgId, id);
        const before = toView(beforeRow);
        const role = body.role ?? beforeRow.role;
        const active = body.active ?? beforeRow.active;
        const losesOwner = beforeRow.role === "OWNER" && beforeRow.active && (role !== "OWNER" || !active);
        if (losesOwner) {
          // Lock the active owners so two concurrent demotions cannot both pass the check.
          const owners = await tx.$queryRaw<{ id: string }[]>`
            SELECT id FROM staff_user WHERE organization_id = ${orgId}::uuid AND role = 'OWNER' AND active = true FOR UPDATE`;
          if (!owners.some((o) => o.id !== id)) {
            throw new ConflictException({ code: "CONFLICT", message: "Cannot demote or deactivate the last active OWNER" });
          }
        }
        const skills: Skill[] = body.skills ?? before.skills;
        if (body.skills) await this.assertServicesMatchSkills(tx, id, skills);

        await tx.staffUser.update({
          where: { id },
          data: {
            ...(body.role !== undefined ? { role: body.role } : {}),
            ...(body.active !== undefined ? { active: body.active } : {}),
            ...(body.email !== undefined ? { email: body.email } : {}),
            ...(body.locale !== undefined ? { locale: body.locale } : {}),
          },
        });
        const profile = {
          displayName: body.displayName ?? before.displayName,
          skills,
          bookableOnline: body.bookableOnline ?? before.bookableOnline,
          bio: (body.bio !== undefined ? body.bio : before.bio) ?? Prisma.DbNull,
        };
        await tx.employeeProfile.upsert({ where: { staffUserId: id }, create: { staffUserId: id, ...profile }, update: profile });
        if (role !== beforeRow.role || !active) await this.refreshTokens.revokeAllFor({ type: "STAFF", id }, tx);

        const view = toView(await this.find(tx, orgId, id));
        await this.audit.record(
          { orgId, actorType: "STAFF", actorId: actor.sub, action: "employee.update", entity: "staff_user", entityId: id, before, after: view, ip },
          tx,
        );
        return view;
      });
    } catch (err) {
      if (isUniqueViolation(err)) throw emailTaken();
      throw err;
    }
  }

  async replaceServices(actor: AccessClaims, id: string, body: EmployeeServicesBody, ip: string | null): Promise<EmployeeView> {
    const orgId = await this.tenancy.getOrgId();
    const serviceIds = [...new Set(body.serviceIds)];
    return this.prisma.$transaction(async (tx) => {
      const beforeRow = await this.find(tx, orgId, id);
      const services = await tx.service.findMany({
        where: { id: { in: serviceIds }, organizationId: orgId, active: true },
        select: { id: true, requiredSkill: true },
      });
      if (services.length !== serviceIds.length) throw bad("Every service must be an active service of this organization");
      const skills = beforeRow.employeeProfile?.skills ?? [];
      if (services.some((s) => !skills.includes(s.requiredSkill))) throw bad("A service requires a skill this person does not have");
      await tx.employeeService.deleteMany({ where: { staffUserId: id } });
      await tx.employeeService.createMany({ data: serviceIds.map((serviceId) => ({ staffUserId: id, serviceId })) });
      const view = toView(await this.find(tx, orgId, id));
      await this.audit.record(
        { orgId, actorType: "STAFF", actorId: actor.sub, action: "employee_services.replace", entity: "staff_user", entityId: id, before: { serviceIds: toView(beforeRow).serviceIds }, after: { serviceIds: view.serviceIds }, ip },
        tx,
      );
      return view;
    });
  }

  async getHours(actor: AccessClaims, id: string): Promise<WorkingHoursBody> {
    if (actor.role === "EMPLOYEE" && actor.sub !== id) throw new ForbiddenException();
    const orgId = await this.tenancy.getOrgId();
    const { id: locationId } = await this.location.getDefault();
    await this.find(this.prisma, orgId, id);
    return this.readHours(this.prisma, id, locationId);
  }

  async replaceHours(actor: AccessClaims, id: string, body: WorkingHoursBody, ip: string | null): Promise<WorkingHoursBody> {
    assertNoOverlap(body);
    const orgId = await this.tenancy.getOrgId();
    const { id: locationId } = await this.location.getDefault();
    return this.prisma.$transaction(async (tx) => {
      await this.find(tx, orgId, id);
      const before = await this.readHours(tx, id, locationId);
      await tx.workingHours.deleteMany({ where: { staffUserId: id, locationId } });
      await tx.workingHours.createMany({
        data: body.map((r) => ({
          organizationId: orgId,
          staffUserId: id,
          locationId,
          weekday: r.weekday,
          startTime: wallToDbTime(r.start),
          endTime: wallToDbTime(r.end),
        })),
      });
      const after = await this.readHours(tx, id, locationId);
      await this.audit.record(
        { orgId, actorType: "STAFF", actorId: actor.sub, action: "working_hours.replace", entity: "staff_user", entityId: id, before: { rows: before }, after: { rows: after }, ip },
        tx,
      );
      return after;
    });
  }

  private async readHours(db: Prisma.TransactionClient | PrismaService, staffUserId: string, locationId: string): Promise<WorkingHoursBody> {
    const rows = await db.workingHours.findMany({ where: { staffUserId, locationId } });
    return rows
      .map((r) => ({ weekday: r.weekday, start: dbTimeToWall(r.startTime, false), end: dbTimeToWall(r.endTime, true) }))
      .sort((a, b) => a.weekday - b.weekday || a.start.localeCompare(b.start));
  }

  private async assertServicesMatchSkills(tx: Prisma.TransactionClient, staffUserId: string, skills: Skill[]): Promise<void> {
    const assigned = await tx.employeeService.findMany({ where: { staffUserId }, select: { service: { select: { requiredSkill: true } } } });
    if (assigned.some((a) => !skills.includes(a.service.requiredSkill))) {
      throw bad("An assigned service requires a skill that is being removed; update the person's services first");
    }
  }

  private async find(db: Prisma.TransactionClient | PrismaService, orgId: string, id: string): Promise<StaffRow> {
    const row = await db.staffUser.findFirst({ where: { id, organizationId: orgId }, include });
    if (!row) throw new NotFoundException("Staff member not found");
    return row;
  }

  private forCaller(actor: AccessClaims, view: EmployeeView): EmployeeView {
    if (actor.role !== "EMPLOYEE") return view;
    const copy = { ...view };
    delete copy.email;
    return copy;
  }
}

function isUniqueViolation(err: unknown): boolean {
  return err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002";
}

/** Same-weekday ranges must not overlap (touching ranges are fine). */
function assertNoOverlap(rows: WorkingHoursBody): void {
  const sorted = [...rows].sort((a, b) => a.weekday - b.weekday || a.start.localeCompare(b.start));
  for (let i = 1; i < sorted.length; i++) {
    const prev = sorted[i - 1]!;
    const cur = sorted[i]!;
    if (prev.weekday === cur.weekday && cur.start < prev.end) throw bad("Working hours overlap on the same weekday");
  }
}
