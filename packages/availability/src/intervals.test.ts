import { describe, expect, it } from "vitest";
import { covers, intersect, normalize, subtract } from "./intervals";

const iv = (start: number, end: number) => ({ start, end });

describe("intervals", () => {
  it("normalize merges overlapping/adjacent and drops empty", () => {
    expect(normalize([iv(0, 10), iv(5, 20), iv(20, 30), iv(40, 40)])).toEqual([iv(0, 30)]);
  });
  it("subtract", () => {
    expect(subtract([iv(0, 100)], [iv(10, 20), iv(50, 60)])).toEqual([iv(0, 10), iv(20, 50), iv(60, 100)]);
  });
  it("intersect", () => {
    expect(intersect([iv(0, 50)], [iv(40, 100)])).toEqual([iv(40, 50)]);
  });
  it("covers", () => {
    expect(covers([iv(0, 50)], iv(10, 50))).toBe(true);
    expect(covers([iv(0, 50)], iv(10, 51))).toBe(false);
  });
});
