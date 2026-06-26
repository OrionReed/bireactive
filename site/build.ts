/* Builds the landing page and slide deck:
 *   site/index.md  → index.html
 *   site/slides.md → slides.html
 * Markdown is rendered with marked + footnotes + Temml math, code fences
 * become `<md-syntax>`, and each page is wrapped in a shell that loads the
 * custom-element bundle. */

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
const SLIDES_SOURCE = fileURLToPath(new URL("./slides.md", import.meta.url));
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

interface TocEntry {
  level: number;
  id: string;
  text: string;
}

interface Page {
  title: string;
  description: string;
  content: string;
  toc: TocEntry[];
}

/** Slugify a heading's plain text into a valid HTML id. */
function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

/** Strip HTML tags (used to clean marked's rendered heading text). */
function stripTags(html: string): string {
  return html.replace(/<[^>]*>/g, "");
}

/** Decode the handful of HTML entities marked emits in heading text. */
function decodeEntities(html: string): string {
  return html
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

/** Normalize whitespace runs. */
function normalizeWs(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function renderMarkdown(file: string): { frontmatter: Record<string, string>; html: string; toc: TocEntry[] } {
  const raw = readFileSync(file, "utf-8");
  const { content: markdown, data: frontmatter } = matter(raw);

  const toc: TocEntry[] = [];

  marked
    .use(markedFootnote())
    .use(markedTemml)
    .use({
      renderer: {
        heading(text: string, level: number) {
          const stripped = normalizeWs(stripTags(text));
          const id = slugify(decodeEntities(stripped));
          if (level === 2 || level === 3) toc.push({ level, id, text: stripped });
          return `<h${level} id="${id}"><a class="heading-anchor" href="#${id}">${text}</a></h${level}>\n`;
        },
        code(code: string, language?: string) {
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

  return { frontmatter, html: marked.parse(markdown) as string, toc };
}

function renderPage(): Page {
  const { frontmatter, html, toc } = renderMarkdown(SOURCE);
  return {
    title: frontmatter.title || "Bireactive",
    description: frontmatter.description || frontmatter.title || "Bireactive",
    content: html,
    toc,
  };
}

function renderToc(toc: TocEntry[]): string {
  if (toc.length === 0) return "";

  // Build nested HTML: h3s are wrapped in a sub-<ol> inside their parent h2 <li>.
  const lines: string[] = [];
  for (let i = 0; i < toc.length; i++) {
    const { level, id, text } = toc[i];
    const next = toc[i + 1];
    if (level === 2) {
      const hasChildren = next?.level === 3;
      if (hasChildren) {
        lines.push(`<li><a href="#${id}">${text}</a>\n        <ol>`);
      } else {
        lines.push(`<li><a href="#${id}">${text}</a></li>`);
      }
    } else {
      // level === 3: close sub-list when the next entry is not also h3
      const closeSub = !next || next.level !== 3;
      lines.push(
        closeSub
          ? `  <li><a href="#${id}">${text}</a></li>\n        </ol></li>`
          : `  <li><a href="#${id}">${text}</a></li>`,
      );
    }
  }

  return `<details class="toc" open>
    <summary class="toc-toggle" aria-label="Toggle outline">
      <span class="toc-toggle-icon">§</span>
    </summary>
    <div class="toc-panel">
      <p class="toc-heading">Contents</p>
      <ol>
        ${lines.join("\n        ")}
      </ol>
    </div>
  </details>`;
}

// Inline script: runs synchronously before first paint (placed at end of <body>).
// Uses plain ES2015+ — no bundling, no TypeScript — so keep it self-contained.
const scrollSpyScript = `
(function () {
  const toc = document.querySelector('.toc');
  if (!toc) return;

  // HTML ships with <details open> so the panel is present before JS runs.
  // Close it on narrow screens immediately (before first paint); keep in sync
  // on resize via matchMedia.
  const mql = window.matchMedia('(min-width: 70em)');
  const syncOpen = e => { toc.open = e.matches; };
  mql.addEventListener('change', syncOpen);
  syncOpen(mql);

  // Close panel on link click (narrow only — wide panel stays open always).
  toc.querySelector('.toc-panel').addEventListener('click', e => {
    if (e.target.tagName === 'A' && !mql.matches) toc.open = false;
  });

  // Scroll spy. Active entry = last heading whose top edge is above 25% of the
  // viewport — i.e. the section currently being read. Correct in both scroll
  // directions: going up past a heading removes it from contention immediately.
  const headings = Array.from(document.querySelectorAll('main h2[id], main h3[id]'));
  const linkMap = new Map();
  headings.forEach(h => {
    const a = toc.querySelector('a[href="#' + h.id + '"]');
    if (a) linkMap.set(h, a);
  });

  let active = null;
  const setActive = h => {
    const a = h ? linkMap.get(h) : null;
    if (a === active) return;
    active?.removeAttribute('aria-current');
    active = a;
    active?.setAttribute('aria-current', 'true');
    active?.closest('li')?.scrollIntoView({ block: 'nearest' });
  };

  // Reads pre-computed bounding rects inside the IO callback — no forced reflow.
  const findActive = () => {
    const threshold = window.innerHeight * 0.25;
    for (let i = headings.length - 1; i >= 0; i--) {
      if (headings[i].getBoundingClientRect().top <= threshold) return headings[i];
    }
    return null;
  };

  // Wide observation zone (20% → viewport bottom): a heading scrolled past at
  // any speed always crosses it. Fast-scroll batches collapse into one call.
  const obs = new IntersectionObserver(() => setActive(findActive()),
    { threshold: 0, rootMargin: '-20% 0px 0px 0px' });
  headings.forEach(h => obs.observe(h));
})();
`;

function pageHTML(page: Page, isProduction: boolean): string {
  const base = isProduction ? PROD_BASE : "/";
  const elementsScript = isProduction ? `${base}js/elements.js` : "/site/elements/index.ts";
  const tocNav = renderToc(page.toc);

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
    <div class="page-chrome">
      <dark-mode-toggle></dark-mode-toggle>
      <github-link></github-link>
      <docs-link></docs-link>
    </div>
    ${tocNav}
    <main class="post">
      ${page.content}
    </main>
    <script type="module" src="${elementsScript}"></script>
    <script>${scrollSpyScript}</script>
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

  if (existsSync(DIST_DIR)) {
    writeFileSync(`${DIST_DIR}/index.html`, pageHTML(page, true));
  }

  console.log("✅ Built landing page");
}

// ── Slide deck ────────────────────────────────────────────────────────────────

const slideNavScript = `
(function () {
  var slides = Array.from(document.querySelectorAll('.slide'));
  var counter = document.getElementById('slide-counter');
  var total = slides.length;
  var cur = Math.max(0, Math.min(parseInt(new URLSearchParams(location.search).get('s') || '0'), total - 1));

  function show(i) {
    slides[cur].classList.remove('active');
    cur = (i + total) % total;
    slides[cur].classList.add('active');
    history.replaceState(null, '', cur === 0 ? location.pathname : '?s=' + cur);
    if (counter) counter.textContent = (cur + 1) + ' / ' + total;
  }

  show(cur);

  document.addEventListener('keydown', function (e) {
    if (e.key === 'ArrowRight' || e.key === 'ArrowDown' || e.key === ' ') {
      e.preventDefault(); show(cur + 1);
    } else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') {
      e.preventDefault(); show(cur - 1);
    }
  });

  // Touch/swipe
  var tx = 0;
  document.addEventListener('touchstart', function (e) { tx = e.touches[0].clientX; }, { passive: true });
  document.addEventListener('touchend', function (e) {
    var dx = e.changedTouches[0].clientX - tx;
    if (Math.abs(dx) > 40) show(cur + (dx < 0 ? 1 : -1));
  }, { passive: true });
})();
`;

function slidesHTML(
  slides: string[],
  title: string,
  description: string,
  isProduction: boolean,
): string {
  const base = isProduction ? PROD_BASE : "/";
  const elementsScript = isProduction ? `${base}js/elements.js` : "/site/elements/index.ts";

  const slideHtml = slides
    .map((s, i) => {
      const cls = i === 0 ? "slide slide-title" : "slide";
      return `  <section class="${cls}">\n    <div class="slide-body">${s}</div>\n  </section>`;
    })
    .join("\n");

  return `<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>${title}</title>
    <link rel="icon" type="image/svg+xml" href="${base}favicon.svg?v=7" />
    <link rel="preconnect" href="https://fonts.googleapis.com" />
    <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
    <link
      href="https://fonts.googleapis.com/css2?family=Recursive:slnt,wght,CASL,CRSV,MONO@-15..0,300..1000,0..1,0..1,0..1&display=swap"
      rel="stylesheet"
    />
    <link rel="stylesheet" href="${base}css/reset.css" />
    <link rel="stylesheet" href="${base}css/color.css" />
    <link rel="stylesheet" href="${base}css/md-syntax.css" />
    <link rel="stylesheet" href="${base}css/slides.css" />
    <script>
      (function () {
        var saved = localStorage.getItem("theme");
        var theme = saved || (matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light");
        var root = document.documentElement;
        root.setAttribute("data-theme", theme);
        root.style.colorScheme = theme === "dark" ? "dark" : "light";
      })();
    </script>
    <meta name="description" content="${description}" />
  </head>
  <body>
    <div class="deck">
${slideHtml}
    </div>
    <div class="slide-chrome">
      <dark-mode-toggle></dark-mode-toggle>
      <span id="slide-counter" class="slide-counter"></span>
    </div>
    <script type="module" src="${elementsScript}"></script>
    <script>${slideNavScript}</script>
  </body>
</html>`;
}

export function buildSlides() {
  if (!existsSync(SLIDES_SOURCE)) {
    console.log("No site/slides.md found, skipping...");
    return;
  }

  const { frontmatter, html } = renderMarkdown(SLIDES_SOURCE);

  // Split on <hr> tags (marked renders `---` as `<hr>`)
  const slides = html
    .split(/<hr\s*\/?>/)
    .map(s => s.trim())
    .filter(s => s.length > 0);

  const title = frontmatter.title || "Bireactive";
  const description = frontmatter.description || title;

  writeFileSync(`${ROOT}/slides.html`, slidesHTML(slides, title, description, false));

  if (existsSync(DIST_DIR)) {
    writeFileSync(`${DIST_DIR}/slides.html`, slidesHTML(slides, title, description, true));
  }

  console.log(`✅ Built slides (${slides.length} slides)`);
}
