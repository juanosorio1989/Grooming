import { describe, expect, it } from "vitest";
import { REFRESH_TTL_MS } from "./refresh-token.service.js";

describe("REFRESH_TTL_MS", () => {
  it("keeps a customer signed in for 90 days", () => {
    expect(REFRESH_TTL_MS.CUSTOMER).toBe(7_776_000_000);
  });

  it("keeps staff at 12 hours", () => {
    expect(REFRESH_TTL_MS.STAFF).toBe(43_200_000);
  });
});
