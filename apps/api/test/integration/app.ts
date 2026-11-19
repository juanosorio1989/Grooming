import type { INestApplication, Type } from "@nestjs/common";
import { Test, type TestingModuleBuilder } from "@nestjs/testing";
import type { Redis } from "ioredis";
import { AppModule } from "../../src/app.module.js";
import { configureApp } from "../../src/bootstrap.js";
import { ENV } from "../../src/config/env.js";
import { PrismaService } from "../../src/prisma/prisma.service.js";
import { REDIS } from "../../src/redis/redis.module.js";
import { testEnv } from "../support/test-env.js";
import { truncateAll } from "./helpers.js";
import { testDatabaseUrl, testRedisUrl } from "./setup.js";

export interface IntegrationApp {
  app: INestApplication;
  prisma: PrismaService;
  redis: Redis;
  close(): Promise<void>;
}

/**
 * Full `AppModule` (plus test-only `imports`) against the test database and
 * test Redis DB. `override` can stub providers before compile.
 */
export async function createIntegrationApp(
  opts: {
    env?: Record<string, string>;
    imports?: Type[];
    override?: (b: TestingModuleBuilder) => TestingModuleBuilder;
  } = {},
): Promise<IntegrationApp> {
  const env = testEnv({ DATABASE_URL: testDatabaseUrl(), REDIS_URL: testRedisUrl(), ...opts.env });
  let builder = Test.createTestingModule({ imports: [AppModule, ...(opts.imports ?? [])] })
    .overrideProvider(ENV)
    .useValue(env);
  if (opts.override) builder = opts.override(builder);
  const moduleRef = await builder.compile();
  const app = moduleRef.createNestApplication();
  await configureApp(app, env);
  await app.init();
  return {
    app,
    prisma: app.get(PrismaService),
    redis: app.get<Redis>(REDIS),
    close: () => app.close(),
  };
}

/** Empties every table and the test Redis DB. */
export async function resetState(prisma: PrismaService, redis: Redis): Promise<void> {
  await truncateAll(prisma);
  await redis.flushdb();
}
