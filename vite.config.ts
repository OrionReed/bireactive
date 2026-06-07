import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import { buildSite, PROD_BASE } from "./site/build";

const src = fileURLToPath(new URL("./src", import.meta.url));

export default defineConfig(({ command }) => ({
  // Dev serves from root; the GitHub Pages build is namespaced under the repo.
  // `PROD_BASE` is shared with site/build.ts so the two can't drift.
  base: command === "build" ? PROD_BASE : "/",
  resolve: {
    alias: {
      "@bireactive": src,
    },
  },
  server: {
    port: 5555,
  },
  build: {
    // The library's compiled output lives in `dist` (see tsconfig.build.json);
    // the demo site bundle gets its own dir.
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
    // Custom-element tag names are derived from class names at runtime
    // (Diagram.tagName / BaseElement.tagName), so the bundle must preserve
    // them — renaming would break every `<md-*>` upgrade.
    keepNames: true,
  },
  plugins: [
    {
      name: "bireactive-site",
      // `buildStart` writes the root index.html that vite consumes as the
      // build input; `closeBundle` rewrites it for production once dist-web
      // exists, so the prod HTML can point at the hashed bundle.
      buildStart() {
        buildSite();
      },
      closeBundle() {
        buildSite();
      },
      configureServer(server) {
        buildSite();
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
