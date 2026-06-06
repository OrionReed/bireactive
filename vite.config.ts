import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import { buildSite } from "./site/build";

const src = fileURLToPath(new URL("./src", import.meta.url));

// GitHub Pages serves this project repo under /bireactive/. Keep this in sync
// with PROD_BASE in site/build.ts (which prefixes the generated HTML's URLs).
export default defineConfig(({ command }) => ({
  base: command === "build" ? "/bireactive/" : "/",
  resolve: {
    alias: {
      "@bireactive": src,
    },
  },
  server: {
    port: 5555,
  },
  build: {
    // The library's compiled output lives in `dist` (see tsconfig.build.json
    // + publishConfig); the demo site bundle gets its own dir.
    outDir: "dist-web",
    minify: false,
    target: "esnext",
    rollupOptions: {
      input: {
        main: "index.html",
        elements: "site/elements/index.ts",
      },
      output: {
        format: "es",
        entryFileNames: chunkInfo => {
          if (chunkInfo.name === "elements") {
            return "js/elements.js";
          }
          return "js/[name]-[hash].js";
        },
        chunkFileNames: "js/[name]-[hash].js",
        assetFileNames: assetInfo => {
          if (assetInfo.name?.endsWith(".css")) {
            return "css/[name]-[hash][extname]";
          }
          return "assets/[name]-[hash][extname]";
        },
      },
    },
  },
  esbuild: {
    keepNames: true,
  },
  plugins: [
    {
      name: "site-watcher",
      configureServer(server) {
        server.watcher.add("/site/**/*");
        server.watcher.on("change", file => {
          if (file.includes("/site/")) {
            buildSite();
            server.ws.send({
              type: "full-reload",
            });
          }
        });
      },
    },
  ],
}));
