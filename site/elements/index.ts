// Custom elements available in *.md to render in the prose (e.g. bireactive.md).
//
// Page chrome and the library-provided elements are registered explicitly;
// every ./md-*.ts demo exports a single element class and is auto-registered
// via glob, so adding a demo never needs a matching line here. md-syntax is
// defined first so diagram source panels created during connect upgrade
// immediately (the glob redefine below is a guarded no-op).

import { MdMarker, MdTex } from "@bireactive/web";
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

const demos = import.meta.glob("./md-*.ts", { eager: true }) as Record<
  string,
  Record<string, unknown>
>;
for (const mod of Object.values(demos)) {
  for (const exported of Object.values(mod)) {
    if (isDefinable(exported)) exported.define();
  }
}
