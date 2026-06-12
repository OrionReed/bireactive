// json.ts — tolerant JSON adapter.
//
// Recovery strategy: garbage at a value/key position is consumed up to
// the next delimiter at bracket depth zero (`,` `}` `]`) and becomes an
// ErrorNode; a missing comma between entries is a zero-width error that
// leaves both neighbouring entries valid. So a half-typed edit breaks
// only its own region — the rest of the document stays addressable for
// surgical writes.

import {
  type Entry,
  type FormatAdapter,
  indentOf,
  type JsonValue,
  type Node,
  type ObjectNode,
  type Op,
  type ParseError,
  type ParseResult,
  type Scalar,
  type TextEdit,
} from "./cst";

const WS = /[ \t\r\n]/;
const NUM = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/;
const DELIM = new Set([",", "}", "]", undefined]);

class P {
  pos = 0;
  errors: ParseError[] = [];
  constructor(readonly text: string) {}

  err(start: number, end: number, message: string): void {
    this.errors.push({ start, end, message });
  }

  skipWs(): void {
    while (this.pos < this.text.length && WS.test(this.text[this.pos]!)) this.pos++;
  }

  peek(): string | undefined {
    return this.text[this.pos];
  }

  /** Consume a garbage run: balanced brackets, strings capped at EOL,
   *  stops at `,` `}` `]` at depth zero. Returns the error node. */
  garbage(start: number, message: string): Node {
    let depth = 0;
    while (this.pos < this.text.length) {
      const c = this.text[this.pos]!;
      if (c === '"') {
        this.pos++;
        while (this.pos < this.text.length) {
          const s = this.text[this.pos]!;
          if (s === "\\") this.pos += 2;
          else if (s === '"' || s === "\n") {
            this.pos++;
            break;
          } else this.pos++;
        }
        continue;
      }
      if (c === "{" || c === "[") depth++;
      else if (c === "}" || c === "]") {
        if (depth === 0) break;
        depth--;
      } else if (c === "," && depth === 0) break;
      this.pos++;
    }
    let end = this.pos;
    while (end > start && WS.test(this.text[end - 1]!)) end--;
    if (end === start) end = Math.min(start + 1, this.text.length);
    this.err(start, end, message);
    return { kind: "error", start, end };
  }

  /** Raw string token; `ok: false` on an unterminated string. */
  scanString(): { value: string; end: number; ok: boolean } {
    const start = this.pos;
    this.pos++; // opening quote
    let out = "";
    while (this.pos < this.text.length) {
      const c = this.text[this.pos]!;
      if (c === '"') {
        this.pos++;
        return { value: out, end: this.pos, ok: true };
      }
      if (c === "\n") break;
      if (c === "\\") {
        const esc = this.text[this.pos + 1];
        this.pos += 2;
        if (esc === "n") out += "\n";
        else if (esc === "t") out += "\t";
        else if (esc === "r") out += "\r";
        else if (esc === "b") out += "\b";
        else if (esc === "f") out += "\f";
        else if (esc === "u") {
          const hex = this.text.slice(this.pos, this.pos + 4);
          if (/^[0-9a-fA-F]{4}$/.test(hex)) {
            out += String.fromCharCode(Number.parseInt(hex, 16));
            this.pos += 4;
          }
        } else out += esc ?? "";
        continue;
      }
      out += c;
      this.pos++;
    }
    this.err(start, this.pos, "unterminated string");
    return { value: out, end: this.pos, ok: false };
  }

  parseValue(): Node {
    const start = this.pos;
    const c = this.peek();
    if (c === "{") return this.parseObject();
    if (c === "[") return this.parseArray();
    if (c === '"') {
      const s = this.scanString();
      if (!s.ok) return { kind: "error", start, end: s.end };
      return this.checkTail({ kind: "scalar", start, end: s.end, value: s.value }, start);
    }
    const rest = this.text.slice(this.pos);
    const num = NUM.exec(rest);
    if (num && num[0].length > 0 && (c === "-" || (c! >= "0" && c! <= "9"))) {
      this.pos += num[0].length;
      return this.checkTail({ kind: "scalar", start, end: this.pos, value: Number(num[0]) }, start);
    }
    for (const [word, value] of [
      ["true", true],
      ["false", false],
      ["null", null],
    ] as const) {
      if (rest.startsWith(word)) {
        this.pos += word.length;
        return this.checkTail({ kind: "scalar", start, end: this.pos, value }, start);
      }
    }
    return this.garbage(start, "expected a value");
  }

  /** A scalar must be followed by a delimiter; trailing junk turns the
   *  whole run into an error node (typing `808x` must not push `808`). */
  checkTail(node: Node, start: number): Node {
    const c = this.peek();
    if (DELIM.has(c) || (c !== undefined && WS.test(c)) || c === ":") return node;
    return this.garbage(start, "malformed value");
  }

  parseObject(): ObjectNode {
    const start = this.pos;
    this.pos++; // {
    const entries: Entry[] = [];
    for (;;) {
      this.skipWs();
      const c = this.peek();
      if (c === undefined) {
        this.err(start, start + 1, "unclosed object");
        return { kind: "object", start, end: this.pos, entries };
      }
      if (c === "}") {
        this.pos++;
        return { kind: "object", start, end: this.pos, entries };
      }
      const entryStart = this.pos;
      if (c !== '"') {
        const node = this.garbage(entryStart, "expected a key");
        entries.push({ key: undefined, start: entryStart, end: node.end, node });
        if (this.peek() === ",") this.pos++;
        continue;
      }
      const key = this.scanString();
      if (!key.ok) {
        const node: Node = { kind: "error", start: entryStart, end: key.end };
        entries.push({ key: undefined, start: entryStart, end: key.end, node });
        if (this.peek() === ",") this.pos++;
        continue;
      }
      this.skipWs();
      if (this.peek() !== ":") {
        const node = this.garbage(entryStart, "expected ':' after key");
        entries.push({ key: undefined, start: entryStart, end: node.end, node });
        if (this.peek() === ",") this.pos++;
        continue;
      }
      this.pos++; // :
      this.skipWs();
      const node = this.parseValue();
      entries.push({
        key: node.kind === "error" ? undefined : key.value,
        start: entryStart,
        end: node.end,
        node,
      });
      this.skipWs();
      const d = this.peek();
      if (d === ",") {
        this.pos++;
        continue;
      }
      if (d === "}") continue; // loop closes
      if (d === undefined) continue; // loop reports unclosed
      if (d === '"') {
        // Missing comma — recover, both entries stay valid.
        this.err(this.pos, this.pos + 1, "expected ',' between entries");
        continue;
      }
      const junk = this.garbage(this.pos, "expected ',' or '}'");
      entries.push({ key: undefined, start: junk.start, end: junk.end, node: junk });
      if (this.peek() === ",") this.pos++;
    }
  }

  parseArray(): Node {
    const start = this.pos;
    this.pos++; // [
    const items: Node[] = [];
    for (;;) {
      this.skipWs();
      const c = this.peek();
      if (c === undefined) {
        this.err(start, start + 1, "unclosed array");
        return { kind: "array", start, end: this.pos, items };
      }
      if (c === "]") {
        this.pos++;
        return { kind: "array", start, end: this.pos, items };
      }
      const node = this.parseValue();
      items.push(node);
      this.skipWs();
      const d = this.peek();
      if (d === ",") {
        this.pos++;
        continue;
      }
      if (d === "]" || d === undefined) continue;
      this.err(this.pos, this.pos + 1, "expected ',' or ']'");
    }
  }
}

function parse(text: string): ParseResult {
  const p = new P(text);
  p.skipWs();
  if (p.pos >= text.length) {
    p.err(0, 0, "empty document");
    return { tree: { kind: "error", start: 0, end: 0 }, errors: p.errors };
  }
  const tree = p.parseValue();
  p.skipWs();
  if (p.pos < text.length) p.err(p.pos, text.length, "unexpected trailing content");
  return { tree, errors: p.errors };
}

function printScalar(v: Scalar): string {
  return JSON.stringify(v);
}

const allScalar = (a: JsonValue[]): boolean => a.every(v => v === null || typeof v !== "object");

function printVal(v: JsonValue, depth: number): string {
  if (v === null || typeof v !== "object") return printScalar(v);
  const ind = indentOf(depth);
  const inner = indentOf(depth + 1);
  if (Array.isArray(v)) {
    if (v.length === 0) return "[]";
    if (allScalar(v)) return `[${v.map(x => printScalar(x as Scalar)).join(", ")}]`;
    return `[\n${v.map(x => inner + printVal(x, depth + 1)).join(",\n")}\n${ind}]`;
  }
  const keys = Object.keys(v);
  if (keys.length === 0) return "{}";
  const body = keys
    .map(k => `${inner}${JSON.stringify(k)}: ${printVal(v[k]!, depth + 1)}`)
    .join(",\n");
  return `{\n${body}\n${ind}}`;
}

function print(value: JsonValue): string {
  return `${printVal(value, 0)}\n`;
}

function opToEdit(op: Op, text: string): TextEdit[] | null {
  switch (op.type) {
    case "replace":
      return [{ start: op.node.start, end: op.node.end, text: printVal(op.value, op.depth) }];
    case "insert": {
      const { obj, key, value, depth } = op;
      const inner = indentOf(depth + 1);
      const printed = `${JSON.stringify(key)}: ${printVal(value, depth + 1)}`;
      if (obj.entries.length === 0) {
        return [
          {
            start: obj.start + 1,
            end: obj.start + 1,
            text: `\n${inner}${printed}\n${indentOf(depth)}`,
          },
        ];
      }
      const anchor = (op.after ?? obj.entries[obj.entries.length - 1]!).end;
      // Match the document's separator style: newline if entries are
      // line-separated, inline otherwise.
      const between = text.slice(obj.start + 1, obj.entries[0]!.start);
      const sep = between.includes("\n") ? `,\n${inner}` : ", ";
      return [{ start: anchor, end: anchor, text: sep + printed }];
    }
    case "delete": {
      // Forward-tiling spans so consecutive deletes never overlap; a
      // last-entry delete adds its leading separator as a second edit
      // (harmlessly dropped when the previous entry is deleted too).
      const { obj, entry } = op;
      const idx = obj.entries.indexOf(entry);
      const next = obj.entries[idx + 1];
      if (next !== undefined) return [{ start: entry.start, end: next.start, text: "" }];
      const prev = obj.entries[idx - 1];
      const sepStart = prev !== undefined ? prev.end : obj.start + 1;
      return [
        { start: sepStart, end: entry.start, text: "" },
        { start: entry.start, end: entry.end, text: "" },
      ];
    }
  }
}

export const jsonFormat: FormatAdapter = { name: "JSON", parse, print, opToEdit };
