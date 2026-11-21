/**
 * Idempotent development seed: one organization, one location (America/New_York)
 * with hours and the grooming settings defaults, the station and kennel
 * resources, the service catalog and price matrix, staff, customers with pets
 * and vaccines, and three completed past visits with reports. Safe to run
 * repeatedly (finds by natural keys, creates what is missing). Each run resets
 * `location.settings`, the price matrix and working hours to the values here.
 * Staff get no passwords; medical notes are not seeded (no encryption key).
 * Run: pnpm --filter @grooming/api db:seed (uses DATABASE_URL).
 */
import { type Prisma, PrismaClient, type ResourceKind, type SizeClass } from "@prisma/client";
import { LocationSettingsSchema, PriceMatrixSchema, type PriceMatrix } from "@grooming/contracts";
import { sizeClassFromWeight } from "@grooming/pricing";
import { checkStageRule } from "../src/catalog/stage-rule.js";
import { CUSTOMERS, VISITS } from "./seed-data/customers.js";
import { CATEGORIES, SERVICES, SIZES } from "./seed-data/services.js";
import { STAFF, WORK_WEEKDAYS } from "./seed-data/staff.js";

/** Weekdays: 0 = Sunday ... 6 = Saturday (same as location_hours). Monday to Saturday. */
const OPEN_WEEKDAYS = [1, 2, 3, 4, 5, 6];

/** Defaults from data-model.md ("location.settings"); validated in the API (Plan 03). */
const LOCATION_SETTINGS = {
  slotIntervalMin: 15,
  holdMinutes: 5,
  cancelWindowHours: 24,
  bookingHorizonDays: 60,
  minLeadMinutes: 60,
  defaultBookingMode: "DROP_OFF",
  /** Per weekday (keys as above), local wall times. */
  dropOffWindows: Object.fromEntries(OPEN_WEEKDAYS.map((d) => [String(d), [{ from: "08:00", to: "11:00" }]])),
  maxQueueWaitMin: 90,
  pickupGraceMin: 60,
  sizeThresholdsLb: { S: 20, M: 50, L: 90 },
  requireAfterPhoto: true,
  vaccinePolicy: "WARN",
  requiredVaccines: { DOG: ["RABIES"] },
  etaNotifyThresholdMin: 30,
} satisfies Prisma.InputJsonObject;

/** Resource types and how many resources of each the location has. */
const RESOURCES: { en: string; es: string; kind: ResourceKind; count: number }[] = [
  { en: "Tub", es: "Tina", kind: "STATION", count: 3 },
  { en: "Table", es: "Mesa", kind: "STATION", count: 3 },
  { en: "Dryer", es: "Secador", kind: "STATION", count: 2 },
  { en: "Kennel", es: "Jaula", kind: "KENNEL", count: 10 },
];

export interface SeedSummary {
  services: number;
  priceRows: number;
  staff: number;
  customers: number;
  pets: number;
  visits: number;
  reports: number;
}

const GRAMS_PER_LB = 453.59237;
const DAY_MS = 86_400_000;
const time = (hhmm: string) => new Date(`1970-01-01T${hhmm}:00.000Z`);


type Tx = Prisma.TransactionClient;

/** Price rows for one service: every size with a NULL coat; main DOG services add DOUBLE and CURLY (+15 %, +15 min). */
function priceMatrix(s: (typeof SERVICES)[number]): PriceMatrix {
  const rows: PriceMatrix = [];
  SIZES.forEach((sizeClass, i) => {
    const dollars = s.dollars[i]!;
    const durationMin = s.minutes[i]!;
    rows.push({ sizeClass, coatType: null, durationMin, priceCents: dollars * 100 });
    if (s.coatSurcharge) {
      for (const coatType of ["DOUBLE", "CURLY"] as const) {
        rows.push({ sizeClass, coatType, durationMin: durationMin + 15, priceCents: Math.round(dollars * 1.15) * 100 });
      }
    }
  });
  return PriceMatrixSchema.parse(rows);
}

async function seedInfrastructure(db: PrismaClient, orgId: string): Promise<{ locationId: string }> {
  const settings = LocationSettingsSchema.parse(LOCATION_SETTINGS);
  return db.$transaction(async (tx) => {
    const existing = await tx.location.findFirst({ where: { organizationId: orgId, name: "Main" } });
    const data = { timezone: "America/New_York", settings };
    const location = existing
      ? await tx.location.update({ where: { id: existing.id }, data })
      : await tx.location.create({ data: { organizationId: orgId, name: "Main", ...data } });

    await tx.locationHours.deleteMany({ where: { locationId: location.id } });
    await tx.locationHours.createMany({
      data: OPEN_WEEKDAYS.map((weekday) => ({
        locationId: location.id,
        weekday,
        opens: time("08:00"),
        closes: time("18:00"),
      })),
    });

    for (const r of RESOURCES) {
      const name = { en: r.en, es: r.es };
      const found = await tx.resourceType.findFirst({
        where: { organizationId: orgId, name: { path: ["en"], equals: r.en } },
      });
      const type = found
        ? await tx.resourceType.update({ where: { id: found.id }, data: { name, kind: r.kind } })
        : await tx.resourceType.create({ data: { organizationId: orgId, name, kind: r.kind } });

      for (let i = 1; i <= r.count; i += 1) {
        const resourceName = `${r.en} ${i}`;
        const have = await tx.resource.findFirst({ where: { locationId: location.id, name: resourceName } });
        if (!have) {
          await tx.resource.create({
            data: { organizationId: orgId, locationId: location.id, resourceTypeId: type.id, name: resourceName },
          });
        }
      }
    }
    return { locationId: location.id };
  });
}

async function seedCatalog(tx: Tx, orgId: string): Promise<Map<string, string>> {
  const categoryIds = new Map<string, string>();
  for (const c of CATEGORIES) {
    const name = { en: c.en, es: c.es };
    const found = await tx.serviceCategory.findFirst({ where: { organizationId: orgId, name: { path: ["en"], equals: c.en } } });
    const row = found
      ? await tx.serviceCategory.update({ where: { id: found.id }, data: { name, sort: c.sort } })
      : await tx.serviceCategory.create({ data: { organizationId: orgId, name, sort: c.sort } });
    categoryIds.set(c.en, row.id);
  }

  const types = await tx.resourceType.findMany({ where: { organizationId: orgId } });
  const typeId = (en: string) => {
    const t = types.find((x) => (x.name as { en?: string }).en === en);
    if (!t) throw new Error(`Resource type ${en} missing`);
    return t.id;
  };

  const serviceIds = new Map<string, string>(); // "<name en>|<species>" -> id
  const checked: { id: string; stage: string; species: "DOG" | "CAT" | "ANY"; resourceTypeId: string | null }[] = [];
  for (const s of SERVICES) {
    const name = { en: s.en, es: s.es };
    const resourceTypeId = s.resource ? typeId(s.resource) : null;
    const data = {
      categoryId: categoryIds.get(s.category)!,
      name,
      species: s.species,
      stage: s.stage,
      isMain: s.isMain,
      resourceTypeId,
      requiredSkill: s.skill,
      bufferAfterMin: s.bufferAfterMin,
      onlineBookable: true,
      active: true,
    };
    const found = await tx.service.findFirst({
      where: { organizationId: orgId, species: s.species, name: { path: ["en"], equals: s.en } },
    });
    const row = found
      ? await tx.service.update({ where: { id: found.id }, data })
      : await tx.service.create({ data: { organizationId: orgId, ...data } });
    serviceIds.set(`${s.en}|${s.species}`, row.id);

    const candidate = { id: row.id, stage: s.stage, species: s.species, resourceTypeId };
    const conflict = checkStageRule(candidate, checked);
    if (conflict) throw new Error(`Seed service ${s.en} breaks the stage rule (conflicts with ${conflict})`);
    checked.push(candidate);

    await tx.servicePrice.deleteMany({ where: { serviceId: row.id } });
    await tx.servicePrice.createMany({
      data: priceMatrix(s).map((p) => ({ organizationId: orgId, serviceId: row.id, ...p })),
    });
  }
  return serviceIds;
}

async function seedStaff(tx: Tx, orgId: string, locationId: string, serviceIds: Map<string, string>): Promise<Map<string, string>> {
  const staffIds = new Map<string, string>();
  for (const s of STAFF) {
    const found = await tx.staffUser.findFirst({ where: { organizationId: orgId, email: s.email } });
    const data = { role: s.role, locale: s.locale, active: true };
    const row = found
      ? await tx.staffUser.update({ where: { id: found.id }, data })
      : await tx.staffUser.create({ data: { organizationId: orgId, email: s.email, canLogin: false, ...data } });
    staffIds.set(s.email, row.id);

    await tx.staffLocation.upsert({
      where: { staffUserId_locationId: { staffUserId: row.id, locationId } },
      update: {},
      create: { staffUserId: row.id, locationId },
    });

    if (!s.profile) continue;
    const { displayName, skills, bio } = s.profile;
    await tx.employeeProfile.upsert({
      where: { staffUserId: row.id },
      update: { displayName, skills, bio, bookableOnline: true },
      create: { staffUserId: row.id, displayName, skills, bio, bookableOnline: true },
    });

    // One employee_service per skill-matching service.
    const skilled = SERVICES.filter((svc) => skills.includes(svc.skill));
    await tx.employeeService.deleteMany({ where: { staffUserId: row.id } });
    await tx.employeeService.createMany({
      data: skilled.map((svc) => ({ staffUserId: row.id, serviceId: serviceIds.get(`${svc.en}|${svc.species}`)! })),
    });

    // Mon-Sat 08:00-17:00, bathers with a 12:00-12:30 break.
    const ranges = s.breakHours
      ? [["08:00", "12:00"], ["12:30", "17:00"]]
      : [["08:00", "17:00"]];
    await tx.workingHours.deleteMany({ where: { staffUserId: row.id, locationId } });
    await tx.workingHours.createMany({
      data: WORK_WEEKDAYS.flatMap((weekday) =>
        ranges.map(([from, to]) => ({
          organizationId: orgId,
          staffUserId: row.id,
          locationId,
          weekday,
          startTime: time(from!),
          endTime: time(to!),
        })),
      ),
    });
  }
  return staffIds;
}

async function seedCustomers(tx: Tx, orgId: string): Promise<Map<string, { id: string; customerId: string; sizeClass: SizeClass; weightG: number; coatType: string; species: "DOG" | "CAT" }>> {
  const now = Date.now();
  const pets = new Map<string, { id: string; customerId: string; sizeClass: SizeClass; weightG: number; coatType: string; species: "DOG" | "CAT" }>();
  for (const c of CUSTOMERS) {
    const found = await tx.customer.findFirst({ where: { organizationId: orgId, phoneE164: c.phoneE164 } });
    const data = { name: c.name, email: c.email, locale: c.locale };
    const customer = found
      ? await tx.customer.update({ where: { id: found.id }, data })
      : await tx.customer.create({ data: { organizationId: orgId, phoneE164: c.phoneE164, createdVia: "RECEPTION", ...data } });

    for (const p of c.pets) {
      const weightG = Math.round(p.weightLb * GRAMS_PER_LB);
      const sizeClass = sizeClassFromWeight(weightG);
      const data = {
        species: p.species,
        breed: p.breed,
        sex: p.sex,
        weightG,
        weightMeasuredAt: new Date(now),
        sizeClass,
        coatType: p.coatType,
        temperament: p.temperament ?? [],
        allergies: p.allergies ?? [],
        behaviorNotes: p.behaviorNotes ?? null,
      };
      const have = await tx.pet.findFirst({ where: { organizationId: orgId, customerId: customer.id, name: p.name } });
      const pet = have
        ? await tx.pet.update({ where: { id: have.id }, data })
        : await tx.pet.create({ data: { organizationId: orgId, customerId: customer.id, name: p.name, ...data } });
      pets.set(`${c.phoneE164}|${p.name}`, { id: pet.id, customerId: customer.id, sizeClass, weightG, coatType: p.coatType, species: p.species });

      for (const v of p.vaccines) {
        const expiresOn = new Date(new Date(now + v.expiresInDays * DAY_MS).toISOString().slice(0, 10));
        const haveVax = await tx.petVaccine.findFirst({ where: { petId: pet.id, type: v.type } });
        if (haveVax) await tx.petVaccine.update({ where: { id: haveVax.id }, data: { expiresOn } });
        else await tx.petVaccine.create({ data: { organizationId: orgId, petId: pet.id, type: v.type, expiresOn } });
      }
    }
  }
  return pets;
}

async function seedVisits(
  tx: Tx,
  orgId: string,
  locationId: string,
  pets: Awaited<ReturnType<typeof seedCustomers>>,
  staffIds: Map<string, string>,
): Promise<void> {
  const resources = await tx.resource.findMany({ where: { locationId } });
  const resourceId = (name: string) => {
    const r = resources.find((x) => x.name === name);
    if (!r) throw new Error(`Resource ${name} missing`);
    return r.id;
  };
  const receptionId = staffIds.get("reception@demo.dev")!;
  const day = new Date();
  day.setUTCHours(0, 0, 0, 0);

  for (const v of VISITS) {
    if (await tx.appointment.findFirst({ where: { organizationId: orgId, notes: v.key } })) continue;
    const pet = pets.get(`${v.customerPhone}|${v.pet}`);
    if (!pet) throw new Error(`Seed pet ${v.pet} missing`);

    const dropOffAt = new Date(day.getTime() - v.daysAgo * DAY_MS + v.startHourUtc * 3_600_000);
    const lines: { serviceId: string; stage: "BATH" | "DRY" | "GROOM" | "FINISH"; staffId: string; resource: string | null; durationMin: number; priceCents: number; buffer: number }[] = [];
    for (const line of v.services) {
      const svc = await tx.service.findFirstOrThrow({
        where: { organizationId: orgId, species: pet.species, name: { path: ["en"], equals: line.service } },
      });
      const prices = await tx.servicePrice.findMany({ where: { serviceId: svc.id, sizeClass: pet.sizeClass } });
      const row = prices.find((p) => p.coatType === pet.coatType) ?? prices.find((p) => p.coatType === null)!;
      lines.push({
        serviceId: svc.id,
        stage: svc.stage,
        staffId: staffIds.get(line.staffEmail)!,
        resource: line.resource,
        durationMin: row.durationMin,
        priceCents: row.priceCents,
        buffer: svc.bufferAfterMin,
      });
    }

    // Segments run one after another so nothing overlaps (blocks include the buffer).
    let cursor = new Date(dropOffAt.getTime() + 15 * 60_000);
    const segments = lines.map((l) => {
      const startsAt = cursor;
      const endsAt = new Date(startsAt.getTime() + l.durationMin * 60_000);
      const blockEndsAt = new Date(endsAt.getTime() + l.buffer * 60_000);
      cursor = blockEndsAt;
      return { ...l, startsAt, endsAt, blockEndsAt };
    });
    const readyAt = new Date(cursor.getTime() + 10 * 60_000);
    const pickedUpAt = new Date(readyAt.getTime() + 30 * 60_000);
    const total = lines.reduce((sum, l) => sum + l.priceCents, 0);

    const appointment = await tx.appointment.create({
      data: {
        organizationId: orgId,
        locationId,
        customerId: pet.customerId,
        status: "COMPLETED",
        source: "RECEPTION",
        bookingMode: "DROP_OFF",
        dropOffAt,
        checkedInAt: dropOffAt,
        estimatedReadyAt: readyAt,
        completedAt: pickedUpAt,
        notes: v.key,
        createdByStaffId: receptionId,
      },
    });
    const visit = await tx.petVisit.create({
      data: {
        organizationId: orgId,
        appointmentId: appointment.id,
        petId: pet.id,
        status: "PICKED_UP",
        sizeClassAtBooking: pet.sizeClass,
        sizeClassAtCheckin: pet.sizeClass,
        weightGAtCheckin: pet.weightG,
        kennelResourceId: v.kennel ? resourceId(v.kennel) : null,
        readyAt,
        pickedUpAt,
        pickedUpByName: "Owner",
        priceCentsQuoted: total,
        priceCentsFinal: total,
        reportPublishedAt: pickedUpAt,
      },
    });
    await tx.petVisitService.createMany({
      data: lines.map((l) => ({ organizationId: orgId, petVisitId: visit.id, serviceId: l.serviceId, priceCents: l.priceCents, durationMin: l.durationMin })),
    });
    await tx.appointmentSegment.createMany({
      data: segments.map((s) => ({
        organizationId: orgId,
        appointmentId: appointment.id,
        petVisitId: visit.id,
        stage: s.stage,
        serviceId: s.serviceId,
        staffUserId: s.staffId,
        resourceId: s.resource ? resourceId(s.resource) : null,
        startsAt: s.startsAt,
        endsAt: s.endsAt,
        blockEndsAt: s.blockEndsAt,
        durationMin: s.durationMin,
        priceCents: s.priceCents,
      })),
    });
    if (v.kennel) {
      await tx.appointmentSegment.create({
        data: {
          organizationId: orgId,
          appointmentId: appointment.id,
          petVisitId: visit.id,
          stage: "KENNEL",
          resourceId: resourceId(v.kennel),
          startsAt: dropOffAt,
          endsAt: pickedUpAt,
          blockEndsAt: pickedUpAt,
          durationMin: Math.round((pickedUpAt.getTime() - dropOffAt.getTime()) / 60_000),
          priceCents: 0,
        },
      });
    }

    // Steps: RECEIVED, one per distinct service stage (in order), READY. All DONE.
    const stages = [...new Set(segments.map((s) => s.stage))];
    const performerFor = (stage: string) => segments.find((s) => s.stage === stage)?.staffId ?? null;
    const timeFor = (stage: string) => segments.find((s) => s.stage === stage);
    const steps = [
      { stage: "RECEIVED" as const, startedAt: dropOffAt, finishedAt: new Date(dropOffAt.getTime() + 15 * 60_000), by: receptionId },
      ...stages.map((stage) => ({ stage, startedAt: timeFor(stage)!.startsAt, finishedAt: timeFor(stage)!.endsAt, by: performerFor(stage)! })),
      { stage: "READY" as const, startedAt: readyAt, finishedAt: readyAt, by: receptionId },
    ];
    await tx.visitStep.createMany({
      data: steps.map((s, sort) => ({
        organizationId: orgId,
        petVisitId: visit.id,
        stage: s.stage,
        sort,
        status: "DONE" as const,
        startedAt: s.startedAt,
        finishedAt: s.finishedAt,
        performedByStaffId: s.by,
        recordedByStaffId: s.by,
      })),
    });

    if (v.observation) {
      await tx.visitObservation.create({
        data: {
          organizationId: orgId,
          petVisitId: visit.id,
          kind: v.observation.kind,
          severity: v.observation.severity,
          note: v.observation.note,
          recordedByStaffId: staffIds.get(v.observation.staffEmail)!,
        },
      });
    }
    await tx.visitReport.create({
      data: { organizationId: orgId, petVisitId: visit.id, ...v.report, publishedAt: pickedUpAt },
    });
  }
}

export async function runSeed(db: PrismaClient): Promise<SeedSummary> {
  const org = await db.organization.upsert({
    where: { slug: "demo-salon" },
    update: { name: "Demo Grooming", defaultLocale: "es" },
    create: { slug: "demo-salon", name: "Demo Grooming", defaultLocale: "es" },
  });
  const { locationId } = await seedInfrastructure(db, org.id);
  await db.$transaction(
    async (tx) => {
      const serviceIds = await seedCatalog(tx, org.id);
      const staffIds = await seedStaff(tx, org.id, locationId, serviceIds);
      const pets = await seedCustomers(tx, org.id);
      await seedVisits(tx, org.id, locationId, pets, staffIds);
    },
    { timeout: 60_000 },
  );

  const [services, priceRows, staff, customers, petCount, visits, reports] = await Promise.all([
    db.service.count({ where: { organizationId: org.id } }),
    db.servicePrice.count({ where: { organizationId: org.id } }),
    db.staffUser.count({ where: { organizationId: org.id } }),
    db.customer.count({ where: { organizationId: org.id } }),
    db.pet.count({ where: { organizationId: org.id } }),
    db.petVisit.count({ where: { organizationId: org.id } }),
    db.visitReport.count({ where: { organizationId: org.id } }),
  ]);
  return { services, priceRows, staff, customers, pets: petCount, visits, reports };
}

async function main(): Promise<void> {
  const db = new PrismaClient();
  try {
    const summary = await runSeed(db);
    const org = await db.organization.findUniqueOrThrow({ where: { slug: "demo-salon" } });
    const [locations, hours, stations, kennels] = await Promise.all([
      db.location.count({ where: { organizationId: org.id } }),
      db.locationHours.count({ where: { location: { organizationId: org.id } } }),
      db.resource.count({ where: { organizationId: org.id, resourceType: { kind: "STATION" } } }),
      db.resource.count({ where: { organizationId: org.id, resourceType: { kind: "KENNEL" } } }),
    ]);
    console.log(
      `seed ok: locations=${locations} location_hours=${hours} stations=${stations} kennels=${kennels} ` +
        Object.entries(summary).map(([k, v]) => `${k}=${v}`).join(" "),
    );
  } finally {
    await db.$disconnect();
  }
}

if (process.argv[1]?.endsWith("seed.ts")) {
  main().catch((err: unknown) => {
    console.error(err);
    process.exitCode = 1;
  });
}
