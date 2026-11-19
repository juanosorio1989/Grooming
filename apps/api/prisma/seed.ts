/**
 * Idempotent development seed: one organization and one location with hours.
 * Safe to run repeatedly (upserts by natural keys). Full catalog seeds come in plan 03.
 * Run: pnpm --filter @grooming/api db:seed (uses DATABASE_URL).
 */
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

const LOCATION_SETTINGS = {
  slotIntervalMin: 15,
  holdMinutes: 5,
  cancelWindowHours: 24,
  bookingHorizonDays: 60,
  minLeadMinutes: 60,
};

/** Monday (1) to Saturday (6), 09:00-19:00 local wall time. */
const OPEN_WEEKDAYS = [1, 2, 3, 4, 5, 6];
const time = (hhmm: string) => new Date(`1970-01-01T${hhmm}:00.000Z`);

async function main(): Promise<void> {
  const org = await prisma.organization.upsert({
    where: { slug: "demo-salon" },
    update: { name: "Demo Salon", defaultLocale: "es" },
    create: { slug: "demo-salon", name: "Demo Salon", defaultLocale: "es" },
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
        opens: time("09:00"),
        closes: time("19:00"),
      })),
    });
  });

  const [organizations, locations, hours] = await Promise.all([
    prisma.organization.count(),
    prisma.location.count({ where: { organizationId: org.id } }),
    prisma.locationHours.count({ where: { location: { organizationId: org.id } } }),
  ]);
  console.log(`seed ok: organizations=${organizations} locations=${locations} location_hours=${hours}`);
}

main()
  .catch((err: unknown) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
