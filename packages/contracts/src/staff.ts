import { z } from "zod";
import { EmailSchema, StaffRoleSchema } from "./auth";
import { SkillSchema } from "./catalog";
import { IdSchema, IsoInstantSchema, LocaleSchema, LocalizedTextSchema, WallTimeSchema } from "./common";

const SkillsSchema = z.array(SkillSchema).max(2).refine((s) => new Set(s).size === s.length, "skills must be unique");

export const EmployeeCreateSchema = z
  .object({
    displayName: z.string().trim().min(1).max(60),
    role: StaffRoleSchema.default("EMPLOYEE"),
    email: EmailSchema.nullable().optional(),
    locale: LocaleSchema,
    skills: SkillsSchema,
    bookableOnline: z.boolean().default(true),
    bio: LocalizedTextSchema.nullable().optional(),
  })
  .strict();
export type EmployeeCreate = z.infer<typeof EmployeeCreateSchema>;

/** Any subset of the create fields (no defaults are applied) plus `active`. */
export const EmployeePatchSchema = z
  .object({
    displayName: z.string().trim().min(1).max(60),
    role: StaffRoleSchema,
    email: EmailSchema.nullable(),
    locale: LocaleSchema,
    skills: SkillsSchema,
    bookableOnline: z.boolean(),
    bio: LocalizedTextSchema.nullable(),
    active: z.boolean(),
  })
  .partial()
  .strict();
export type EmployeePatch = z.infer<typeof EmployeePatchSchema>;

export const EmployeeQuerySchema = z.object({ includeInactive: z.enum(["true", "false"]).optional() }).strict();
export type EmployeeQuery = z.infer<typeof EmployeeQuerySchema>;

/** `email` is omitted for EMPLOYEE callers. */
export const EmployeeViewSchema = z.object({
  id: IdSchema,
  displayName: z.string(),
  role: StaffRoleSchema,
  email: EmailSchema.nullable().optional(),
  locale: LocaleSchema,
  active: z.boolean(),
  canLogin: z.boolean(),
  skills: z.array(SkillSchema),
  bookableOnline: z.boolean(),
  bio: LocalizedTextSchema.nullable(),
  serviceIds: z.array(IdSchema),
});
export type EmployeeView = z.infer<typeof EmployeeViewSchema>;

export const EmployeeServicesSchema = z.object({ serviceIds: z.array(IdSchema).max(500) }).strict();
export type EmployeeServicesBody = z.infer<typeof EmployeeServicesSchema>;

export const WorkingHoursRowSchema = z
  .object({ weekday: z.number().int().min(0).max(6), start: WallTimeSchema, end: WallTimeSchema })
  .strict()
  .refine((r) => r.start !== "24:00" && r.start < r.end, "start must be before end");
export type WorkingHoursRow = z.infer<typeof WorkingHoursRowSchema>;

export const WorkingHoursSchema = z.array(WorkingHoursRowSchema).max(21);
export type WorkingHoursBody = z.infer<typeof WorkingHoursSchema>;

export const TimeOffKindSchema = z.enum(["VACATION", "BLOCK"]);
export type TimeOffKind = z.infer<typeof TimeOffKindSchema>;

const TimeOffBase = z.object({
  staffUserId: IdSchema,
  startsAt: IsoInstantSchema,
  endsAt: IsoInstantSchema,
  kind: TimeOffKindSchema,
  note: z.string().trim().max(200).nullable().optional(),
});

const endsAfterStart = (r: { startsAt?: string; endsAt?: string }) =>
  r.startsAt === undefined || r.endsAt === undefined || Date.parse(r.endsAt) > Date.parse(r.startsAt);

export const TimeOffSchema = TimeOffBase.strict().refine(endsAfterStart, "endsAt must be after startsAt");
export type TimeOffBody = z.infer<typeof TimeOffSchema>;

/** PATCH: any subset; the merged range is re-checked by the service. `staffUserId` is immutable. */
export const TimeOffPatchSchema = TimeOffBase.omit({ staffUserId: true })
  .partial()
  .strict()
  .refine(endsAfterStart, "endsAt must be after startsAt");
export type TimeOffPatch = z.infer<typeof TimeOffPatchSchema>;

export const TimeOffQuerySchema = z
  .object({ staffUserId: IdSchema.optional(), from: IsoInstantSchema.optional(), to: IsoInstantSchema.optional() })
  .strict();
export type TimeOffQuery = z.infer<typeof TimeOffQuerySchema>;

export const TimeOffItemSchema = z.object({
  id: IdSchema,
  staffUserId: IdSchema,
  startsAt: IsoInstantSchema,
  endsAt: IsoInstantSchema,
  kind: TimeOffKindSchema,
  note: z.string().nullable(),
});
export type TimeOffItem = z.infer<typeof TimeOffItemSchema>;
