import { z } from "zod";
import { AvailabilityNewPetSchema, AvailabilitySavedPetSchema, SlotViewSchema } from "./availability";
import { IdSchema, IsoInstantSchema, MoneyCentsSchema } from "./common";

const BookingModeSchema = z.enum(["WAIT", "DROP_OFF"]);

/** Details a new (not yet saved) pet needs to be created when the booking is confirmed. */
export const NewPetDetailsSchema = {
  name: z.string().trim().min(1).max(40),
  breed: z.string().trim().min(1).max(60),
  breedCode: z.string().trim().min(1).max(60).nullish(),
  weightG: z.number().int().min(1).max(150_000).nullish(),
};

/** A saved pet, or an inline pet plus the details to save it. */
export const HoldPetSchema = z.union([AvailabilitySavedPetSchema, AvailabilityNewPetSchema.extend(NewPetDetailsSchema).strict()]);
export type HoldPet = z.infer<typeof HoldPetSchema>;

const label = (p: { petId?: string; ref?: string }) => p.petId ?? p.ref;

/** The slot must list the same pets, in the same order, as `pets` (matched by `petId` or `ref`). */
function slotMatchesPets(
  v: { pets: { petId?: string; ref?: string }[]; slot: { pets: { petId?: string; ref?: string }[] } },
  ctx: z.RefinementCtx,
): void {
  const same = v.slot.pets.length === v.pets.length && v.pets.every((p, i) => label(p) === label(v.slot.pets[i] ?? {}));
  if (!same)
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["slot"], message: "slot.pets must match pets in the same order" });
}

export const HoldRequestSchema = z
  .object({ pets: z.array(HoldPetSchema).min(1).max(4), slot: SlotViewSchema, replaceHoldId: IdSchema.optional() })
  .strict()
  .superRefine(slotMatchesPets);
export type HoldRequest = z.infer<typeof HoldRequestSchema>;

export const HoldResponseSchema = z.object({ holdId: IdSchema, expiresAt: IsoInstantSchema });
export type HoldResponse = z.infer<typeof HoldResponseSchema>;

/** A saved pet of the customer that may be the same animal as a new pet in the hold. */
export const PetMatchSchema = z.object({
  petId: IdSchema,
  name: z.string(),
  breed: z.string(),
  weightG: z.number().int().nullable(),
});
export type PetMatch = z.infer<typeof PetMatchSchema>;

export const HoldViewSchema = z.object({
  holdId: IdSchema,
  expiresAt: IsoInstantSchema,
  bookingMode: BookingModeSchema,
  startsAt: IsoInstantSchema,
  readyAt: IsoInstantSchema,
  pets: z.array(
    z.object({
      visitId: IdSchema,
      petId: IdSchema.nullable(),
      ref: z.string().nullable(),
      name: z.string(),
      priceCents: MoneyCentsSchema,
      matches: z.array(PetMatchSchema),
    }),
  ),
});
export type HoldView = z.infer<typeof HoldViewSchema>;

/** Confirms a hold. `usePets` maps a new pet's `ref` to a saved pet to book instead of creating one. */
export const AppointmentCreateSchema = z
  .object({
    holdId: IdSchema,
    notes: z.string().trim().max(500).optional(),
    usePets: z.record(z.string().regex(/^new-[1-4]$/), IdSchema).optional(),
  })
  .strict();
export type AppointmentCreate = z.infer<typeof AppointmentCreateSchema>;

export const AppointmentStatusSchema = z.enum(["HELD", "BOOKED", "IN_SHOP", "COMPLETED", "CANCELLED", "NO_SHOW"]);
export type AppointmentStatus = z.infer<typeof AppointmentStatusSchema>;

/** `startsAt` = `dropOffAt` in drop-off mode, else the earliest work segment start. */
export const AppointmentViewSchema = z.object({
  id: IdSchema,
  status: AppointmentStatusSchema,
  source: z.enum(["ONLINE", "RECEPTION", "WALK_IN"]),
  bookingMode: BookingModeSchema,
  startsAt: IsoInstantSchema,
  dropOffAt: IsoInstantSchema.nullable(),
  estimatedReadyAt: IsoInstantSchema.nullable(),
  notes: z.string().nullable(),
  cancelledAt: IsoInstantSchema.nullable(),
  pets: z.array(
    z.object({
      visitId: IdSchema,
      petId: IdSchema,
      petName: z.string(),
      status: z.string(),
      priceCentsQuoted: MoneyCentsSchema,
      services: z.array(z.object({ serviceId: IdSchema, priceCents: MoneyCentsSchema, durationMin: z.number().int().positive() })),
      segments: z.array(
        z.object({
          id: IdSchema,
          stage: z.enum(["BATH", "DRY", "GROOM", "FINISH", "KENNEL"]),
          employeeId: IdSchema.nullable(),
          resourceId: IdSchema.nullable(),
          startsAt: IsoInstantSchema,
          endsAt: IsoInstantSchema,
        }),
      ),
    }),
  ),
});
export type AppointmentView = z.infer<typeof AppointmentViewSchema>;

export const StaffAppointmentViewSchema = AppointmentViewSchema.extend({
  customerId: IdSchema,
  createdByStaffId: IdSchema.nullable(),
  cancelReason: z.string().nullable(),
});
export type StaffAppointmentView = z.infer<typeof StaffAppointmentViewSchema>;

export const MeAppointmentsQuerySchema = z.object({ scope: z.enum(["upcoming", "past"]).default("upcoming") }).strict();
export type MeAppointmentsQuery = z.infer<typeof MeAppointmentsQuerySchema>;

export const RescheduleSchema = z.object({ slot: SlotViewSchema }).strict();
export type Reschedule = z.infer<typeof RescheduleSchema>;

export const StaffMoveSchema = z.object({ slot: SlotViewSchema, override: z.boolean().default(false) }).strict();
export type StaffMove = z.infer<typeof StaffMoveSchema>;

export const StaffBookingSchema = z
  .object({
    customerId: IdSchema,
    pets: z.array(HoldPetSchema).min(1).max(4),
    slot: SlotViewSchema,
    override: z.boolean().default(false),
    notes: z.string().trim().max(500).optional(),
  })
  .strict()
  .superRefine(slotMatchesPets);
export type StaffBooking = z.infer<typeof StaffBookingSchema>;

export const WalkInSchema = z
  .object({ customerId: IdSchema, pets: z.array(HoldPetSchema).min(1).max(4), override: z.boolean().default(false) })
  .strict();
export type WalkIn = z.infer<typeof WalkInSchema>;

export const StaffStatusSchema = z
  .object({ action: z.enum(["CANCEL", "NO_SHOW"]), reason: z.string().trim().max(200).optional() })
  .strict();
export type StaffStatus = z.infer<typeof StaffStatusSchema>;
