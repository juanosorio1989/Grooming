import type { Context, EmployeeInput, ServiceInput, Skill, WeeklyHours, WorkStage } from "@grooming/availability";
import type { ServicePriceRow } from "@grooming/pricing";
import type { BookingMode } from "@prisma/client";
import { dbTimeToWall } from "../common/wall-time.js";
import type { DefaultLocation } from "../location/location.service.js";

/** Row shapes selected by `AvailabilityContextLoader`. */
export interface HoursRow { weekday: number; opens: Date; closes: Date }
export interface ClosureRow { startsAt: Date; endsAt: Date }
export interface ServiceRow {
  id: string;
  stage: string;
  species: "DOG" | "CAT" | "ANY";
  resourceTypeId: string | null;
  requiredSkill: Skill;
  bufferAfterMin: number;
  onlineBookable: boolean;
  /** Null = location default; used by `resolveBookingMode`, not by the engine. */
  bookingMode: BookingMode | null;
}
export interface PriceRow {
  serviceId: string;
  sizeClass: ServicePriceRow["sizeClass"];
  coatType: ServicePriceRow["coatType"];
  durationMin: number;
  priceCents: number;
}
export interface EmployeeRow {
  id: string;
  profile: { skills: Skill[]; bookableOnline: boolean };
  serviceIds: string[];
  workingHours: { weekday: number; startTime: Date; endTime: Date }[];
  timeOff: { startsAt: Date; endsAt: Date }[];
}
export interface ResourceRow { id: string; resourceTypeId: string; name: string; kind: "STATION" | "KENNEL" }
export interface BusyRow { staffUserId: string | null; resourceId: string | null; startsAt: Date; blockEndsAt: Date }

export interface ContextRows {
  location: DefaultLocation;
  hours: HoursRow[];
  closures: ClosureRow[];
  services: ServiceRow[];
  prices: PriceRow[];
  employees: EmployeeRow[];
  resources: ResourceRow[];
  busy: BusyRow[];
}

const WORK_STAGES: readonly string[] = ["BATH", "DRY", "GROOM", "FINISH"];

const weekly = (weekday: number, from: Date, to: Date): WeeklyHours => ({
  weekday: weekday as WeeklyHours["weekday"],
  start: dbTimeToWall(from, false),
  end: dbTimeToWall(to, true),
});

/**
 * Pure mapping from the loader's rows to the engine `Context` (without `mode` and `override`).
 * Services whose stage is not one of the four work stages are skipped.
 */
export function toEngineContext(rows: ContextRows, now: Date): Omit<Context, "mode" | "override"> {
  const s = rows.location.settings;
  const services: ServiceInput[] = rows.services
    .filter((x) => WORK_STAGES.includes(x.stage))
    .map((x) => ({
      id: x.id,
      stage: x.stage as WorkStage,
      species: x.species,
      resourceTypeId: x.resourceTypeId,
      requiredSkill: x.requiredSkill,
      bufferAfterMin: x.bufferAfterMin,
      onlineBookable: x.onlineBookable,
    }));
  const kept = new Set(services.map((x) => x.id));
  const employees: EmployeeInput[] = rows.employees.map((e) => ({
    id: e.id,
    serviceIds: e.serviceIds,
    workingHours: e.workingHours.map((w) => weekly(w.weekday, w.startTime, w.endTime)),
    timeOff: e.timeOff.map((t) => ({ start: t.startsAt.getTime(), end: t.endsAt.getTime() })),
    bookableOnline: e.profile.bookableOnline,
    skills: e.profile.skills,
  }));
  return {
    location: {
      timezone: rows.location.timezone,
      slotIntervalMin: s.slotIntervalMin,
      minLeadMinutes: s.minLeadMinutes,
      bookingHorizonDays: s.bookingHorizonDays,
      hours: rows.hours.map((h) => weekly(h.weekday, h.opens, h.closes)),
      closures: rows.closures.map((c) => ({ start: c.startsAt.getTime(), end: c.endsAt.getTime() })),
      dropOffWindows: Object.entries(s.dropOffWindows).flatMap(([key, ranges]) =>
        ranges.map((r) => ({ weekday: Number(key) as WeeklyHours["weekday"], start: r.from, end: r.to })),
      ),
      maxQueueWaitMin: s.maxQueueWaitMin,
      pickupGraceMin: s.pickupGraceMin,
    },
    services,
    prices: rows.prices.filter((p) => kept.has(p.serviceId)).map((p) => ({ ...p })),
    employees,
    resources: rows.resources.map((r) => ({ ...r })),
    busy: rows.busy.map((b) => ({
      employeeId: b.staffUserId,
      resourceId: b.resourceId,
      start: b.startsAt.getTime(),
      blockEnd: b.blockEndsAt.getTime(),
    })),
    now: now.getTime(),
  };
}

/** DROP_OFF if any requested service is DROP_OFF (own bookingMode, or null and the location default is DROP_OFF); else WAIT. */
export function resolveBookingMode(services: { bookingMode: BookingMode | null }[], locationDefault: BookingMode): BookingMode {
  return services.some((s) => (s.bookingMode ?? locationDefault) === "DROP_OFF") ? "DROP_OFF" : "WAIT";
}
