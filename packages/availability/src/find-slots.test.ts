import { describe, expect, it } from "vitest";
import { localDayBoundsUtc } from "@grooming/datetime";
import type { IsoDate, WallTime } from "@grooming/datetime";
import { findSlots } from "./find-slots";
import { prepare } from "./prepare";
import { resolvePets } from "./resolve";
import { planWait } from "./search";
import type { BusySegment, PetRequest, PlannedSegment, ServiceInput, Slot } from "./types";
import {
  at, bath, batherA, batherB, dry, everyDay, groomCtx, groomerA, groomerB, haircut, kennel1,
  KENNEL_1_ID, KENNEL_2_ID, luna, makeEmployee, makeLocation, max, MON, nails, NY, pet, rex,
  services, table1, TABLE, TABLE_1_ID, tub1, tub2, TUB_1_ID, TUB_2_ID, dryer1, table2,
} from "../test/fixtures";

const iso = (ms: number) => new Date(ms).toISOString();
const m = (time: WallTime, date: IsoDate = MON) => at(date, time);
const busy = (
  who: { employeeId?: string | null; resourceId?: string | null },
  start: WallTime,
  end: WallTime,
): BusySegment => ({
  employeeId: who.employeeId ?? null,
  resourceId: who.resourceId ?? null,
  start: m(start),
  blockEnd: m(end),
});
const allDay = (date: IsoDate = MON) => localDayBoundsUtc(date, NY);
const withService = (s: ServiceInput): ServiceInput[] => services.map((x) => (x.id === s.id ? s : x));
const firstAt = (slots: Slot[], time: WallTime) => slots.find((s) => s.start === m(time));
const segs = (slot: Slot | undefined, petIndex = 0): PlannedSegment[] => slot!.pets[petIndex]!.segments;
const seg = (slot: Slot | undefined, stage: PlannedSegment["stage"], petIndex = 0) =>
  segs(slot, petIndex).find((s) => s.stage === stage)!;
const span = (s: PlannedSegment) => [s.start, s.end];
const fourthDog: PetRequest = { ...rex, petId: "00000000-0000-4000-8000-000000000a05" };

describe("findSlots: wait mode", () => {
  it("single pet: day bounds", () => {
    const slots = findSlots(groomCtx({ pets: [pet(rex, [bath.id, haircut.id])] }));
    expect(slots).toHaveLength(34);
    const first = slots[0]!;
    expect(first.start).toBe(m("09:00"));
    expect(first.bookingMode).toBe("WAIT");
    expect(seg(first, "BATH")).toMatchObject({
      start: m("09:00"), end: m("09:45"), employeeId: batherA.id, resourceId: TUB_1_ID,
    });
    expect(seg(first, "GROOM")).toMatchObject({
      start: m("09:45"), end: m("10:45"), employeeId: groomerA.id, resourceId: TABLE_1_ID,
    });
    expect(first.readyAt).toBe(m("10:45"));
    expect(first.pets[0]!.priceCents).toBe(10000);
    expect(segs(first).map((s) => s.stage)).toEqual(["BATH", "GROOM"]);
    const last = slots[slots.length - 1]!;
    expect(last.start).toBe(m("17:15"));
    expect(last.readyAt).toBe(m("19:00"));
  });

  it("two bathers start two pets together", () => {
    const slots = findSlots(
      groomCtx({ employees: [batherA, batherB], pets: [pet(rex, [bath.id]), pet(luna, [bath.id])] }),
    );
    const first = slots[0]!;
    expect(first.start).toBe(m("09:00"));
    const a = seg(first, "BATH", 0);
    const b = seg(first, "BATH", 1);
    expect([a.start, b.start]).toEqual([m("09:00"), m("09:00")]);
    expect(new Set([a.employeeId, b.employeeId])).toEqual(new Set([batherA.id, batherB.id]));
    expect(new Set([a.resourceId, b.resourceId])).toEqual(new Set([TUB_1_ID, TUB_2_ID]));
  });

  it("pipelined with one bather and one groomer", () => {
    const slots = findSlots(
      groomCtx({
        employees: [batherA, groomerA],
        pets: [pet(rex, [bath.id, haircut.id]), pet(luna, [bath.id, haircut.id])],
      }),
    );
    const first = slots[0]!;
    expect(first.start).toBe(m("09:00"));
    expect(span(seg(first, "BATH", 0))).toEqual([m("09:00"), m("09:45")]);
    expect(span(seg(first, "GROOM", 0))).toEqual([m("09:45"), m("10:45")]);
    expect(span(seg(first, "BATH", 1))).toEqual([m("09:45"), m("10:30")]);
    expect(span(seg(first, "GROOM", 1))).toEqual([m("10:45"), m("11:45")]);
    expect(first.readyAt).toBe(m("11:45"));
  });

  it("idle over 15 min drops the start", () => {
    const slots = findSlots(
      groomCtx({
        employees: [batherA, groomerA],
        busy: [busy({ employeeId: groomerA.id }, "09:45", "10:15")],
        pets: [pet(rex, [bath.id, haircut.id])],
      }),
    );
    expect(firstAt(slots, "09:00")).toBeUndefined();
    const s = firstAt(slots, "09:15");
    expect(span(seg(s, "BATH"))).toEqual([m("09:15"), m("10:00")]);
    expect(seg(s, "GROOM").start).toBe(m("10:15"));
  });

  it("busy station", () => {
    const day = allDay();
    const slots = findSlots(
      groomCtx({
        busy: [
          { employeeId: null, resourceId: TUB_1_ID, start: day.start, blockEnd: day.end },
          { employeeId: null, resourceId: TUB_2_ID, start: day.start, blockEnd: day.end },
        ],
        pets: [pet(rex, [bath.id, haircut.id])],
      }),
    );
    expect(slots).toEqual([]);
  });

  it("buffer blocks a different next person", () => {
    const slots = findSlots(
      groomCtx({
        services: withService({ ...bath, bufferAfterMin: 10 }),
        employees: [batherA, groomerA],
        pets: [pet(rex, [bath.id, haircut.id]), pet(luna, [bath.id, haircut.id])],
      }),
    );
    const first = slots[0]!;
    expect(first.start).toBe(m("09:00"));
    expect(seg(first, "BATH", 0).blockEnd).toBe(m("09:55"));
    expect(seg(first, "BATH", 1).start).toBe(m("10:00"));
  });

  it("buffer dropped on same groomer and same table", () => {
    const slots = findSlots(
      groomCtx({
        services: withService({ ...nails, resourceTypeId: TABLE }).map((s) =>
          s.id === haircut.id ? { ...haircut, bufferAfterMin: 15 } : s,
        ),
        employees: [groomerA],
        resources: [table1],
        pets: [pet(rex, [haircut.id, nails.id])],
      }),
    );
    const first = slots[0]!;
    expect(first.start).toBe(m("09:00"));
    expect(seg(first, "GROOM")).toMatchObject({ start: m("09:00"), end: m("10:00"), blockEnd: m("10:00") });
    expect(span(seg(first, "FINISH"))).toEqual([m("10:00"), m("10:15")]);
    expect(seg(first, "FINISH").resourceId).toBe(TABLE_1_ID);
  });

  it("buffer kept when the station is released", () => {
    const slots = findSlots(
      groomCtx({
        services: withService({ ...haircut, bufferAfterMin: 15 }),
        employees: [groomerA],
        resources: [table1],
        pets: [pet(rex, [haircut.id, nails.id])],
      }),
    );
    const first = slots[0]!;
    expect(first.start).toBe(m("09:00"));
    expect(seg(first, "GROOM")).toMatchObject({ start: m("09:00"), end: m("10:00"), blockEnd: m("10:15") });
    expect(span(seg(first, "FINISH"))).toEqual([m("10:15"), m("10:30")]);
  });

  it("last segment's buffer must be free", () => {
    const slots = findSlots(
      groomCtx({
        services: withService({ ...bath, bufferAfterMin: 10 }),
        employees: [batherA],
        busy: [busy({ employeeId: batherA.id }, "09:50", "10:00")],
        pets: [pet(rex, [bath.id])],
      }),
    );
    expect(firstAt(slots, "09:00")).toBeUndefined();
    expect(seg(firstAt(slots, "10:00"), "BATH").blockEnd).toBe(m("10:55"));
  });

  it("preferred groomer", () => {
    const slots = findSlots(groomCtx({ pets: [pet(rex, [bath.id, haircut.id], { preferredGroomerId: groomerB.id })] }));
    expect(seg(slots[0], "GROOM").employeeId).toBe(groomerB.id);
  });

  it("tie-break by booked minutes", () => {
    const slots = findSlots(
      groomCtx({
        busy: [busy({ employeeId: groomerA.id }, "15:00", "17:00")],
        pets: [pet(rex, [bath.id, haircut.id])],
      }),
    );
    expect(slots[0]!.start).toBe(m("09:00"));
    expect(seg(slots[0], "GROOM").employeeId).toBe(groomerB.id);
  });

  it("lead time and staff mode", () => {
    const now = Date.parse("2026-12-07T15:10:00Z");
    const pets = [pet(rex, [bath.id, haircut.id])];
    expect(iso(findSlots(groomCtx({ now, pets }))[0]!.start)).toBe("2026-12-07T16:15:00.000Z");
    expect(iso(findSlots(groomCtx({ now, pets, mode: "STAFF" }))[0]!.start)).toBe("2026-12-07T15:00:00.000Z");
  });

  it("horizon and past date", () => {
    const pets = [pet(rex, [bath.id, haircut.id])];
    expect(findSlots(groomCtx({ date: "2027-02-04", pets })).length).toBeGreaterThan(0);
    expect(findSlots(groomCtx({ date: "2027-02-05", pets }))).toEqual([]);
    expect(findSlots(groomCtx({ date: "2027-02-05", pets, mode: "STAFF" })).length).toBeGreaterThan(0);
    expect(findSlots(groomCtx({ date: "2026-12-05", pets }))).toEqual([]);
  });

  it("not online bookable", () => {
    const pets = [pet(rex, [bath.id, haircut.id])];
    const hidden = withService({ ...haircut, onlineBookable: false });
    expect(findSlots(groomCtx({ services: hidden, pets }))).toEqual([]);
    expect(findSlots(groomCtx({ services: hidden, pets, mode: "STAFF" })).length).toBeGreaterThan(0);
    const offline = [
      batherA,
      batherB,
      makeEmployee(groomerA, { bookableOnline: false }),
      makeEmployee(groomerB, { bookableOnline: false }),
    ];
    expect(findSlots(groomCtx({ employees: offline, pets }))).toEqual([]);
  });

  it("staff override ignores hours", () => {
    const day = allDay();
    const timeOff = [{ start: day.start, end: day.end }];
    const slots = findSlots(
      groomCtx({
        mode: "STAFF",
        override: true,
        employees: [batherA, batherB, makeEmployee(groomerA, { timeOff }), makeEmployee(groomerB, { timeOff })],
        pets: [pet(rex, [bath.id, haircut.id])],
      }),
    );
    expect(slots[0]!.start).toBe(m("00:00"));
  });

  it("DST day", () => {
    const slots = findSlots(
      groomCtx({ date: "2026-03-08", now: Date.parse("2026-03-01T12:00:00Z"), pets: [pet(rex, [bath.id])] }),
    );
    expect(iso(slots[0]!.start)).toBe("2026-03-08T13:00:00.000Z");
  });
});

describe("findSlots: drop-off mode", () => {
  const dropOff = (o: Parameters<typeof groomCtx>[0] = {}) => findSlots(groomCtx({ bookingMode: "DROP_OFF", ...o }));
  const noKennel2 = [tub1, tub2, table1, table2, dryer1, kennel1];
  const kennelBusy = (resourceId: string, start: number, end: number): BusySegment => ({
    employeeId: null,
    resourceId,
    start,
    blockEnd: end,
  });

  it("windows define drop-off times", () => {
    const slots = dropOff({ pets: [pet(rex, [bath.id])] });
    expect(slots.map((s) => s.start)).toEqual(
      ["09:00", "09:15", "09:30", "09:45", "10:00", "10:15", "10:30", "10:45"].map((t) => m(t as WallTime)),
    );
    const first = slots[0]!;
    expect(first.bookingMode).toBe("DROP_OFF");
    expect(span(seg(first, "BATH"))).toEqual([m("09:10"), m("09:55")]);
    expect(seg(first, "KENNEL")).toMatchObject({
      employeeId: null,
      resourceId: KENNEL_1_ID,
      serviceIds: [],
      start: m("09:00"),
      end: m("10:55"),
      blockEnd: m("10:55"),
      durationMin: 115,
      priceCents: 0,
    });
    expect(segs(first).map((s) => s.stage)).toEqual(["BATH", "KENNEL"]);
    expect(first.readyAt).toBe(m("09:55"));
  });

  it("no window that weekday", () => {
    const dropOffWindows = everyDay("09:00", "11:00").filter((w) => w.weekday !== 1);
    expect(dropOff({ location: makeLocation({ dropOffWindows }), pets: [pet(rex, [bath.id])] })).toEqual([]);
  });

  it("staff override ignores windows", () => {
    const slots = dropOff({ mode: "STAFF", override: true, pets: [pet(rex, [bath.id])] });
    expect(slots[0]!.start).toBe(m("00:00"));
  });

  it("lead time", () => {
    const slots = dropOff({ now: m("08:50"), pets: [pet(rex, [bath.id])] });
    expect(slots.map((s) => s.start)).toEqual([m("10:00"), m("10:15"), m("10:30"), m("10:45")]);
  });

  it("queue wait boundary", () => {
    const base = {
      employees: [batherA, groomerA],
      busy: [busy({ employeeId: batherA.id }, "09:00", "10:15"), busy({ employeeId: groomerA.id }, "09:00", "11:15")],
      pets: [pet(rex, [bath.id, haircut.id])],
    };
    const ok = firstAt(dropOff({ ...base, location: makeLocation({ maxQueueWaitMin: 80 }) }), "09:00");
    expect(span(seg(ok, "BATH"))).toEqual([m("10:15"), m("11:00")]);
    expect(span(seg(ok, "GROOM"))).toEqual([m("11:15"), m("12:15")]);
    expect(span(seg(ok, "KENNEL"))).toEqual([m("09:00"), m("13:15")]);
    expect(firstAt(dropOff({ ...base, location: makeLocation({ maxQueueWaitMin: 79 }) }), "09:00")).toBeUndefined();
  });

  it("later pets see earlier pets", () => {
    const slots = dropOff({ employees: [batherA], pets: [pet(rex, [bath.id]), pet(luna, [bath.id])] });
    const s = firstAt(slots, "09:00");
    expect(span(seg(s, "BATH", 0))).toEqual([m("09:10"), m("09:55")]);
    expect(span(seg(s, "BATH", 1))).toEqual([m("10:00"), m("10:45")]);
    expect(seg(s, "KENNEL", 0).resourceId).toBe(KENNEL_1_ID);
    expect(seg(s, "KENNEL", 1).resourceId).toBe(KENNEL_2_ID);
    expect(s!.readyAt).toBe(m("10:45"));
  });

  it("no free kennel", () => {
    const day = allDay();
    const slots = dropOff({
      busy: [kennelBusy(KENNEL_1_ID, day.start, day.end), kennelBusy(KENNEL_2_ID, day.start, day.end)],
      pets: [pet(rex, [bath.id])],
    });
    expect(slots).toEqual([]);
  });

  it("one kennel, two pets", () => {
    expect(dropOff({ resources: noKennel2, pets: [pet(rex, [bath.id]), pet(luna, [bath.id])] })).toEqual([]);
  });

  it("pickup grace boundary", () => {
    const day = allDay();
    const run = (b: BusySegment) =>
      firstAt(dropOff({ resources: noKennel2, busy: [b], pets: [pet(rex, [bath.id, haircut.id])] }), "09:00");
    const ok = run(kennelBusy(KENNEL_1_ID, m("11:55"), day.end));
    expect(span(seg(ok, "BATH"))).toEqual([m("09:10"), m("09:55")]);
    expect(span(seg(ok, "GROOM"))).toEqual([m("09:55"), m("10:55")]);
    expect(span(seg(ok, "KENNEL"))).toEqual([m("09:00"), m("11:55")]);
    expect(run(kennelBusy(KENNEL_1_ID, m("11:54"), day.end))).toBeUndefined();
    expect(run(kennelBusy(KENNEL_1_ID, day.start, m("09:00")))).toBeDefined();
  });

  it("DST day", () => {
    const slots = dropOff({ date: "2026-03-08", now: Date.parse("2026-03-01T12:00:00Z"), pets: [pet(rex, [bath.id])] });
    expect(slots).toHaveLength(8);
    expect(iso(slots[0]!.start)).toBe("2026-03-08T13:00:00.000Z");
  });
});

describe("search budget and performance", () => {
  it("budget exhausted yields no plan", () => {
    const p = prepare(groomCtx(), MON);
    const specs = resolvePets(p, [pet(rex, [bath.id, haircut.id])]);
    expect(planWait(p, specs, m("09:00"), 1)).toBeNull();
    expect(planWait(p, specs, m("09:00"))).not.toBeNull();
  });

  it("heavy infeasible search stays fast", () => {
    const day = allDay();
    const full = [bath.id, dry.id, haircut.id, nails.id];
    const pets = [pet(rex, full), pet(luna, full), pet(max, full), pet(fourthDog, full)];
    let t0 = Date.now();
    const none = findSlots(
      groomCtx({
        bookingMode: "DROP_OFF",
        busy: [
          { employeeId: null, resourceId: KENNEL_1_ID, start: day.start, blockEnd: day.end },
          { employeeId: null, resourceId: KENNEL_2_ID, start: day.start, blockEnd: day.end },
        ],
        pets,
      }),
    );
    expect(none).toEqual([]);
    expect(Date.now() - t0).toBeLessThan(2000);
    t0 = Date.now();
    findSlots(groomCtx({ employees: [batherA, groomerA], pets }));
    expect(Date.now() - t0).toBeLessThan(2000);
  });
});
