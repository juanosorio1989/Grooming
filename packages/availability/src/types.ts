import type { WallTime, Weekday } from "@grooming/datetime";

export type Ms = number;
/** Half-open interval [start, end). */
export interface Interval {
  start: Ms;
  end: Ms;
}
export interface WeeklyHours {
  weekday: Weekday;
  start: WallTime;
  end: WallTime;
}
export interface LocationInput {
  timezone: string;
  slotIntervalMin: number;
  minLeadMinutes: number;
  bookingHorizonDays: number;
  hours: WeeklyHours[];
  closures: Interval[];
}
export interface EmployeeInput {
  id: string;
  serviceIds: string[];
  workingHours: WeeklyHours[];
  timeOff: Interval[];
  bookableOnline: boolean;
}
export interface ResourceInput {
  id: string;
  resourceTypeId: string;
  name: string;
}
export interface BusySegment {
  employeeId: string;
  resourceId: string | null;
  start: Ms;
  blockEnd: Ms;
}
