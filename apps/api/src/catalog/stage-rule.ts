export interface StageRuleService {
  id: string;
  stage: string;
  species: "DOG" | "CAT" | "ANY";
  resourceTypeId: string | null;
  /** Inactive services never conflict. Defaults to active. */
  active?: boolean;
}

const compatible = (a: StageRuleService["species"], b: StageRuleService["species"]) => a === b || a === "ANY" || b === "ANY";

/**
 * Returns the id of the first active other service that conflicts with the
 * candidate, else null. Conflict: same stage, compatible species, different
 * resourceTypeId (null counts as a value).
 */
export function checkStageRule(candidate: StageRuleService, others: StageRuleService[]): string | null {
  for (const o of others) {
    if (o.id === candidate.id || o.active === false) continue;
    if (o.stage === candidate.stage && compatible(o.species, candidate.species) && o.resourceTypeId !== candidate.resourceTypeId) return o.id;
  }
  return null;
}
