/* Builds the single landing page: `site/index.md` → root `index.html`
 * (and `dist/index.html` once vite has emitted the bundle). Markdown is
 * rendered with marked + footnotes + Temml math, code fences become
 * `<md-syntax>`, and the prose is wrapped in a minimal shell that loads
 * the custom-element bundle. There is no post list, header, or byline —
 * the page is the whole site. */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import matter from "gray-matter";
import {
  type MarkedExtension,
  marked,
  type RendererExtension,
  type TokenizerExtension,
} from "marked";
import markedFootnote from "marked-footnote";
import temml from "temml";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const SOURCE = fileURLToPath(new URL("./index.md", import.meta.url));
const DIST_DIR = `${ROOT}/dist-web`;

// GitHub Pages serves this project repo under /bireactive/, so the production
// page references assets with that prefix. `vite.config.ts` imports this for
// its `base`, so the two can't drift. Dev is served from the root.
export const PROD_BASE = "/bireactive/";

/** Marked extension that renders `$$...$$` (block) and `$...$` (inline)
 *  math via Temml → MathML. No runtime CSS dependency — the New CM Math
 *  font is loaded by `style.css`. */
const markedTemml: MarkedExtension = {
  extensions: [
    {
      name: "math_block",
      level: "block",
      start: src => src.indexOf("$$"),
      tokenizer(src): ReturnType<TokenizerExtension["tokenizer"]> {
        const match = /^\$\$([\s\S]+?)\$\$/.exec(src);
        if (match) return { type: "math_block", raw: match[0], text: match[1].trim() };
      },
      renderer(token): ReturnType<RendererExtension["renderer"]> {
        return `<p class="math-block">${temml.renderToString(token["text"], {
          displayMode: true,
          throwOnError: false,
        })}</p>\n`;
      },
    } as TokenizerExtension & RendererExtension,
    {
      name: "math_inline",
      level: "inline",
      start: src => src.indexOf("$"),
      tokenizer(src): ReturnType<TokenizerExtension["tokenizer"]> {
        // Match $...$ but not $$...$$
        const match = /^\$(?!\$)([^$\n]+?)\$(?!\$)/.exec(src);
        if (match) return { type: "math_inline", raw: match[0], text: match[1] };
      },
      renderer(token): ReturnType<RendererExtension["renderer"]> {
        return `<span class="math-inline">${temml.renderToString(token["text"], {
          throwOnError: false,
        })}</span>`;
      },
    } as TokenizerExtension & RendererExtension,
  ],
};

interface Page {
  title: string;
  description: string;
  content: string;
}

function renderPage(): Page {
  const raw = readFileSync(SOURCE, "utf-8");
  const { content: markdown, data: frontmatter } = matter(raw);

  marked
    .use(markedFootnote())
    .use(markedTemml)
    .use({
      renderer: {
        code(code: string, language?: string) {
          // md-syntax tokenizes innerText, so HTML-escape the raw source
          // before embedding (parse5 treats `<` as a tag start).
          const escaped = code.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
          const lang = language ? ` lang="${language}"` : "";
          return `<md-syntax${lang}>${escaped}</md-syntax>`;
        },
        image(href: string, title: string | null, text: string) {
          if (href.match(/\.(mp4|mov)$/i)) {
            return `<video controls><source src="${href}" type="video/${
              href.endsWith(".mov") ? "quicktime" : "mp4"
            }">Your browser does not support the video tag.</video>`;
          }
          return `<img src="${href}" alt="${text || ""}"${title ? ` title="${title}"` : ""}>`;
        },
      },
    });

  return {
    title: frontmatter.title || "Bireactive",
    description: frontmatter.description || frontmatter.title || "Bireactive",
    content: marked.parse(markdown) as string,
  };
}

function pageHTML(page: Page, isProduction: boolean): string {
  const base = isProduction ? PROD_BASE : "/";
  const elementsScript = isProduction ? `${base}js/elements.js` : "/site/elements/index.ts";

  return `<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>${page.title}</title>
    <link rel="icon" type="image/svg+xml" href="${base}favicon.svg?v=7" />
    <link rel="preconnect" href="https://fonts.googleapis.com" />
    <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
    <link
      href="https://fonts.googleapis.com/css2?family=Recursive:slnt,wght,CASL,CRSV,MONO@-15..0,300..1000,0..1,0..1,0..1&display=swap"
      rel="stylesheet"
    />
    <link rel="stylesheet" href="${base}css/reset.css" />
    <link rel="stylesheet" href="${base}css/style.css" />

    <!-- Resolve the theme before first paint to avoid a flash. Must match
         DarkModeToggle.loadTheme(): saved preference, else OS preference. The
         ink-color overrides key on [data-theme], the rest on color-scheme. -->
    <script>
      (function () {
        var saved = localStorage.getItem("theme");
        var theme = saved || (matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light");
        var root = document.documentElement;
        root.setAttribute("data-theme", theme);
        root.style.colorScheme = theme === "dark" ? "dark" : "light";
      })();
    </script>

    <meta name="description" content="${page.description}" />
    <meta property="og:type" content="article" />
    <meta property="og:title" content="${page.title}" />
    <meta property="og:description" content="${page.description}" />
    <meta name="twitter:card" content="summary" />
    <meta name="twitter:title" content="${page.title}" />
    <meta name="twitter:description" content="${page.description}" />
  </head>
  <body>
    <dark-mode-toggle></dark-mode-toggle>
    <github-link></github-link>
    <docs-link></docs-link>
    <main class="post">
      ${page.content}
    </main>
    <script type="module" src="${elementsScript}"></script>
  </body>
</html>`;
}

export function buildSite() {
  if (!existsSync(SOURCE)) {
    console.log("No site/index.md found, skipping...");
    return;
  }

  const page = renderPage();

  writeFileSync(`${ROOT}/index.html`, pageHTML(page, false));

  // The prod page is written into the vite bundle dir once it exists (the
  // build script runs this file again after `vite build`).
  if (existsSync(DIST_DIR)) {
    writeFileSync(`${DIST_DIR}/index.html`, pageHTML(page, true));
  }

  console.log("✅ Built landing page");
}
