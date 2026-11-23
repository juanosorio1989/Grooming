import { type Prisma, PrismaClient, type SegmentStage, type StaffRole } from "@prisma/client";
import { Encryptor } from "../../src/auth/crypto/encryption.js";
import { hashPassword } from "../../src/auth/crypto/password.js";
import { FIXTURE_SETTINGS } from "../support/fixture-settings.js";
import { testEnv } from "../support/test-env.js";
import { testDatabaseUrl } from "./setup.js";

export function createTestClient(): PrismaClient {
  return new PrismaClient({ datasourceUrl: testDatabaseUrl() });
}

/** Empties every application table (keeps `_prisma_migrations`). */
export async function truncateAll(prisma: PrismaClient): Promise<void> {
  const rows = await prisma.$queryRaw<{ tablename: string }[]>`
    SELECT tablename FROM pg_tables
    WHERE schemaname = 'public' AND tablename <> '_prisma_migrations'`;
  if (rows.length === 0) return;
  const list = rows.map((r) => `"public"."${r.tablename}"`).join(", ");
  await prisma.$executeRawUnsafe(`TRUNCATE TABLE ${list} RESTART IDENTITY CASCADE`);
}

/**
 * Extracts the PostgreSQL SQLSTATE from a Prisma error. P2002 (unique
 * constraint) is reported as 23505. Prisma 6 does not map
 * exclusion (23P01) or check (23514) violations to a P-code: it throws
 * PrismaClientUnknownRequestError with no `meta`/`cause`, and the SQLSTATE
 * appears only in the message as `code: "23P01"`. `meta.code` / `cause.code`
 * are checked first in case a future Prisma version exposes them. With
 * `constraint`, a P2002 only counts when `meta.target` contains that name.
 */
export function pgCode(err: unknown, constraint?: string): string | undefined {
  if (typeof err !== "object" || err === null) return undefined;
  const e = err as { code?: unknown; meta?: Record<string, unknown>; cause?: { code?: unknown }; message?: string };
  // Prisma maps unique violations (23505) to P2002 and drops the SQLSTATE.
  if (e.code === "P2002") {
    if (constraint === undefined) return "23505";
    const target = e.meta?.target;
    const names = Array.isArray(target) ? target.map(String) : typeof target === "string" ? [target] : [];
    return names.includes(constraint) ? "23505" : undefined;
  }
  const metaCode = e.meta?.code;
  if (typeof metaCode === "string" && /^[0-9A-Z]{5}$/.test(metaCode)) return metaCode;
  const causeCode = e.cause?.code;
  if (typeof causeCode === "string" && /^[0-9A-Z]{5}$/.test(causeCode)) return causeCode;
  return /code: "([0-9A-Z]{5})"/.exec(e.message ?? "")?.[1];
}

export async function rejectionCode(promise: Promise<unknown>, constraint?: string): Promise<string | undefined> {
  try {
    await promise;
  } catch (err) {
    return pgCode(err, constraint) ?? `unrecognized: ${(err as Error).message}`;
  }
  return undefined;
}

export { FIXTURE_SETTINGS };

export interface Fixture {
  orgId: string;
  locationId: string;
  staffA: string;
  staffB: string;
  /** BATH service on the tub resource type. */
  serviceId: string;
  /** Tub resource type (`STATION`). */
  resourceTypeId: string;
  resource1: string;
  resource2: string;
  /** Kennel resource type (`KENNEL`). */
  kennelTypeId: string;
  kennel1: string;
  kennel2: string;
  customerId: string;
  petId: string;
}

export interface FixtureOpts {
  /** Organization slug; defaults to `test-salon` (the test `DEFAULT_ORG_SLUG`). */
  slug?: string;
}

export async function seedFixture(prisma: PrismaClient, opts: FixtureOpts = {}): Promise<Fixture> {
  const org = await prisma.organization.create({
    data: { name: "Test Grooming", slug: opts.slug ?? "test-salon", defaultLocale: "en" },
  });
  const location = await prisma.location.create({
    data: { organizationId: org.id, name: "Main", timezone: "America/New_York", settings: FIXTURE_SETTINGS },
  });
  const staffA = await prisma.staffUser.create({
    data: { organizationId: org.id, email: "a@test.dev", role: "EMPLOYEE", locale: "en" },
  });
  const staffB = await prisma.staffUser.create({
    data: { organizationId: org.id, email: "b@test.dev", role: "EMPLOYEE", locale: "en" },
  });
  const resourceType = await prisma.resourceType.create({
    data: { organizationId: org.id, name: { en: "Tub", es: "Tina" }, kind: "STATION" },
  });
  const resource1 = await prisma.resource.create({
    data: { organizationId: org.id, locationId: location.id, resourceTypeId: resourceType.id, name: "Tub 1" },
  });
  const resource2 = await prisma.resource.create({
    data: { organizationId: org.id, locationId: location.id, resourceTypeId: resourceType.id, name: "Tub 2" },
  });
  const kennelType = await prisma.resourceType.create({
    data: { organizationId: org.id, name: { en: "Kennel", es: "Jaula" }, kind: "KENNEL" },
  });
  const kennel1 = await prisma.resource.create({
    data: { organizationId: org.id, locationId: location.id, resourceTypeId: kennelType.id, name: "Kennel 1" },
  });
  const kennel2 = await prisma.resource.create({
    data: { organizationId: org.id, locationId: location.id, resourceTypeId: kennelType.id, name: "Kennel 2" },
  });
  const service = await prisma.service.create({
    data: {
      organizationId: org.id,
      name: { en: "Bath", es: "Baño" },
      species: "DOG",
      stage: "BATH",
      isMain: true,
      requiredSkill: "BATHER",
      bufferAfterMin: 0,
      resourceTypeId: resourceType.id,
    },
  });
  const customer = await prisma.customer.create({
    data: { organizationId: org.id, phoneE164: "+13055550100", name: "Ana", locale: "es", createdVia: "ONLINE" },
  });
  const pet = await prisma.pet.create({
    data: {
      organizationId: org.id,
      customerId: customer.id,
      name: "Max",
      species: "DOG",
      breed: "Poodle",
      weightG: 19_000,
      sizeClass: "M",
      coatType: "CURLY",
    },
  });
  return {
    orgId: org.id,
    locationId: location.id,
    staffA: staffA.id,
    staffB: staffB.id,
    serviceId: service.id,
    resourceTypeId: resourceType.id,
    resource1: resource1.id,
    resource2: resource2.id,
    kennelTypeId: kennelType.id,
    kennel1: kennel1.id,
    kennel2: kennel2.id,
    customerId: customer.id,
    petId: pet.id,
  };
}

export interface SegmentInput {
  /** Null for kennel segments (no person). */
  staffUserId: string | null;
  startsAt: string; // "HH:MM" on 2026-12-01 UTC
  endsAt: string;
  blockEndsAt?: string;
  resourceId?: string | null;
  occupies?: boolean;
  /** Defaults to `BATH`. */
  stage?: SegmentStage;
  /** Defaults to the fixture's BATH service; pass null for kennel segments. */
  serviceId?: string | null;
}

export const at = (hhmm: string) => new Date(`2026-12-01T${hhmm}:00.000Z`);

/**
 * Creates a BOOKED appointment with one pet visit (the fixture's pet) and one
 * segment, in one transaction, and returns the segment.
 */
export function bookSegment(prisma: PrismaClient, f: Fixture, s: SegmentInput) {
  const startsAt = at(s.startsAt);
  const endsAt = at(s.endsAt);
  return prisma.$transaction(async (tx) => {
    const visit = await createPetVisit(tx, f);
    return tx.appointmentSegment.create({
      data: {
        organizationId: f.orgId,
        appointmentId: visit.appointmentId,
        petVisitId: visit.id,
        stage: s.stage ?? "BATH",
        serviceId: s.serviceId === undefined ? f.serviceId : s.serviceId,
        staffUserId: s.staffUserId,
        resourceId: s.resourceId ?? null,
        startsAt,
        endsAt,
        blockEndsAt: s.blockEndsAt ? at(s.blockEndsAt) : endsAt,
        durationMin: Math.round((endsAt.getTime() - startsAt.getTime()) / 60_000),
        priceCents: (s.stage ?? "BATH") === "KENNEL" ? 0 : 4000,
        occupies: s.occupies ?? true,
      },
    });
  });
}

/** Creates a BOOKED appointment with one pet visit for the fixture's pet; returns the visit. */
export async function createPetVisit(
  prisma: PrismaClient | Prisma.TransactionClient,
  f: Fixture,
): Promise<{ id: string; appointmentId: string }> {
  const appointment = await prisma.appointment.create({
    data: {
      organizationId: f.orgId,
      locationId: f.locationId,
      customerId: f.customerId,
      status: "BOOKED",
      source: "ONLINE",
      bookingMode: "DROP_OFF",
    },
  });
  return prisma.petVisit.create({
    data: {
      organizationId: f.orgId,
      appointmentId: appointment.id,
      petId: f.petId,
      position: 0,
      status: "BOOKED",
      sizeClassAtBooking: "M",
      coatTypeAtBooking: "SMOOTH",
      priceCentsQuoted: 4000,
    },
    select: { id: true, appointmentId: true },
  });
}

export interface CreateStaffOpts {
  email: string;
  role: StaffRole;
  password?: string;
  totpSecret?: string;
  active?: boolean;
  canLogin?: boolean;
}

/**
 * Creates a staff user (email lowercased). `password` is hashed with argon2id;
 * `totpSecret` is encrypted with the test `Encryptor` (same key as the app's
 * `testEnv()`) and marks the user as enrolled. `canLogin` defaults to true.
 */
export async function createStaff(prisma: PrismaClient, f: Fixture, opts: CreateStaffOpts): Promise<{ id: string }> {
  const env = testEnv();
  const encryptor = new Encryptor({ keyId: env.DATA_ENCRYPTION_KEY_ID, keyB64: env.DATA_ENCRYPTION_KEY });
  return prisma.staffUser.create({
    data: {
      organizationId: f.orgId,
      email: opts.email.toLowerCase(),
      role: opts.role,
      locale: "en",
      active: opts.active ?? true,
      canLogin: opts.canLogin ?? true,
      passwordHash: opts.password ? await hashPassword(opts.password) : null,
      totpSecretEnc: opts.totpSecret ? encryptor.encrypt(opts.totpSecret) : null,
      totpEnrolledAt: opts.totpSecret ? new Date() : null,
    },
    select: { id: true },
  });
}
