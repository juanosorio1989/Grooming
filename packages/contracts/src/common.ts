import { z } from "zod";

export const IdSchema = z.string().uuid();
export type Id = z.infer<typeof IdSchema>;

export const PhoneE164Schema = z.string().regex(/^\+[1-9]\d{7,14}$/);
export type PhoneE164 = z.infer<typeof PhoneE164Schema>;

export const LocaleSchema = z.enum(["en", "es"]);
export type Locale = z.infer<typeof LocaleSchema>;

export const LocalizedTextSchema = z.object({ en: z.string().min(1), es: z.string().min(1) });
export type LocalizedText = z.infer<typeof LocalizedTextSchema>;

export const MoneyCentsSchema = z.number().int().nonnegative();
export type MoneyCents = z.infer<typeof MoneyCentsSchema>;

export const IsoDateSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .refine((s) => {
    const d = new Date(`${s}T00:00:00Z`);
    return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
  }, "Invalid date");
export type IsoDate = z.infer<typeof IsoDateSchema>;

export const IsoInstantSchema = z.string().datetime({ offset: true });
export type IsoInstant = z.infer<typeof IsoInstantSchema>;
