import { z } from "zod";
import { IdSchema, LocalizedTextSchema } from "./common";

export const ResourceKindSchema = z.enum(["STATION", "KENNEL"]);
export type ResourceKind = z.infer<typeof ResourceKindSchema>;

/** POST body. `kind` is immutable after creation. */
export const ResourceTypeSchema = z.object({ name: LocalizedTextSchema, kind: ResourceKindSchema }).strict();
export type ResourceTypeBody = z.infer<typeof ResourceTypeSchema>;

/** PATCH body: `name` only (sending `kind` is a 400). */
export const ResourceTypePatchSchema = z.object({ name: LocalizedTextSchema }).strict();
export type ResourceTypePatch = z.infer<typeof ResourceTypePatchSchema>;

export const ResourceTypeItemSchema = z.object({
  id: IdSchema,
  name: LocalizedTextSchema,
  kind: ResourceKindSchema,
  resourceCount: z.number().int().min(0),
});
export type ResourceTypeItem = z.infer<typeof ResourceTypeItemSchema>;

export const ResourceSchema = z.object({ resourceTypeId: IdSchema, name: z.string().trim().min(1).max(60) }).strict();
export type ResourceBody = z.infer<typeof ResourceSchema>;

export const ResourcePatchSchema = z
  .object({ name: z.string().trim().min(1).max(60).optional(), active: z.boolean().optional() })
  .strict();
export type ResourcePatch = z.infer<typeof ResourcePatchSchema>;

export const ResourceQuerySchema = z
  .object({ kind: ResourceKindSchema.optional(), includeInactive: z.enum(["true", "false"]).optional() })
  .strict();
export type ResourceQuery = z.infer<typeof ResourceQuerySchema>;

export const ResourceItemSchema = z.object({
  id: IdSchema,
  name: z.string(),
  resourceTypeId: IdSchema,
  kind: ResourceKindSchema,
  active: z.boolean(),
});
export type ResourceItem = z.infer<typeof ResourceItemSchema>;
