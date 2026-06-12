// cst.ts — shared concrete-syntax machinery for the format lenses.
//
// Every format adapter (JSON, YAML, TOML, EDN) parses text into the same
// CST shape: nodes with byte spans, error regions as first-class nodes.
// The backward direction of a format lens is always a set of SURGICAL
// SPAN EDITS computed here: a three-way diff (mine = the CST, theirs =
// the new abstract value, base = the last value both sides agreed on)
// yields ops, each op maps to text edits via the adapter, and any edit
// touching an error span is dropped — so external writes flow "around"
// a user's in-progress syntax errors instead of trampling them. The
// same machinery is what preserves formatting, comments, and cursor
// position in the error-free case; errors merely mark spans unwritable.

/** Abstract value shared by all formats (the hub type). */
export type JsonValue = null | boolean | number | string | JsonValue[] | JsonObject;
export interface JsonObject {
  [key: string]: JsonValue;
}

export type Scalar = null | boolean | number | string;

export interface ParseError {
  start: number;
  end: number;
  message: string;
}

export type Node = ObjectNode | ArrayNode | ScalarNode | ErrorNode;

export interface ObjectNode {
  kind: "object";
  start: number;
  end: number;
  entries: Entry[];
  /** Adapter-private layout info (flow vs block, section paths, …). */
  meta?: unknown;
}

export interface ArrayNode {
  kind: "array";
  start: number;
  end: number;
  items: Node[];
  meta?: unknown;
}

export interface ScalarNode {
  kind: "scalar";
  start: number;
  end: number;
  value: Scalar;
}

/** Unparseable region. Never written into; skipped by the differ. */
export interface ErrorNode {
  kind: "error";
  start: number;
  end: number;
}

/** Object entry. `key === undefined` marks a garbage region recovered
 *  inside an object (its node is an ErrorNode). */
export interface Entry {
  key: string | undefined;
  start: number;
  end: number;
  node: Node;
  meta?: unknown;
}

export interface ParseResult {
  tree: Node;
  errors: ParseError[];
}

export interface TextEdit {
  start: number;
  end: number;
  text: string;
}

/** Diff op against a CST. `depth` is the nesting depth of the target
 *  node/object (root = 0); adapters derive indentation from it. A
 *  replace carries its context: the object `entry` it is the value of,
 *  or the `container` array and `index` it sits at. */
export type Op =
  | {
      type: "replace";
      node: Node;
      value: JsonValue;
      depth: number;
      entry?: Entry;
      container?: Node;
      index?: number;
    }
  | {
      type: "insert";
      obj: ObjectNode;
      key: string;
      value: JsonValue;
      depth: number;
      /** Last surviving entry to anchor after (deleted entries are not
       *  safe anchors — their spans vanish in the same merge). */
      after?: Entry;
    }
  | { type: "delete"; obj: ObjectNode; entry: Entry; depth: number };

/** A concrete syntax: tolerant parser, canonical printer, op → edits.
 *  `opToEdit` returns `null` for an op the syntax can't express in
 *  place (caller falls back to a full reprint when the doc is clean). */
export interface FormatAdapter {
  name: string;
  parse(text: string): ParseResult;
  print(value: JsonValue): string;
  opToEdit(op: Op, text: string): TextEdit[] | null;
}

// ---------------------------------------------------------------------------
// Value helpers

export function isObject(v: JsonValue): v is JsonObject {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

export function deepEqual(a: JsonValue, b: JsonValue): boolean {
  if (a === b) return true;
  if (Array.isArray(a)) {
    if (!Array.isArray(b) || a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) if (!deepEqual(a[i]!, b[i]!)) return false;
    return true;
  }
  if (isObject(a)) {
    if (!isObject(b)) return false;
    const ka = Object.keys(a);
    const kb = Object.keys(b);
    if (ka.length !== kb.length) return false;
    for (const k of ka) {
      if (!(k in b) || !deepEqual(a[k]!, b[k]!)) return false;
    }
    return true;
  }
  return false;
}

/** Recovered abstract value of a CST. Error regions are dropped;
 *  duplicate keys last-write-wins. Error nodes become `null` (callers
 *  only rely on `valueOf` when the parse reported zero errors). */
export function valueOf(node: Node): JsonValue {
  switch (node.kind) {
    case "scalar":
      return node.value;
    case "array":
      return node.items.filter(it => it.kind !== "error").map(valueOf);
    case "object": {
      const out: JsonObject = {};
      for (const e of node.entries) {
        if (e.key === undefined || e.node.kind === "error") continue;
        out[e.key] = valueOf(e.node);
      }
      return out;
    }
    case "error":
      return null;
  }
}

/** Structural equality between a CST subtree and an abstract value.
 *  Error nodes are never equal to anything. */
export function nodeEquals(node: Node, value: JsonValue): boolean {
  switch (node.kind) {
    case "error":
      return false;
    case "scalar":
      return node.value === value;
    case "array": {
      if (!Array.isArray(value) || node.items.length !== value.length) return false;
      for (let i = 0; i < value.length; i++) {
        if (!nodeEquals(node.items[i]!, value[i]!)) return false;
      }
      return true;
    }
    case "object": {
      if (!isObject(value)) return false;
      const last = lastEntries(node);
      if (last.size !== Object.keys(value).length) return false;
      for (const [k, e] of last) {
        if (!(k in value) || !nodeEquals(e.node, value[k]!)) return false;
      }
      // Garbage entries make the object not-equal (they're divergence).
      for (const e of node.entries) if (e.key === undefined) return false;
      return true;
    }
  }
}

export function subtreeHasError(node: Node): boolean {
  switch (node.kind) {
    case "error":
      return true;
    case "scalar":
      return false;
    case "array":
      return node.items.some(subtreeHasError);
    case "object":
      return node.entries.some(e => e.key === undefined || subtreeHasError(e.node));
  }
}

/** Keyed entries, duplicates resolved to the last occurrence. */
function lastEntries(node: ObjectNode): Map<string, Entry> {
  const m = new Map<string, Entry>();
  for (const e of node.entries) if (e.key !== undefined) m.set(e.key, e);
  return m;
}

// ---------------------------------------------------------------------------
// Three-way diff
//
// mine  = the CST (possibly containing error regions / local divergence)
// theirs = the new hub value to absorb
// base  = the value this document last agreed with the hub on
//
// Per subtree: if theirs == base, the other side didn't touch it — keep
// mine (this is what preserves valid-but-unpropagated local edits while
// the doc is broken elsewhere). Error subtrees are never written.

/** Collect ops that bring `node` in line with `theirs`. */
export function diffOps(
  node: Node,
  theirs: JsonValue,
  base: JsonValue | undefined,
  depth: number,
  ops: Op[],
  entry?: Entry,
  container?: Node,
  index?: number,
): void {
  if (base !== undefined && deepEqual(theirs, base)) return;
  if (node.kind === "error") return;
  if (nodeEquals(node, theirs)) return;

  if (node.kind === "object" && isObject(theirs) && node.entries.length > 0) {
    const last = lastEntries(node);
    const baseObj = base !== undefined && isObject(base) ? base : undefined;
    const keep: Entry[] = [];
    const dels: Entry[] = [];
    let hasGarbage = false;
    for (const e of node.entries) {
      if (e.key === undefined) {
        hasGarbage = true;
        continue;
      }
      if (last.get(e.key) !== e) continue; // shadowed duplicate
      if (e.key in theirs) {
        keep.push(e);
      } else if ((baseObj === undefined || e.key in baseObj) && !subtreeHasError(e.node)) {
        // Theirs deleted it (or we have no base info — trust theirs).
        dels.push(e);
      } else {
        keep.push(e); // mine added it (or it's broken) — keep
      }
    }
    // Everything keyed is going away: a wholesale replace is both
    // simpler and the only safe option (inserts can't anchor on
    // entries whose spans are being deleted).
    if (keep.length === 0 && !hasGarbage && dels.length > 0) {
      ops.push({ type: "replace", node, value: theirs, depth, entry, container, index });
      return;
    }
    for (const e of dels) ops.push({ type: "delete", obj: node, entry: e, depth });
    for (const e of keep) {
      if (!(e.key! in theirs)) continue; // kept-mine divergence — no target
      diffOps(e.node, theirs[e.key!]!, baseObj?.[e.key!], depth + 1, ops, e, node);
    }
    let after: Entry | undefined;
    for (const e of keep) if (after === undefined || e.end > after.end) after = e;
    for (const k of Object.keys(theirs)) {
      if (last.has(k)) continue;
      if (baseObj !== undefined && k in baseObj && deepEqual(theirs[k]!, baseObj[k]!)) continue;
      ops.push({ type: "insert", obj: node, key: k, value: theirs[k]!, depth, after });
    }
    return;
  }

  if (node.kind === "array" && Array.isArray(theirs) && node.items.length === theirs.length) {
    const baseArr = Array.isArray(base) && base.length === theirs.length ? base : undefined;
    for (let i = 0; i < theirs.length; i++) {
      diffOps(node.items[i]!, theirs[i]!, baseArr?.[i], depth + 1, ops, undefined, node, i);
    }
    return;
  }

  // Shape change (or empty object getting members): whole-node replace,
  // unless the subtree holds an error region — then it stays stale.
  if (subtreeHasError(node)) return;
  ops.push({ type: "replace", node, value: theirs, depth, entry, container, index });
}

// ---------------------------------------------------------------------------
// Edit application

function spansIntersect(aStart: number, aEnd: number, bStart: number, bEnd: number): boolean {
  return aStart < bEnd && bStart < aEnd;
}

/** True if any edit touches an error span (insertions count when they
 *  land strictly inside one). */
export function editsBlocked(edits: TextEdit[], errors: ParseError[]): boolean {
  for (const e of edits) {
    for (const err of errors) {
      if (e.start === e.end) {
        if (err.start < e.start && e.start < err.end) return true;
      } else if (spansIntersect(e.start, e.end, err.start, err.end)) {
        return true;
      }
    }
  }
  return false;
}

/** Apply non-overlapping edits (overlapping later edits are dropped).
 *  Equal-start insertions apply in op order. */
export function applyEdits(text: string, edits: TextEdit[]): string {
  const sorted = edits
    .map((e, i) => ({ e, i }))
    .sort((a, b) => a.e.start - b.e.start || a.e.end - b.e.end || a.i - b.i);
  let out = "";
  let pos = 0;
  for (const { e } of sorted) {
    if (e.start < pos) continue; // overlap — drop
    out += text.slice(pos, e.start) + e.text;
    pos = e.end;
  }
  return out + text.slice(pos);
}

/** Result of absorbing an external value into existing concrete text. */
export interface MergeResult {
  text: string;
  /** Ops that could not be applied (blocked by errors or unsupported). */
  skipped: number;
}

/** Merge `theirs` into `text` by surgical edits around error regions.
 *  Falls back to a full canonical reprint only when an op is
 *  inexpressible in place AND the document is error-free. */
export function mergeText(
  adapter: FormatAdapter,
  text: string,
  tree: Node,
  errors: ParseError[],
  theirs: JsonValue,
  base: JsonValue | undefined,
): MergeResult {
  const ops: Op[] = [];
  diffOps(tree, theirs, base, 0, ops);
  if (ops.length === 0) return { text, skipped: 0 };

  const edits: TextEdit[] = [];
  let skipped = 0;
  for (const op of ops) {
    const e = adapter.opToEdit(op, text);
    if (e === null) {
      if (errors.length === 0) return { text: adapter.print(theirs), skipped: 0 };
      skipped++;
      continue;
    }
    if (editsBlocked(e, errors)) {
      skipped++;
      continue;
    }
    edits.push(...e);
  }
  return { text: applyEdits(text, edits), skipped };
}

// ---------------------------------------------------------------------------
// Misc shared helpers

/** 1-based line/column of a byte offset (for error display). */
export function lineColOf(text: string, offset: number): { line: number; col: number } {
  let line = 1;
  let lineStart = 0;
  for (let i = 0; i < offset && i < text.length; i++) {
    if (text[i] === "\n") {
      line++;
      lineStart = i + 1;
    }
  }
  return { line, col: offset - lineStart + 1 };
}

export const indentOf = (depth: number): string => "  ".repeat(depth);
