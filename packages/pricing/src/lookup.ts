import type { CoatType, PetQuote, PriceTerms, ServicePriceRow, SizeClass } from "./types.js";

export function lookupPrice(
  rows: ServicePriceRow[],
  serviceId: string,
  sizeClass: SizeClass,
  coatType: CoatType,
): PriceTerms | null {
  const matching = rows.filter((r) => r.serviceId === serviceId && r.sizeClass === sizeClass);
  const row = matching.find((r) => r.coatType === coatType) ?? matching.find((r) => r.coatType === null);
  return row ? { durationMin: row.durationMin, priceCents: row.priceCents } : null;
}

export function quotePet(args: {
  rows: ServicePriceRow[];
  serviceIds: string[];
  sizeClass: SizeClass;
  coatType: CoatType;
}): PetQuote {
  const lines: (PriceTerms & { serviceId: string })[] = [];
  const missing: string[] = [];
  for (const serviceId of args.serviceIds) {
    const terms = lookupPrice(args.rows, serviceId, args.sizeClass, args.coatType);
    if (terms) lines.push({ serviceId, ...terms });
    else missing.push(serviceId);
  }
  if (missing.length > 0) return { ok: false, missing };
  return {
    ok: true,
    lines,
    totalCents: lines.reduce((s, l) => s + l.priceCents, 0),
    totalMin: lines.reduce((s, l) => s + l.durationMin, 0),
  };
}
