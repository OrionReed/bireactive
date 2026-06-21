// debug.ts — read-only inspection of the cell graph (dev-time, no hot-path cost).
//
// Three small tools: `explain` (one line about a cell), `dumpGraph` (the upstream
// dependency tree), and `traceWrites` (which sources a block of work actually
// wrote). All walk the same edges the engine maintains — lens parents
// (`parentEdges`, eager) unioned with dynamic forward deps (`deps`, post-read) —
// and label cells by their optional `name` (falling back to `Ctor#n`). Nothing
// here mutates graph state; reads go through `peek` so they don't track.

import { Cell, isLens, isReadonly, setCellWriteHook } from "./cell";

// Structural view of the internal edge lists (kept @internal on the class).
interface Edges {
  deps: { dep: unknown; nextDep: Edges["deps"] } | undefined;
  parentEdges: { parent: Cell<unknown>; nextParent: Edges["parentEdges"] } | undefined;
}
const edges = (c: Cell<unknown>): Edges => c as unknown as Edges;

// `Cell<T>` is invariant (settable `value`, `_equals`), so a public helper must be
// generic to accept `Cell<number>` et al.; internally we erase to `Cell<unknown>`.
// biome-ignore lint/suspicious/noExplicitAny: variance escape for arbitrary cells
type SomeCell = Cell<any>;
const erase = (c: SomeCell): Cell<unknown> => c as Cell<unknown>;

const ids = new WeakMap<Cell<unknown>, number>();
let nextId = 1;
function idOf(c: Cell<unknown>): number {
  let i = ids.get(c);
  if (i === undefined) {
    i = nextId++;
    ids.set(c, i);
  }
  return i;
}

/** Short, stable display name: the cell's `name`, else `Ctor#n`. */
export function label(c: SomeCell): string {
  return c.name ?? `${c.constructor.name}#${idOf(erase(c))}`;
}

/** `source` (no getter), `lens` (writable derived), or `computed` (read-only derived). */
export function kind(c: SomeCell): "source" | "lens" | "computed" {
  return isLens(c) ? "lens" : isReadonly(c) ? "computed" : "source";
}

function short(v: unknown): string {
  try {
    if (typeof v === "string") return JSON.stringify(v);
    if (v === null || v === undefined || typeof v !== "object") return String(v);
    const s = JSON.stringify(v);
    if (s === undefined) return Object.prototype.toString.call(v);
    return s.length > 48 ? `${s.slice(0, 47)}…` : s;
  } catch {
    return "?";
  }
}

/** Upstream cells: eager lens parents unioned with dynamic forward deps. */
export function upstream(c: SomeCell): Cell<unknown>[] {
  const out: Cell<unknown>[] = [];
  const seen = new Set<Cell<unknown>>();
  const push = (n: unknown): void => {
    if (n instanceof Cell && !seen.has(n)) {
      seen.add(n);
      out.push(n);
    }
  };
  for (let e = edges(erase(c)).parentEdges; e !== undefined; e = e.nextParent) push(e.parent);
  for (let l = edges(erase(c)).deps; l !== undefined; l = l.nextDep) push(l.dep);
  return out;
}

/** One-line summary: `name = value  [kind]` plus upstream labels, if any. */
export function explain(c: SomeCell): string {
  let v: unknown;
  try {
    v = c.peek();
  } catch {
    v = "?";
  }
  const ups = upstream(c);
  const tail = ups.length > 0 ? `  ← ${ups.map(label).join(", ")}` : "";
  return `${label(c)} = ${short(v)}  [${kind(c)}]${tail}`;
}

export interface DumpOpts {
  /** Max upstream depth to descend. Default `Infinity`. */
  depth?: number;
  /** Include `= value` in each line. Default `true`. */
  values?: boolean;
}

/** Render the upstream graph of `root` as an indented tree (cycle-safe). */
export function dumpGraph(root: SomeCell, opts: DumpOpts = {}): string {
  const maxDepth = opts.depth ?? Number.POSITIVE_INFINITY;
  const withValues = opts.values ?? true;
  const lines: string[] = [];
  const path = new Set<Cell<unknown>>();

  const line = (c: Cell<unknown>, indent: string): string => {
    if (!withValues) return `${indent}${label(c)}  [${kind(c)}]`;
    let v: unknown;
    try {
      v = c.peek();
    } catch {
      v = "?";
    }
    return `${indent}${label(c)} = ${short(v)}  [${kind(c)}]`;
  };

  const walk = (c: Cell<unknown>, indent: string, depth: number): void => {
    if (path.has(c)) {
      lines.push(`${indent}${label(c)} ↺`); // back-edge into the current path
      return;
    }
    lines.push(line(c, indent));
    if (depth >= maxDepth) return;
    path.add(c);
    for (const u of upstream(c)) walk(u, `${indent}  `, depth + 1);
    path.delete(c);
  };

  walk(root, "", 0);
  return lines.join("\n");
}

/** Run `fn` and collect the source cells written during it (back-writes included,
 *  since a view write commits through its sources' `_writeSource`). */
export function traceWrites<T>(fn: () => T): { result: T; writes: Cell<unknown>[] } {
  const writes: Cell<unknown>[] = [];
  const restore = setCellWriteHook(c => {
    writes.push(c);
  });
  try {
    return { result: fn(), writes };
  } finally {
    restore();
  }
}
