import { Prisma } from "@prisma/client";

const SQLSTATE = /^[0-9A-Z]{5}$/;

const isPrismaRequestError = (err: unknown): boolean =>
  err instanceof Prisma.PrismaClientUnknownRequestError || err instanceof Prisma.PrismaClientKnownRequestError;

/**
 * The PostgreSQL SQLSTATE behind a Prisma error, or undefined. P2002 (unique
 * violation) is reported as `23505`. Prisma 6 maps neither exclusion (`23P01`)
 * nor check (`23514`) violations to a P-code: it throws
 * `PrismaClientUnknownRequestError` with no `meta`/`cause`, and the SQLSTATE
 * appears only in the message as `code: "23P01"`. `meta.code` and `cause.code`
 * are read first in case a later Prisma version exposes them. The message is
 * read only for Prisma request errors, so an arbitrary error that quotes a
 * SQLSTATE is not mistaken for a database error.
 */
export function pgSqlState(err: unknown): string | undefined {
  if (typeof err !== "object" || err === null) return undefined;
  const e = err as { code?: unknown; meta?: { code?: unknown }; cause?: { code?: unknown }; message?: unknown };
  if (e.code === "P2002") return "23505";
  const metaCode = e.meta?.code;
  if (typeof metaCode === "string" && SQLSTATE.test(metaCode)) return metaCode;
  const causeCode = e.cause?.code;
  if (typeof causeCode === "string" && SQLSTATE.test(causeCode)) return causeCode;
  if (!isPrismaRequestError(err) || typeof e.message !== "string") return undefined;
  return /code: "([0-9A-Z]{5})"/.exec(e.message)?.[1];
}

/** The constraint named in a Postgres error message (`constraint "name"`, quotes possibly escaped), or undefined. */
export function pgConstraintName(err: unknown): string | undefined {
  const message = err instanceof Error ? err.message : undefined;
  return message ? /constraint \\?"([A-Za-z0-9_]+)\\?"/.exec(message)?.[1] : undefined;
}
