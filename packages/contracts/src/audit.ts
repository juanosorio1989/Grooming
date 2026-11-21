import { z } from "zod";
import { IsoInstantSchema } from "./common";

export const AuditQuerySchema = z
  .object({
    entity: z.string().min(1).optional(),
    entityId: z.string().min(1).optional(),
    limit: z.coerce.number().int().min(1).max(100).default(50),
    /** Exclusive upper bound on `at` (an ISO instant); pass the previous page's `nextBefore`. */
    before: IsoInstantSchema.optional(),
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
  nextBefore: IsoInstantSchema.nullable(),
});
export type AuditPage = z.infer<typeof AuditPageSchema>;
