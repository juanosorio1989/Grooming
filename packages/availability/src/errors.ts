export type AvailabilityErrorCode = "NO_SERVICES" | "TOO_MANY_SERVICES" | "UNKNOWN_SERVICE" | "UNKNOWN_EMPLOYEE";

export class AvailabilityError extends Error {
  readonly code: AvailabilityErrorCode;
  constructor(code: AvailabilityErrorCode, message?: string) {
    super(message ?? code);
    this.name = "AvailabilityError";
    this.code = code;
  }
}
