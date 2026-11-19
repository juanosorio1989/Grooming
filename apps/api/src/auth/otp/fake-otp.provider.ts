import type { OtpProvider } from "./otp-provider.js";

/** TEST ONLY (`loadEnv` allows `OTP_PROVIDER=fake` only with `NODE_ENV=test`): sends nothing, accepts `000000`. */
export class FakeOtpProvider implements OtpProvider {
  async start(): Promise<void> {}

  async check(_phone: string, code: string): Promise<boolean> {
    return code === "000000";
  }
}
