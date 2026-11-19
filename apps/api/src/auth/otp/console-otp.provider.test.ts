import { Logger } from "@nestjs/common";
import type { Redis } from "ioredis";
import { afterEach, describe, expect, it, vi } from "vitest";
import { sha256Hex } from "../crypto/tokens.js";
import { hashKeyPart } from "../../rate-limit/rate-limit.service.js";
import { ConsoleOtpProvider } from "./console-otp.provider.js";
import type { OtpProvider } from "./otp-provider.js";

function memoryRedis() {
  const store = new Map<string, string>();
  const set = vi.fn(async (k: string, v: string) => {
    store.set(k, v);
    return "OK";
  });
  const redis = {
    set,
    get: async (k: string) => store.get(k) ?? null,
    del: async (k: string) => Number(store.delete(k)),
  };
  return { store, set, redis: redis as unknown as Redis };
}

describe("ConsoleOtpProvider", () => {
  afterEach(() => vi.restoreAllMocks());

  it("stores only the code hash under the hashed phone for 600 s and logs the code", async () => {
    const log = vi.spyOn(Logger.prototype, "log").mockImplementation(() => undefined);
    const { store, set, redis } = memoryRedis();
    const provider: OtpProvider = new ConsoleOtpProvider(redis);
    await provider.start("+13055550100", "whatsapp", "en");

    const key = `otp:console:${hashKeyPart("+13055550100")}`;
    expect(set).toHaveBeenCalledWith(key, expect.any(String), "EX", 600);
    const code = /OTP for \+13055550100: (\d{6})$/.exec(String(log.mock.calls[0]![0]))![1]!;
    expect(store.get(key)).toBe(sha256Hex(code));

    expect(await provider.check("+13055550100", code === "000000" ? "111111" : "000000")).toBe(false);
    expect(store.has(key)).toBe(true);
    expect(await provider.check("+13055550100", code)).toBe(true);
    expect(store.has(key)).toBe(false);
    expect(await provider.check("+13055550100", code)).toBe(false);
  });
});
