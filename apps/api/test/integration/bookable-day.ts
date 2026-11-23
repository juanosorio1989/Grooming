import type { PrismaClient } from "@prisma/client";
import { addDays, todayIn, wallTimeToUtc, weekdayOf, type IsoDate } from "@grooming/datetime";
import type { Fixture } from "./helpers.js";

/**
 * Shared setup for the `/availability` and booking suites: a bookable Tuesday
 * in New York with one bather (`staffA`, 08:00-17:00), location hours
 * 08:00-18:00 and a size M price of 4500 / 60 min for the fixture's bath.
 */
export const TZ = "America/New_York";

const t = (hhmm: string) => new Date(`1970-01-01T${hhmm}:00.000Z`);

/** The first Tuesday at least 3 days after today (New York): inside the 60-day horizon, past the 60-min lead time. */
export function nextTuesday(): IsoDate {
  let d = addDays(todayIn(TZ, Date.now()), 3);
  while (weekdayOf(d) !== 2) d = addDays(d, 1);
  return d;
}

export const FROM = nextTuesday();

/** The UTC instant (ISO) of a New York wall time on `date` (default `FROM`). */
export const local = (hhmm: string, date: IsoDate = FROM) => new Date(wallTimeToUtc(date, hhmm, TZ)).toISOString();

/** New York wall time "HH:MM" of an ISO instant. */
export const wall = (iso: string) =>
  new Intl.DateTimeFormat("en-GB", { timeZone: TZ, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(new Date(iso));

/** Hours, the bather's profile, skills, location and working hours, and the M price row. */
export async function seedBookableTuesday(prisma: PrismaClient, f: Fixture): Promise<void> {
  await prisma.locationHours.create({ data: { locationId: f.locationId, weekday: 2, opens: t("08:00"), closes: t("18:00") } });
  await prisma.employeeProfile.create({ data: { staffUserId: f.staffA, displayName: "A", skills: ["BATHER"] } });
  await prisma.employeeService.create({ data: { staffUserId: f.staffA, serviceId: f.serviceId } });
  await prisma.staffLocation.create({ data: { staffUserId: f.staffA, locationId: f.locationId } });
  await prisma.workingHours.create({
    data: { organizationId: f.orgId, staffUserId: f.staffA, locationId: f.locationId, weekday: 2, startTime: t("08:00"), endTime: t("17:00") },
  });
  await prisma.servicePrice.create({
    data: { organizationId: f.orgId, serviceId: f.serviceId, sizeClass: "M", coatType: null, durationMin: 60, priceCents: 4500 },
  });
}
