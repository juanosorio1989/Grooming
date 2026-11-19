import { Module } from "@nestjs/common";
import { APP_GUARD } from "@nestjs/core";
import type { Redis } from "ioredis";
import { AuditModule } from "../audit/audit.module.js";
import { ENV, type Env } from "../config/env.js";
import { REDIS } from "../redis/redis.module.js";
import { AccessGuard } from "./access.guard.js";
import { Encryptor } from "./crypto/encryption.js";
import { ConsoleOtpProvider } from "./otp/console-otp.provider.js";
import { FakeOtpProvider } from "./otp/fake-otp.provider.js";
import { OTP_PROVIDER, type OtpProvider } from "./otp/otp-provider.js";
import { OtpController } from "./otp/otp.controller.js";
import { OtpService } from "./otp/otp.service.js";
import { TwilioVerifyProvider } from "./otp/twilio-verify.provider.js";
import { RefreshTokenService } from "./refresh-token.service.js";
import { SessionController } from "./session.controller.js";
import { SessionService } from "./session.service.js";
import { MfaService } from "./staff/mfa.service.js";
import { StaffAdminController } from "./staff/staff-admin.controller.js";
import { StaffAuthController } from "./staff/staff-auth.controller.js";
import { StaffAuthService } from "./staff/staff-auth.service.js";
import { StaffLinksController } from "./staff/staff-links.controller.js";
import { StaffLinksService } from "./staff/staff-links.service.js";
import { TokenService } from "./token.service.js";

/** `loadEnv` already refuses `console`/`fake` in production and `fake` outside tests. */
function otpProviderFactory(env: Env, redis: Redis): OtpProvider {
  switch (env.OTP_PROVIDER) {
    case "twilio":
      return new TwilioVerifyProvider(env);
    case "console":
      return new ConsoleOtpProvider(redis);
    case "fake":
      return new FakeOtpProvider();
  }
}

@Module({
  imports: [AuditModule],
  controllers: [SessionController, OtpController, StaffAuthController, StaffLinksController, StaffAdminController],
  providers: [
    TokenService,
    RefreshTokenService,
    SessionService,
    OtpService,
    StaffAuthService,
    MfaService,
    StaffLinksService,
    {
      provide: Encryptor,
      inject: [ENV],
      useFactory: (env: Env) => new Encryptor({ keyId: env.DATA_ENCRYPTION_KEY_ID, keyB64: env.DATA_ENCRYPTION_KEY }),
    },
    { provide: OTP_PROVIDER, inject: [ENV, REDIS], useFactory: otpProviderFactory },
    { provide: APP_GUARD, useClass: AccessGuard },
  ],
  exports: [TokenService, RefreshTokenService, SessionService, Encryptor, StaffLinksService],
})
export class AuthModule {}
