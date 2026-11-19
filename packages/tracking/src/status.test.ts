import { describe, expect, it } from "vitest";
import {
  appointmentStatusAfterVisits,
  canTransitionAppointment,
  canTransitionVisit,
} from "./status";

describe("status", () => {
  it("visit transitions", () => {
    const ok: [string, string][] = [
      ["BOOKED", "RECEIVED"],
      ["BOOKED", "CANCELLED"],
      ["BOOKED", "NO_SHOW"],
      ["RECEIVED", "IN_PROGRESS"],
      ["RECEIVED", "READY"],
      ["IN_PROGRESS", "READY"],
      ["READY", "PICKED_UP"],
    ];
    for (const [a, b] of ok) {
      expect(canTransitionVisit(a as never, b as never)).toBe(true);
    }
    expect(canTransitionVisit("READY", "IN_PROGRESS")).toBe(false);
    expect(canTransitionVisit("PICKED_UP", "READY")).toBe(false);
    expect(canTransitionVisit("RECEIVED", "CANCELLED")).toBe(false);
  });

  it("appointment transitions", () => {
    const ok: [string, string][] = [
      ["HELD", "BOOKED"],
      ["HELD", "CANCELLED"],
      ["BOOKED", "IN_SHOP"],
      ["BOOKED", "CANCELLED"],
      ["BOOKED", "NO_SHOW"],
      ["IN_SHOP", "COMPLETED"],
    ];
    for (const [a, b] of ok) {
      expect(canTransitionAppointment(a as never, b as never)).toBe(true);
    }
    expect(canTransitionAppointment("COMPLETED", "IN_SHOP")).toBe(false);
    expect(canTransitionAppointment("HELD", "IN_SHOP")).toBe(false);
  });

  it("appointment follows visits", () => {
    expect(appointmentStatusAfterVisits("BOOKED", ["BOOKED", "BOOKED"])).toBe("BOOKED");
    expect(appointmentStatusAfterVisits("BOOKED", ["RECEIVED", "BOOKED"])).toBe("IN_SHOP");
    expect(appointmentStatusAfterVisits("IN_SHOP", ["PICKED_UP", "READY"])).toBe("IN_SHOP");
    expect(appointmentStatusAfterVisits("IN_SHOP", ["PICKED_UP", "CANCELLED"])).toBe("COMPLETED");
    expect(appointmentStatusAfterVisits("BOOKED", ["PICKED_UP"])).toBe("COMPLETED");
    expect(appointmentStatusAfterVisits("IN_SHOP", ["CANCELLED"])).toBe("IN_SHOP");
    expect(appointmentStatusAfterVisits("CANCELLED", ["RECEIVED"])).toBe("CANCELLED");
  });
});
