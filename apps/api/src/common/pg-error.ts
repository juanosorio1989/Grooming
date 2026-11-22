const SQLSTATE = /^[0-9A-Z]{5}$/;

/**
 * The PostgreSQL SQLSTATE behind a Prisma error, or undefined. P2002 (unique
 * violation) is reported as `23505`. Prisma 6 maps neither exclusion (`23P01`)
 * nor check (`23514`) violations to a P-code: it throws
 * `PrismaClientUnknownRequestError` with no `meta`/`cause`, and the SQLSTATE
 * appears only in the message as `code: "23P01"`. `meta.code` and `cause.code`
 * are read first in case a later Prisma version exposes them.
 */
export function pgSqlState(err: unknown): string | undefined {
  if (typeof err !== "object" || err === null) return undefined;
  const e = err as { code?: unknown; meta?: { code?: unknown }; cause?: { code?: unknown }; message?: unknown };
  if (e.code === "P2002") return "23505";
  const metaCode = e.meta?.code;
  if (typeof metaCode === "string" && SQLSTATE.test(metaCode)) return metaCode;
  const causeCode = e.cause?.code;
  if (typeof causeCode === "string" && SQLSTATE.test(causeCode)) return causeCode;
  return typeof e.message === "string" ? /code: "([0-9A-Z]{5})"/.exec(e.message)?.[1] : undefined;
}
