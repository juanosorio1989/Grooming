import { Global, Module } from "@nestjs/common";
import { ENV, loadEnv } from "./env.js";

export { ENV } from "./env.js";

/** Provides the validated `Env` under the `ENV` token. Tests override it with `testEnv()`. */
@Global()
@Module({ providers: [{ provide: ENV, useFactory: () => loadEnv() }], exports: [ENV] })
export class ConfigModule {}
