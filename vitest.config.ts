import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const src = fileURLToPath(new URL("./src", import.meta.url));

export default defineConfig({
  resolve: {
    alias: { "@bireactive": src },
  },
  test: {
    include: ["src/**/*.test.ts"],
    exclude: ["**/node_modules/**", "**/_bench/**", "dist/**", "site/**"],
    environment: "node",
    setupFiles: ["src/_test/setup.ts"],
  },
});
