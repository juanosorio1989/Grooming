import { Injectable, NotFoundException } from "@nestjs/common";
import type { PetPlan, PetRequest, Slot } from "@grooming/availability";
import { lookupPrice, type ServicePriceRow } from "@grooming/pricing";
import { Prisma } from "@prisma/client";
import { appointmentStartsAt } from "./appointment-view.js";

/** Details of a pet not saved yet, kept in `pet_visit.pending_pet` until the booking is confirmed. */
export type PendingPet = {
  ref: string;
  /** Needed to create the pet on confirm and to find same-species matches. */
  species: PetRequest["species"];
  name: string;
  breed: string;
  breedCode: string | null;
  weightG: number | null;
};

/**
 * A validated plan to store. `slot.pets[i]`, `pets[i]`, `petIds[i]` and
 * `pendingPets[i]` describe the pet at position `i`; exactly one of
 * `petIds[i]` / `pendingPets[i]` is set. `prices` is the matrix the plan was
 * validated against.
 */
export interface PlanWrite {
  orgId: string;
  locationId: string;
  slot: Slot;
  pets: PetRequest[];
  petIds: (string | null)[];
  pendingPets: (PendingPet | null)[];
  prices: ServicePriceRow[];
}

const iso = (d: Date) => d.toISOString();

/**
 * Writes a validated slot as pet visits, visit services and segments. It never
 * re-checks the plan (that is `validatePlan`, outside the transaction); the
 * exclusion constraints catch races (`23P01` → 409 SLOT_TAKEN).
 */
@Injectable()
export class PlanWriter {
  /**
   * Inserts pet_visit (+ position, snapshots, kennelResourceId = the pet's
   * KENNEL segment resource), pet_visit_service and appointment_segment rows
   * for a new appointment that already exists.
   */
  async insert(tx: Prisma.TransactionClient, appointmentId: string, w: PlanWrite): Promise<void> {
    const n = w.slot.pets.length;
    if (w.pets.length !== n || w.petIds.length !== n || w.pendingPets.length !== n) {
      throw new Error("PlanWriter.insert: slot, pets, petIds and pendingPets differ in length");
    }
    for (const [position, plan] of w.slot.pets.entries()) {
      const request = requestFor(w.pets, position, plan);
      const petId = w.petIds[position] ?? null;
      const pending = w.pendingPets[position] ?? null;
      if ((petId === null) === (pending === null)) {
        throw new Error(`PlanWriter.insert: pet ${position} needs exactly one of petId and pendingPet`);
      }
      const visit = await tx.petVisit.create({
        data: {
          organizationId: w.orgId,
          appointmentId,
          petId,
          pendingPet: pending ?? Prisma.DbNull,
          position,
          status: "BOOKED",
          sizeClassAtBooking: request.sizeClass,
          coatTypeAtBooking: request.coatType,
          preferredGroomerId: request.preferredGroomerId === "ANY" ? null : request.preferredGroomerId,
          kennelResourceId: kennelOf(plan),
          priceCentsQuoted: plan.priceCents,
        },
        select: { id: true },
      });
      await tx.petVisitService.createMany({
        data: serviceTerms(w.prices, request).map((t) => ({ organizationId: w.orgId, petVisitId: visit.id, ...t })),
      });
      await this.insertSegments(tx, w.orgId, appointmentId, visit.id, plan);
    }
  }

  /**
   * Reschedule/move: deletes the segments of the live visits, inserts the slot's
   * segments for them, refreshes pet_visit_service snapshots, priceCentsQuoted,
   * kennelResourceId, appointment.dropOffAt and estimatedReadyAt. The live
   * visits are the list `PetRequestResolver.fromAppointment` rebuilds the
   * request from (not CANCELLED, position order), matched by index to
   * `slot.pets`; a CANCELLED visit keeps its rows. Returns before/after times
   * for the audit (`appointmentStartsAt`). 404 when the appointment is not in `orgId`.
   */
  async replace(
    tx: Prisma.TransactionClient,
    appointmentId: string,
    w: Omit<PlanWrite, "petIds" | "pendingPets">,
  ): Promise<{ before: { startsAt: string; readyAt: string | null }; after: { startsAt: string; readyAt: string } }> {
    const appt = await tx.appointment.findFirst({
      where: { id: appointmentId, organizationId: w.orgId },
      select: {
        bookingMode: true,
        dropOffAt: true,
        estimatedReadyAt: true,
        petVisits: { where: { status: { not: "CANCELLED" } }, orderBy: { position: "asc" }, select: { id: true, petId: true } },
        segments: { select: { stage: true, startsAt: true, occupies: true } },
      },
    });
    if (!appt) throw new NotFoundException({ code: "NOT_FOUND" });
    const n = w.slot.pets.length;
    if (w.pets.length !== n || appt.petVisits.length !== n) {
      throw new Error("PlanWriter.replace: the slot does not match the appointment's visits");
    }

    const beforeStart = appointmentStartsAt(appt, appt.segments);
    if (beforeStart === null) throw new Error("PlanWriter.replace: the appointment has no start time");
    const before = { startsAt: iso(beforeStart), readyAt: appt.estimatedReadyAt ? iso(appt.estimatedReadyAt) : null };
    const visitIds = appt.petVisits.map((v) => v.id);

    // Old rows go first, so the new segments may overlap the old times.
    await tx.appointmentSegment.deleteMany({ where: { appointmentId, organizationId: w.orgId, petVisitId: { in: visitIds } } });
    for (const [position, plan] of w.slot.pets.entries()) {
      const visit = appt.petVisits[position];
      if (!visit || visit.petId !== plan.petId) throw new Error(`PlanWriter.replace: visit ${position} does not match the plan`);
      const request = requestFor(w.pets, position, plan);
      await tx.petVisit.update({
        where: { id: visit.id },
        data: { priceCentsQuoted: plan.priceCents, kennelResourceId: kennelOf(plan) },
      });
      // Upsert keeps the rows (and their ids, which order the services when the request is rebuilt).
      // It never deletes: the slot's services must equal the visit's existing services (reschedule
      // and move rebuild the request from the appointment, so they cannot add or drop a service).
      for (const t of serviceTerms(w.prices, request)) {
        await tx.petVisitService.upsert({
          where: { petVisitId_serviceId: { petVisitId: visit.id, serviceId: t.serviceId } },
          update: { priceCents: t.priceCents, durationMin: t.durationMin },
          create: { organizationId: w.orgId, petVisitId: visit.id, ...t },
        });
      }
      await this.insertSegments(tx, w.orgId, appointmentId, visit.id, plan);
    }
    await tx.appointment.update({
      where: { id: appointmentId },
      data: {
        dropOffAt: w.slot.bookingMode === "DROP_OFF" ? new Date(w.slot.start) : null,
        estimatedReadyAt: new Date(w.slot.readyAt),
      },
    });
    return { before, after: { startsAt: iso(new Date(w.slot.start)), readyAt: iso(new Date(w.slot.readyAt)) } };
  }

  private async insertSegments(tx: Prisma.TransactionClient, orgId: string, appointmentId: string, petVisitId: string, plan: PetPlan) {
    await tx.appointmentSegment.createMany({
      data: plan.segments.map((s) => ({
        organizationId: orgId,
        appointmentId,
        petVisitId,
        stage: s.stage,
        serviceId: s.serviceIds.length === 1 ? s.serviceIds[0]! : null,
        staffUserId: s.employeeId,
        resourceId: s.resourceId,
        startsAt: new Date(s.start),
        endsAt: new Date(s.end),
        blockEndsAt: new Date(s.blockEnd),
        durationMin: s.durationMin,
        priceCents: s.priceCents,
      })),
    });
  }
}

/** The request for the pet at `position`; it must be the same engine pet as the plan. */
function requestFor(pets: PetRequest[], position: number, plan: PetPlan): PetRequest {
  const request = pets[position];
  if (!request || request.petId !== plan.petId) throw new Error(`PlanWriter: pet ${position} does not match the plan`);
  return request;
}

/** The pet's KENNEL segment resource (drop-off mode), else null. */
function kennelOf(plan: PetPlan): string | null {
  return plan.segments.find((s) => s.stage === "KENNEL")?.resourceId ?? null;
}

/** Matrix price and duration of each requested service; a missing row means the plan was not validated against `prices`. */
function serviceTerms(prices: ServicePriceRow[], r: PetRequest): { serviceId: string; priceCents: number; durationMin: number }[] {
  return r.serviceIds.map((serviceId) => {
    const terms = lookupPrice(prices, serviceId, r.sizeClass, r.coatType);
    if (!terms) throw new Error(`PlanWriter: no price for service ${serviceId}`);
    return { serviceId, ...terms };
  });
}
