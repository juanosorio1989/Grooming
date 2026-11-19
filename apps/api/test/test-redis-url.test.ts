import { afterEach, describe, expect, it, vi } from "vitest";
import { testRedisUrl } from "./integration/setup.js";

describe("testRedisUrl", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("requires REDIS_URL_TEST", () => {
    vi.stubEnv("REDIS_URL_TEST", "");
    expect(() => testRedisUrl()).toThrow(/REDIS_URL_TEST is required/);
  });

  it.each(["redis://localhost:6379", "redis://localhost:6379/", "redis://localhost:6379/0"])("refuses DB 0 (%s)", (url) => {
    vi.stubEnv("REDIS_URL_TEST", url);
    vi.stubEnv("REDIS_URL", "redis://localhost:6379/5");
    expect(() => testRedisUrl()).toThrow(/DB index 0/);
  });

  it("refuses the REDIS_URL database", () => {
    vi.stubEnv("REDIS_URL_TEST", "redis://localhost:6379/2");
    vi.stubEnv("REDIS_URL", "redis://localhost:6379/2");
    expect(() => testRedisUrl()).toThrow(/same database as REDIS_URL/);
  });

  it("accepts a separate non-zero DB", () => {
    vi.stubEnv("REDIS_URL_TEST", "redis://localhost:6379/1");
    vi.stubEnv("REDIS_URL", "redis://localhost:6379");
    expect(testRedisUrl()).toBe("redis://localhost:6379/1");
  });
});
