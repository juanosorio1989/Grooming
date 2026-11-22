import { z } from "zod";
import { CoatTypeSchema, SizeClassSchema } from "./catalog";
import { IdSchema, IsoDateSchema, IsoInstantSchema, MoneyCentsSchema } from "./common";

/** A range is at most this many local dates (`to - from < 7`). */
export const MAX_AVAILABILITY_DAYS = 7;
/** Max length of the URL-decoded `pets` query value. */
export const MAX_AVAILABILITY_PETS_CHARS = 4000;

const PetChoiceBase = {
  serviceIds: z.array(IdSchema).min(1).max(6),
  preferredGroomerId: z.union([IdSchema, z.literal("ANY")]).default("ANY"),
};

/** A saved pet of the signed-in owner (`petId`), or an inline pet (`ref` "new-1".."new-4") for visitors and new pets. */
export const AvailabilityPetSchema = z.union([
  z
    .object({ petId: IdSchema, sizeClass: SizeClassSchema.optional(), coatType: CoatTypeSchema.optional(), ...PetChoiceBase })
    .strict(),
  z
    .object({
      ref: z.string().regex(/^new-[1-4]$/),
      species: z.enum(["DOG", "CAT"]),
      sizeClass: SizeClassSchema,
      coatType: CoatTypeSchema,
      ...PetChoiceBase,
    })
    .strict(),
]);
export type AvailabilityPet = z.infer<typeof AvailabilityPetSchema>;

const PetsListSchema = z.array(AvailabilityPetSchema).min(1).max(4);

/** `pets` arrives as a URL-encoded JSON string (Express's simple query parser has no nested objects). */
const PetsParamSchema = z
  .string()
  .max(MAX_AVAILABILITY_PETS_CHARS)
  .transform((raw, ctx) => {
    try {
      return JSON.parse(raw) as unknown;
    } catch {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "pets must be a JSON array" });
      return z.NEVER;
    }
  })
  .pipe(PetsListSchema);

const dayIndex = (d: string) => Date.parse(`${d}T00:00:00Z`) / 86_400_000;

/** Query string: from, to? (defaults to from), pets = URL-encoded JSON array (≤ 4000 chars), 1..4 entries. */
export const AvailabilityQuerySchema = z
  .object({ from: IsoDateSchema, to: IsoDateSchema.optional(), pets: PetsParamSchema })
  .strict()
  .superRefine((q, ctx) => {
    if (q.to === undefined) return;
    const span = dayIndex(q.to) - dayIndex(q.from);
    if (span < 0) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["to"], message: "to must not be before from" });
    else if (span >= MAX_AVAILABILITY_DAYS)
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["to"], message: `A range covers at most ${MAX_AVAILABILITY_DAYS} days` });
  });
export type AvailabilityQuery = z.infer<typeof AvailabilityQuerySchema>;

export const SegmentViewSchema = z.object({
  stage: z.enum(["BATH", "DRY", "GROOM", "FINISH", "KENNEL"]),
  serviceIds: z.array(IdSchema),
  employeeId: IdSchema.nullable(),
  resourceId: IdSchema.nullable(),
  startsAt: IsoInstantSchema,
  endsAt: IsoInstantSchema,
  blockEndsAt: IsoInstantSchema,
  durationMin: z.number().int().positive(),
  priceCents: MoneyCentsSchema,
});
export type SegmentView = z.infer<typeof SegmentViewSchema>;

/** One pet's plan; `petId` for a saved pet, `ref` for an inline one. */
export const PetPlanViewSchema = z.object({
  petId: IdSchema.optional(),
  ref: z.string().optional(),
  priceCents: MoneyCentsSchema,
  segments: z.array(SegmentViewSchema).min(1),
});
export type PetPlanView = z.infer<typeof PetPlanViewSchema>;

export const SlotViewSchema = z.object({
  startsAt: IsoInstantSchema,
  readyAt: IsoInstantSchema,
  bookingMode: z.enum(["WAIT", "DROP_OFF"]),
  pets: z.array(PetPlanViewSchema).min(1).max(4),
});
export type SlotView = z.infer<typeof SlotViewSchema>;

export const AvailabilityResponseSchema = z.object({
  bookingMode: z.enum(["WAIT", "DROP_OFF"]),
  slots: z.array(SlotViewSchema),
});
export type AvailabilityResponse = z.infer<typeof AvailabilityResponseSchema>;
