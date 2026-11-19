import type { Locale } from "@grooming/contracts";
import type { Env } from "../../config/env.js";
import {
  OtpInvalidRecipientError,
  OtpProviderRateLimitedError,
  OtpProviderUnavailableError,
  type OtpChannel,
  type OtpProvider,
} from "./otp-provider.js";

type FetchFn = (url: string, init: RequestInit) => Promise<Response>;

const BASE_URL = "https://verify.twilio.com/v2/Services";
const TIMEOUT_MS = 10_000;

/**
 * Twilio Verify over its REST API (no SDK). Twilio generates, delivers and
 * checks the code; this class never sees it on `start`. Error messages carry
 * only the HTTP status (or `network` / `timeout`): never the response body,
 * the code or the auth token. Every request is aborted after 10 s.
 *
 * start: 400 → `OtpInvalidRecipientError`, 429 → `OtpProviderRateLimitedError`,
 * anything else non-2xx, network error or timeout → `OtpProviderUnavailableError`.
 * check: 404 → false, 429 → `OtpProviderRateLimitedError`, anything else
 * non-2xx, network error or timeout → `OtpProviderUnavailableError`.
 */
export class TwilioVerifyProvider implements OtpProvider {
  private readonly serviceUrl: string;
  private readonly authorization: string;

  constructor(
    env: Pick<Env, "TWILIO_ACCOUNT_SID" | "TWILIO_AUTH_TOKEN" | "TWILIO_VERIFY_SERVICE_SID">,
    private readonly fetchFn: FetchFn = fetch,
  ) {
    const { TWILIO_ACCOUNT_SID: sid, TWILIO_AUTH_TOKEN: token, TWILIO_VERIFY_SERVICE_SID: service } = env;
    if (!sid || !token || !service) throw new Error("Twilio Verify is not configured");
    this.serviceUrl = `${BASE_URL}/${encodeURIComponent(service)}`;
    this.authorization = `Basic ${Buffer.from(`${sid}:${token}`).toString("base64")}`;
  }

  async start(phone: string, channel: OtpChannel, locale: Locale): Promise<void> {
    const label = "Twilio Verify start failed";
    const res = await this.post("Verifications", { To: phone, Channel: channel, Locale: locale }, label);
    if (res.ok) return;
    const message = `${label}: ${res.status}`;
    if (res.status === 400) throw new OtpInvalidRecipientError(message);
    if (res.status === 429) throw new OtpProviderRateLimitedError(message);
    throw new OtpProviderUnavailableError(message);
  }

  async check(phone: string, code: string): Promise<boolean> {
    const label = "Twilio Verify check failed";
    const res = await this.post("VerificationCheck", { To: phone, Code: code }, label);
    // 404: no pending verification (expired, already approved, or too many attempts).
    if (res.status === 404) return false;
    if (res.status === 429) throw new OtpProviderRateLimitedError(`${label}: 429`);
    if (!res.ok) throw new OtpProviderUnavailableError(`${label}: ${res.status}`);
    const json = (await res.json()) as { status?: unknown };
    return json.status === "approved";
  }

  /** POSTs a form; a network error or timeout becomes `OtpProviderUnavailableError` (cause text dropped). */
  private async post(path: string, form: Record<string, string>, label: string): Promise<Response> {
    try {
      return await this.fetchFn(`${this.serviceUrl}/${path}`, {
        method: "POST",
        headers: { Authorization: this.authorization, "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams(form).toString(),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch (err) {
      throw new OtpProviderUnavailableError(`${label}: ${isAbort(err) ? "timeout" : "network"}`);
    }
  }
}

function isAbort(err: unknown): boolean {
  return err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError");
}
