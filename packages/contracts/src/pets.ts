import { z } from "zod";
import { CoatTypeSchema, SizeClassSchema } from "./catalog";
import { IdSchema, IsoDateSchema, IsoInstantSchema, PhoneE164Schema } from "./common";
import { VaccineTypeSchema } from "./settings";

export const SpeciesSchema = z.enum(["DOG", "CAT"]);
export type Species = z.infer<typeof SpeciesSchema>;
export const PetSexSchema = z.enum(["MALE", "FEMALE"]);
export type PetSex = z.infer<typeof PetSexSchema>;
export const TemperamentSchema = z.enum(["CALM", "NERVOUS", "REACTIVE", "NEEDS_MUZZLE"]);
export type Temperament = z.infer<typeof TemperamentSchema>;

/** Max pets per customer; the 21st create is `409 CONFLICT`. */
export const MAX_PETS_PER_CUSTOMER = 20;

const PetInputBase = z.object({
  name: z.string().trim().min(1).max(40),
  species: SpeciesSchema,
  breed: z.string().trim().min(1).max(60),
  breedCode: z.string().trim().min(1).max(60).nullish(),
  birthDate: IsoDateSchema.nullish(),
  sex: PetSexSchema.nullish(),
  neutered: z.boolean().nullish(),
  /** Grams. When set, `sizeClass` is derived from the location thresholds and a sent `sizeClass` is ignored. */
  weightG: z.number().int().min(1).max(150_000).nullish(),
  sizeClass: SizeClassSchema.nullish(),
  coatType: CoatTypeSchema.nullish(),
  temperament: z.array(TemperamentSchema).refine((t) => new Set(t).size === t.length, "temperament must be unique").optional(),
  allergies: z.array(z.string().trim().min(1).max(60)).max(20).optional(),
  /** Stored encrypted; empty string or null clears. */
  medicalNotes: z.string().max(2000).nullish(),
  behaviorNotes: z.string().max(1000).nullish(),
  vetName: z.string().trim().max(80).nullish(),
  vetPhone: PhoneE164Schema.nullish(),
});

export const PetInputSchema = PetInputBase.strict();
export type PetInput = z.infer<typeof PetInputSchema>;

export const PetPatchSchema = PetInputBase.partial().strict();
export type PetPatch = z.infer<typeof PetPatchSchema>;

export const StaffPetCreateSchema = PetInputBase.extend({ customerId: IdSchema }).strict();
export type StaffPetCreate = z.infer<typeof StaffPetCreateSchema>;

export const StaffPetQuerySchema = z
  .object({ customerId: IdSchema.optional(), q: z.string().trim().max(100).optional() })
  .strict();
export type StaffPetQuery = z.infer<typeof StaffPetQuerySchema>;

export const VaccineInputSchema = z.object({ type: VaccineTypeSchema, expiresOn: IsoDateSchema }).strict();
export type VaccineInput = z.infer<typeof VaccineInputSchema>;

export const VaccinePatchSchema = VaccineInputSchema.partial().strict();
export type VaccinePatch = z.infer<typeof VaccinePatchSchema>;

export const VaccineViewSchema = z.object({
  id: IdSchema,
  type: VaccineTypeSchema,
  expiresOn: IsoDateSchema,
  cardMediaId: IdSchema.nullable(),
  verified: z.boolean(),
  verifiedAt: IsoInstantSchema.nullable(),
});
export type VaccineView = z.infer<typeof VaccineViewSchema>;

export const PetViewSchema = z.object({
  id: IdSchema,
  customerId: IdSchema,
  name: z.string(),
  species: SpeciesSchema,
  breed: z.string(),
  breedCode: z.string().nullable(),
  birthDate: IsoDateSchema.nullable(),
  sex: PetSexSchema.nullable(),
  neutered: z.boolean().nullable(),
  weightG: z.number().int().nullable(),
  weightMeasuredAt: IsoInstantSchema.nullable(),
  sizeClass: SizeClassSchema.nullable(),
  coatType: CoatTypeSchema.nullable(),
  temperament: z.array(TemperamentSchema),
  allergies: z.array(z.string()),
  /** Decrypted. */
  medicalNotes: z.string().nullable(),
  behaviorNotes: z.string().nullable(),
  vetName: z.string().nullable(),
  vetPhone: PhoneE164Schema.nullable(),
  photoMediaId: IdSchema.nullable(),
  vaccines: z.array(VaccineViewSchema),
});
export type PetView = z.infer<typeof PetViewSchema>;
