import tseslint from "typescript-eslint";
import base from "./eslint.base.mjs";

const banned = ["next", "next/*", "@nestjs/*", "react-dom", "node:*", "fs", "path", "crypto", "http"];

export default tseslint.config(...base, {
  rules: {
    "no-restricted-imports": [
      "error",
      {
        paths: banned.filter((p) => !p.includes("*")).map((name) => ({
          name,
          message: "Platform-agnostic packages must not import framework or Node modules.",
        })),
        patterns: banned.filter((p) => p.includes("*")),
      },
    ],
  },
});
