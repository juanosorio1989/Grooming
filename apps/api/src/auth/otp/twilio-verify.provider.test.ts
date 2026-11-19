import { describe, expect, it, vi } from "vitest";
import { testEnv } from "../../../test/support/test-env.js";
import {
  OtpInvalidRecipientError,
  OtpProviderRateLimitedError,
  OtpProviderUnavailableError,
} from "./otp-provider.js";
import { TwilioVerifyProvider } from "./twilio-verify.provider.js";

const SID = "ACtest0000000000000000000000000000";
const TOKEN = "test-auth-token-not-real";
const SERVICE = "VAtest0000000000000000000000000000";

const env = testEnv({
  OTP_PROVIDER: "twilio",
  TWILIO_ACCOUNT_SID: SID,
  TWILIO_AUTH_TOKEN: TOKEN,
  TWILIO_VERIFY_SERVICE_SID: SERVICE,
});

function fakeFetch(status: number, body: unknown) {
  return vi.fn<(url: string, init: RequestInit) => Promise<Response>>(async () =>
    new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } }),
  );
}

describe("TwilioVerifyProvider", () => {
  it("start posts To/Channel/Locale as a form to Verifications with Basic auth", async () => {
    const fetchFn = fakeFetch(201, { status: "pending" });
    await new TwilioVerifyProvider(env, fetchFn).start("+13055550100", "whatsapp", "es");
    expect(fetchFn).toHaveBeenCalledTimes(1);
    const [url, init] = fetchFn.mock.calls[0]!;
    expect(String(url)).toBe(`https://verify.twilio.com/v2/Services/${SERVICE}/Verifications`);
    expect(init?.method).toBe("POST");
    expect(String(init?.body)).toBe("To=%2B13055550100&Channel=whatsapp&Locale=es");
    const headers = new Headers(init?.headers);
    expect(headers.get("authorization")).toBe(`Basic ${Buffer.from(`${SID}:${TOKEN}`).toString("base64")}`);
    expect(headers.get("content-type")).toBe("application/x-www-form-urlencoded");
  });

  it("start and check pass a 10 s abort signal to fetch", async () => {
    const timeout = vi.spyOn(AbortSignal, "timeout");
    const fetchFn = fakeFetch(200, { status: "approved" });
    const provider = new TwilioVerifyProvider(env, fetchFn);
    await provider.start("+13055550100", "sms", "en");
    await provider.check("+13055550100", "123456");
    expect(timeout).toHaveBeenCalledWith(10_000);
    for (const [, init] of fetchFn.mock.calls) expect(init.signal).toBeInstanceOf(AbortSignal);
    timeout.mockRestore();
  });

  it("start maps 400 to OtpInvalidRecipientError without the response body", async () => {
    const fetchFn = fakeFetch(400, { message: "body-secret-detail" });
    const err = await new TwilioVerifyProvider(env, fetchFn).start("+13055550100", "sms", "en").catch((e: Error) => e);
    expect(err).toBeInstanceOf(OtpInvalidRecipientError);
    expect((err as Error).message).toBe("Twilio Verify start failed: 400");
  });

  it("start maps 429 to OtpProviderRateLimitedError", async () => {
    const err = await new TwilioVerifyProvider(env, fakeFetch(429, {})).start("+13055550100", "sms", "en").catch((e: Error) => e);
    expect(err).toBeInstanceOf(OtpProviderRateLimitedError);
    expect((err as Error).message).toBe("Twilio Verify start failed: 429");
  });

  it.each([500, 503, 401, 403])("start maps %i to OtpProviderUnavailableError", async (status) => {
    const err = await new TwilioVerifyProvider(env, fakeFetch(status, { message: "body-secret-detail" }))
      .start("+13055550100", "whatsapp", "en")
      .catch((e: Error) => e);
    expect(err).toBeInstanceOf(OtpProviderUnavailableError);
    expect((err as Error).message).toBe(`Twilio Verify start failed: ${status}`);
  });

  it("start maps a network error to OtpProviderUnavailableError without the cause text", async () => {
    const fetchFn = vi.fn<(url: string, init: RequestInit) => Promise<Response>>(async () => {
      throw new TypeError("fetch failed: secret-host-detail");
    });
    const err = await new TwilioVerifyProvider(env, fetchFn).start("+13055550100", "whatsapp", "en").catch((e: Error) => e);
    expect(err).toBeInstanceOf(OtpProviderUnavailableError);
    expect((err as Error).message).toBe("Twilio Verify start failed: network");
  });

  it("start maps a timeout (AbortSignal.timeout) to OtpProviderUnavailableError", async () => {
    const fetchFn = vi.fn<(url: string, init: RequestInit) => Promise<Response>>(async () => {
      throw new DOMException("The operation was aborted due to timeout", "TimeoutError");
    });
    const err = await new TwilioVerifyProvider(env, fetchFn).start("+13055550100", "whatsapp", "en").catch((e: Error) => e);
    expect(err).toBeInstanceOf(OtpProviderUnavailableError);
    expect((err as Error).message).toBe("Twilio Verify start failed: timeout");
  });

  it("start maps an AbortError to OtpProviderUnavailableError", async () => {
    const fetchFn = vi.fn<(url: string, init: RequestInit) => Promise<Response>>(async () => {
      throw new DOMException("This operation was aborted", "AbortError");
    });
    const err = await new TwilioVerifyProvider(env, fetchFn).start("+13055550100", "sms", "en").catch((e: Error) => e);
    expect(err).toBeInstanceOf(OtpProviderUnavailableError);
    expect((err as Error).message).toBe("Twilio Verify start failed: timeout");
  });

  it("check posts To/Code to VerificationCheck and returns true when approved", async () => {
    const fetchFn = fakeFetch(200, { status: "approved" });
    await expect(new TwilioVerifyProvider(env, fetchFn).check("+13055550100", "123456")).resolves.toBe(true);
    const [url, init] = fetchFn.mock.calls[0]!;
    expect(String(url)).toBe(`https://verify.twilio.com/v2/Services/${SERVICE}/VerificationCheck`);
    expect(String(init?.body)).toBe("To=%2B13055550100&Code=123456");
  });

  it("check returns false for pending", async () => {
    await expect(
      new TwilioVerifyProvider(env, fakeFetch(200, { status: "pending" })).check("+13055550100", "123456"),
    ).resolves.toBe(false);
  });

  it("check returns false on 404 (no pending verification)", async () => {
    await expect(
      new TwilioVerifyProvider(env, fakeFetch(404, { code: 20404 })).check("+13055550100", "123456"),
    ).resolves.toBe(false);
  });

  it("check maps 429 to OtpProviderRateLimitedError", async () => {
    const err = await new TwilioVerifyProvider(env, fakeFetch(429, {})).check("+13055550100", "123456").catch((e: Error) => e);
    expect(err).toBeInstanceOf(OtpProviderRateLimitedError);
    expect((err as Error).message).toBe("Twilio Verify check failed: 429");
  });

  it.each([400, 401, 500, 503])("check maps %i to OtpProviderUnavailableError", async (status) => {
    const err = await new TwilioVerifyProvider(env, fakeFetch(status, {})).check("+13055550100", "123456").catch((e: Error) => e);
    expect(err).toBeInstanceOf(OtpProviderUnavailableError);
    expect((err as Error).message).toBe(`Twilio Verify check failed: ${status}`);
  });

  it("check maps a network error or timeout to OtpProviderUnavailableError", async () => {
    const network = vi.fn<(url: string, init: RequestInit) => Promise<Response>>(async () => {
      throw new TypeError("fetch failed");
    });
    const timeout = vi.fn<(url: string, init: RequestInit) => Promise<Response>>(async () => {
      throw new DOMException("The operation was aborted due to timeout", "TimeoutError");
    });
    const e1 = await new TwilioVerifyProvider(env, network).check("+13055550100", "123456").catch((e: Error) => e);
    const e2 = await new TwilioVerifyProvider(env, timeout).check("+13055550100", "123456").catch((e: Error) => e);
    expect(e1).toBeInstanceOf(OtpProviderUnavailableError);
    expect((e1 as Error).message).toBe("Twilio Verify check failed: network");
    expect(e2).toBeInstanceOf(OtpProviderUnavailableError);
    expect((e2 as Error).message).toBe("Twilio Verify check failed: timeout");
  });

  it("check throws on 500 without the response body or the token", async () => {
    const fetchFn = fakeFetch(500, { message: "body-secret-detail" });
    const err = (await new TwilioVerifyProvider(env, fetchFn).check("+13055550100", "123456").catch((e: Error) => e)) as Error;
    expect(err).toBeInstanceOf(Error);
    expect(err.message).not.toContain("body-secret-detail");
    expect(err.message).not.toContain(TOKEN);
    expect(err.message).not.toContain("123456");
  });
});
