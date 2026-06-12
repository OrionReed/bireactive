// edn.ts — tolerant EDN adapter (maps, vectors, strings, numbers,
// booleans, nil, keywords). Keyword map keys project to plain string
// keys in the abstract value; commas are whitespace; `;` comments run
// to end of line. Recovery mirrors the JSON adapter: garbage runs to
// the next delimiter at depth zero become ErrorNodes.

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

const WS = /[ \t\r\n,]/;
const NUM = /^[-+]?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/;
const KEYWORD = /^:[A-Za-z_*+!?<>=.][\w*+!?<>=.-]*/;
const SAFE_KEY = /^[A-Za-z_][\w-]*$/;

class P {
  pos = 0;
  errors: ParseError[] = [];
  constructor(readonly text: string) {}

  err(start: number, end: number, message: string): void {
    this.errors.push({ start, end, message });
  }

  skipWs(): void {
    for (;;) {
      while (this.pos < this.text.length && WS.test(this.text[this.pos]!)) this.pos++;
      if (this.text[this.pos] === ";") {
        while (this.pos < this.text.length && this.text[this.pos] !== "\n") this.pos++;
        continue;
      }
      return;
    }
  }

  peek(): string | undefined {
    return this.text[this.pos];
  }

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
      if (c === "{" || c === "[" || c === "(") depth++;
      else if (c === "}" || c === "]" || c === ")") {
        if (depth === 0) break;
        depth--;
      } else if (depth === 0 && WS.test(c)) break;
      this.pos++;
    }
    let end = this.pos;
    if (end === start) end = Math.min(start + 1, this.text.length);
    this.err(start, end, message);
    return { kind: "error", start, end };
  }

  scanString(): { value: string; end: number; ok: boolean } {
    const start = this.pos;
    this.pos++;
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
        else out += esc ?? "";
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
    if (c === "{") return this.parseMap();
    if (c === "[") return this.parseVector();
    if (c === '"') {
      const s = this.scanString();
      if (!s.ok) return { kind: "error", start, end: s.end };
      return { kind: "scalar", start, end: s.end, value: s.value };
    }
    const rest = this.text.slice(this.pos);
    const kw = KEYWORD.exec(rest);
    if (kw) {
      this.pos += kw[0].length;
      return { kind: "scalar", start, end: this.pos, value: kw[0].slice(1) };
    }
    const num = NUM.exec(rest);
    if (num && num[0].length > 0 && /^[-+]?\d/.test(rest)) {
      this.pos += num[0].length;
      const after = this.peek();
      if (after !== undefined && !WS.test(after) && !"}])".includes(after)) {
        return this.garbage(start, "malformed number");
      }
      return { kind: "scalar", start, end: this.pos, value: Number(num[0]) };
    }
    for (const [word, value] of [
      ["true", true],
      ["false", false],
      ["nil", null],
    ] as const) {
      if (rest.startsWith(word)) {
        const after = this.text[this.pos + word.length];
        if (after === undefined || WS.test(after) || "}])".includes(after)) {
          this.pos += word.length;
          return { kind: "scalar", start, end: this.pos, value };
        }
      }
    }
    return this.garbage(start, "expected a value");
  }

  parseMap(): ObjectNode {
    const start = this.pos;
    this.pos++; // {
    const entries: Entry[] = [];
    for (;;) {
      this.skipWs();
      const c = this.peek();
      if (c === undefined) {
        this.err(start, start + 1, "unclosed map");
        return { kind: "object", start, end: this.pos, entries };
      }
      if (c === "}") {
        this.pos++;
        return { kind: "object", start, end: this.pos, entries };
      }
      const entryStart = this.pos;
      let key: string | undefined;
      if (c === ":") {
        const kw = KEYWORD.exec(this.text.slice(this.pos));
        if (kw) {
          key = kw[0].slice(1);
          this.pos += kw[0].length;
        }
      } else if (c === '"') {
        const s = this.scanString();
        if (s.ok) key = s.value;
      }
      if (key === undefined) {
        const node = this.garbage(entryStart, "expected a keyword or string key");
        entries.push({ key: undefined, start: entryStart, end: node.end, node });
        continue;
      }
      this.skipWs();
      if (this.peek() === undefined || this.peek() === "}") {
        const end = this.pos;
        this.err(entryStart, end, "key without a value");
        entries.push({
          key: undefined,
          start: entryStart,
          end,
          node: { kind: "error", start: entryStart, end },
        });
        continue;
      }
      const node = this.parseValue();
      entries.push({
        key: node.kind === "error" ? undefined : key,
        start: entryStart,
        end: node.end,
        node,
      });
    }
  }

  parseVector(): Node {
    const start = this.pos;
    this.pos++; // [
    const items: Node[] = [];
    for (;;) {
      this.skipWs();
      const c = this.peek();
      if (c === undefined) {
        this.err(start, start + 1, "unclosed vector");
        return { kind: "array", start, end: this.pos, items };
      }
      if (c === "]") {
        this.pos++;
        return { kind: "array", start, end: this.pos, items };
      }
      items.push(this.parseValue());
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
  if (v === null) return "nil";
  return JSON.stringify(v);
}

function printKey(k: string): string {
  return SAFE_KEY.test(k) ? `:${k}` : JSON.stringify(k);
}

const allScalar = (a: JsonValue[]): boolean => a.every(v => v === null || typeof v !== "object");

function printVal(v: JsonValue, depth: number): string {
  if (v === null || typeof v !== "object") return printScalar(v);
  const ind = indentOf(depth);
  const inner = indentOf(depth + 1);
  if (Array.isArray(v)) {
    if (v.length === 0) return "[]";
    if (allScalar(v)) return `[${v.map(x => printScalar(x as Scalar)).join(" ")}]`;
    return `[\n${v.map(x => inner + printVal(x, depth + 1)).join("\n")}\n${ind}]`;
  }
  const keys = Object.keys(v);
  if (keys.length === 0) return "{}";
  const body = keys.map(k => `${inner}${printKey(k)} ${printVal(v[k]!, depth + 1)}`).join("\n");
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
      const printed = `${printKey(key)} ${printVal(value, depth + 1)}`;
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
      const between = text.slice(obj.start + 1, obj.entries[0]!.start);
      const sep = between.includes("\n") ? `\n${inner}` : " ";
      return [{ start: anchor, end: anchor, text: sep + printed }];
    }
    case "delete": {
      // Forward-tiling spans; see the JSON adapter for the rationale.
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

export const ednFormat: FormatAdapter = { name: "EDN", parse, print, opToEdit };
