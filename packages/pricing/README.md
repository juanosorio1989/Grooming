# @grooming/pricing

Pure helpers for size classes and the service price matrix. No runtime dependencies.

## Exports

- Types: `SizeClass`, `CoatType`, `SizeThresholdsLb`, `ServicePriceRow`, `PriceTerms`
- `DEFAULT_SIZE_THRESHOLDS_LB` (`S: 20, M: 50, L: 90`), `GRAMS_PER_LB`, `lbToGrams`, `gramsToLb`
- `sizeClassFromWeight(weightG, thresholds?)`
- `lookupPrice(rows, serviceId, sizeClass, coatType)`, `quotePet({ rows, serviceIds, sizeClass, coatType })`
- `PricingError` (`INVALID_WEIGHT`, `INVALID_THRESHOLDS`)

## Rules

- Weight is integer grams. Thresholds are inclusive upper bounds in lb: S when weight <= S, M when <= M,
  L when <= L, else XL. Thresholds must satisfy `0 < S < M < L`.
- Lookup order: exact coat row, then the `coatType: null` (any coat) row, else `null`.
- `quotePet` returns lines in input order, or `{ ok: false, missing }` listing every service without a row.
- Money is integer cents.
