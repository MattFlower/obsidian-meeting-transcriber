import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      // The `obsidian` npm package is types-only (no runtime entry point), so
      // modules that import it are resolved to a small headless stub in tests.
      obsidian: fileURLToPath(
        new URL("./tests/helpers/obsidian-stub.ts", import.meta.url),
      ),
    },
  },
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
  },
});
