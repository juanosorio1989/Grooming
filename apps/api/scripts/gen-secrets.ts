/**
 * `pnpm --filter @grooming/api secrets:gen`: fills missing secrets in the
 * repo-root `.env` (copied from `.env.example` when absent). Prints only key
 * names, never values. Also fills the local S3 keys (alphanumeric) when empty.
 */
import { chmodSync, copyFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { addMissingSecrets, defaultGenerators } from "./secrets.js";

const root = resolve(__dirname, "../../..");
const envPath = resolve(root, ".env");

if (!existsSync(envPath)) copyFileSync(resolve(root, ".env.example"), envPath);

const { text, added } = addMissingSecrets(readFileSync(envPath, "utf8"), defaultGenerators());
if (added.length > 0) {
  writeFileSync(envPath, text);
  console.log(`Added: ${added.join(", ")}`);
} else {
  console.log("Nothing to add");
}
// The file holds private keys: owner read/write only, also when it already existed.
chmodSync(envPath, 0o600);
