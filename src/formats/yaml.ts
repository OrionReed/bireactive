// yaml.ts — tolerant YAML adapter (block subset).
//
// Supports block maps and sequences, compact `- key: value` items,
// single-line flow collections, plain/quoted scalars, and comments.
// Anchors, tags, block scalars, and multi-document streams are out of
// scope: such lines become whole-line error regions, which keeps the
// rest of the document live. Comments survive surgical edits because
// scalar value spans exclude them and standalone comment lines sit
// outside entry spans.

import {
  type Entry,
  type FormatAdapter,
  isObject,
  type JsonValue,
  type Node,
  type Op,
  type ParseError,
  type ParseResult,
  type Scalar,
  type TextEdit,
} from "./cst";

interface Line {
  start: number;
  end: number; // exclusive, before the newline
  indent: number;
  contentStart: number;
}

interface MapMeta {
  indent: number;
  flow: boolean;
}

interface SeqMeta {
  indent: number;
  flow: boolean;
  itemMeta: { dashEnd: number }[];
}

interface EntryMeta {
  colonEnd: number;
  indent: number;
  inline: boolean;
  compactFirst: boolean;
}

const NUMRE = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?$/;
const PLAIN_KEY = /^[A-Za-z_][\w-]*$/;
const PLAIN_STR = /^[A-Za-z0-9_][A-Za-z0-9_ ./@-]*$/;

function inferScalar(s: string): Scalar {
  if (s === "true") return true;
  if (s === "false") return false;
  if (s === "null" || s === "~" || s === "") return null;
  if (NUMRE.test(s)) return Number(s);
  return s;
}

class P {
  errors: ParseError[] = [];
  lines: Line[] = [];
  constructor(readonly text: string) {
    let pos = 0;
    while (pos <= text.length - 1) {
      let end = text.indexOf("\n", pos);
      if (end === -1) end = text.length;
      let indent = 0;
      while (pos + indent < end && text[pos + indent] === " ") indent++;
      const contentStart = pos + indent;
      // Blank (or tab-led — flagged) lines are structurally invisible.
      if (contentStart < end && text[contentStart] !== "\r") {
        if (text[contentStart] === "\t") {
          this.errors.push({ start: pos, end, message: "tab indentation is not supported" });
        } else {
          this.lines.push({ start: pos, end, indent, contentStart });
        }
      }
      pos = end + 1;
    }
  }

  err(start: number, end: number, message: string): void {
    this.errors.push({ start, end, message });
  }

  /** Comment-aware effective end of a line region, trailing ws trimmed. */
  effEnd(from: number, lineEnd: number): number {
    const t = this.text;
    let p = from;
    let q: '"' | "'" | null = null;
    while (p < lineEnd) {
      const c = t[p]!;
      if (q === '"') {
        if (c === "\\") p++;
        else if (c === '"') q = null;
      } else if (q === "'") {
        if (c === "'") q = null;
      } else if (c === '"') q = '"';
      else if (c === "'") q = "'";
      else if (c === "#" && (p === from || t[p - 1] === " " || t[p - 1] === "\t")) break;
      p++;
    }
    while (p > from && (t[p - 1] === " " || t[p - 1] === "\t" || t[p - 1] === "\r")) p--;
    return p;
  }

  isComment(li: number, cs?: number): boolean {
    return this.text[cs ?? this.lines[li]!.contentStart] === "#";
  }

  /** Next structural line index at or after `i` (skips comment lines). */
  nextContent(i: number): number {
    let j = i;
    while (j < this.lines.length && this.isComment(j)) j++;
    return j < this.lines.length ? j : -1;
  }

  isSeqItem(cs: number, end: number): boolean {
    if (this.text[cs] !== "-") return false;
    return cs + 1 >= end || this.text[cs + 1] === " ";
  }

  /** `key:` scan at a content start. Returns null when the region isn't
   *  a mapping entry (plain scalar, flow value, …). */
  scanKey(cs: number, end: number): { key: string; colonEnd: number } | null {
    const t = this.text;
    const c = t[cs];
    if (c === "[" || c === "{" || c === undefined) return null;
    if (c === '"' || c === "'") {
      const s = this.scanQuoted(cs, end);
      if (s === null) return null;
      let p = s.end;
      while (p < end && t[p] === " ") p++;
      if (t[p] !== ":") return null;
      if (p + 1 < end && t[p + 1] !== " ") return null;
      return { key: s.value, colonEnd: p + 1 };
    }
    for (let p = cs; p < end; p++) {
      if (t[p] === ":" && (p + 1 >= end || t[p + 1] === " ")) {
        const key = t.slice(cs, p).trim();
        if (key.length === 0 || key.includes("#")) return null;
        return { key, colonEnd: p + 1 };
      }
    }
    return null;
  }

  scanQuoted(start: number, max: number): { value: string; end: number } | null {
    const t = this.text;
    const q = t[start]!;
    let out = "";
    let p = start + 1;
    while (p < max) {
      const c = t[p]!;
      if (q === '"' && c === "\\") {
        const esc = t[p + 1];
        p += 2;
        if (esc === "n") out += "\n";
        else if (esc === "t") out += "\t";
        else out += esc ?? "";
        continue;
      }
      if (c === q) {
        if (q === "'" && t[p + 1] === "'") {
          out += "'";
          p += 2;
          continue;
        }
        return { value: out, end: p + 1 };
      }
      out += c;
      p++;
    }
    return null;
  }

  // -- flow (single-line [..] / {..}) -------------------------------------

  flowSkip(p: number, end: number): number {
    while (p < end && (this.text[p] === " " || this.text[p] === ",")) p++;
    return p;
  }

  flowGarbage(start: number, end: number, message: string): { node: Node; pos: number } {
    const t = this.text;
    let p = start;
    let depth = 0;
    while (p < end) {
      const c = t[p]!;
      if (c === "[" || c === "{") depth++;
      else if (c === "]" || c === "}") {
        if (depth === 0) break;
        depth--;
      } else if (depth === 0 && c === ",") break;
      p++;
    }
    const e = Math.max(p, start + 1);
    this.err(start, e, message);
    return { node: { kind: "error", start, end: e }, pos: p };
  }

  flowValue(p0: number, end: number): { node: Node; pos: number } {
    const t = this.text;
    const p = this.flowSkip(p0, end);
    const c = t[p];
    if (c === "[") {
      const items: Node[] = [];
      let q = p + 1;
      for (;;) {
        q = this.flowSkip(q, end);
        if (q >= end) {
          this.err(p, p + 1, "unclosed flow sequence");
          return {
            node: { kind: "array", start: p, end: q, items, meta: seqMeta(0, true) },
            pos: q,
          };
        }
        if (t[q] === "]") {
          return {
            node: { kind: "array", start: p, end: q + 1, items, meta: seqMeta(0, true) },
            pos: q + 1,
          };
        }
        const r = this.flowValue(q, end);
        items.push(r.node);
        q = r.pos;
      }
    }
    if (c === "{") {
      const entries: Entry[] = [];
      let q = p + 1;
      for (;;) {
        q = this.flowSkip(q, end);
        if (q >= end) {
          this.err(p, p + 1, "unclosed flow mapping");
          return {
            node: { kind: "object", start: p, end: q, entries, meta: mapMeta(0, true) },
            pos: q,
          };
        }
        if (t[q] === "}") {
          return {
            node: { kind: "object", start: p, end: q + 1, entries, meta: mapMeta(0, true) },
            pos: q + 1,
          };
        }
        const entryStart = q;
        let key: string | null = null;
        let kEnd = q;
        if (t[q] === '"' || t[q] === "'") {
          const s = this.scanQuoted(q, end);
          if (s !== null) {
            key = s.value;
            kEnd = s.end;
          }
        } else {
          let e2 = q;
          while (e2 < end && !":,]}".includes(t[e2]!)) e2++;
          if (t[e2] === ":") {
            key = t.slice(q, e2).trim();
            kEnd = e2;
          }
        }
        kEnd = this.flowSkip(kEnd, end);
        if (key === null || t[kEnd] !== ":") {
          const g = this.flowGarbage(q, end, "expected 'key:' in flow mapping");
          entries.push({ key: undefined, start: entryStart, end: g.node.end, node: g.node });
          q = g.pos;
          continue;
        }
        const r = this.flowValue(kEnd + 1, end);
        entries.push({
          key: r.node.kind === "error" ? undefined : key,
          start: entryStart,
          end: r.node.end,
          node: r.node,
        });
        q = r.pos;
      }
    }
    if (c === '"' || c === "'") {
      const s = this.scanQuoted(p, end);
      if (s === null) return this.flowGarbage(p, end, "unterminated string");
      return { node: { kind: "scalar", start: p, end: s.end, value: s.value }, pos: s.end };
    }
    // Plain scalar: run to a flow delimiter.
    let q = p;
    while (q < end && !",]}".includes(t[q]!)) q++;
    let e = q;
    while (e > p && t[e - 1] === " ") e--;
    if (e === p) return this.flowGarbage(p, end, "expected a value");
    const raw = t.slice(p, e);
    if ("&*!|>".includes(raw[0]!)) {
      this.err(p, e, "unsupported YAML feature");
      return { node: { kind: "error", start: p, end: e }, pos: q };
    }
    return { node: { kind: "scalar", start: p, end: e, value: inferScalar(raw) }, pos: q };
  }

  /** Inline value region of a line: flow collection or scalar. */
  parseInline(start: number, end: number): Node {
    const t = this.text;
    const c = t[start];
    if (c === "[" || c === "{") {
      const r = this.flowValue(start, end);
      let p = r.pos;
      while (p < end && t[p] === " ") p++;
      if (p < end) {
        this.err(start, end, "trailing content after flow value");
        return { kind: "error", start, end };
      }
      return r.node;
    }
    if (c === '"' || c === "'") {
      const s = this.scanQuoted(start, end);
      if (s === null || s.end < end) {
        this.err(start, end, s === null ? "unterminated string" : "trailing content after string");
        return { kind: "error", start, end };
      }
      return { kind: "scalar", start, end: s.end, value: s.value };
    }
    const raw = t.slice(start, end);
    if ("&*!|>".includes(raw[0]!)) {
      this.err(start, end, "unsupported YAML feature");
      return { kind: "error", start, end };
    }
    return { kind: "scalar", start, end, value: inferScalar(raw) };
  }

  // -- block structure ------------------------------------------------------

  parseBlock(i: number, indent: number): { node: Node; next: number } {
    const line = this.lines[i]!;
    const e = this.effEnd(line.contentStart, line.end);
    if (this.isSeqItem(line.contentStart, e)) return this.parseSeq(i, indent);
    if (this.scanKey(line.contentStart, e) !== null) return this.parseMap(i, indent);
    return { node: this.parseInline(line.contentStart, e), next: i + 1 };
  }

  parseMap(
    i: number,
    indent: number,
    compact?: { keyStart: number },
  ): { node: Node; next: number } {
    const entries: Entry[] = [];
    let idx = i;
    let start = -1;
    while (idx < this.lines.length) {
      const line = this.lines[idx]!;
      const first = compact !== undefined && idx === i;
      const cs = first ? compact.keyStart : line.contentStart;
      const ind = cs - line.start;
      if (this.isComment(idx, cs)) {
        idx++;
        continue;
      }
      if (ind < indent) break;
      const lineEff = this.effEnd(cs, line.end);
      if (ind > indent) {
        this.err(cs, lineEff, "unexpected indentation");
        entries.push({
          key: undefined,
          start: line.start,
          end: lineEff,
          node: { kind: "error", start: cs, end: lineEff },
        });
        idx++;
        continue;
      }
      if (this.isSeqItem(cs, lineEff)) break;
      const k = this.scanKey(cs, lineEff);
      if (k === null) {
        this.err(cs, lineEff, "expected 'key: value'");
        entries.push({
          key: undefined,
          start: line.start,
          end: lineEff,
          node: { kind: "error", start: cs, end: lineEff },
        });
        idx++;
        continue;
      }
      if (start === -1) start = first ? compact.keyStart : line.start;
      let vstart = k.colonEnd;
      while (vstart < lineEff && this.text[vstart] === " ") vstart++;
      let node: Node;
      let inline: boolean;
      if (vstart >= lineEff) {
        const j = this.nextContent(idx + 1);
        if (j !== -1 && this.lines[j]!.indent > indent) {
          const child = this.parseBlock(j, this.lines[j]!.indent);
          node = child.node;
          idx = child.next;
        } else {
          node = { kind: "scalar", start: k.colonEnd, end: k.colonEnd, value: null };
          idx++;
        }
        inline = false;
      } else {
        node = this.parseInline(vstart, lineEff);
        idx++;
        inline = true;
      }
      const meta: EntryMeta = {
        colonEnd: k.colonEnd,
        indent,
        inline,
        compactFirst: first,
      };
      entries.push({
        key: k.key,
        start: first ? compact.keyStart : line.start,
        end: Math.max(node.end, k.colonEnd),
        node,
        meta,
      });
    }
    const s = start === -1 ? this.lines[i]!.start : start;
    return {
      node: {
        kind: "object",
        start: s,
        end: entries.length > 0 ? entries[entries.length - 1]!.end : s,
        entries,
        meta: mapMeta(indent, false),
      },
      next: idx,
    };
  }

  parseSeq(i: number, indent: number): { node: Node; next: number } {
    const items: Node[] = [];
    const itemMeta: { dashEnd: number }[] = [];
    let idx = i;
    while (idx < this.lines.length) {
      const line = this.lines[idx]!;
      if (this.isComment(idx)) {
        idx++;
        continue;
      }
      if (line.indent !== indent) break;
      const lineEff = this.effEnd(line.contentStart, line.end);
      if (!this.isSeqItem(line.contentStart, lineEff)) break;
      const dashEnd = line.contentStart + 1;
      let restStart = dashEnd;
      while (restStart < lineEff && this.text[restStart] === " ") restStart++;
      let node: Node;
      if (restStart >= lineEff) {
        const j = this.nextContent(idx + 1);
        if (j !== -1 && this.lines[j]!.indent > indent) {
          const child = this.parseBlock(j, this.lines[j]!.indent);
          node = child.node;
          idx = child.next;
        } else {
          node = { kind: "scalar", start: dashEnd, end: dashEnd, value: null };
          idx++;
        }
      } else if (this.scanKey(restStart, lineEff) !== null) {
        const m = this.parseMap(idx, restStart - line.start, { keyStart: restStart });
        node = m.node;
        idx = m.next;
      } else {
        node = this.parseInline(restStart, lineEff);
        idx++;
      }
      items.push(node);
      itemMeta.push({ dashEnd });
    }
    return {
      node: {
        kind: "array",
        start: this.lines[i]!.start,
        end: items.length > 0 ? items[items.length - 1]!.end : this.lines[i]!.start,
        items,
        meta: { indent, flow: false, itemMeta } satisfies SeqMeta,
      },
      next: idx,
    };
  }
}

const mapMeta = (indent: number, flow: boolean): MapMeta => ({ indent, flow });
const seqMeta = (indent: number, flow: boolean): SeqMeta => ({ indent, flow, itemMeta: [] });

function parse(text: string): ParseResult {
  const p = new P(text);
  const first = p.nextContent(0);
  if (first === -1) {
    p.err(0, 0, "empty document");
    return { tree: { kind: "error", start: 0, end: 0 }, errors: p.errors };
  }
  const { node, next } = p.parseBlock(first, p.lines[first]!.indent);
  for (let j = next; j < p.lines.length; j++) {
    if (p.isComment(j)) continue;
    const l = p.lines[j]!;
    p.err(l.contentStart, p.effEnd(l.contentStart, l.end), "content after the document root");
  }
  return { tree: node, errors: p.errors };
}

// -- printing ----------------------------------------------------------------

function pkey(k: string): string {
  return PLAIN_KEY.test(k) ? k : JSON.stringify(k);
}

function inlineScalar(v: Scalar): string {
  if (v === null) return "null";
  if (typeof v === "string") {
    return PLAIN_STR.test(v) && !v.endsWith(" ") && inferScalar(v) === v ? v : JSON.stringify(v);
  }
  return String(v);
}

const isScalar = (v: JsonValue): v is Scalar => v === null || typeof v !== "object";

/** Inline-printable: a scalar or an empty container. */
function inlineable(v: JsonValue): boolean {
  if (isScalar(v)) return true;
  if (Array.isArray(v)) return v.length === 0;
  return Object.keys(v).length === 0;
}

function inline(v: JsonValue): string {
  if (isScalar(v)) return inlineScalar(v);
  return printFlow(v);
}

/** Single-line flow rendering (used inside flow contexts). */
function printFlow(v: JsonValue): string {
  if (isScalar(v)) return inlineScalar(v);
  if (Array.isArray(v)) return `[${v.map(printFlow).join(", ")}]`;
  const keys = Object.keys(v);
  return `{${keys.map(k => `${pkey(k)}: ${printFlow(v[k]!)}`).join(", ")}}`;
}

function printMapBlock(obj: { [k: string]: JsonValue }, indent: number): string {
  const ind = " ".repeat(indent);
  return Object.keys(obj)
    .map(k => {
      const v = obj[k]!;
      if (inlineable(v)) return `${ind}${pkey(k)}: ${inline(v)}`;
      return `${ind}${pkey(k)}:\n${blockOf(v, indent + 2)}`;
    })
    .join("\n");
}

function printSeqBlock(arr: JsonValue[], indent: number): string {
  const ind = " ".repeat(indent);
  return arr
    .map(v => {
      if (inlineable(v)) return `${ind}- ${inline(v)}`;
      if (isObject(v)) {
        const block = printMapBlock(v, indent + 2);
        return `${ind}- ${block.slice(indent + 2)}`;
      }
      return `${ind}-\n${printSeqBlock(v as JsonValue[], indent + 2)}`;
    })
    .join("\n");
}

function blockOf(v: JsonValue, indent: number): string {
  if (isObject(v)) return printMapBlock(v, indent);
  if (Array.isArray(v)) return printSeqBlock(v, indent);
  return `${" ".repeat(indent)}${inlineScalar(v)}`;
}

function rootText(v: JsonValue): string {
  if (inlineable(v)) return inline(v);
  return blockOf(v, 0);
}

function print(value: JsonValue): string {
  return `${rootText(value)}\n`;
}

// -- ops → edits ---------------------------------------------------------------

function endOfLine(text: string, pos: number): number {
  const nl = text.indexOf("\n", pos);
  return nl === -1 ? text.length : nl;
}

function opToEdit(op: Op, text: string): TextEdit[] | null {
  switch (op.type) {
    case "replace": {
      const v = op.value;
      const node = op.node;
      // Flow context: stay in flow style.
      const inFlowSeq = op.container?.kind === "array" && (op.container.meta as SeqMeta).flow;
      const inFlowMap = op.container?.kind === "object" && (op.container.meta as MapMeta).flow;
      if (inFlowSeq || inFlowMap) {
        return [{ start: node.start, end: node.end, text: printFlow(v) }];
      }
      // Block map entry value.
      if (op.entry?.meta !== undefined && op.container?.kind === "object") {
        const em = op.entry.meta as EntryMeta;
        const nodeFlow =
          (node.kind === "object" || node.kind === "array") &&
          (node.meta as MapMeta | SeqMeta).flow;
        if (em.inline && (node.kind === "scalar" || nodeFlow)) {
          if (inlineable(v) || nodeFlow) {
            return [
              {
                start: node.start,
                end: node.end,
                text: nodeFlow && !isScalar(v) ? printFlow(v) : inline(v),
              },
            ];
          }
        }
        const tail = inlineable(v) ? ` ${inline(v)}` : `\n${blockOf(v, em.indent + 2)}`;
        return [{ start: em.colonEnd, end: op.entry.end, text: tail }];
      }
      // Block seq item.
      if (op.container?.kind === "array" && op.index !== undefined) {
        const am = op.container.meta as SeqMeta;
        const im = am.itemMeta[op.index];
        if (im === undefined) return null;
        if (node.kind === "scalar" && inlineable(v)) {
          return [{ start: node.start, end: node.end, text: inline(v) }];
        }
        if (isObject(v) && Object.keys(v).length > 0) {
          const block = printMapBlock(v, am.indent + 2);
          return [{ start: im.dashEnd, end: node.end, text: ` ${block.slice(am.indent + 2)}` }];
        }
        if (inlineable(v)) return [{ start: im.dashEnd, end: node.end, text: ` ${inline(v)}` }];
        return [{ start: im.dashEnd, end: node.end, text: `\n${blockOf(v, am.indent + 2)}` }];
      }
      // Root.
      return [{ start: node.start, end: node.end, text: rootText(v) }];
    }
    case "insert": {
      const { obj, key, value } = op;
      const meta = obj.meta as MapMeta;
      if (meta.flow) {
        if (obj.entries.length === 0) return null;
        const anchor = (op.after ?? obj.entries[obj.entries.length - 1]!).end;
        return [{ start: anchor, end: anchor, text: `, ${pkey(key)}: ${printFlow(value)}` }];
      }
      const anchor = endOfLine(text, op.after?.end ?? obj.end);
      const ind = " ".repeat(meta.indent);
      const tail = inlineable(value) ? ` ${inline(value)}` : `\n${blockOf(value, meta.indent + 2)}`;
      return [{ start: anchor, end: anchor, text: `\n${ind}${pkey(key)}:${tail}` }];
    }
    case "delete": {
      const { obj, entry } = op;
      const meta = obj.meta as MapMeta;
      if (meta.flow) {
        const idx = obj.entries.indexOf(entry);
        const next = obj.entries[idx + 1];
        if (next !== undefined) return [{ start: entry.start, end: next.start, text: "" }];
        const prev = obj.entries[idx - 1];
        const start = prev !== undefined ? prev.end : obj.start + 1;
        return [{ start, end: entry.end, text: "" }];
      }
      const em = entry.meta as EntryMeta | undefined;
      if (em?.compactFirst) return null;
      const eol = endOfLine(text, entry.end);
      const end = eol < text.length ? eol + 1 : eol;
      return [{ start: entry.start, end, text: "" }];
    }
  }
}

export const yamlFormat: FormatAdapter = { name: "YAML", parse, print, opToEdit };
