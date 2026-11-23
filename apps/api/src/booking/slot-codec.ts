import { BadRequestException, ConflictException, type HttpException } from "@nestjs/common";
import type { AvailabilityError, PetPlan, PlanRejection, Slot } from "@grooming/availability";
import type { PetPlanView, SlotView } from "@grooming/contracts";

/** How a pet is labeled in views: the saved pet's id or the inline `ref`. The engine pet id is that same value. */
export type PetLabel = { petId: string } | { ref: string };

const iso = (ms: number) => new Date(ms).toISOString();

/**
 * Engine slot from a client-sent view (the hold, reschedule and staff bodies
 * carry the slot exactly as `/availability` returned it). Each pet's engine id
 * is its `petId` or `ref`; a pet missing from `labels` is 400.
 */
export function slotFromView(view: SlotView, labels: Map<string, PetLabel>): Slot {
  return {
    start: Date.parse(view.startsAt),
    readyAt: Date.parse(view.readyAt),
    bookingMode: view.bookingMode,
    pets: view.pets.map((p, i): PetPlan => {
      const petId = p.petId ?? p.ref;
      const label = petId === undefined ? undefined : labels.get(petId);
      const matches = label !== undefined && ("petId" in label ? label.petId === p.petId : label.ref === p.ref);
      if (!matches || petId === undefined) {
        throw new BadRequestException({
          code: "VALIDATION_FAILED",
          message: "Validation failed",
          errors: [{ path: `slot.pets.${i}`, message: "Unknown pet" }],
        });
      }
      return {
        petId,
        priceCents: p.priceCents,
        segments: p.segments.map((s) => ({
          petId,
          stage: s.stage,
          serviceIds: s.serviceIds,
          employeeId: s.employeeId,
          resourceId: s.resourceId,
          start: Date.parse(s.startsAt),
          end: Date.parse(s.endsAt),
          blockEnd: Date.parse(s.blockEndsAt),
          durationMin: s.durationMin,
          priceCents: s.priceCents,
        })),
      };
    }),
  };
}

/** The API view of an engine slot; each pet carries back its `petId` or `ref`. */
export function toSlotView(slot: Slot, labels: Map<string, PetLabel>): SlotView {
  return {
    startsAt: iso(slot.start),
    readyAt: iso(slot.readyAt),
    bookingMode: slot.bookingMode,
    pets: slot.pets.map(
      (p): PetPlanView => ({
        ...(labels.get(p.petId) ?? { ref: p.petId }),
        priceCents: p.priceCents,
        segments: p.segments.map((s) => ({
          stage: s.stage,
          serviceIds: s.serviceIds,
          employeeId: s.employeeId,
          resourceId: s.resourceId,
          startsAt: iso(s.start),
          endsAt: iso(s.end),
          blockEndsAt: iso(s.blockEnd),
          durationMin: s.durationMin,
          priceCents: s.priceCents,
        })),
      }),
    ),
  };
}

/** Engine input errors are 400, never 500: two codes keep their name, the rest are VALIDATION_FAILED with the code as detail. */
export function engineError(err: AvailabilityError): BadRequestException {
  if (err.code === "NO_PRICE_FOR_PET" || err.code === "STAGE_RESOURCE_MISMATCH") {
    return new BadRequestException({ code: err.code, message: err.code });
  }
  return new BadRequestException({ code: "VALIDATION_FAILED", message: err.code });
}

/** Rejections that mean "the time is gone": the client refreshes its slots. */
const TAKEN: ReadonlySet<PlanRejection> = new Set(["EMPLOYEE_UNAVAILABLE", "RESOURCE_UNAVAILABLE", "TOO_SOON"]);

/** EMPLOYEE_UNAVAILABLE | RESOURCE_UNAVAILABLE | TOO_SOON → 409 SLOT_TAKEN; else 400 VALIDATION_FAILED, detail = reason. */
export function verdictError(reason: PlanRejection): HttpException {
  if (TAKEN.has(reason)) return new ConflictException({ code: "SLOT_TAKEN", message: "That time was just taken" });
  return new BadRequestException({ code: "VALIDATION_FAILED", message: reason });
}
