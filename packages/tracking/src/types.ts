export type Ms = number;

export type WorkStage = "BATH" | "DRY" | "GROOM" | "FINISH";
export const WORK_STAGE_ORDER: readonly WorkStage[] = ["BATH", "DRY", "GROOM", "FINISH"];

export type StepStage = "RECEIVED" | WorkStage | "READY";
export type StepStatus = "PENDING" | "IN_PROGRESS" | "DONE" | "SKIPPED";

export interface Step {
  stage: StepStage;
  sort: number;
  status: StepStatus;
  startedAt: Ms | null;
  finishedAt: Ms | null;
  performedBy: string | null;
  recordedBy: string | null;
}

export type PetVisitStatus =
  | "BOOKED"
  | "RECEIVED"
  | "IN_PROGRESS"
  | "READY"
  | "PICKED_UP"
  | "CANCELLED"
  | "NO_SHOW";

export type AppointmentStatus =
  | "HELD"
  | "BOOKED"
  | "IN_SHOP"
  | "COMPLETED"
  | "CANCELLED"
  | "NO_SHOW";
