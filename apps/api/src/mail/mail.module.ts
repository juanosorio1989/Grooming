import { Global, Module } from "@nestjs/common";
import { ENV, type Env } from "../config/env.js";
import { ConsoleMailer } from "./console.mailer.js";
import { MAILER, type Mailer } from "./mailer.js";
import { ResendMailer } from "./resend.mailer.js";

/** `loadEnv` refuses `console` in production and requires the Resend settings for `resend`. */
function mailerFactory(env: Env): Mailer {
  return env.EMAIL_PROVIDER === "resend" ? new ResendMailer(env) : new ConsoleMailer();
}

@Global()
@Module({
  providers: [{ provide: MAILER, inject: [ENV], useFactory: mailerFactory }],
  exports: [MAILER],
})
export class MailModule {}
