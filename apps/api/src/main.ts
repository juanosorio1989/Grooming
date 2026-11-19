import "reflect-metadata";
import { NestFactory } from "@nestjs/core";
import { AppModule } from "./app.module.js";
import { configureApp } from "./bootstrap.js";
import { ENV, type Env } from "./config/env.js";

async function main(): Promise<void> {
  const app = await NestFactory.create(AppModule);
  const env = app.get<Env>(ENV);
  await configureApp(app, env);
  await app.listen(env.PORT);
}

void main();
