import type { AppointmentStatus, PetVisitStatus } from "./types.js";

const VISIT_EDGES: Record<PetVisitStatus, readonly PetVisitStatus[]> = {
  BOOKED: ["RECEIVED", "CANCELLED", "NO_SHOW"],
  RECEIVED: ["IN_PROGRESS", "READY"],
  IN_PROGRESS: ["READY"],
  READY: ["PICKED_UP"],
  PICKED_UP: [],
  CANCELLED: [],
  NO_SHOW: [],
};

const APPOINTMENT_EDGES: Record<AppointmentStatus, readonly AppointmentStatus[]> = {
  HELD: ["BOOKED", "CANCELLED"],
  BOOKED: ["IN_SHOP", "CANCELLED", "NO_SHOW"],
  IN_SHOP: ["COMPLETED"],
  COMPLETED: [],
  CANCELLED: [],
  NO_SHOW: [],
};

export function canTransitionVisit(from: PetVisitStatus, to: PetVisitStatus): boolean {
  return VISIT_EDGES[from].includes(to);
}

export function canTransitionAppointment(from: AppointmentStatus, to: AppointmentStatus): boolean {
  return APPOINTMENT_EDGES[from].includes(to);
}

const STARTED: readonly PetVisitStatus[] = ["RECEIVED", "IN_PROGRESS", "READY", "PICKED_UP"];

export function appointmentStatusAfterVisits(
  current: AppointmentStatus,
  visits: PetVisitStatus[],
): AppointmentStatus {
  let status = current;
  if (status === "BOOKED" && visits.some((v) => STARTED.includes(v))) status = "IN_SHOP";
  if (status === "IN_SHOP") {
    const active = visits.filter((v) => v !== "CANCELLED" && v !== "NO_SHOW");
    if (active.length > 0 && active.every((v) => v === "PICKED_UP")) return "COMPLETED";
  }
  return status;
}
