import { describe, expect, it } from "vitest";
import type { WallTime } from "@grooming/datetime";
import { findSlots } from "./find-slots";
import { validatePlan } from "./validate-plan";
import type { BusySegment, FindSlotsInput, PlannedSegment, Slot } from "./types";
import {
  at, bath, batherA, deshed, groomerA, groomerB, haircut, kennel1, luna, makeEmployee,
  makeLocation, MON, nails, pet, rex, services, TABLE_1_ID, tub1, tub2, TUB_1_ID, table1, table2,
  dryer1, kennel2, groomCtx,
} from "../test/fixtures";

const m = (time: WallTime) => at(MON, time);
const clone = (slot: Slot): Slot => structuredClone(slot);
const seg = (slot: Slot, stage: PlannedSegment["stage"], petIndex = 0): PlannedSegment =>
  slot.pets[petIndex]!.segments.find((s) => s.stage === stage)!;
const firstSlot = (input: FindSlotsInput, time: WallTime = "09:00"): Slot => {
  const slot = findSlots(input).find((s) => s.start === m(time));
  if (!slot) throw new Error(`no slot at ${time}`);
  return slot;
};
const rejection = (input: FindSlotsInput, slot: Slot) => validatePlan(input, slot);

describe("validatePlan: accepts what findSlots returns", () => {
  const scenarios: [string, FindSlotsInput][] = [
    ["single pet", groomCtx({ pets: [pet(rex, [bath.id, haircut.id])] })],
    [
      "pipelined",
      groomCtx({
        employees: [batherA, groomerA],
        pets: [pet(rex, [bath.id, haircut.id]), pet(luna, [bath.id, haircut.id])],
      }),
    ],
    [
      "later pets see earlier pets (drop-off)",
      groomCtx({ bookingMode: "DROP_OFF", employees: [batherA], pets: [pet(rex, [bath.id]), pet(luna, [bath.id])] }),
    ],
    [
      "buffer kept",
      groomCtx({
        services: services.map((s) => (s.id === haircut.id ? { ...haircut, bufferAfterMin: 15 } : s)),
        employees: [groomerA],
        resources: [table1],
        pets: [pet(rex, [haircut.id, nails.id])],
      }),
    ],
  ];
  it.each(scenarios)("accepts every slot: %s", (_name, input) => {
    const slots = findSlots(input);
    expect(slots.length).toBeGreaterThan(0);
    for (const slot of slots) expect(rejection(input, slot)).toEqual({ ok: true });
  });
});

describe("validatePlan: rejections", () => {
  const input = groomCtx({ pets: [pet(rex, [bath.id, deshed.id, haircut.id, nails.id])] });
  const base = firstSlot(input);
  const reject = (mutate: (s: Slot) => void, ctx: FindSlotsInput = input) => {
    const s = clone(base);
    mutate(s);
    return rejection(ctx, s);
  };

  it("bookingMode or pets mismatch", () => {
    expect(reject((s) => { s.bookingMode = "DROP_OFF"; })).toEqual({ ok: false, reason: "MALFORMED_PLAN" });
    expect(reject(() => {}, { ...input, pets: [...input.pets, pet(luna, [bath.id])] })).toEqual({
      ok: false,
      reason: "MALFORMED_PLAN",
    });
    expect(reject((s) => { s.pets[0]!.petId = luna.petId; })).toEqual({ ok: false, reason: "MALFORMED_PLAN" });
    expect(reject((s) => { seg(s, "BATH").petId = "someone-else"; })).toEqual({ ok: false, reason: "MALFORMED_PLAN" });
    const drop = groomCtx({ bookingMode: "DROP_OFF", pets: [pet(rex, [bath.id]), pet(luna, [bath.id])] });
    const ds = clone(firstSlot(drop));
    seg(ds, "KENNEL", 1).petId = rex.petId;
    expect(rejection(drop, ds)).toEqual({ ok: false, reason: "MALFORMED_PLAN" });
  });

  it("wrong price, duration or stage grouping", () => {
    const bad = { ok: false, reason: "MALFORMED_PLAN" };
    expect(reject((s) => { seg(s, "BATH").priceCents += 1; })).toEqual(bad);
    expect(reject((s) => { s.pets[0]!.priceCents += 1; })).toEqual(bad);
    expect(reject((s) => { seg(s, "BATH").durationMin += 5; seg(s, "BATH").end += 5 * 60_000; })).toEqual(bad);
    expect(reject((s) => { seg(s, "BATH").serviceIds.reverse(); })).toEqual(bad);
    expect(reject((s) => { seg(s, "BATH").stage = "DRY"; })).toEqual(bad);
    expect(reject((s) => { s.pets[0]!.segments.pop(); })).toEqual(bad);
  });

  it("unqualified employee", () => {
    expect(reject((s) => { seg(s, "BATH").employeeId = groomerA.id; })).toEqual({ ok: false, reason: "NOT_QUALIFIED" });
    expect(reject((s) => { seg(s, "BATH").employeeId = null; })).toEqual({ ok: false, reason: "NOT_QUALIFIED" });
    expect(reject((s) => { seg(s, "BATH").employeeId = "unknown"; })).toEqual({ ok: false, reason: "NOT_QUALIFIED" });
    const preferB = groomCtx({ pets: [pet(rex, [bath.id, haircut.id], { preferredGroomerId: groomerB.id })] });
    const slot = firstSlot(preferB);
    expect(seg(slot, "GROOM").employeeId).toBe(groomerB.id);
    const s = clone(slot);
    seg(s, "GROOM").employeeId = groomerA.id;
    expect(rejection(preferB, s)).toEqual({ ok: false, reason: "NOT_QUALIFIED" });
  });

  it("not online bookable", () => {
    const hidden = services.map((x) => (x.id === haircut.id ? { ...x, onlineBookable: false } : x));
    expect(reject(() => {}, { ...input, services: hidden })).toEqual({ ok: false, reason: "NOT_BOOKABLE_ONLINE" });
    const two = groomCtx({ employees: [batherA, groomerA], pets: [pet(rex, [bath.id, haircut.id])] });
    const slot = firstSlot(two);
    const offline = { ...two, employees: [batherA, makeEmployee(groomerA, { bookableOnline: false })] };
    expect(rejection(offline, slot)).toEqual({ ok: false, reason: "NOT_BOOKABLE_ONLINE" });
  });

  it("too soon and beyond horizon", () => {
    expect(reject(() => {}, { ...input, now: m("08:30") })).toEqual({ ok: false, reason: "TOO_SOON" });
    const far = groomCtx({ mode: "STAFF", date: "2027-02-05", pets: [pet(rex, [bath.id])] });
    const slot = findSlots(far)[0]!;
    expect(rejection({ ...far, mode: "ONLINE" }, slot)).toEqual({ ok: false, reason: "BEYOND_HORIZON" });
    expect(rejection(far, slot)).toEqual({ ok: true });
  });

  it("off the slot grid", () => {
    const shift = (s: Slot) => {
      s.start += 5 * 60_000;
      for (const x of s.pets[0]!.segments) { x.start += 5 * 60_000; x.end += 5 * 60_000; x.blockEnd += 5 * 60_000; }
      s.readyAt += 5 * 60_000;
    };
    expect(reject(shift)).toEqual({ ok: false, reason: "MALFORMED_PLAN" });
  });

  it("outside drop-off window", () => {
    const staff = groomCtx({
      bookingMode: "DROP_OFF",
      mode: "STAFF",
      override: true,
      pets: [pet(rex, [bath.id])],
    });
    const slot = firstSlot(staff, "08:00");
    expect(rejection(staff, slot)).toEqual({ ok: true });
    expect(rejection({ ...staff, override: false }, slot)).toEqual({ ok: false, reason: "OUTSIDE_DROP_OFF_WINDOW" });
  });

  it("segment past the end of the day", () => {
    const late = groomCtx({ mode: "STAFF", override: true, pets: [pet(rex, [bath.id])] });
    const slot = firstSlot(late, "23:00");
    expect(rejection(late, slot)).toEqual({ ok: true });
    const s = clone(slot);
    seg(s, "BATH").blockEnd = at("2026-12-08", "00:15");
    expect(rejection(late, s)).toEqual({ ok: false, reason: "MALFORMED_PLAN" });
  });

  it("gap and idle limits", () => {
    const wait = groomCtx({ pets: [pet(rex, [bath.id, haircut.id])] });
    const slot = clone(firstSlot(wait));
    const g = seg(slot, "GROOM");
    g.start += 30 * 60_000; g.end += 30 * 60_000; g.blockEnd += 30 * 60_000;
    slot.readyAt = g.end;
    expect(rejection(wait, slot)).toEqual({ ok: false, reason: "MALFORMED_PLAN" });
    // first pet's first segment must start at slot.start
    const s2 = clone(firstSlot(wait));
    const b = seg(s2, "BATH");
    b.start += 15 * 60_000; b.end += 15 * 60_000; b.blockEnd += 15 * 60_000;
    expect(rejection(wait, s2)).toEqual({ ok: false, reason: "MALFORMED_PLAN" });

    const drop = groomCtx({
      bookingMode: "DROP_OFF",
      employees: [batherA, groomerA],
      location: makeLocation({ maxQueueWaitMin: 80 }),
      busy: [
        { employeeId: batherA.id, resourceId: null, start: m("09:00"), blockEnd: m("10:15") },
        { employeeId: groomerA.id, resourceId: null, start: m("09:00"), blockEnd: m("11:15") },
      ],
      pets: [pet(rex, [bath.id, haircut.id])],
    });
    const dslot = firstSlot(drop);
    expect(rejection(drop, dslot)).toEqual({ ok: true });
    expect(rejection({ ...drop, location: makeLocation({ maxQueueWaitMin: 79 }) }, dslot)).toEqual({
      ok: false,
      reason: "MALFORMED_PLAN",
    });
  });

  it("drop-off shape: first segment before intake, kennel segment wrong", () => {
    const drop = groomCtx({ bookingMode: "DROP_OFF", pets: [pet(rex, [bath.id])] });
    const slot = firstSlot(drop);
    const bad = { ok: false, reason: "MALFORMED_PLAN" };
    const early = clone(slot);
    seg(early, "BATH").start -= 5 * 60_000; seg(early, "BATH").durationMin += 5;
    expect(rejection(drop, early)).toEqual(bad);
    const noKennel = clone(slot);
    noKennel.pets[0]!.segments.pop();
    expect(rejection(drop, noKennel)).toEqual(bad);
    const shortKennel = clone(slot);
    seg(shortKennel, "KENNEL").end -= 15 * 60_000; seg(shortKennel, "KENNEL").blockEnd -= 15 * 60_000;
    seg(shortKennel, "KENNEL").durationMin -= 15;
    expect(rejection(drop, shortKennel)).toEqual(bad);
    const wrongReady = clone(slot);
    wrongReady.readyAt += 15 * 60_000;
    expect(rejection(drop, wrongReady)).toEqual(bad);
  });

  it("dropped buffer that Rule B does not allow", () => {
    const kept = groomCtx({
      services: services.map((s) => (s.id === haircut.id ? { ...haircut, bufferAfterMin: 15 } : s)),
      employees: [groomerA],
      resources: [table1],
      pets: [pet(rex, [haircut.id, nails.id])],
    });
    const slot = firstSlot(kept);
    expect(seg(slot, "GROOM").blockEnd).toBe(m("10:15"));
    const s = clone(slot);
    seg(s, "GROOM").blockEnd = seg(s, "GROOM").end;
    expect(rejection(kept, s)).toEqual({ ok: false, reason: "MALFORMED_PLAN" });
  });

  it("missing or wrong resource", () => {
    expect(reject((s) => { seg(s, "BATH").resourceId = null; })).toEqual({ ok: false, reason: "RESOURCE_UNAVAILABLE" });
    expect(reject((s) => { seg(s, "BATH").resourceId = TABLE_1_ID; })).toEqual({
      ok: false,
      reason: "RESOURCE_UNAVAILABLE",
    });
    expect(reject((s) => { seg(s, "BATH").resourceId = "unknown"; })).toEqual({
      ok: false,
      reason: "RESOURCE_UNAVAILABLE",
    });
    expect(reject((s) => { seg(s, "FINISH").resourceId = TUB_1_ID; })).toEqual({ ok: false, reason: "MALFORMED_PLAN" });
    const drop = groomCtx({ bookingMode: "DROP_OFF", pets: [pet(rex, [bath.id])] });
    const ds = clone(firstSlot(drop));
    seg(ds, "KENNEL").resourceId = TUB_1_ID;
    expect(rejection(drop, ds)).toEqual({ ok: false, reason: "RESOURCE_UNAVAILABLE" });
    const ds2 = clone(firstSlot(drop));
    seg(ds2, "KENNEL").resourceId = null;
    expect(rejection(drop, ds2)).toEqual({ ok: false, reason: "RESOURCE_UNAVAILABLE" });
  });

  it("taken since search", () => {
    const b = seg(base, "BATH");
    const taken: BusySegment = { employeeId: b.employeeId, resourceId: null, start: b.start, blockEnd: b.end };
    expect(reject(() => {}, { ...input, busy: [taken] })).toEqual({ ok: false, reason: "EMPLOYEE_UNAVAILABLE" });
    const tubTaken: BusySegment = { employeeId: null, resourceId: b.resourceId, start: b.start, blockEnd: b.end };
    expect(reject(() => {}, { ...input, busy: [tubTaken] })).toEqual({ ok: false, reason: "RESOURCE_UNAVAILABLE" });

    const drop = groomCtx({ bookingMode: "DROP_OFF", pets: [pet(rex, [bath.id])] });
    const ds = firstSlot(drop);
    const k = seg(ds, "KENNEL");
    const kBusy: BusySegment = { employeeId: null, resourceId: k.resourceId, start: k.start, blockEnd: k.end };
    expect(rejection({ ...drop, busy: [kBusy] }, ds)).toEqual({ ok: false, reason: "RESOURCE_UNAVAILABLE" });
  });

  it("overlap inside the plan", () => {
    const two = groomCtx({ employees: [batherA, groomerA], pets: [pet(rex, [bath.id]), pet(luna, [bath.id])] });
    const slot = clone(firstSlot(two));
    // move pet 2's bath on top of pet 1's, same employee
    const a = seg(slot, "BATH", 0);
    const b = seg(slot, "BATH", 1);
    b.start = a.start; b.end = a.end; b.blockEnd = a.blockEnd; b.resourceId = a.resourceId;
    slot.readyAt = a.end;
    expect(rejection(two, slot)).toEqual({ ok: false, reason: "EMPLOYEE_UNAVAILABLE" });
    // same station, different employees
    const three = groomCtx({
      employees: [batherA, makeEmployee(batherA, { id: "b2" })],
      resources: [tub1, tub2, table1, table2, dryer1, kennel1, kennel2],
      pets: [pet(rex, [bath.id]), pet(luna, [bath.id])],
    });
    const s3 = clone(firstSlot(three));
    const p = seg(s3, "BATH", 0);
    const q = seg(s3, "BATH", 1);
    q.resourceId = p.resourceId;
    expect(p.start).toBe(q.start);
    expect(rejection(three, s3)).toEqual({ ok: false, reason: "RESOURCE_UNAVAILABLE" });
  });
});
