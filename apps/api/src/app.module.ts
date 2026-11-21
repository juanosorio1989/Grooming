import { Module } from "@nestjs/common";
import { AuditModule } from "./audit/audit.module.js";
import { AuthModule } from "./auth/auth.module.js";
import { CatalogModule } from "./catalog/catalog.module.js";
import { ConfigModule } from "./config/config.module.js";
import { HealthModule } from "./health/health.module.js";
import { LocationModule } from "./location/location.module.js";
import { MailModule } from "./mail/mail.module.js";
import { PrismaModule } from "./prisma/prisma.module.js";
import { RateLimitModule } from "./rate-limit/rate-limit.module.js";
import { RedisModule } from "./redis/redis.module.js";
import { ResourcesModule } from "./resources/resources.module.js";
import { SettingsModule } from "./settings/settings.module.js";
import { TenancyModule } from "./tenancy/tenancy.module.js";

@Module({ imports: [ConfigModule, PrismaModule, RedisModule, RateLimitModule, TenancyModule, LocationModule, AuditModule, MailModule, AuthModule, HealthModule, SettingsModule, ResourcesModule, CatalogModule] })
export class AppModule {}
