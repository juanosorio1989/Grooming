import { z } from "zod";
import { AppointmentViewSchema } from "./booking";
import { IdSchema, IsoInstantSchema } from "./common";
import { CustomerViewSchema, IdentityViewSchema } from "./customers";
import { PetViewSchema, VaccineViewSchema } from "./pets";

/** Notification channels a consent applies to. */
export const NotificationChannelSchema = z.enum(["WHATSAPP", "SMS", "EMAIL"]);
export type NotificationChannel = z.infer<typeof NotificationChannelSchema>;

/**
 * `GET /me/export`: everything the shop holds about the signed-in customer.
 * Never contains staff-only private notes or provider subjects. Media rows have
 * no download links yet (they arrive with the media plan).
 */
export const MeExportSchema = z.object({
  exportedAt: IsoInstantSchema,
  customer: CustomerViewSchema,
  identities: z.array(IdentityViewSchema.extend({ linkedAt: IsoInstantSchema })),
  consents: z.array(
    z.object({ channel: NotificationChannelSchema, granted: z.boolean(), source: z.string(), changedAt: IsoInstantSchema }),
  ),
  pets: z.array(PetViewSchema.extend({ vaccines: z.array(VaccineViewSchema) })),
  appointments: z.array(AppointmentViewSchema),
  media: z.array(z.object({ id: IdSchema, kind: z.string(), petId: IdSchema, createdAt: IsoInstantSchema })),
});
export type MeExport = z.infer<typeof MeExportSchema>;
