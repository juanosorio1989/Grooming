import { describe, expect, it } from "vitest";
import { AvailabilityError } from "./errors";
import type { AvailabilityErrorCode } from "./errors";
import { prepare } from "./prepare";
import { resolvePets } from "./resolve";
import type { PetRequest } from "./types";
import {
  at, bath, batherA, batherB, catBath, deshed, dry, groomCtx, groomerA, groomerB, haircut, luna, makeEmployee,
  max, mia, MON, nails, pet, rex, teeth, employees, services,
} from "../test/fixtures";

const resolve = (pets: PetRequest[], o: Parameters<typeof groomCtx>[0] = {}) =>
  resolvePets(prepare(groomCtx(o), MON), pets);
const ids = (xs: { id: string }[]) => xs.map((x) => x.id);
const codeOf = (fn: () => unknown): AvailabilityErrorCode | undefined => {
  try {
    fn();
  } catch (e) {
    if (e instanceof AvailabilityError) return e.code;
    throw e;
  }
  return undefined;
};

describe("resolvePets", () => {
  it("groups services into stages in fixed order", () => {
    const [spec] = resolve([pet(rex, [nails.id, haircut.id, deshed.id, bath.id, teeth.id])]);
    expect(spec!.segments.map((s) => s.stage)).toEqual(["BATH", "GROOM", "FINISH"]);
    const [b, g, f] = spec!.segments;
    expect(b).toMatchObject({ serviceIds: [deshed.id, bath.id], durationMin: 60, priceCents: 6000 });
    expect(g).toMatchObject({ serviceIds: [haircut.id, teeth.id], durationMin: 70, priceCents: 7000 });
    expect(f).toMatchObject({ durationMin: 15, priceCents: 1500 });
    expect(spec!.priceCents).toBe(14500);
  });

  it("coat row is used", () => {
    const [spec] = resolve([pet(max, [bath.id])]);
    expect(spec!.segments[0]).toMatchObject({ durationMin: 60, priceCents: 5000 });
  });

  it("buffer is the stage max", () => {
    const services2 = services.map((s) =>
      s.id === bath.id ? { ...s, bufferAfterMin: 5 } : s.id === deshed.id ? { ...s, bufferAfterMin: 10 } : s,
    );
    const [spec] = resolve([pet(rex, [bath.id, deshed.id])], { services: services2 });
    expect(spec!.segments[0]!.bufferAfterMin).toBe(10);
  });

  it("candidates need skill and every service", () => {
    expect(ids(resolve([pet(rex, [bath.id, deshed.id])])[0]!.segments[0]!.candidates)).toEqual([batherA.id]);
    expect(ids(resolve([pet(rex, [bath.id])])[0]!.segments[0]!.candidates)).toEqual([batherA.id, batherB.id]);
  });

  it("preferred groomer only on GROOM and FINISH", () => {
    const svcs = [bath.id, haircut.id, nails.id];
    const [spec] = resolve([pet(rex, svcs, { preferredGroomerId: groomerB.id })]);
    expect(spec!.segments.map((s) => ids(s.candidates))).toEqual([
      [batherA.id, batherB.id],
      [groomerB.id],
      [groomerB.id],
    ]);
    const [other] = resolve([pet(rex, svcs, { preferredGroomerId: batherA.id })]);
    expect(ids(other!.segments[1]!.candidates)).toEqual([]);
  });

  it("online drops employees not bookable online", () => {
    const emps = employees.map((e) => (e.id === groomerA.id ? makeEmployee(e, { bookableOnline: false }) : e));
    const grooms = (o: Parameters<typeof groomCtx>[0]) => ids(resolve([pet(rex, [haircut.id])], { employees: emps, ...o })[0]!.segments[0]!.candidates);
    expect(grooms({})).toEqual([groomerB.id]);
    expect(grooms({ mode: "STAFF" })).toEqual([groomerA.id, groomerB.id]);
  });

  it("candidates ordered by booked minutes", () => {
    const busy = [{ employeeId: groomerA.id, resourceId: null, start: at(MON, "10:00"), blockEnd: at(MON, "11:00") }];
    const [spec] = resolve([pet(rex, [haircut.id])], { busy });
    expect(ids(spec!.segments[0]!.candidates)).toEqual([groomerB.id, groomerA.id]);
  });

  it("input errors", () => {
    const s = (n: number) => [bath, deshed, dry, haircut, teeth, nails].slice(0, n).map((x) => x.id);
    const five = [rex, luna, max, mia, { ...rex, petId: "p5" }].map((b) => pet(b, [bath.id]));
    const noTeethType = services.map((x) => (x.id === teeth.id ? { ...x, resourceTypeId: null } : x));
    expect(codeOf(() => resolve([]))).toBe("NO_PETS");
    expect(codeOf(() => resolve(five))).toBe("TOO_MANY_PETS");
    expect(codeOf(() => resolve([pet(rex, [bath.id]), pet(rex, [dry.id])]))).toBe("DUPLICATE_PET");
    expect(codeOf(() => resolve([pet(rex, [])]))).toBe("NO_SERVICES");
    expect(codeOf(() => resolve([pet(rex, [...s(6), catBath.id])]))).toBe("TOO_MANY_SERVICES");
    expect(codeOf(() => resolve([pet(rex, [bath.id, bath.id])]))).toBe("DUPLICATE_SERVICE");
    expect(codeOf(() => resolve([pet(rex, ["nope"])]))).toBe("UNKNOWN_SERVICE");
    expect(codeOf(() => resolve([pet(mia, [haircut.id])]))).toBe("SPECIES_MISMATCH");
    expect(codeOf(() => resolve([pet(rex, [bath.id], { preferredGroomerId: "nope" })]))).toBe("UNKNOWN_EMPLOYEE");
    expect(codeOf(() => resolve([pet(rex, [bath.id], { sizeClass: "L" })]))).toBe("NO_PRICE_FOR_PET");
    expect(codeOf(() => resolve([pet(rex, [haircut.id, teeth.id])], { services: noTeethType }))).toBe("STAGE_RESOURCE_MISMATCH");
  });
});
