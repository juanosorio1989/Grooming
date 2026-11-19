import { wallTimeToUtc } from "@grooming/datetime";
import type { IsoDate, WallTime, Weekday } from "@grooming/datetime";
import type { EmployeeInput, LocationInput, ResourceInput, WeeklyHours } from "../src/types";

export const NY = "America/New_York";
export const MON: IsoDate = "2026-12-07";
export const at = (date: IsoDate, time: WallTime): number => wallTimeToUtc(date, time, NY);

const WEEKDAYS: Weekday[] = [0, 1, 2, 3, 4, 5, 6];
export const everyDay = (start: WallTime, end: WallTime): WeeklyHours[] =>
  WEEKDAYS.map((weekday) => ({ weekday, start, end }));

export const DANI_ID = "00000000-0000-4000-8000-00000000000d";
export const CHAIR = "00000000-0000-4000-8000-0000000000c1";
export const CHAIR_1_ID = "00000000-0000-4000-8000-0000000000d1";

export const makeLocation = (o: Partial<LocationInput> = {}): LocationInput => ({
  timezone: NY,
  slotIntervalMin: 15,
  minLeadMinutes: 60,
  bookingHorizonDays: 60,
  hours: everyDay("09:00", "19:00"),
  closures: [],
  ...o,
});
export const location = makeLocation();

export const makeEmployee = (base: EmployeeInput, o: Partial<EmployeeInput> = {}): EmployeeInput => ({
  ...base,
  ...o,
});
export const dani: EmployeeInput = {
  id: DANI_ID,
  serviceIds: [],
  workingHours: everyDay("09:00", "19:00"),
  timeOff: [],
  bookableOnline: true,
};

export const chair1: ResourceInput = { id: CHAIR_1_ID, resourceTypeId: CHAIR, name: "chair-1" };
