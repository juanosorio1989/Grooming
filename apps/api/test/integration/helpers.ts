import { PrismaClient, type StaffRole } from "@prisma/client";
import { Encryptor } from "../../src/auth/crypto/encryption.js";
import { hashPassword } from "../../src/auth/crypto/password.js";
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
 * Extracts the PostgreSQL SQLSTATE from a Prisma error. Prisma 6 does not map
 * exclusion (23P01) or check (23514) violations to a P-code: it throws
 * PrismaClientUnknownRequestError with no `meta`/`cause`, and the SQLSTATE
 * appears only in the message as `code: "23P01"`. `meta.code` / `cause.code`
 * are checked first in case a future Prisma version exposes them.
 */
export function pgCode(err: unknown): string | undefined {
  if (typeof err !== "object" || err === null) return undefined;
  const e = err as { meta?: Record<string, unknown>; cause?: { code?: unknown }; message?: string };
  const metaCode = e.meta?.code;
  if (typeof metaCode === "string" && /^[0-9A-Z]{5}$/.test(metaCode)) return metaCode;
  const causeCode = e.cause?.code;
  if (typeof causeCode === "string" && /^[0-9A-Z]{5}$/.test(causeCode)) return causeCode;
  return /code: "([0-9A-Z]{5})"/.exec(e.message ?? "")?.[1];
}

export async function rejectionCode(promise: Promise<unknown>): Promise<string | undefined> {
  try {
    await promise;
  } catch (err) {
    return pgCode(err) ?? `unrecognized: ${(err as Error).message}`;
  }
  return undefined;
}

export interface Fixture {
  orgId: string;
  locationId: string;
  staffA: string;
  staffB: string;
  serviceId: string;
  resourceTypeId: string;
  resource1: string;
  resource2: string;
  customerId: string;
}

export async function seedFixture(prisma: PrismaClient): Promise<Fixture> {
  const org = await prisma.organization.create({
    data: { name: "Test Salon", slug: "test-salon", defaultLocale: "en" },
  });
  const location = await prisma.location.create({
    data: { organizationId: org.id, name: "Main", timezone: "America/New_York", settings: {} },
  });
  const staffA = await prisma.staffUser.create({
    data: { organizationId: org.id, email: "a@test.dev", role: "EMPLOYEE", locale: "en" },
  });
  const staffB = await prisma.staffUser.create({
    data: { organizationId: org.id, email: "b@test.dev", role: "EMPLOYEE", locale: "en" },
  });
  const resourceType = await prisma.resourceType.create({
    data: { organizationId: org.id, name: { en: "Pedicure chair", es: "Silla de pedicura" } },
  });
  const resource1 = await prisma.resource.create({
    data: { organizationId: org.id, locationId: location.id, resourceTypeId: resourceType.id, name: "Chair 1" },
  });
  const resource2 = await prisma.resource.create({
    data: { organizationId: org.id, locationId: location.id, resourceTypeId: resourceType.id, name: "Chair 2" },
  });
  const service = await prisma.service.create({
    data: {
      organizationId: org.id,
      name: { en: "Pedicure", es: "Pedicura" },
      durationMin: 60,
      bufferAfterMin: 0,
      priceCents: 4000,
      resourceTypeId: resourceType.id,
    },
  });
  const customer = await prisma.customer.create({
    data: { organizationId: org.id, phoneE164: "+13055550100", name: "Ana", locale: "es", createdVia: "ONLINE" },
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
    customerId: customer.id,
  };
}

export interface SegmentInput {
  staffUserId: string;
  startsAt: string; // "HH:MM" on 2026-12-01 UTC
  endsAt: string;
  blockEndsAt?: string;
  resourceId?: string | null;
  occupies?: boolean;
}

const at = (hhmm: string) => new Date(`2026-12-01T${hhmm}:00.000Z`);

/** Creates a BOOKED appointment with one segment. */
export function bookSegment(prisma: PrismaClient, f: Fixture, s: SegmentInput) {
  const startsAt = at(s.startsAt);
  const endsAt = at(s.endsAt);
  return prisma.appointment.create({
    data: {
      organizationId: f.orgId,
      locationId: f.locationId,
      customerId: f.customerId,
      status: "BOOKED",
      source: "ONLINE",
      segments: {
        create: {
          organizationId: f.orgId,
          serviceId: f.serviceId,
          staffUserId: s.staffUserId,
          resourceId: s.resourceId ?? null,
          startsAt,
          endsAt,
          blockEndsAt: s.blockEndsAt ? at(s.blockEndsAt) : endsAt,
          durationMin: Math.round((endsAt.getTime() - startsAt.getTime()) / 60_000),
          priceCents: 4000,
          occupies: s.occupies ?? true,
        },
      },
    },
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
