import { describe, expect, it } from "vitest";
import { parseArgs } from "./create-owner.js";

describe("create-owner parseArgs", () => {
  it("parses --email and --locale, normalizing the email; locale is omitted when not given", () => {
    expect(parseArgs(["--email", " Boss@Salon.com ", "--locale", "es"])).toStrictEqual({ email: "boss@salon.com", locale: "es" });
    expect(parseArgs(["--", "--email", "boss@salon.com"])).toStrictEqual({ email: "boss@salon.com" });
  });

  it("rejects a missing or invalid email, a bad locale and unknown flags with a one-line message", () => {
    for (const argv of [[], ["--email"], ["--email", "nope"], ["--email", "a@b.co", "--locale", "fr"], ["--x", "1"]]) {
      expect(() => parseArgs(argv)).toThrow(/^[^\n]+$/);
    }
  });
});
