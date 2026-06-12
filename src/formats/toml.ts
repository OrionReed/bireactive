// toml.ts — tolerant TOML adapter (line subset).
//
// Supports `key = value` lines, `[section]` headers (dotted paths),
// comments, basic/literal strings, numbers, booleans, inline arrays
// (multi-line) and inline tables. The canonical printer emits root
// scalars first, then one [section] per top-level object; deeper
// objects render as inline tables. TOML has no null: ops carrying null
// are reported as inexpressible (full-reprint fallback on clean docs).
// `[[arrays-of-tables]]`, dotted keys, and datetimes parse as error
// regions rather than failing the document.

import {
  type Entry,
  type FormatAdapter,
  isObject,
  type JsonObject,
  type JsonValue,
  type Node,
  type ObjectNode,
  type Op,
  type ParseError,
  type ParseResult,
  type Scalar,
  type TextEdit,
} from "./cst";

interface TableMeta {
  kind: "root" | "section" | "implicit" | "inline";
  /** Root only: offset where a new root scalar line goes (before the
   *  first section header). */
  preambleEnd?: number;
}

interface LineEntryMeta {
  lineStart: number;
}

const BARE_KEY = /^[A-Za-z0-9_-]+$/;
const NUMRE = /^[-+]?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/;
const HEADER = /^\[\s*([^\]]+?)\s*\]\s*(?:#.*)?$/;

class P {
  pos = 0;
  errors: ParseError[] = [];
  root: ObjectNode;
  current: ObjectNode;
  currentEntry: Entry | null = null;
  lastContentEnd = -1;
  sawSection = false;

  constructor(readonly text: string) {
    this.root = {
      kind: "object",
      start: 0,
      end: text.length,
      entries: [],
      meta: { kind: "root", preambleEnd: 0 } satisfies TableMeta,
    };
    this.current = this.root;
  }

  err(start: number, end: number, message: string): void {
    this.errors.push({ start, end, message });
  }

  run(): void {
    const t = this.text;
    while (this.pos < t.length) {
      const lineStart = this.pos;
      let lineEnd = t.indexOf("\n", this.pos);
      if (lineEnd === -1) lineEnd = t.length;
      let j = lineStart;
      while (j < lineEnd && (t[j] === " " || t[j] === "\t")) j++;
      if (j >= lineEnd || t[j] === "#" || t[j] === "\r") {
        this.pos = lineEnd + 1;
        continue;
      }
      if (t[j] === "[") {
        this.header(j, lineStart, lineEnd);
        this.pos = lineEnd + 1;
        continue;
      }
      this.keyValue(j, lineStart, lineEnd);
    }
    this.finalizeSection();
  }

  finalizeSection(): void {
    if (this.current !== this.root && this.lastContentEnd >= 0) {
      this.current.end = Math.max(this.current.end, this.lastContentEnd);
      if (this.currentEntry !== null) {
        this.currentEntry.end = this.current.end;
      }
    }
  }

  errorLine(lineStart: number, contentStart: number, lineEnd: number, message: string): void {
    this.err(contentStart, lineEnd, message);
    const node: Node = { kind: "error", start: contentStart, end: lineEnd };
    this.current.entries.push({
      key: undefined,
      start: lineStart,
      end: lineEnd,
      node,
      meta: { lineStart } satisfies LineEntryMeta,
    });
    this.lastContentEnd = lineEnd;
  }

  header(j: number, lineStart: number, lineEnd: number): void {
    const raw = this.text.slice(j, lineEnd);
    if (raw.startsWith("[[")) {
      this.errorLine(lineStart, j, lineEnd, "arrays of tables are not supported");
      return;
    }
    const m = HEADER.exec(raw);
    if (m === null) {
      this.errorLine(lineStart, j, lineEnd, "malformed table header");
      return;
    }
    const segs = m[1]!.split(".").map(s => s.trim().replace(/^["']|["']$/g, ""));
    if (segs.some(s => s.length === 0)) {
      this.errorLine(lineStart, j, lineEnd, "malformed table path");
      return;
    }
    this.finalizeSection();
    let node = this.root;
    for (let i = 0; i < segs.length; i++) {
      const seg = segs[i]!;
      const existing = node.entries.find(e => e.key === seg);
      if (existing !== undefined) {
        if (existing.node.kind !== "object") {
          this.errorLine(lineStart, j, lineEnd, `'${seg}' is already a value`);
          return;
        }
        node = existing.node;
        if (i === segs.length - 1) {
          (node.meta as TableMeta).kind = "section";
          this.currentEntry = existing;
        }
        continue;
      }
      const child: ObjectNode = {
        kind: "object",
        start: lineStart,
        end: lineEnd,
        entries: [],
        meta: { kind: i === segs.length - 1 ? "section" : "implicit" } satisfies TableMeta,
      };
      const entry: Entry = {
        key: seg,
        start: lineStart,
        end: lineEnd,
        node: child,
        meta: { lineStart } satisfies LineEntryMeta,
      };
      node.entries.push(entry);
      node = child;
      if (i === segs.length - 1) this.currentEntry = entry;
    }
    this.current = node;
    this.lastContentEnd = lineEnd;
    this.sawSection = true;
  }

  keyValue(j: number, lineStart: number, lineEnd: number): void {
    const t = this.text;
    let key: string | null = null;
    let p = j;
    if (t[p] === '"' || t[p] === "'") {
      const s = this.scanString(p);
      if (s !== null) {
        key = s.value;
        p = s.end;
      }
    } else {
      let e = p;
      while (e < lineEnd && BARE_KEY.test(t[e]!)) e++;
      if (e > p) {
        key = t.slice(p, e);
        p = e;
      }
    }
    while (p < lineEnd && (t[p] === " " || t[p] === "\t")) p++;
    if (key === null || t[p] !== "=") {
      this.errorLine(lineStart, j, lineEnd, "expected 'key = value'");
      this.pos = lineEnd + 1;
      return;
    }
    p++;
    while (p < lineEnd && (t[p] === " " || t[p] === "\t")) p++;
    let node = this.parseValue(p);
    // Past the value: only whitespace or a comment may remain on its line.
    let q = node.end;
    const vLineEnd = endOfLine(t, node.end);
    while (q < vLineEnd && (t[q] === " " || t[q] === "\t")) q++;
    if (q < vLineEnd && t[q] !== "#" && node.kind !== "error") {
      this.err(node.start, vLineEnd, "unexpected content after value");
      node = { kind: "error", start: node.start, end: vLineEnd };
    }
    const entry: Entry = {
      key: node.kind === "error" ? undefined : key,
      start: lineStart,
      end: node.end,
      node,
      meta: { lineStart } satisfies LineEntryMeta,
    };
    this.current.entries.push(entry);
    if (this.current === this.root && !this.sawSection) {
      (this.root.meta as TableMeta).preambleEnd = Math.min(vLineEnd + 1, t.length);
    }
    this.lastContentEnd = node.end;
    this.pos = vLineEnd + 1;
  }

  scanString(start: number): { value: string; end: number } | null {
    const t = this.text;
    const q = t[start]!;
    let out = "";
    let p = start + 1;
    while (p < t.length && t[p] !== "\n") {
      const c = t[p]!;
      if (q === '"' && c === "\\") {
        const esc = t[p + 1];
        p += 2;
        if (esc === "n") out += "\n";
        else if (esc === "t") out += "\t";
        else out += esc ?? "";
        continue;
      }
      if (c === q) return { value: out, end: p + 1 };
      out += c;
      p++;
    }
    return null;
  }

  skipValueWs(p: number): number {
    const t = this.text;
    for (;;) {
      while (p < t.length && (t[p] === " " || t[p] === "\t" || t[p] === "\n" || t[p] === "\r")) p++;
      if (t[p] === "#") {
        while (p < t.length && t[p] !== "\n") p++;
        continue;
      }
      return p;
    }
  }

  garbage(start: number, message: string): Node {
    const t = this.text;
    let p = start;
    let depth = 0;
    while (p < t.length) {
      const c = t[p]!;
      if (c === "[" || c === "{") depth++;
      else if (c === "]" || c === "}") {
        if (depth === 0) break;
        depth--;
      } else if (depth === 0 && (c === "," || c === "\n" || c === "#")) break;
      p++;
    }
    let end = p;
    while (end > start && (t[end - 1] === " " || t[end - 1] === "\t")) end--;
    if (end === start) end = Math.min(start + 1, t.length);
    this.err(start, end, message);
    return { kind: "error", start, end };
  }

  parseValue(start: number): Node {
    const t = this.text;
    const c = t[start];
    if (c === undefined || c === "\n") {
      this.err(start, start + 1, "missing value");
      return { kind: "error", start, end: Math.min(start + 1, t.length) };
    }
    if (c === '"' || c === "'") {
      const s = this.scanString(start);
      if (s === null) return this.garbage(start, "unterminated string");
      return { kind: "scalar", start, end: s.end, value: s.value };
    }
    if (c === "[") {
      const items: Node[] = [];
      let p = start + 1;
      for (;;) {
        p = this.skipValueWs(p);
        if (p >= t.length) {
          this.err(start, start + 1, "unclosed array");
          return { kind: "array", start, end: p, items };
        }
        if (t[p] === "]") return { kind: "array", start, end: p + 1, items };
        if (t[p] === ",") {
          p++;
          continue;
        }
        const item = this.parseValue(p);
        items.push(item);
        p = item.end;
      }
    }
    if (c === "{") {
      const entries: Entry[] = [];
      let p = start + 1;
      for (;;) {
        p = this.skipValueWs(p);
        if (p >= t.length || t[p] === "\n") {
          this.err(start, start + 1, "unclosed inline table");
          return {
            kind: "object",
            start,
            end: p,
            entries,
            meta: { kind: "inline" } satisfies TableMeta,
          };
        }
        if (t[p] === "}") {
          return {
            kind: "object",
            start,
            end: p + 1,
            entries,
            meta: { kind: "inline" } satisfies TableMeta,
          };
        }
        if (t[p] === ",") {
          p++;
          continue;
        }
        const entryStart = p;
        let key: string | null = null;
        if (t[p] === '"' || t[p] === "'") {
          const s = this.scanString(p);
          if (s !== null) {
            key = s.value;
            p = s.end;
          }
        } else {
          let e = p;
          while (e < t.length && BARE_KEY.test(t[e]!)) e++;
          if (e > p) {
            key = t.slice(p, e);
            p = e;
          }
        }
        while (p < t.length && (t[p] === " " || t[p] === "\t")) p++;
        if (key === null || t[p] !== "=") {
          const g = this.garbage(entryStart, "expected 'key = value' in inline table");
          entries.push({ key: undefined, start: entryStart, end: g.end, node: g });
          p = Math.max(g.end, entryStart + 1);
          continue;
        }
        p++;
        while (p < t.length && (t[p] === " " || t[p] === "\t")) p++;
        const v = this.parseValue(p);
        entries.push({
          key: v.kind === "error" ? undefined : key,
          start: entryStart,
          end: v.end,
          node: v,
        });
        p = v.end;
      }
    }
    const rest = t.slice(start, endOfLine(t, start));
    if (rest.startsWith("true")) return this.literal(start, 4, true);
    if (rest.startsWith("false")) return this.literal(start, 5, false);
    const num = NUMRE.exec(rest);
    if (num !== null && num[0].length > 0 && /^[-+]?\d/.test(rest)) {
      const end = start + num[0].length;
      const after = t[end];
      if (after === undefined || " \t\n,]}#".includes(after)) {
        return { kind: "scalar", start, end, value: Number(num[0]) };
      }
    }
    return this.garbage(start, "expected a value");
  }

  literal(start: number, len: number, value: Scalar): Node {
    const after = this.text[start + len];
    if (after === undefined || " \t\n,]}#".includes(after)) {
      return { kind: "scalar", start, end: start + len, value };
    }
    return this.garbage(start, "expected a value");
  }
}

function endOfLine(text: string, pos: number): number {
  const nl = text.indexOf("\n", pos);
  return nl === -1 ? text.length : nl;
}

function parse(text: string): ParseResult {
  const p = new P(text);
  p.run();
  if (p.root.entries.length === 0 && p.errors.length === 0) {
    p.err(0, 0, "empty document");
    return { tree: { kind: "error", start: 0, end: 0 }, errors: p.errors };
  }
  return { tree: p.root, errors: p.errors };
}

// -- printing ----------------------------------------------------------------

function containsNull(v: JsonValue): boolean {
  if (v === null) return true;
  if (Array.isArray(v)) return v.some(containsNull);
  if (isObject(v)) return Object.values(v).some(containsNull);
  return false;
}

function printKey(k: string): string {
  return BARE_KEY.test(k) ? k : JSON.stringify(k);
}

function printInline(v: JsonValue): string {
  if (v === null) return '""'; // unreachable: null ops are rejected upstream
  if (typeof v === "string") return JSON.stringify(v);
  if (typeof v !== "object") return String(v);
  if (Array.isArray(v)) return `[${v.map(printInline).join(", ")}]`;
  const keys = Object.keys(v);
  if (keys.length === 0) return "{}";
  return `{ ${keys.map(k => `${printKey(k)} = ${printInline(v[k]!)}`).join(", ")} }`;
}

function sectionBody(obj: JsonObject): string {
  return Object.keys(obj)
    .map(k => `${printKey(k)} = ${printInline(obj[k]!)}`)
    .join("\n");
}

function printSection(key: string, obj: JsonObject): string {
  const body = sectionBody(obj);
  return body.length > 0 ? `[${printKey(key)}]\n${body}` : `[${printKey(key)}]`;
}

function print(value: JsonValue): string {
  if (!isObject(value)) return "# TOML requires a table at the root\n";
  const keys = Object.keys(value);
  const scalars = keys.filter(k => !isObject(value[k]!));
  const tables = keys.filter(k => isObject(value[k]!));
  const parts: string[] = [];
  if (scalars.length > 0) {
    parts.push(scalars.map(k => `${printKey(k)} = ${printInline(value[k]!)}`).join("\n"));
  }
  for (const k of tables) parts.push(printSection(k, value[k] as JsonObject));
  return `${parts.join("\n\n")}\n`;
}

// -- ops → edits ---------------------------------------------------------------

function tableKind(node: Node): TableMeta["kind"] | null {
  if (node.kind !== "object") return null;
  return (node.meta as TableMeta).kind;
}

function opToEdit(op: Op, text: string): TextEdit[] | null {
  switch (op.type) {
    case "replace": {
      const { node, value } = op;
      if (containsNull(value)) return null;
      const kind = tableKind(node);
      if (kind === "root") {
        if (!isObject(value)) return null;
        return [{ start: 0, end: text.length, text: print(value) }];
      }
      if (kind === "section") {
        if (!isObject(value) || op.entry?.key === undefined) return null;
        return [{ start: node.start, end: node.end, text: printSection(op.entry.key, value) }];
      }
      if (kind === "implicit") return null;
      // Inline value (scalar, array, inline table, or entry value line).
      return [{ start: node.start, end: node.end, text: printInline(value) }];
    }
    case "insert": {
      const { obj, key, value } = op;
      if (containsNull(value)) return null;
      const kind = tableKind(obj);
      if (kind === "root") {
        const meta = obj.meta as TableMeta;
        if (isObject(value)) {
          const prefix = text.length === 0 || text.endsWith("\n") ? "\n" : "\n\n";
          return [
            {
              start: text.length,
              end: text.length,
              text: `${prefix}${printSection(key, value)}\n`,
            },
          ];
        }
        const at = Math.min(meta.preambleEnd ?? 0, text.length);
        const pad = at > 0 && text[at - 1] !== "\n" ? "\n" : "";
        return [{ start: at, end: at, text: `${pad}${printKey(key)} = ${printInline(value)}\n` }];
      }
      if (kind === "section" || kind === "implicit") {
        // Anchor after the surviving line entry, never after a child
        // section (the key would land in the wrong table); with no safe
        // anchor, insert right below the header.
        const afterKind = op.after !== undefined ? tableKind(op.after.node) : null;
        const anchor =
          op.after !== undefined && (afterKind === null || afterKind === "inline")
            ? op.after.end
            : endOfLine(text, obj.start);
        return [{ start: anchor, end: anchor, text: `\n${printKey(key)} = ${printInline(value)}` }];
      }
      // Inline table.
      if (obj.entries.length === 0) return null; // diff replaces empty objects
      const anchor = (op.after ?? obj.entries[obj.entries.length - 1]!).end;
      return [{ start: anchor, end: anchor, text: `, ${printKey(key)} = ${printInline(value)}` }];
    }
    case "delete": {
      const { obj, entry } = op;
      const kind = tableKind(obj);
      if (kind === "inline") {
        const idx = obj.entries.indexOf(entry);
        const next = obj.entries[idx + 1];
        if (next !== undefined) return [{ start: entry.start, end: next.start, text: "" }];
        const prev = obj.entries[idx - 1];
        const start = prev !== undefined ? prev.end : obj.start + 1;
        return [{ start, end: entry.end, text: "" }];
      }
      // Line-level entry (scalar line or whole section).
      const eol = endOfLine(text, entry.end);
      const end = eol < text.length ? eol + 1 : eol;
      const meta = entry.meta as LineEntryMeta | undefined;
      const start = meta?.lineStart ?? entry.start;
      return [{ start, end, text: "" }];
    }
  }
}

export const tomlFormat: FormatAdapter = { name: "TOML", parse, print, opToEdit };
