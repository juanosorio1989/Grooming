/**
 * Idempotent development seed: one organization, one location (America/New_York)
 * with hours and the grooming settings defaults, and the station and kennel
 * resources. Safe to run repeatedly (finds by natural keys, creates what is
 * missing). The full catalog and sample data come in Plan 03.
 * Run: pnpm --filter @grooming/api db:seed (uses DATABASE_URL).
 */
import { type Prisma, PrismaClient, type ResourceKind } from "@prisma/client";

const prisma = new PrismaClient();

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

const time = (hhmm: string) => new Date(`1970-01-01T${hhmm}:00.000Z`);

async function main(): Promise<void> {
  const org = await prisma.organization.upsert({
    where: { slug: "demo-salon" },
    update: { name: "Demo Grooming", defaultLocale: "es" },
    create: { slug: "demo-salon", name: "Demo Grooming", defaultLocale: "es" },
  });

  await prisma.$transaction(async (tx) => {
    const existing = await tx.location.findFirst({ where: { organizationId: org.id, name: "Main" } });
    const data = { timezone: "America/New_York", settings: LOCATION_SETTINGS };
    const location = existing
      ? await tx.location.update({ where: { id: existing.id }, data })
      : await tx.location.create({ data: { organizationId: org.id, name: "Main", ...data } });

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
        where: { organizationId: org.id, name: { path: ["en"], equals: r.en } },
      });
      const type = found
        ? await tx.resourceType.update({ where: { id: found.id }, data: { name, kind: r.kind } })
        : await tx.resourceType.create({ data: { organizationId: org.id, name, kind: r.kind } });

      for (let i = 1; i <= r.count; i += 1) {
        const resourceName = `${r.en} ${i}`;
        const have = await tx.resource.findFirst({ where: { locationId: location.id, name: resourceName } });
        if (!have) {
          await tx.resource.create({
            data: { organizationId: org.id, locationId: location.id, resourceTypeId: type.id, name: resourceName },
          });
        }
      }
    }
  });

  const [organizations, locations, hours, stations, kennels] = await Promise.all([
    prisma.organization.count(),
    prisma.location.count({ where: { organizationId: org.id } }),
    prisma.locationHours.count({ where: { location: { organizationId: org.id } } }),
    prisma.resource.count({ where: { organizationId: org.id, resourceType: { kind: "STATION" } } }),
    prisma.resource.count({ where: { organizationId: org.id, resourceType: { kind: "KENNEL" } } }),
  ]);
  console.log(
    `seed ok: organizations=${organizations} locations=${locations} location_hours=${hours} stations=${stations} kennels=${kennels}`,
  );
}

main()
  .catch((err: unknown) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
