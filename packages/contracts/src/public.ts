import { z } from "zod";
import { IdSchema, LocalizedTextSchema } from "./common";
import { BookingModeSchema, CoatTypeSchema, ServicePriceRowSchema, ServiceSpeciesSchema, SkillSchema, StageSchema } from "./catalog";
import { LocationHoursSchema } from "./settings";

export const PublicLocationSchema = z.object({
  id: IdSchema,
  name: z.string(),
  address: z.string().nullable(),
  phone: z.string().nullable(),
  timezone: z.string(),
  defaultBookingMode: BookingModeSchema,
  hours: z.array(LocationHoursSchema),
});
export type PublicLocation = z.infer<typeof PublicLocationSchema>;

export const PublicServiceSchema = z.object({
  id: IdSchema,
  categoryId: IdSchema.nullable(),
  name: LocalizedTextSchema,
  description: LocalizedTextSchema.nullable(),
  species: ServiceSpeciesSchema,
  stage: StageSchema,
  isMain: z.boolean(),
  bookingMode: BookingModeSchema.nullable(),
  prices: z.array(ServicePriceRowSchema),
});
export type PublicService = z.infer<typeof PublicServiceSchema>;

export const PublicServicesSchema = z.object({
  categories: z.array(z.object({ id: IdSchema, name: LocalizedTextSchema, sort: z.number().int() })),
  services: z.array(PublicServiceSchema),
});
export type PublicServices = z.infer<typeof PublicServicesSchema>;

export const PublicEmployeeSchema = z.object({
  id: IdSchema,
  displayName: z.string(),
  bio: LocalizedTextSchema.nullable(),
  photoUrl: z.string().nullable(),
  skills: z.array(SkillSchema),
  serviceIds: z.array(IdSchema),
});
export type PublicEmployee = z.infer<typeof PublicEmployeeSchema>;

export const BreedQuerySchema = z.object({ species: z.enum(["DOG", "CAT"]).optional() }).strict();
export type BreedQuery = z.infer<typeof BreedQuerySchema>;

export const BreedSchema = z.object({
  code: z.string().regex(/^[a-z0-9]+(-[a-z0-9]+)*$/),
  species: z.enum(["DOG", "CAT"]),
  en: z.string(),
  es: z.string(),
  defaultCoat: CoatTypeSchema.nullable(),
});
export type Breed = z.infer<typeof BreedSchema>;
