export type SizeClass = "S" | "M" | "L" | "XL";
export type CoatType = "SMOOTH" | "DOUBLE" | "CURLY" | "WIRE" | "LONG" | "HAIRLESS";

/** Inclusive upper bounds in pounds for S, M and L; anything heavier is XL. */
export interface SizeThresholdsLb {
  S: number;
  M: number;
  L: number;
}

export interface ServicePriceRow {
  serviceId: string;
  sizeClass: SizeClass;
  /** null means the row applies to any coat. */
  coatType: CoatType | null;
  durationMin: number;
  priceCents: number;
}

export interface PriceTerms {
  durationMin: number;
  priceCents: number;
}

export type PetQuote =
  | { ok: true; lines: (PriceTerms & { serviceId: string })[]; totalCents: number; totalMin: number }
  | { ok: false; missing: string[] };
