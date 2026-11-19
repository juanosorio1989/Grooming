import { Inject, Injectable, OnModuleDestroy } from "@nestjs/common";
import { PrismaClient } from "@prisma/client";
import { ENV, type Env } from "../config/env.js";

/**
 * Prisma client as a Nest provider. It connects lazily on the first query
 * (no `$connect` at startup), so modules and tests that never touch the
 * database do not need one. Uses `ENV.DATABASE_URL`.
 */
@Injectable()
export class PrismaService extends PrismaClient implements OnModuleDestroy {
  constructor(@Inject(ENV) env: Env) {
    super({ datasourceUrl: env.DATABASE_URL });
  }

  async onModuleDestroy(): Promise<void> {
    await this.$disconnect();
  }
}
