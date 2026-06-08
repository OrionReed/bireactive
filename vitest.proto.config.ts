import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

// Prototype config: same as vitest.config.ts but rooted at `proto-microtask`
// (the parallel engine copy) so the `@bireactive` alias and the test
// include glob resolve to the prototype, not the real `src`.
const protoRoot = fileURLToPath(new URL("./proto-microtask", import.meta.url));

export default defineConfig({
  resolve: {
    alias: { "@bireactive": protoRoot },
  },
  test: {
    include: ["proto-microtask/**/*.test.ts"],
    exclude: ["**/node_modules/**", "**/_bench/**", "dist/**", "site/**"],
    environment: "node",
    setupFiles: ["proto-microtask/_test/setup.ts"],
  },
});
