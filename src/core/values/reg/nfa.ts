import type { Node, RegVal, Span } from "../reg";
import { CharSet, type Re } from "./engine";

// ── structural markers ─────────────────────────────────────────────────

const ENTER = 0;
const LEAVE = 1;
const BRANCH = 2;
const SEP_START = 3;
const SEP_END = 4;

interface EvT {
  readonly k: number;
  readonly id: number;
  readonly i: number;
}

// ── program ─────────────────────────────────────────────────────────────

type Char = { op: 0; set: CharSet };
type Split = { op: 1; x: number; y: number };
type Jmp = { op: 2; x: number };
type Mark = { op: 3; ev: EvT };
type MatchI = { op: 4 };
type Instr = Char | Split | Jmp | Mark | MatchI;

export interface Program {
  readonly code: readonly Instr[];
  readonly idOf: WeakMap<Node, number>;
}

/** Compile a grammar AST to a tagged Thompson program. */
export function compileProgram(root: Node): Program {
  const code: Instr[] = [];
  const idOf = new WeakMap<Node, number>();
  let nid = 0;
  const idFor = (n: Node): number => {
    let x = idOf.get(n);
    if (x === undefined) {
      x = nid++;
      idOf.set(n, x);
    }
    return x;
  };
  const emit = (ins: Instr): void => {
    code.push(ins);
  };
  const mark = (k: number, id: number, i = -1): void => emit({ op: 3, ev: { k, id, i } });

  // Recognition-only compilation of an engine `Re` (no structural markers).
  const re = (r: Re): void => {
    switch (r.k) {
      case "emp":
        emit({ op: 0, set: CharSet.empty() }); // never matches → thread dies
        return;
      case "eps":
        return;
      case "chr":
        emit({ op: 0, set: r.set });
        return;
      case "seq":
        re(r.a);
        re(r.b);
        return;
      case "alt": {
        const sp: Split = { op: 1, x: 0, y: 0 };
        emit(sp);
        sp.x = code.length;
        re(r.a);
        const j: Jmp = { op: 2, x: 0 };
        emit(j);
        sp.y = code.length;
        re(r.b);
        j.x = code.length;
        return;
      }
      case "star": {
        const sp: Split = { op: 1, x: 0, y: 0 };
        const back = code.length;
        emit(sp);
        sp.x = code.length;
        re(r.r);
        emit({ op: 2, x: back });
        sp.y = code.length;
        return;
      }
    }
  };

  // Recognition-only compilation of a separator node (no markers — the sep's
  // span is captured by SEP_START/SEP_END around it, its value is discarded).
  const recog = (n: Node): void => {
    switch (n.kind) {
      case "lit":
        for (let k = 0; k < n.text.length; k++)
          emit({ op: 0, set: CharSet.char(n.text.charCodeAt(k)) });
        return;
      case "copy":
      case "of":
        re(n.engine);
        return;
      case "seq":
        for (const p of n.parts) recog(p);
        return;
      case "alt": {
        const jmps: Jmp[] = [];
        for (let bi = 0; bi < n.branches.length; bi++) {
          if (bi < n.branches.length - 1) {
            const sp: Split = { op: 1, x: 0, y: 0 };
            emit(sp);
            sp.x = code.length;
            recog(n.branches[bi]!);
            const j: Jmp = { op: 2, x: 0 };
            emit(j);
            jmps.push(j);
            sp.y = code.length;
          } else recog(n.branches[bi]!);
        }
        const end = code.length;
        for (const j of jmps) j.x = end;
        return;
      }
      case "opt": {
        const sp: Split = { op: 1, x: 0, y: 0 };
        emit(sp);
        sp.x = code.length;
        recog(n.part);
        const j: Jmp = { op: 2, x: 0 };
        emit(j);
        sp.y = code.length;
        j.x = code.length;
        return;
      }
      case "star": {
        if (n.sep === undefined) {
          const sp: Split = { op: 1, x: 0, y: 0 };
          const back = code.length;
          emit(sp);
          sp.x = code.length;
          recog(n.part);
          emit({ op: 2, x: back });
          sp.y = code.length;
        } else {
          recog(n.part);
          const sp: Split = { op: 1, x: 0, y: 0 };
          const back = code.length;
          emit(sp);
          sp.x = code.length;
          recog(n.sep);
          recog(n.part);
          emit({ op: 2, x: back });
          sp.y = code.length;
        }
        return;
      }
    }
  };

  const node = (n: Node): void => {
    switch (n.kind) {
      case "lit":
        for (let k = 0; k < n.text.length; k++)
          emit({ op: 0, set: CharSet.char(n.text.charCodeAt(k)) });
        return;
      case "copy":
      case "of": {
        const id = idFor(n);
        mark(ENTER, id);
        re(n.engine);
        mark(LEAVE, id);
        return;
      }
      case "seq": {
        const id = idFor(n);
        mark(ENTER, id);
        for (const p of n.parts) node(p);
        mark(LEAVE, id);
        return;
      }
      case "alt": {
        const id = idFor(n);
        mark(ENTER, id);
        const jmps: Jmp[] = [];
        for (let bi = 0; bi < n.branches.length; bi++) {
          if (bi < n.branches.length - 1) {
            const sp: Split = { op: 1, x: 0, y: 0 };
            emit(sp);
            sp.x = code.length;
            mark(BRANCH, id, bi);
            node(n.branches[bi]!);
            const j: Jmp = { op: 2, x: 0 };
            emit(j);
            jmps.push(j);
            sp.y = code.length;
          } else {
            mark(BRANCH, id, bi);
            node(n.branches[bi]!);
          }
        }
        const end = code.length;
        for (const j of jmps) j.x = end;
        mark(LEAVE, id);
        return;
      }
      case "opt": {
        const id = idFor(n);
        mark(ENTER, id);
        const sp: Split = { op: 1, x: 0, y: 0 };
        emit(sp);
        sp.x = code.length; // present (greedy first)
        mark(BRANCH, id, 1);
        node(n.part);
        const j: Jmp = { op: 2, x: 0 };
        emit(j);
        sp.y = code.length; // absent
        mark(BRANCH, id, 0);
        j.x = code.length;
        mark(LEAVE, id);
        return;
      }
      case "star": {
        const id = idFor(n);
        mark(ENTER, id);
        if (n.sep === undefined) {
          if (n.min === 1) node(n.part);
          const sp: Split = { op: 1, x: 0, y: 0 };
          const back = code.length;
          emit(sp);
          sp.x = code.length; // iterate (greedy first)
          node(n.part);
          emit({ op: 2, x: back });
          sp.y = code.length; // exit
        } else {
          node(n.part); // ≥1 element, like Str.split
          const sp: Split = { op: 1, x: 0, y: 0 };
          const back = code.length;
          emit(sp);
          sp.x = code.length; // (sep element)+
          mark(SEP_START, id);
          recog(n.sep);
          mark(SEP_END, id);
          node(n.part);
          emit({ op: 2, x: back });
          sp.y = code.length; // exit
        }
        mark(LEAVE, id);
        return;
      }
    }
  };

  node(root);
  emit({ op: 4 });
  return { code, idOf };
}

// ── PikeVM ───────────────────────────────────────────────────────────────

interface LogNode {
  readonly k: number;
  readonly id: number;
  readonly i: number;
  readonly pos: number;
  readonly prev: LogNode | null;
}

interface Thread {
  readonly pc: number;
  readonly log: LogNode | null;
}

/** Run the program over `s`, anchored to the whole string. Returns the winning
 *  thread's marker log wrapped in a result object, or `null` if no full parse
 *  exists. With `keepLog = false` no markers are allocated (recognition only),
 *  so a successful run reports `{ log: null }` — distinct from a `null` miss. */
function run(code: readonly Instr[], s: string, keepLog: boolean): { log: LogNode | null } | null {
  const n = s.length;
  const visited = new Int32Array(code.length).fill(-1);

  const add = (list: Thread[], gen: number, pc: number, log: LogNode | null, pos: number): void => {
    if (visited[pc] === gen) return;
    visited[pc] = gen;
    const ins = code[pc]!;
    switch (ins.op) {
      case 2: // jmp
        add(list, gen, ins.x, log, pos);
        return;
      case 1: // split — x is higher priority
        add(list, gen, ins.x, log, pos);
        add(list, gen, ins.y, log, pos);
        return;
      case 3: {
        // mark
        const nl: LogNode | null = keepLog
          ? { k: ins.ev.k, id: ins.ev.id, i: ins.ev.i, pos, prev: log }
          : null;
        add(list, gen, pc + 1, nl, pos);
        return;
      }
      default: // char (0) or match (4): a real (waiting) thread
        list.push({ pc, log });
    }
  };

  let gen = 0;
  let clist: Thread[] = [];
  add(clist, gen, 0, null, 0);

  for (let pos = 0; ; pos++) {
    if (pos === n) {
      for (const t of clist) if (code[t.pc]!.op === 4) return { log: t.log }; // highest-priority full match
      return null;
    }
    const c = s.charCodeAt(pos);
    gen++;
    const nlist: Thread[] = [];
    for (const t of clist) {
      const ins = code[t.pc]!;
      if (ins.op === 0 && ins.set.has(c)) add(nlist, gen, t.pc + 1, t.log, pos + 1);
      // op === 4 (match before end-of-input) and non-matching chars: thread dies.
    }
    clist = nlist;
    if (clist.length === 0) return null;
  }
}

// ── reconstruction (markers → value tree) ─────────────────────────────────

function logToEvs(log: LogNode): LogNode[] {
  const out: LogNode[] = [];
  for (let p: LogNode | null = log; p !== null; p = p.prev) out.push(p);
  out.reverse();
  return out;
}

/** Parse `s` fully; `null` if it doesn't match. Builds the value tree (and, if
 *  given, the named-capture span map) from the winning marker log. */
export function parseValue(
  root: Node,
  prog: Program,
  s: string,
  spans?: Map<string, Span>,
): { val: RegVal } | null {
  const res = run(prog.code, s, true);
  if (res === null) return null;
  const evs = res.log === null ? [] : logToEvs(res.log);
  const idOf = prog.idOf;
  let i = 0;

  const build = (node: Node): RegVal => {
    switch (node.kind) {
      case "lit":
        return null; // silent: emits no markers, contributes no value
      case "copy": {
        const e = evs[i++]!;
        const l = evs[i++]!;
        const v = s.slice(e.pos, l.pos);
        if (spans !== undefined && node.name !== undefined) spans.set(node.name, [e.pos, l.pos]);
        return v;
      }
      case "of": {
        const e = evs[i++]!;
        const l = evs[i++]!;
        if (spans !== undefined && node.name !== undefined) spans.set(node.name, [e.pos, l.pos]);
        const v = node.codec.parse(s.slice(e.pos, l.pos));
        return (v === undefined ? null : v) as RegVal;
      }
      case "seq": {
        i++; // ENTER
        const vals: RegVal[] = [];
        for (const p of node.parts) {
          if (p.kind === "lit") continue;
          vals.push(build(p));
        }
        i++; // LEAVE
        return vals;
      }
      case "alt": {
        i++; // ENTER
        const b = evs[i++]!; // BRANCH
        const val = build(node.branches[b.i]!);
        i++; // LEAVE
        return { branch: b.i, val };
      }
      case "opt": {
        i++; // ENTER
        const b = evs[i++]!; // BRANCH (1 = present, 0 = absent)
        let val: RegVal;
        if (b.i === 1) val = node.part.kind === "lit" ? true : build(node.part);
        else val = null;
        i++; // LEAVE
        return val;
      }
      case "star": {
        const e = evs[i++]!; // ENTER
        const items: RegVal[] = [];
        const seps: string[] = [];
        if (node.sep === undefined) {
          const pid = idOf.get(node.part);
          while (i < evs.length && evs[i]!.k === ENTER && evs[i]!.id === pid)
            items.push(build(node.part));
        } else {
          const sid = idOf.get(node);
          items.push(build(node.part));
          while (i < evs.length && evs[i]!.k === SEP_START && evs[i]!.id === sid) {
            const ss = evs[i++]!;
            const se = evs[i++]!;
            seps.push(s.slice(ss.pos, se.pos));
            items.push(build(node.part));
          }
        }
        const l = evs[i++]!; // LEAVE
        if (spans !== undefined && node.name !== undefined) spans.set(node.name, [e.pos, l.pos]);
        return { items, seps };
      }
    }
  };

  return { val: build(root) };
}

/** Does the program match the whole of `s`? Recognition only (no allocation). */
export function recognize(prog: Program, s: string): boolean {
  return run(prog.code, s, false) !== null;
}
