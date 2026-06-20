// Custom elements available in *.md to render in the prose (e.g. bireactive.md).
//
// Page chrome and the library-provided elements are registered explicitly;
// demos are auto-registered via glob, so adding one never needs a matching
// line here. Two demo flavours intermix: a `./md-*.ts` exports an element
// class (`.define()`d directly); a `./md-*.tsx` `export default`s a bireactive
// component (plus an optional `styles` export) and is wrapped in a generated
// element whose tag is the filename. md-syntax is defined first so diagram
// source panels created during connect upgrade immediately (the glob redefine
// below is a guarded no-op).

import { mount } from "@bireactive/jsx-runtime";
import { MdMarker, MdTex } from "@bireactive/web";
import { BaseElement } from "./base-element";
import { DarkModeToggle } from "./dark-mode-toggle";
import { DocsLink } from "./docs-link";
import { GithubLink } from "./github-link";
import { MdSyntax } from "./md-syntax";

DarkModeToggle.define();
GithubLink.define();
DocsLink.define();
MdSyntax.define();
MdMarker.define();
MdTex.define();

interface Definable {
  define(): void;
}

function isDefinable(value: unknown): value is Definable {
  return (
    typeof value === "function" && typeof (value as { define?: unknown }).define === "function"
  );
}

// Per-tag stylesheet cache for wrapped `.tsx` demos (the generated elements all
// share a class name, so we key by tag instead of leaning on BaseElement's
// name-keyed cache).
const tsxSheets = new Map<string, CSSStyleSheet>();

/** Wrap a bireactive component (`.tsx` default export) in a custom element so
 *  it embeds in markdown exactly like the class-based `.ts` demos. */
function defineTsx(tag: string, component: () => Node, styles?: string): void {
  if (customElements.get(tag)) return;
  class TsxElement extends BaseElement {
    #dispose?: () => void;
    protected render(): void {
      this.#dispose?.();
      this.shadow.replaceChildren();
      if (styles) {
        let sheet = tsxSheets.get(tag);
        if (!sheet) {
          sheet = new CSSStyleSheet();
          sheet.replaceSync(styles);
          tsxSheets.set(tag, sheet);
        }
        this.shadow.adoptedStyleSheets = [sheet];
      }
      this.#dispose = mount(component, this.shadow);
    }
    disconnectedCallback(): void {
      this.#dispose?.();
      this.#dispose = undefined;
    }
  }
  customElements.define(tag, TsxElement);
}

const demos = import.meta.glob("./md-*.{ts,tsx}", { eager: true }) as Record<
  string,
  Record<string, unknown>
>;
for (const [path, mod] of Object.entries(demos)) {
  let defined = false;
  for (const exported of Object.values(mod)) {
    if (isDefinable(exported)) {
      exported.define();
      defined = true;
    }
  }
  if (!defined && typeof mod.default === "function") {
    const tag = path.replace(/^.*\/(md-[^/]+)\.tsx?$/, "$1");
    defineTsx(tag, mod.default as () => Node, mod.styles as string | undefined);
  }
}
