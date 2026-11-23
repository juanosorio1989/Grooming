import { type ArgumentsHost, Logger } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { describe, expect, it, vi } from "vitest";
import { isTxConflict, pgSqlState } from "./pg-error.js";
import { ProblemFilter } from "./problem.filter.js";

/** Runs the filter against a fake Express response and returns status and parsed body. */
function run(exception: unknown): { status: number; type: string; body: Record<string, unknown> } {
  const out = { status: 0, type: "", body: {} as Record<string, unknown> };
  const res = {
    status(s: number) {
      out.status = s;
      return res;
    },
    type(t: string) {
      out.type = t;
      return res;
    },
    send(b: string) {
      out.body = JSON.parse(b) as Record<string, unknown>;
      return res;
    },
  };
  const host = { switchToHttp: () => ({ getResponse: () => res }) } as unknown as ArgumentsHost;
  new ProblemFilter().catch(exception, host);
  return out;
}

/** What Prisma 6 throws for an exclusion violation: no P-code, SQLSTATE only in the message. */
const exclusionError = () =>
  new Prisma.PrismaClientUnknownRequestError(
    'Error occurred during query execution:\nConnectorError(ConnectorError { user_facing_error: None, kind: QueryError(PostgresError { code: "23P01", message: "conflicting key value violates exclusion constraint \\"no_employee_overlap\\"", severity: "ERROR" }) })',
    { clientVersion: "6.19.3" },
  );

describe("ProblemFilter", () => {
  it("maps a 23P01 Prisma error to 409 SLOT_TAKEN", () => {
    const r = run(exclusionError());
    expect(r.status).toBe(409);
    expect(r.type).toBe("application/problem+json");
    expect(r.body).toMatchObject({ status: 409, code: "SLOT_TAKEN" });
  });

  it("logs the violated constraint name on 23P01 → 409", () => {
    const warn = vi.spyOn(Logger.prototype, "warn").mockImplementation(() => undefined);
    try {
      run(exclusionError());
      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn.mock.calls[0]?.[0]).toBe("SLOT_TAKEN: exclusion constraint no_employee_overlap");
    } finally {
      warn.mockRestore();
    }
  });

  it.each([
    ["40P01 (deadlock)", new Prisma.PrismaClientUnknownRequestError('PostgresError { code: "40P01", message: "deadlock detected" }', { clientVersion: "6.19.3" })],
    ["40001 (serialization)", new Prisma.PrismaClientKnownRequestError("boom", { code: "P2010", clientVersion: "6.19.3", meta: { code: "40001" } })],
    ["P2034 (write conflict)", new Prisma.PrismaClientKnownRequestError("boom", { code: "P2034", clientVersion: "6.19.3" })],
  ])("maps a transaction conflict %s to 409 CONFLICT with a warn log", (_name, err) => {
    const warn = vi.spyOn(Logger.prototype, "warn").mockImplementation(() => undefined);
    try {
      const r = run(err);
      expect(r.status).toBe(409);
      expect(r.body).toMatchObject({ status: 409, code: "CONFLICT" });
      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn.mock.calls[0]?.[0]).toBe("CONFLICT: transaction aborted by a lock or serialization conflict");
    } finally {
      warn.mockRestore();
    }
  });

  it("keeps other unknown Prisma errors as 500 INTERNAL", () => {
    const err = new Prisma.PrismaClientUnknownRequestError('PostgresError { code: "23514" }', { clientVersion: "6.19.3" });
    expect(run(err)).toMatchObject({ status: 500, body: { code: "INTERNAL" } });
  });
});

const known = (code: string, meta?: Record<string, unknown>) =>
  new Prisma.PrismaClientKnownRequestError("boom", { code, clientVersion: "6", ...(meta ? { meta } : {}) });

describe("isTxConflict", () => {
  it("recognizes write-conflict, serialization and deadlock aborts", () => {
    expect(isTxConflict(known("P2034"))).toBe(true);
    expect(isTxConflict(known("P2010", { code: "40P01" }))).toBe(true);
    expect(isTxConflict(known("P2010", { code: "40001" }))).toBe(true);
    expect(isTxConflict(new Error("Raw query failed. Code: `40P01`. Message: `deadlock detected`"))).toBe(true);
  });
  it("ignores other errors", () => {
    expect(isTxConflict(known("P2002"))).toBe(false);
    expect(isTxConflict(new Error("connection reset"))).toBe(false);
    expect(isTxConflict(null)).toBe(false);
  });
});

describe("pgSqlState", () => {
  it("reads the SQLSTATE from meta.code, cause.code or the message", () => {
    expect(pgSqlState(exclusionError())).toBe("23P01");
    expect(pgSqlState({ meta: { code: "23P01" } })).toBe("23P01");
    expect(pgSqlState({ cause: { code: "23514" } })).toBe("23514");
    expect(pgSqlState({ code: "P2002" })).toBe("23505");
  });

  it("returns undefined for non-objects and unrelated errors", () => {
    expect(pgSqlState(undefined)).toBeUndefined();
    expect(pgSqlState("23P01")).toBeUndefined();
    expect(pgSqlState(new Error("boom"))).toBeUndefined();
  });

  it("reads the message only for Prisma errors", () => {
    expect(pgSqlState(new Error('PostgresError { code: "23P01" }'))).toBeUndefined();
    expect(pgSqlState({ message: 'code: "23P01"' })).toBeUndefined();
    const known = new Prisma.PrismaClientKnownRequestError('PostgresError { code: "23514" }', { code: "P2010", clientVersion: "6.19.3" });
    expect(pgSqlState(known)).toBe("23514");
  });
});
