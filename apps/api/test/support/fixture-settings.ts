import type { LocationSettings } from "@grooming/contracts";

/** Same values as `prisma/seed.ts` LOCATION_SETTINGS; the fixture location stores these. */
export const FIXTURE_SETTINGS: LocationSettings = {
  slotIntervalMin: 15,
  holdMinutes: 5,
  cancelWindowHours: 24,
  bookingHorizonDays: 60,
  minLeadMinutes: 60,
  defaultBookingMode: "DROP_OFF",
  dropOffWindows: Object.fromEntries([1, 2, 3, 4, 5, 6].map((d) => [String(d), [{ from: "08:00", to: "11:00" }]])),
  maxQueueWaitMin: 90,
  pickupGraceMin: 60,
  sizeThresholdsLb: { S: 20, M: 50, L: 90 },
  requireAfterPhoto: true,
  vaccinePolicy: "WARN",
  requiredVaccines: { DOG: ["RABIES"] },
  etaNotifyThresholdMin: 30,
};
