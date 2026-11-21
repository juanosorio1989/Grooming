import { describe, expect, it } from "vitest";
import { checkStageRule, type StageRuleService } from "./stage-rule.js";

const s = (o: Partial<StageRuleService> & { id: string }): StageRuleService => ({ stage: "BATH", species: "DOG", resourceTypeId: "t1", ...o });

describe("checkStageRule", () => {
  it("same stage, DOG/DOG, different types conflicts", () => {
    expect(checkStageRule(s({ id: "a", resourceTypeId: "t1" }), [s({ id: "b", resourceTypeId: "t2" })])).toBe("b");
  });
  it("DOG vs CAT does not conflict", () => {
    expect(checkStageRule(s({ id: "a" }), [s({ id: "b", species: "CAT", resourceTypeId: "t2" })])).toBeNull();
  });
  it("DOG vs ANY conflicts", () => {
    expect(checkStageRule(s({ id: "a" }), [s({ id: "b", species: "ANY", resourceTypeId: "t2" })])).toBe("b");
  });
  it("different stages do not conflict", () => {
    expect(checkStageRule(s({ id: "a" }), [s({ id: "b", stage: "DRY", resourceTypeId: "t2" })])).toBeNull();
  });
  it("null vs type conflicts", () => {
    expect(checkStageRule(s({ id: "a", resourceTypeId: null }), [s({ id: "b", resourceTypeId: "t2" })])).toBe("b");
  });
  it("null vs null does not conflict", () => {
    expect(checkStageRule(s({ id: "a", resourceTypeId: null }), [s({ id: "b", resourceTypeId: null })])).toBeNull();
  });
  it("inactive other does not conflict", () => {
    expect(checkStageRule(s({ id: "a" }), [{ ...s({ id: "b", resourceTypeId: "t2" }), active: false }])).toBeNull();
  });
  it("same type does not conflict", () => {
    expect(checkStageRule(s({ id: "a" }), [s({ id: "b" })])).toBeNull();
  });
});
