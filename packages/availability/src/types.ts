import type { IsoDate, WallTime, Weekday } from "@grooming/datetime";
import type { CoatType, ServicePriceRow, SizeClass } from "@grooming/pricing";

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
export type Skill = "BATHER" | "GROOMER";
export type WorkStage = "BATH" | "DRY" | "GROOM" | "FINISH";
export const WORK_STAGE_ORDER: readonly WorkStage[] = ["BATH", "DRY", "GROOM", "FINISH"];
export type SegmentStage = WorkStage | "KENNEL";
export type Species = "DOG" | "CAT";
export type BookingMode = "WAIT" | "DROP_OFF";
export type Mode = "ONLINE" | "STAFF";

export interface LocationInput {
  timezone: string;
  slotIntervalMin: number;
  minLeadMinutes: number;
  bookingHorizonDays: number;
  hours: WeeklyHours[];
  closures: Interval[];
  /** Half-open [start, end) local drop-off times. */
  dropOffWindows: WeeklyHours[];
  maxQueueWaitMin: number;
  pickupGraceMin: number;
}
export interface EmployeeInput {
  id: string;
  serviceIds: string[];
  workingHours: WeeklyHours[];
  timeOff: Interval[];
  bookableOnline: boolean;
  skills: Skill[];
}
export interface ResourceInput {
  id: string;
  resourceTypeId: string;
  name: string;
  kind: "STATION" | "KENNEL";
}
export interface BusySegment {
  /** Kennel segments have no person. */
  employeeId: string | null;
  resourceId: string | null;
  start: Ms;
  blockEnd: Ms;
}

export interface ServiceInput {
  id: string;
  stage: WorkStage;
  species: Species | "ANY";
  resourceTypeId: string | null;
  requiredSkill: Skill;
  bufferAfterMin: number;
  onlineBookable: boolean;
}
export interface PetRequest {
  petId: string;
  species: Species;
  sizeClass: SizeClass;
  coatType: CoatType;
  serviceIds: string[];
  preferredGroomerId: string | "ANY";
}
export interface Context {
  location: LocationInput;
  services: ServiceInput[];
  prices: ServicePriceRow[];
  employees: EmployeeInput[];
  resources: ResourceInput[];
  busy: BusySegment[];
  mode: Mode;
  now: Ms;
  override?: boolean;
}
export interface SlotRequest {
  bookingMode: BookingMode;
  pets: PetRequest[];
}
export interface FindSlotsInput extends Context, SlotRequest {
  date: IsoDate;
}
export interface PlannedSegment {
  petId: string;
  stage: SegmentStage;
  serviceIds: string[];
  employeeId: string | null;
  resourceId: string | null;
  start: Ms;
  end: Ms;
  blockEnd: Ms;
  durationMin: number;
  priceCents: number;
}
/** Work segments in stage order, then the KENNEL segment in drop-off mode. */
export interface PetPlan {
  petId: string;
  priceCents: number;
  segments: PlannedSegment[];
}
export interface Slot {
  /** First segment start in wait mode, drop-off time in drop-off mode. */
  start: Ms;
  /** Latest work segment end. */
  readyAt: Ms;
  bookingMode: BookingMode;
  pets: PetPlan[];
}
export type PlanRejection =
  | "NOT_QUALIFIED"
  | "EMPLOYEE_UNAVAILABLE"
  | "RESOURCE_UNAVAILABLE"
  | "TOO_SOON"
  | "BEYOND_HORIZON"
  | "NOT_BOOKABLE_ONLINE"
  | "OUTSIDE_DROP_OFF_WINDOW"
  | "MALFORMED_PLAN";
