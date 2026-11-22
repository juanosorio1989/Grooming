import { ArgumentsHost, Catch, ExceptionFilter, HttpException, HttpStatus, Logger } from "@nestjs/common";
import type { Response } from "express";
import { ZodValidationException } from "nestjs-zod";
import { ErrorCode, ProblemSchema, type Problem } from "@grooming/contracts";
import { pgSqlState } from "./pg-error.js";

const STATUS_CODES: Record<number, ErrorCode> = {
  400: "VALIDATION_FAILED",
  401: "UNAUTHORIZED",
  403: "FORBIDDEN",
  404: "NOT_FOUND",
  409: "CONFLICT",
  429: "RATE_LIMITED",
};

function codeForStatus(status: number): ErrorCode {
  return STATUS_CODES[status] ?? (status >= 400 && status < 500 ? "BAD_REQUEST" : "INTERNAL");
}

const FieldErrors = ProblemSchema.shape.errors.unwrap();

/** A well-formed `errors` array from an HttpException body, or undefined (malformed arrays are dropped). */
function fieldErrors(body: unknown): Problem["errors"] {
  if (typeof body !== "object" || body === null) return undefined;
  const parsed = FieldErrors.safeParse((body as { errors?: unknown }).errors);
  // Zod strips unknown keys: only `path` and `message` reach the response.
  return parsed.success ? parsed.data : undefined;
}

// body-parser / http-errors shape: numeric 4xx status plus string type
function isHttpError(e: unknown): e is { status: number; type: string } {
  if (typeof e !== "object" || e === null) return false;
  const { status, type } = e as { status?: unknown; type?: unknown };
  return typeof status === "number" && status >= 400 && status < 500 && typeof type === "string";
}

@Catch()
export class ProblemFilter implements ExceptionFilter {
  private readonly logger = new Logger(ProblemFilter.name);

  catch(exception: unknown, host: ArgumentsHost): void {
    const res = host.switchToHttp().getResponse<Response>();
    const problem = this.toProblem(exception);
    if (problem.status >= 500) this.logger.error(exception instanceof Error ? (exception.stack ?? exception.message) : String(exception));
    res.status(problem.status).type("application/problem+json").send(JSON.stringify(problem));
  }

  private toProblem(exception: unknown): Problem {
    if (exception instanceof ZodValidationException) {
      const zodError = exception.getZodError() as { issues?: { path: (string | number)[]; message: string }[] };
      const errors = (zodError.issues ?? []).map((i) => ({ path: i.path.join("."), message: i.message }));
      return { type: "about:blank", title: "Validation failed", status: 400, code: "VALIDATION_FAILED", errors };
    }
    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      const body = exception.getResponse();
      const parsedCode = typeof body === "object" && body !== null ? ErrorCode.safeParse((body as { code?: unknown }).code) : undefined;
      const code = parsedCode?.success ? parsedCode.data : codeForStatus(status);
      const detail = typeof body === "string" ? body : (body as { message?: unknown }).message;
      const errors = status < 500 ? fieldErrors(body) : undefined;
      return {
        type: "about:blank",
        title: HttpStatus[status]?.replaceAll("_", " ") ?? "Error",
        status,
        code,
        ...(status < 500 && typeof detail === "string" ? { detail } : {}),
        ...(errors ? { errors } : {}),
      };
    }
    if (isHttpError(exception)) {
      const status = exception.status;
      return {
        type: "about:blank",
        title: HttpStatus[status]?.replaceAll("_", " ") ?? "Bad Request",
        status,
        code: codeForStatus(status),
      };
    }
    // An exclusion violation (no_employee_overlap / no_resource_overlap) is a lost booking race, never a 500.
    if (pgSqlState(exception) === "23P01") {
      return { type: "about:blank", title: "Conflict", status: 409, code: "SLOT_TAKEN", detail: "That time was just taken" };
    }
    return { type: "about:blank", title: "Internal Server Error", status: 500, code: "INTERNAL" };
  }
}
