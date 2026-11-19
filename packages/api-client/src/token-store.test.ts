import { describe, expect, it } from "vitest";
import { MemoryTokenStore, createCookieTokenStore } from "./token-store";

describe("token stores", () => {
  it("cookie store getRefreshToken resolves null", async () => {
    const s = createCookieTokenStore();
    await s.setRefreshToken("x");
    await expect(s.getRefreshToken()).resolves.toBeNull();
    s.setAccessToken("a");
    expect(s.getAccessToken()).toBe("a");
  });
  it("memory store keeps both tokens", async () => {
    const s = new MemoryTokenStore();
    s.setAccessToken("a");
    await s.setRefreshToken("r");
    expect(s.getAccessToken()).toBe("a");
    await expect(s.getRefreshToken()).resolves.toBe("r");
  });
});
