import { z } from "zod";
import { IdSchema, LocalizedTextSchema } from "./common";

export const ServiceSpeciesSchema = z.enum(["DOG", "CAT", "ANY"]);
export type ServiceSpecies = z.infer<typeof ServiceSpeciesSchema>;
export const StageSchema = z.enum(["BATH", "DRY", "GROOM", "FINISH"]);
export type Stage = z.infer<typeof StageSchema>;
export const SkillSchema = z.enum(["BATHER", "GROOMER"]);
export type Skill = z.infer<typeof SkillSchema>;
export const BookingModeSchema = z.enum(["WAIT", "DROP_OFF"]);
export type BookingMode = z.infer<typeof BookingModeSchema>;
export const SizeClassSchema = z.enum(["S", "M", "L", "XL"]);
export type SizeClass = z.infer<typeof SizeClassSchema>;
export const CoatTypeSchema = z.enum(["SMOOTH", "DOUBLE", "CURLY", "WIRE", "LONG", "HAIRLESS"]);
export type CoatType = z.infer<typeof CoatTypeSchema>;

// ---------------------------------------------------------------- categories

export const CategorySchema = z.object({ name: LocalizedTextSchema, sort: z.number().int().min(0).optional() }).strict();
export type CategoryBody = z.infer<typeof CategorySchema>;

/** PATCH: any subset. */
export const CategoryPatchSchema = z.object({ name: LocalizedTextSchema.optional(), sort: z.number().int().min(0).optional() }).strict();
export type CategoryPatch = z.infer<typeof CategoryPatchSchema>;

export const CategoryItemSchema = z.object({ id: IdSchema, name: LocalizedTextSchema, sort: z.number().int().min(0) });
export type CategoryItem = z.infer<typeof CategoryItemSchema>;

// ------------------------------------------------------------------ services

export const ServiceSchema = z
  .object({
    categoryId: IdSchema.nullable().optional(),
    name: LocalizedTextSchema,
    description: LocalizedTextSchema.nullable().optional(),
    species: ServiceSpeciesSchema,
    stage: StageSchema,
    isMain: z.boolean(),
    resourceTypeId: IdSchema.nullable().optional(),
    requiredSkill: SkillSchema,
    bookingMode: BookingModeSchema.nullable().optional(),
    bufferAfterMin: z.number().int().min(0).max(120),
    onlineBookable: z.boolean(),
  })
  .strict();
export type ServiceBody = z.infer<typeof ServiceSchema>;

export const ServicePatchSchema = ServiceSchema.partial().extend({ active: z.boolean().optional() }).strict();
export type ServicePatch = z.infer<typeof ServicePatchSchema>;

export const ServiceQuerySchema = z.object({ includeInactive: z.enum(["true", "false"]).optional() }).strict();
export type ServiceQuery = z.infer<typeof ServiceQuerySchema>;

export const ServicePriceRowSchema = z
  .object({
    sizeClass: SizeClassSchema,
    coatType: CoatTypeSchema.nullable(),
    durationMin: z.number().int().min(1).max(480),
    priceCents: z.number().int().min(0).max(1_000_000),
  })
  .strict();
export type ServicePriceRow = z.infer<typeof ServicePriceRowSchema>;

/** Replaces the whole matrix: at most 4 sizes x 7 coats (6 coats + any), unique `(sizeClass, coatType)`. */
export const PriceMatrixSchema = z
  .array(ServicePriceRowSchema)
  .max(28)
  .refine((rows) => new Set(rows.map((r) => `${r.sizeClass}:${r.coatType ?? ""}`)).size === rows.length, "Duplicate (sizeClass, coatType)");
export type PriceMatrix = z.infer<typeof PriceMatrixSchema>;

export const ServiceViewSchema = z.object({
  id: IdSchema,
  categoryId: IdSchema.nullable(),
  name: LocalizedTextSchema,
  description: LocalizedTextSchema.nullable(),
  species: ServiceSpeciesSchema,
  stage: StageSchema,
  isMain: z.boolean(),
  resourceTypeId: IdSchema.nullable(),
  requiredSkill: SkillSchema,
  bookingMode: BookingModeSchema.nullable(),
  bufferAfterMin: z.number().int(),
  onlineBookable: z.boolean(),
  active: z.boolean(),
  prices: z.array(ServicePriceRowSchema),
});
export type ServiceView = z.infer<typeof ServiceViewSchema>;
