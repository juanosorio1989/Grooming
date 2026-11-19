import { generateKeyPairSync, randomBytes, randomInt } from "node:crypto";

export type SecretGenerators = Record<string, () => string>;

const ALPHANUMERIC = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";

/**
 * Uniform random alphanumeric string (CSPRNG). Used for the local S3 keys:
 * SeaweedFS's identity JSON is built by an unquoted heredoc, so the values
 * must not contain shell or JSON special characters.
 */
export function randomAlphanumeric(length: number): string {
  let out = "";
  for (let i = 0; i < length; i++) out += ALPHANUMERIC[randomInt(ALPHANUMERIC.length)];
  return out;
}

/** Generators for the secrets `secrets:gen` fills in. */
export function defaultGenerators(): SecretGenerators {
  return {
    JWT_PRIVATE_KEY_B64: () =>
      generateKeyPairSync("ed25519").privateKey.export({ format: "der", type: "pkcs8" }).toString("base64"),
    DATA_ENCRYPTION_KEY: () => randomBytes(32).toString("base64"),
    // Local SeaweedFS credentials (docker compose and the API read them from .env).
    S3_ACCESS_KEY_ID: () => randomAlphanumeric(20),
    S3_SECRET_ACCESS_KEY: () => randomAlphanumeric(40),
  };
}

/**
 * Adds a `KEY=value` line for each generator key that is absent from `envText`
 * or present with an empty value (`KEY=`, replaced in place). Lines with a
 * value, comments and other keys are never changed.
 */
export function addMissingSecrets(envText: string, gen: SecretGenerators): { text: string; added: string[] } {
  const lines = envText.split("\n");
  const added: string[] = [];
  const append: string[] = [];
  for (const [key, make] of Object.entries(gen)) {
    const idx = lines.findIndex((l) => l.startsWith(`${key}=`));
    if (idx >= 0 && lines[idx]!.slice(key.length + 1).trim() !== "") continue;
    const line = `${key}=${make()}`;
    if (idx >= 0) lines[idx] = line;
    else append.push(line);
    added.push(key);
  }
  if (added.length === 0) return { text: envText, added };
  let text = lines.join("\n");
  if (append.length > 0) {
    if (text !== "" && !text.endsWith("\n")) text += "\n";
    text += append.join("\n") + "\n";
  }
  return { text, added };
}
