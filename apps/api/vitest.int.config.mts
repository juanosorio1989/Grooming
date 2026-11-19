import { defineConfig } from "vitest/config";
import swc from "unplugin-swc";

// Integration tests: real PostgreSQL at DATABASE_URL_TEST (pending migrations applied once per run, tables truncated per test).
export default defineConfig({
  plugins: [swc.vite({ module: { type: "es6" } })],
  test: {
    environment: "node",
    include: ["test/integration/**/*.int.test.ts"],
    globalSetup: ["./test/integration/setup.ts"],
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 120_000,
  },
});
