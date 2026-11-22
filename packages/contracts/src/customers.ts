import { z } from "zod";
import { IdSchema, IsoInstantSchema, LocaleSchema, PhoneE164Schema } from "./common";

const NameSchema = z.string().trim().min(1).max(120);
const EmailSchema = z.string().trim().toLowerCase().email().max(254);

/** Customer as seen by the customer (`/me`) and, with `privateNotes`, by staff. */
export const CustomerViewSchema = z.object({
  id: IdSchema,
  /** Null until the customer enters it. */
  name: z.string().nullable(),
  phone: PhoneE164Schema,
  email: z.string().nullable(),
  locale: LocaleSchema,
  emergencyPhone: PhoneE164Schema.nullable(),
  createdAt: IsoInstantSchema,
});
export type CustomerView = z.infer<typeof CustomerViewSchema>;

/** A linked sign-in account as shown on `/me` (never the provider subject). */
export const IdentityViewSchema = z.object({ provider: z.literal("GOOGLE"), email: z.string() });
export type IdentityView = z.infer<typeof IdentityViewSchema>;

/** `GET /me`: the customer view plus linked sign-in accounts. */
export const MeViewSchema = CustomerViewSchema.extend({ identities: z.array(IdentityViewSchema) });
export type MeView = z.infer<typeof MeViewSchema>;

/** Staff view; `privateNotes` is present for OWNER/RECEPTION only (decrypted). */
export const StaffCustomerViewSchema = CustomerViewSchema.extend({
  privateNotes: z.string().nullable().optional(),
});
export type StaffCustomerView = z.infer<typeof StaffCustomerViewSchema>;

export const CustomerQuerySchema = z.object({ q: z.string().trim().max(100).optional() }).strict();
export type CustomerQuery = z.infer<typeof CustomerQuerySchema>;

export const CustomerCreateSchema = z
  .object({
    name: NameSchema,
    phone: PhoneE164Schema,
    locale: LocaleSchema,
    email: EmailSchema.optional(),
    emergencyPhone: PhoneE164Schema.optional(),
  })
  .strict();
export type CustomerCreate = z.infer<typeof CustomerCreateSchema>;

export const CustomerPatchSchema = z
  .object({
    name: NameSchema.optional(),
    email: EmailSchema.nullable().optional(),
    locale: LocaleSchema.optional(),
    emergencyPhone: PhoneE164Schema.nullable().optional(),
    /** Empty string or null clears the notes. */
    privateNotes: z.string().max(4000).nullable().optional(),
  })
  .strict();
export type CustomerPatch = z.infer<typeof CustomerPatchSchema>;

export const MePatchSchema = CustomerPatchSchema.omit({ privateNotes: true }).strict();
export type MePatch = z.infer<typeof MePatchSchema>;
