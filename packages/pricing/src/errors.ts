export type PricingErrorCode = "INVALID_WEIGHT" | "INVALID_THRESHOLDS";

export class PricingError extends Error {
  readonly code: PricingErrorCode;
  constructor(code: PricingErrorCode, message?: string) {
    super(message ?? code);
    this.name = "PricingError";
    this.code = code;
  }
}
