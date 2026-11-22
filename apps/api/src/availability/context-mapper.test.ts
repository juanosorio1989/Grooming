import { describe, expect, it } from "vitest";
import { FIXTURE_SETTINGS } from "../../test/integration/helpers.js";
import { resolveBookingMode, toEngineContext, type ContextRows } from "./context-mapper.js";

const t = (hhmm: string) => new Date(`1970-01-01T${hhmm}:00.000Z`);

function rows(over: Partial<ContextRows> = {}): ContextRows {
  return {
    location: { id: "loc", timezone: "America/New_York", settings: FIXTURE_SETTINGS },
    hours: [],
    closures: [],
    services: [],
    prices: [],
    employees: [],
    resources: [],
    busy: [],
    ...over,
  };
}

describe("toEngineContext", () => {
  it('closes 00:00 maps to "24:00"', () => {
    const ctx = toEngineContext(rows({ hours: [{ weekday: 2, opens: t("09:00"), closes: t("00:00") }] }), new Date(5));
    expect(ctx.location.hours).toEqual([{ weekday: 2, start: "09:00", end: "24:00" }]);
    expect(ctx.now).toBe(5);
  });

  it('dropOffWindows {"1":[{from:"08:00",to:"11:00"}]} → [{weekday:1,start:"08:00",end:"11:00"}]', () => {
    const settings = { ...FIXTURE_SETTINGS, dropOffWindows: { "1": [{ from: "08:00", to: "11:00" }] } };
    const ctx = toEngineContext(rows({ location: { id: "loc", timezone: "America/New_York", settings } }), new Date(0));
    expect(ctx.location.dropOffWindows).toEqual([{ weekday: 1, start: "08:00", end: "11:00" }]);
    expect(ctx.location.slotIntervalMin).toBe(15);
  });

  it("kennel busy row keeps employeeId null", () => {
    const ctx = toEngineContext(
      rows({ busy: [{ staffUserId: null, resourceId: "k1", startsAt: new Date(10), blockEndsAt: new Date(20) }] }),
      new Date(0),
    );
    expect(ctx.busy).toEqual([{ employeeId: null, resourceId: "k1", start: 10, blockEnd: 20 }]);
  });
});

describe("resolveBookingMode", () => {
  it("uses the location default for a null service mode", () => {
    expect(resolveBookingMode([{ bookingMode: null }], "DROP_OFF")).toBe("DROP_OFF");
    expect(resolveBookingMode([{ bookingMode: "WAIT" }, { bookingMode: null }], "WAIT")).toBe("WAIT");
    expect(resolveBookingMode([{ bookingMode: "WAIT" }, { bookingMode: "DROP_OFF" }], "WAIT")).toBe("DROP_OFF");
  });
});
