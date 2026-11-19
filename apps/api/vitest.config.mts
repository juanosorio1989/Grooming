import { configDefaults, defineConfig, mergeConfig } from "vitest/config";
import swc from "unplugin-swc";
import preset from "@grooming/config/vitest.preset";

export default mergeConfig(
  preset,
  defineConfig({
    plugins: [swc.vite({ module: { type: "es6" } })],
    // Integration tests need a database; they run only via `test:int` (vitest.int.config.mts).
    test: { exclude: [...configDefaults.exclude, "test/integration/**"] },
  }),
);
