import { wallTimeToUtc } from "@grooming/datetime";
import type { IsoDate, WallTime, Weekday } from "@grooming/datetime";
import type { ServicePriceRow } from "@grooming/pricing";
import type {
  EmployeeInput,
  FindSlotsInput,
  LocationInput,
  PetRequest,
  ResourceInput,
  ServiceInput,
  WeeklyHours,
} from "../src/types";

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
  dropOffWindows: everyDay("09:00", "11:00"),
  maxQueueWaitMin: 90,
  pickupGraceMin: 60,
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
  skills: ["GROOMER"],
};

export const chair1: ResourceInput = { id: CHAIR_1_ID, resourceTypeId: CHAIR, name: "chair-1", kind: "STATION" };

// Grooming fixtures
const id = (n: string): string => `00000000-0000-4000-8000-${n.padStart(12, "0")}`;

export const TUB = id("0000000000a1");
export const TABLE = id("0000000000a2");
export const DRYER = id("0000000000a3");
export const KENNEL = id("0000000000a4");

export const TUB_1_ID = id("0000000000b1");
export const TUB_2_ID = id("0000000000b2");
export const TABLE_1_ID = id("0000000000b3");
export const TABLE_2_ID = id("0000000000b4");
export const DRYER_1_ID = id("0000000000b5");
export const KENNEL_1_ID = id("0000000000b6");
export const KENNEL_2_ID = id("0000000000b7");

export const tub1: ResourceInput = { id: TUB_1_ID, resourceTypeId: TUB, name: "tub-1", kind: "STATION" };
export const tub2: ResourceInput = { id: TUB_2_ID, resourceTypeId: TUB, name: "tub-2", kind: "STATION" };
export const table1: ResourceInput = { id: TABLE_1_ID, resourceTypeId: TABLE, name: "table-1", kind: "STATION" };
export const table2: ResourceInput = { id: TABLE_2_ID, resourceTypeId: TABLE, name: "table-2", kind: "STATION" };
export const dryer1: ResourceInput = { id: DRYER_1_ID, resourceTypeId: DRYER, name: "dryer-1", kind: "STATION" };
export const kennel1: ResourceInput = { id: KENNEL_1_ID, resourceTypeId: KENNEL, name: "kennel-1", kind: "KENNEL" };
export const kennel2: ResourceInput = { id: KENNEL_2_ID, resourceTypeId: KENNEL, name: "kennel-2", kind: "KENNEL" };

const svc = (n: string, o: Omit<ServiceInput, "id" | "bufferAfterMin" | "onlineBookable">): ServiceInput => ({
  id: id(n),
  bufferAfterMin: 0,
  onlineBookable: true,
  ...o,
});
export const bath = svc("0000000000e1", { stage: "BATH", species: "ANY", resourceTypeId: TUB, requiredSkill: "BATHER" });
export const deshed = svc("0000000000e2", { stage: "BATH", species: "DOG", resourceTypeId: TUB, requiredSkill: "BATHER" });
export const dry = svc("0000000000e3", { stage: "DRY", species: "ANY", resourceTypeId: DRYER, requiredSkill: "BATHER" });
export const haircut = svc("0000000000e4", { stage: "GROOM", species: "DOG", resourceTypeId: TABLE, requiredSkill: "GROOMER" });
export const teeth = svc("0000000000e5", { stage: "GROOM", species: "ANY", resourceTypeId: TABLE, requiredSkill: "GROOMER" });
export const nails = svc("0000000000e6", { stage: "FINISH", species: "ANY", resourceTypeId: null, requiredSkill: "GROOMER" });
export const catBath = svc("0000000000e7", { stage: "BATH", species: "CAT", resourceTypeId: TUB, requiredSkill: "BATHER" });
export const services: ServiceInput[] = [bath, deshed, dry, haircut, teeth, nails, catBath];

const row = (
  s: ServiceInput,
  sizeClass: ServicePriceRow["sizeClass"],
  coatType: ServicePriceRow["coatType"],
  durationMin: number,
  priceCents: number,
): ServicePriceRow => ({ serviceId: s.id, sizeClass, coatType, durationMin, priceCents });
export const prices: ServicePriceRow[] = [
  row(bath, "S", null, 30, 3000),
  row(bath, "M", null, 45, 4000),
  row(bath, "M", "CURLY", 60, 5000),
  row(deshed, "M", null, 15, 2000),
  row(dry, "M", null, 30, 1500),
  row(haircut, "S", null, 45, 5000),
  row(haircut, "M", null, 60, 6000),
  row(teeth, "M", null, 10, 1000),
  row(nails, "M", null, 15, 1500),
  row(catBath, "M", null, 45, 4500),
];

const emp = (n: string, skills: EmployeeInput["skills"], serviceIds: string[]): EmployeeInput => ({
  id: id(n),
  serviceIds,
  skills,
  workingHours: everyDay("09:00", "19:00"),
  timeOff: [],
  bookableOnline: true,
});
export const batherA = emp("0000000000f1", ["BATHER"], [bath.id, deshed.id, dry.id, catBath.id]);
export const batherB = emp("0000000000f2", ["BATHER"], [bath.id, dry.id, catBath.id]);
export const groomerA = emp("0000000000f3", ["GROOMER"], [haircut.id, teeth.id, nails.id]);
export const groomerB = emp("0000000000f4", ["GROOMER"], [haircut.id, teeth.id, nails.id]);
export const employees: EmployeeInput[] = [batherA, batherB, groomerA, groomerB];

const basePet = (petId: string, species: PetRequest["species"], coatType: PetRequest["coatType"]): PetRequest => ({
  petId,
  species,
  sizeClass: "M",
  coatType,
  serviceIds: [],
  preferredGroomerId: "ANY",
});
export const rex = basePet(id("000000000a01"), "DOG", "SMOOTH");
export const luna = basePet(id("000000000a02"), "DOG", "SMOOTH");
export const max = basePet(id("000000000a03"), "DOG", "CURLY");
export const mia = basePet(id("000000000a04"), "CAT", "SMOOTH");
export const pet = (base: PetRequest, serviceIds: string[], o: Partial<PetRequest> = {}): PetRequest => ({
  ...base,
  serviceIds,
  ...o,
});

export const GROOM_NOW = Date.parse("2026-12-06T12:00:00Z");
export const groomCtx = (o: Partial<FindSlotsInput> = {}): FindSlotsInput => ({
  location: location,
  services,
  prices,
  employees,
  resources: [tub1, tub2, table1, table2, dryer1, kennel1, kennel2],
  busy: [],
  mode: "ONLINE",
  now: GROOM_NOW,
  bookingMode: "WAIT",
  date: MON,
  pets: [],
  ...o,
});
