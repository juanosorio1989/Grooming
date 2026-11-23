import type { AppointmentView, StaffAppointmentView } from "@grooming/contracts";
import type { Prisma } from "@prisma/client";

/** What `toAppointmentView` needs: visits in position order with pet name, services and segments (start order). */
export const APPOINTMENT_VIEW_INCLUDE = {
  petVisits: {
    orderBy: { position: "asc" },
    include: {
      pet: { select: { name: true } },
      services: { orderBy: { id: "asc" }, select: { serviceId: true, priceCents: true, durationMin: true } },
      segments: {
        orderBy: [{ startsAt: "asc" }, { id: "asc" }],
        select: { id: true, stage: true, staffUserId: true, resourceId: true, startsAt: true, endsAt: true, occupies: true },
      },
    },
  },
} satisfies Prisma.AppointmentInclude;

export type AppointmentWithVisits = Prisma.AppointmentGetPayload<{ include: typeof APPOINTMENT_VIEW_INCLUDE }>;

const iso = (d: Date | null) => (d ? d.toISOString() : null);

/**
 * The appointment start every view, the cancel window and the reschedule audit use:
 * `dropOffAt` in drop-off mode, else the earliest work (non-KENNEL) segment start
 * (any segment when there is no work segment). Only occupying segments count when
 * there are any: a CANCELLED visit keeps its old, non-occupying rows after a
 * reschedule, and those must not set the start. A fully cancelled appointment has
 * no occupying segment, so all of them count. Null when there is none.
 */
export function appointmentStartsAt(
  a: { bookingMode: "WAIT" | "DROP_OFF"; dropOffAt: Date | null },
  all: { stage: string; startsAt: Date; occupies: boolean }[],
): Date | null {
  if (a.bookingMode === "DROP_OFF" && a.dropOffAt) return a.dropOffAt;
  const live = all.filter((s) => s.occupies);
  const segments = live.length > 0 ? live : all;
  const work = segments.filter((s) => s.stage !== "KENNEL");
  return (work.length > 0 ? work : segments).reduce<Date | null>((m, s) => (m === null || s.startsAt < m ? s.startsAt : m), null);
}

/**
 * Pure mapper for a booked (non-HELD) appointment. `startsAt` is
 * `appointmentStartsAt`. Throws
 * on a visit without a saved pet or an appointment without times: those are
 * holds, which have their own view.
 */
export function toAppointmentView(row: AppointmentWithVisits): AppointmentView {
  const startsAt = appointmentStartsAt(row, row.petVisits.flatMap((v) => v.segments));
  if (startsAt === null) throw new Error(`toAppointmentView: appointment ${row.id} has no start time`);
  return {
    id: row.id,
    status: row.status,
    source: row.source,
    bookingMode: row.bookingMode,
    startsAt: startsAt.toISOString(),
    dropOffAt: iso(row.dropOffAt),
    estimatedReadyAt: iso(row.estimatedReadyAt),
    notes: row.notes,
    cancelledAt: iso(row.cancelledAt),
    pets: row.petVisits.map((v) => {
      if (v.petId === null || v.pet === null) throw new Error(`toAppointmentView: visit ${v.id} has no saved pet`);
      return {
        visitId: v.id,
        petId: v.petId,
        petName: v.pet.name,
        status: v.status,
        priceCentsQuoted: v.priceCentsQuoted,
        services: v.services.map((s) => ({ serviceId: s.serviceId, priceCents: s.priceCents, durationMin: s.durationMin })),
        segments: v.segments.map((s) => ({
          id: s.id,
          stage: s.stage,
          employeeId: s.staffUserId,
          resourceId: s.resourceId,
          startsAt: s.startsAt.toISOString(),
          endsAt: s.endsAt.toISOString(),
        })),
      };
    }),
  };
}

/** The owner view plus the customer, the creating staff member and the cancel reason. */
export function toStaffAppointmentView(row: AppointmentWithVisits): StaffAppointmentView {
  if (row.customerId === null) throw new Error(`toStaffAppointmentView: appointment ${row.id} has no customer`);
  return { ...toAppointmentView(row), customerId: row.customerId, createdByStaffId: row.createdByStaffId, cancelReason: row.cancelReason };
}
