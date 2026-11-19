import { PricingError } from "./errors.js";
import type { SizeClass, SizeThresholdsLb } from "./types.js";

export const DEFAULT_SIZE_THRESHOLDS_LB: SizeThresholdsLb = { S: 20, M: 50, L: 90 };
export const GRAMS_PER_LB = 453.59237;

export function lbToGrams(lb: number): number {
  return Math.round(lb * GRAMS_PER_LB);
}

export function gramsToLb(g: number): number {
  return Math.round((g / GRAMS_PER_LB) * 10) / 10;
}

export function sizeClassFromWeight(
  weightG: number,
  thresholds: SizeThresholdsLb = DEFAULT_SIZE_THRESHOLDS_LB,
): SizeClass {
  if (!Number.isInteger(weightG) || weightG <= 0) throw new PricingError("INVALID_WEIGHT");
  const { S, M, L } = thresholds;
  if (!(Number.isFinite(S) && Number.isFinite(M) && Number.isFinite(L) && S > 0 && S < M && M < L))
    throw new PricingError("INVALID_THRESHOLDS");
  if (weightG <= lbToGrams(S)) return "S";
  if (weightG <= lbToGrams(M)) return "M";
  if (weightG <= lbToGrams(L)) return "L";
  return "XL";
}
