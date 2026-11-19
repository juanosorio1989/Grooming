import "reflect-metadata";
import { BadRequestException, Body, ConflictException, Controller, Get, INestApplication, Module, Post, Req } from "@nestjs/common";
import type { Request } from "express";
import { Test } from "@nestjs/testing";
import request from "supertest";
import { createZodDto } from "nestjs-zod";
import { z } from "zod";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ProblemSchema } from "@grooming/contracts";
import { HealthModule } from "../src/health/health.module.js";
import { configureApp } from "../src/bootstrap.js";
import { loadEnv } from "../src/config/env.js";
import { testEnv } from "./support/test-env.js";

class EchoDto extends createZodDto(z.object({ name: z.string() })) {}

@Controller("echo")
class EchoController {
  @Post()
  echo(@Body() body: EchoDto) {
    return body;
  }

  @Get("conflict")
  conflict(): never {
    throw new ConflictException({ code: "SLOT_TAKEN" });
  }

  @Get("field-error")
  fieldError(): never {
    throw new BadRequestException({
      code: "VALIDATION_FAILED",
      message: "Only US phone numbers are supported",
      errors: [{ path: "phone", message: "Only US phone numbers are supported" }],
    });
  }

  @Get("bad-errors")
  badErrors(): never {
    throw new BadRequestException({ code: "VALIDATION_FAILED", errors: [{ path: 1, secret: "x" }] });
  }

  @Get("ip")
  ip(@Req() req: Request) {
    return { ip: req.ip };
  }

  @Get("boom")
  boom(): never {
    throw new Error("secret detail");
  }
}

@Module({ imports: [HealthModule], controllers: [EchoController] })
class TestModule {}

const env = testEnv();

describe("api skeleton", () => {
  let app: INestApplication;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [TestModule] }).compile();
    app = moduleRef.createNestApplication();
    await configureApp(app, env);
    await app.init();
  });
  afterAll(async () => {
    await app.close();
  });

  it("GET /v1/health returns ok with nosniff", async () => {
    const res = await request(app.getHttpServer()).get("/v1/health");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: "ok" });
    expect(res.headers["x-content-type-options"]).toBe("nosniff");
  });

  it("GET /v1/openapi.json lists /v1/health", async () => {
    const res = await request(app.getHttpServer()).get("/v1/openapi.json");
    expect(res.status).toBe(200);
    expect(res.body.paths).toHaveProperty("/v1/health");
  });

  it("unknown route returns problem+json NOT_FOUND", async () => {
    const res = await request(app.getHttpServer()).get("/v1/nope");
    expect(res.status).toBe(404);
    expect(res.headers["content-type"]).toMatch(/^application\/problem\+json/);
    expect(res.body.code).toBe("NOT_FOUND");
    expect(ProblemSchema.safeParse(res.body).success).toBe(true);
  });

  it("invalid body returns VALIDATION_FAILED with path", async () => {
    const res = await request(app.getHttpServer()).post("/v1/echo").send({});
    expect(res.status).toBe(400);
    expect(res.body.code).toBe("VALIDATION_FAILED");
    expect(res.headers["content-type"]).toMatch(/^application\/problem\+json/);
    expect(ProblemSchema.safeParse(res.body).success).toBe(true);
    expect(res.body.errors[0].path).toBe("name");
  });

  it("malformed JSON returns VALIDATION_FAILED", async () => {
    const res = await request(app.getHttpServer())
      .post("/v1/echo")
      .set("content-type", "application/json")
      .send('{"name":');
    expect(res.status).toBe(400);
    expect(res.headers["content-type"]).toMatch(/^application\/problem\+json/);
    expect(res.body.code).toBe("VALIDATION_FAILED");
    expect(ProblemSchema.safeParse(res.body).success).toBe(true);
  });

  it("oversized body returns 413 BAD_REQUEST problem", async () => {
    const res = await request(app.getHttpServer())
      .post("/v1/echo")
      .send({ name: "x".repeat(200_000) });
    expect(res.status).toBe(413);
    expect(res.headers["content-type"]).toMatch(/^application\/problem\+json/);
    expect(res.body.code).toBe("BAD_REQUEST");
    expect(ProblemSchema.safeParse(res.body).success).toBe(true);
  });

  it("custom code on HttpException is preserved", async () => {
    const res = await request(app.getHttpServer()).get("/v1/echo/conflict");
    expect(res.status).toBe(409);
    expect(res.body.code).toBe("SLOT_TAKEN");
    expect(ProblemSchema.safeParse(res.body).success).toBe(true);
  });

  it("an errors array on an HttpException body is passed through", async () => {
    const res = await request(app.getHttpServer()).get("/v1/echo/field-error");
    expect(res.status).toBe(400);
    expect(res.body.code).toBe("VALIDATION_FAILED");
    expect(res.body.detail).toBe("Only US phone numbers are supported");
    expect(res.body.errors).toEqual([{ path: "phone", message: "Only US phone numbers are supported" }]);
    expect(ProblemSchema.safeParse(res.body).success).toBe(true);
  });

  it("a malformed errors array on an HttpException body is dropped", async () => {
    const res = await request(app.getHttpServer()).get("/v1/echo/bad-errors");
    expect(res.status).toBe(400);
    expect(res.body.errors).toBeUndefined();
    expect(res.text).not.toContain("secret");
    expect(ProblemSchema.safeParse(res.body).success).toBe(true);
  });

  it("unknown error returns 500 INTERNAL without leaking details", async () => {
    const res = await request(app.getHttpServer()).get("/v1/echo/boom");
    expect(res.status).toBe(500);
    expect(res.body.code).toBe("INTERNAL");
    expect(res.body.detail).toBeUndefined();
    expect(res.text).not.toContain("secret detail");
    expect(res.text).not.toMatch(/at /);
    expect(ProblemSchema.safeParse(res.body).success).toBe(true);
  });

  it("CORS rejects unknown origin and echoes the allowed one", async () => {
    const evil = await request(app.getHttpServer())
      .options("/v1/health")
      .set("Origin", "https://evil.example")
      .set("Access-Control-Request-Method", "GET");
    expect(evil.headers["access-control-allow-origin"]).toBeUndefined();
    const ok = await request(app.getHttpServer())
      .options("/v1/health")
      .set("Origin", "http://localhost:3000")
      .set("Access-Control-Request-Method", "GET");
    expect(ok.headers["access-control-allow-origin"]).toBe("http://localhost:3000");
  });

  it("CORS preflight allows only the auth/CSRF headers, not x-token-transport", async () => {
    const res = await request(app.getHttpServer())
      .options("/v1/health")
      .set("Origin", "http://localhost:3000")
      .set("Access-Control-Request-Method", "POST")
      .set("Access-Control-Request-Headers", "x-token-transport,x-grooming-csrf");
    const allowed = String(res.headers["access-control-allow-headers"] ?? "").toLowerCase().split(/\s*,\s*/);
    expect(allowed).toEqual(expect.arrayContaining(["authorization", "content-type", "x-grooming-csrf"]));
    expect(allowed).not.toContain("x-token-transport");
  });

  it("loadEnv({}) throws naming DATABASE_URL", () => {
    expect(() => loadEnv({})).toThrow(/DATABASE_URL/);
  });
});

describe("trust proxy", () => {
  const ipWith = async (trustProxy: string, xff: string): Promise<string> => {
    const moduleRef = await Test.createTestingModule({ imports: [TestModule] }).compile();
    const app = moduleRef.createNestApplication();
    await configureApp(app, testEnv({ TRUST_PROXY: trustProxy }));
    await app.init();
    try {
      const res = await request(app.getHttpServer()).get("/v1/echo/ip").set("X-Forwarded-For", xff);
      return res.body.ip as string;
    } finally {
      await app.close();
    }
  };

  it("TRUST_PROXY=1 uses the right-most X-Forwarded-For entry, not a forged left-most one", async () => {
    expect(await ipWith("1", "6.6.6.6, 203.0.113.7")).toBe("203.0.113.7");
  });

  it("TRUST_PROXY=false ignores X-Forwarded-For", async () => {
    const ip = await ipWith("false", "6.6.6.6, 203.0.113.7");
    expect(ip).not.toBe("6.6.6.6");
    expect(ip).not.toBe("203.0.113.7");
  });
});
