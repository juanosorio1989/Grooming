export type AvailabilityErrorCode =
  | "NO_PETS"
  | "TOO_MANY_PETS"
  | "DUPLICATE_PET"
  | "NO_SERVICES"
  | "TOO_MANY_SERVICES"
  | "DUPLICATE_SERVICE"
  | "UNKNOWN_SERVICE"
  | "UNKNOWN_EMPLOYEE"
  | "SPECIES_MISMATCH"
  | "NO_PRICE_FOR_PET"
  | "STAGE_RESOURCE_MISMATCH";

export class AvailabilityError extends Error {
  readonly code: AvailabilityErrorCode;
  constructor(code: AvailabilityErrorCode, message?: string) {
    super(message ?? code);
    this.name = "AvailabilityError";
    this.code = code;
  }
}
