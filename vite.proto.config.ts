import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";

// Prototype vite config for vite-node benches: repoints the `@bireactive`
// alias at the parallel engine copy in `proto-microtask`.
const protoRoot = fileURLToPath(new URL("./proto-microtask", import.meta.url));

export default defineConfig({
  resolve: {
    alias: { "@bireactive": protoRoot },
  },
});
