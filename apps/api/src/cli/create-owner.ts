/**
 * Creates the first OWNER of the default organization, or resets an existing
 * OWNER (password, TOTP, recovery codes and sessions cleared), and prints a
 * fresh 72 h invite link. `--locale` is optional: a new OWNER defaults to `en`,
 * a reset changes the locale only when the flag is given. Does not start the HTTP server.
 *
 * Usage: pnpm --filter @grooming/api create-owner --email <email> [--locale en|es]
 */
import "reflect-metadata";
import { NestFactory } from "@nestjs/core";
import { EmailSchema, LocaleSchema, type Locale } from "@grooming/contracts";
import { AppModule } from "../app.module.js";
import { StaffLinksService } from "../auth/staff/staff-links.service.js";

const USAGE = "Usage: create-owner --email <email> [--locale en|es]";

export type CreateOwnerArgs = { email: string; locale?: Locale };

/**
 * Parses `--email <e>` and optional `--locale en|es` (omitted when not given: a new
 * OWNER gets `en`, a reset keeps the current locale). Throws a one-line message on bad input.
 */
export function parseArgs(argv: readonly string[]): CreateOwnerArgs {
  let email: string | undefined;
  let locale: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    const value = argv[i + 1];
    if (flag === "--") continue;
    if ((flag === "--email" || flag === "--locale") && value !== undefined && !value.startsWith("--")) {
      if (flag === "--email") email = value;
      else locale = value;
      i++;
    } else {
      throw new Error(USAGE);
    }
  }
  const parsedEmail = EmailSchema.safeParse(email);
  if (!parsedEmail.success) throw new Error(`Invalid or missing --email. ${USAGE}`);
  if (locale === undefined) return { email: parsedEmail.data };
  const parsedLocale = LocaleSchema.safeParse(locale);
  if (!parsedLocale.success) throw new Error(`Invalid --locale (en or es). ${USAGE}`);
  return { email: parsedEmail.data, locale: parsedLocale.data };
}

async function main(): Promise<void> {
  let args: CreateOwnerArgs;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (err) {
    process.stderr.write(`${(err as Error).message}\n`);
    process.exitCode = 1;
    return;
  }

  const app = await NestFactory.createApplicationContext(AppModule, { logger: ["error", "warn"] });
  try {
    const { link, created } = await app.get(StaffLinksService).createOrResetOwner(args.email, args.locale);
    process.stdout.write(`${created ? "Owner created" : "Owner reset"}\n`);
    process.stdout.write(`Invite link (valid 72 h): ${link}\n`);
  } catch (err) {
    const message = err instanceof Error ? err.message.split("\n")[0] : "create-owner failed";
    process.stderr.write(`${message}\n`);
    process.exitCode = 1;
  } finally {
    await app.close();
  }
}

if (process.argv[1] && /create-owner\.(js|ts)$/.test(process.argv[1])) void main();
