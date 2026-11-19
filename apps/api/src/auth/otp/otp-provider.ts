import type { Locale } from "@grooming/contracts";

/** Nest injection token for the active `OtpProvider` (chosen by `env.OTP_PROVIDER` in `AuthModule`). */
export const OTP_PROVIDER = Symbol("OTP_PROVIDER");

export type OtpChannel = "whatsapp" | "sms";

/**
 * Sends and checks one-time codes for a phone. Implementations must never put
 * the code (or provider credentials) in logs or error messages, except the
 * dev-only console provider, which logs the code on purpose.
 */
export interface OtpProvider {
  /**
   * Sends a code over `channel`. Throws `OtpInvalidRecipientError`,
   * `OtpProviderRateLimitedError` or `OtpProviderUnavailableError`; any other
   * error is treated as unavailable.
   */
  start(phone: string, channel: OtpChannel, locale: Locale): Promise<void>;
  /**
   * True when `code` is the current code for `phone`. Throws
   * `OtpProviderRateLimitedError` or `OtpProviderUnavailableError`.
   */
  check(phone: string, code: string): Promise<boolean>;
}

/** Base for typed provider failures. Messages carry only a status or `network`/`timeout`, never a phone, code or body. */
export abstract class OtpProviderError extends Error {
  constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}

/** The provider rejected the phone itself (Twilio 400 on start): retrying on another channel will not help. */
export class OtpInvalidRecipientError extends OtpProviderError {}

/** The provider rate-limited us for this phone or account (HTTP 429). */
export class OtpProviderRateLimitedError extends OtpProviderError {}

/** The channel cannot deliver right now (5xx, other unexpected status, network error, timeout). */
export class OtpProviderUnavailableError extends OtpProviderError {}
