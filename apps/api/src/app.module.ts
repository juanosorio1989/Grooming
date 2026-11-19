import { Module } from "@nestjs/common";
import { AuditModule } from "./audit/audit.module.js";
import { AuthModule } from "./auth/auth.module.js";
import { ConfigModule } from "./config/config.module.js";
import { HealthModule } from "./health/health.module.js";
import { MailModule } from "./mail/mail.module.js";
import { PrismaModule } from "./prisma/prisma.module.js";
import { RateLimitModule } from "./rate-limit/rate-limit.module.js";
import { RedisModule } from "./redis/redis.module.js";
import { TenancyModule } from "./tenancy/tenancy.module.js";

@Module({ imports: [ConfigModule, PrismaModule, RedisModule, RateLimitModule, TenancyModule, AuditModule, MailModule, AuthModule, HealthModule] })
export class AppModule {}
