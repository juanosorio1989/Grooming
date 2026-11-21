import { z } from "zod";
import { IdSchema, IsoInstantSchema, WallRangeSchema, WallTimeSchema } from "./common";

export const VaccineTypeSchema = z.enum(["RABIES", "DHPP", "BORDETELLA", "FVRCP", "OTHER"]);
export type VaccineType = z.infer<typeof VaccineTypeSchema>;

/** Ranges sorted by start and non-overlapping (touching is allowed). */
function sortedDisjoint(ranges: { from: string; to: string }[]): boolean {
  return ranges.every((r, i) => i === 0 || (ranges[i - 1] as { to: string }).to <= r.from);
}

const Weekday = z.number().int().min(0).max(6);
const WEEKDAY_KEYS = ["0", "1", "2", "3", "4", "5", "6"] as const;

const DropOffWindowsSchema = z
  .object(
    Object.fromEntries(
      WEEKDAY_KEYS.map((k) => [k, z.array(WallRangeSchema).max(4).refine(sortedDisjoint, "Ranges must be sorted and not overlap").optional()]),
    ) as Record<(typeof WEEKDAY_KEYS)[number], z.ZodOptional<z.ZodEffects<z.ZodArray<typeof WallRangeSchema>>>>,
  )
  .strict();

const SizeThresholdsSchema = z
  .object({ S: z.number().int().positive(), M: z.number().int().positive(), L: z.number().int().positive() })
  .strict()
  .refine((t) => t.S < t.M && t.M < t.L, "Thresholds must satisfy S < M < L")
  .refine((t) => t.L <= 300, "L must be at most 300");

const VaccineList = z
  .array(VaccineTypeSchema)
  .refine((a) => new Set(a).size === a.length, "Vaccines must be unique");

export const LocationSettingsSchema = z
  .object({
    slotIntervalMin: z.union([z.literal(5), z.literal(10), z.literal(15), z.literal(20), z.literal(30), z.literal(60)]),
    holdMinutes: z.number().int().min(1).max(30),
    cancelWindowHours: z.number().int().min(0).max(168),
    bookingHorizonDays: z.number().int().min(1).max(365),
    minLeadMinutes: z.number().int().min(0).max(1440),
    defaultBookingMode: z.enum(["WAIT", "DROP_OFF"]),
    dropOffWindows: DropOffWindowsSchema,
    maxQueueWaitMin: z.number().int().min(0).max(480),
    pickupGraceMin: z.number().int().min(0).max(480),
    sizeThresholdsLb: SizeThresholdsSchema,
    requireAfterPhoto: z.boolean(),
    vaccinePolicy: z.enum(["WARN", "BLOCK_CHECKIN"]),
    requiredVaccines: z.object({ DOG: VaccineList.optional(), CAT: VaccineList.optional() }).strict(),
    etaNotifyThresholdMin: z.number().int().min(5).max(240),
  })
  .strict();
export type LocationSettings = z.infer<typeof LocationSettingsSchema>;

/** Top-level keys optional; a given key replaces that whole value. */
export const LocationSettingsPatchSchema = LocationSettingsSchema.partial();
export type LocationSettingsPatch = z.infer<typeof LocationSettingsPatchSchema>;

export const LocationHoursSchema = z
  .object({ weekday: Weekday, opens: WallTimeSchema, closes: WallTimeSchema })
  .strict()
  .refine((h) => h.opens !== "24:00" && h.opens < h.closes, "opens must be before closes");
export type LocationHours = z.infer<typeof LocationHoursSchema>;

/** PUT body: replaces all hours; ranges of one weekday must not overlap. */
export const LocationHoursListSchema = z
  .array(LocationHoursSchema)
  .max(14)
  .refine(
    (list) =>
      Array.from({ length: 7 }, (_, d) =>
        list
          .filter((h) => h.weekday === d)
          .sort((a, b) => a.opens.localeCompare(b.opens))
          .map((h) => ({ from: h.opens, to: h.closes })),
      ).every(sortedDisjoint),
    "Ranges of one weekday must not overlap",
  );

const ClosureBase = z.object({ startsAt: IsoInstantSchema, endsAt: IsoInstantSchema, reason: z.string().max(200).optional() });
const closureOrder = (c: { startsAt: string; endsAt: string }) => Date.parse(c.startsAt) < Date.parse(c.endsAt);
export const ClosureSchema = ClosureBase.strict().refine(closureOrder, "startsAt must be before endsAt");
export type Closure = z.infer<typeof ClosureSchema>;

export const ClosureQuerySchema = z.object({ from: IsoInstantSchema.optional(), to: IsoInstantSchema.optional() }).strict();
export type ClosureQuery = z.infer<typeof ClosureQuerySchema>;

export const ClosureItemSchema = ClosureBase.extend({ id: IdSchema }).strict().refine(closureOrder, "startsAt must be before endsAt");
export type ClosureItem = z.infer<typeof ClosureItemSchema>;

export const LocationInfoSchema = z.object({
  id: IdSchema,
  name: z.string(),
  address: z.string().nullable(),
  phone: z.string().nullable(),
  timezone: z.string(),
});
export type LocationInfo = z.infer<typeof LocationInfoSchema>;

export const SettingsViewSchema = z.object({
  location: LocationInfoSchema,
  settings: LocationSettingsSchema,
  hours: z.array(LocationHoursSchema),
});
export type SettingsView = z.infer<typeof SettingsViewSchema>;

export const SettingsPatchBodySchema = z
  .object({
    location: z
      .object({ name: z.string().min(1).max(120).optional(), address: z.string().max(300).nullable().optional(), phone: z.string().max(40).nullable().optional() })
      .strict()
      .optional(),
    settings: LocationSettingsPatchSchema.optional(),
  })
  .strict();
export type SettingsPatchBody = z.infer<typeof SettingsPatchBodySchema>;
