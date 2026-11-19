import { describe, expect, it } from "vitest";
import { MINUTE } from "@grooming/datetime";
import { blockEndFor } from "./search";

const END = Date.parse("2026-12-07T15:00:00Z");
const seg = (o: { employeeId?: string | null; resourceId?: string | null } = {}) => ({
  employeeId: "e1",
  resourceId: null as string | null,
  end: END,
  bufferAfterMin: 10,
  ...o,
});
const next = (o: { employeeId?: string | null; resourceId?: string | null; start?: number } = {}) => ({
  employeeId: "e1",
  resourceId: null as string | null,
  start: END,
  ...o,
});
const buffered = END + 10 * MINUTE;

describe("blockEndFor (Rule B)", () => {
  it("same employee, no resource, starts at end: buffer dropped", () => {
    expect(blockEndFor(seg(), next({ resourceId: "r9" }))).toBe(END);
  });

  it("same employee and same resource: buffer dropped", () => {
    expect(blockEndFor(seg({ resourceId: "r1" }), next({ resourceId: "r1" }))).toBe(END);
  });

  it("same employee, different resource: buffer kept", () => {
    expect(blockEndFor(seg({ resourceId: "r1" }), next({ resourceId: "r2" }))).toBe(buffered);
    expect(blockEndFor(seg({ resourceId: "r1" }), next({ resourceId: null }))).toBe(buffered);
  });

  it("different employee: buffer kept", () => {
    expect(blockEndFor(seg(), next({ employeeId: "e2" }))).toBe(buffered);
  });

  it("next starts later: buffer kept", () => {
    expect(blockEndFor(seg(), next({ start: END + 5 * MINUTE }))).toBe(buffered);
  });

  it("no next segment: buffer kept", () => {
    expect(blockEndFor(seg(), null)).toBe(buffered);
  });
});
