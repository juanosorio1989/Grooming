import { z } from "zod";
import { IdSchema, IsoInstantSchema } from "./common";

/** `<ISO instant>_<uuid>` of the last item of a page. */
export const AuditCursorSchema = z
  .string()
  .regex(/^[^_]+_[0-9a-fA-F-]{36}$/)
  .refine((s) => {
    const [at, id] = s.split("_") as [string, string];
    return IsoInstantSchema.safeParse(at).success && IdSchema.safeParse(id).success;
  }, "Invalid cursor");

export const AuditQuerySchema = z
  .object({
    entity: z.string().min(1).optional(),
    entityId: z.string().min(1).optional(),
    limit: z.coerce.number().int().min(1).max(100).default(50),
    /** Opaque keyset cursor `<ISO at>_<id>`: pass the previous page's `nextBefore`. */
    before: AuditCursorSchema.optional(),
  })
  .strict();
export type AuditQuery = z.infer<typeof AuditQuerySchema>;

export const AuditItemSchema = z.object({
  id: z.string().uuid(),
  at: IsoInstantSchema,
  actorType: z.enum(["STAFF", "CUSTOMER", "SYSTEM"]),
  actorId: z.string().uuid().nullable(),
  action: z.string(),
  entity: z.string(),
  entityId: z.string().nullable(),
  before: z.unknown().nullable(),
  after: z.unknown().nullable(),
});
export type AuditItem = z.infer<typeof AuditItemSchema>;

export const AuditPageSchema = z.object({
  items: z.array(AuditItemSchema),
  nextBefore: AuditCursorSchema.nullable(),
});
export type AuditPage = z.infer<typeof AuditPageSchema>;
