import type { INestApplication } from "@nestjs/common";
import type { NestExpressApplication } from "@nestjs/platform-express";
import { DocumentBuilder, SwaggerModule } from "@nestjs/swagger";
import cookieParser from "cookie-parser";
import helmet from "helmet";
import { ZodValidationPipe, cleanupOpenApiDoc } from "nestjs-zod";
import { AUTH_HEADERS } from "@grooming/contracts";
import { ProblemFilter } from "./common/problem.filter.js";
import type { Env } from "./config/env.js";

export async function configureApp(app: INestApplication, env: Env): Promise<void> {
  app.setGlobalPrefix("v1");
  // false, a hop count, or a list of trusted proxy IPs/CIDRs; never `true` (see `TRUST_PROXY` in env.ts).
  (app as NestExpressApplication).set("trust proxy", env.TRUST_PROXY);
  app.use(helmet());
  app.use(cookieParser());
  // Native clients do not use CORS, so `x-token-transport` is deliberately not allowed for browsers.
  app.enableCors({
    origin: [env.WEB_ORIGIN],
    credentials: true,
    allowedHeaders: ["authorization", "content-type", AUTH_HEADERS.csrf],
  });
  app.useGlobalPipes(new ZodValidationPipe());
  app.useGlobalFilters(new ProblemFilter());

  const config = new DocumentBuilder().setTitle("Grooming API").setVersion("1.0").build();
  const document = cleanupOpenApiDoc(SwaggerModule.createDocument(app, config));
  SwaggerModule.setup("v1/docs", app, document, { jsonDocumentUrl: "v1/openapi.json" });
}
