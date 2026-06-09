// regions.ts — PROTOTYPE 2 (scratch, not wired to the engine).
//
//   run: node node_modules/.bin/vite-node src/core3/_proto/regions.ts
//
// Picks up where `unified.ts` left off. `unified.ts` proved membership can be a
// CONDENSATION LOOKUP rather than a per-cell mode (no `_region`, no `relax`, no
// `owner`) — but it re-solved on every read and elided cross-group ordering. Its
// RESIDUE section listed exactly what a real engine must add back:
//   (1) a per-group solve cache (skip re-solving when nothing changed), and
//   (2) cross-group glitch-freedom (a downstream group re-solves when an
//       upstream member changes), in dependency order.
//
// THIS prototype adds both, and the design that falls out is:
//
//   • A REGION is the unit of scheduling (rename of "Component"). It is NOT a
//     cell, NOT pointed to by any `_region` field — it's a memo keyed by the
//     condensation representative, born lazily on read and dying with its
//     partition entry.
//   • A region's solved output lives in the MEMO (`solved`), not on the cell.
//     A source member's cell still holds its STANDING (its input). So input and
//     output are cleanly separated WITHOUT splitting the cell — which is what
//     dissolves the "member duality" + the manual `invalidate()` poke.
//   • Freshness is PULL-VALIDATED by snapshot, exactly like a computed checks
//     its deps: a region is valid iff (a) the partition hasn't changed and
//     (b) re-reading every input it used (member seeds + external reads) yields
//     the same values. Re-reading an external recurses through `read`, which
//     pulls the upstream region first — so validation IS the glitch-free
//     ordering. No push, no manual dirtying, no `invalidate`.
//
// What's deliberately coarse (and noted): topology edits invalidate all memos
// (a real engine scopes this via `drainDirty`), and snapshot validation is O(
// inputs) per read where a version-stamped variant would be ~O(1). Neither
// affects the DESIGN shape we're judging — the value-change hot path is handled
// by snapshot validation, which never bumps the topology generation.
//
// The gate that keeps the acyclic path free: `read` consults none of this
// unless the cell is a relation PARTICIPANT (it appears in a rule / lens edge).
// "Has a lattice" is NOT the gate — ~every value class has one; only cells
// actually USED in a relation enter the condensation.

import { DynCondensation } from "../condense";
import { flat, interval } from "../lattice";

interface Lat {
  top: unknown;
  meet(a: unknown, b: unknown): unknown;
  equals(a: unknown, b: unknown): boolean;
  abstract(v: unknown): unknown;
  concretize(k: unknown, fb: unknown): unknown;
  pinned(k: unknown): unknown;
  image?(k: unknown, f: (t: number) => number): unknown;
}

// One node type. Discriminants are DATA, not subclasses (mirrors core3):
//   • lattice === undefined → plain cell (never a relation member)
//   • getter  === undefined → source: `value` is its STANDING (its input)
//   • getter  !== undefined → lens/computed: forward derivation
class Node {
  value: unknown; // source: standing/input. lens: unused (getter derives).
  lattice: Lat | undefined;
  getter: (() => unknown) | undefined;
  parent: Node | undefined; // lens structural parent (for the in-cycle lift)
  fwd: ((t: number) => number) | undefined;
  bwd: ((t: number) => number) | undefined;
  constructor(value: unknown, lattice?: Lat) {
    this.value = value;
    this.lattice = lattice;
  }
}

function source(value: unknown, lattice?: Lat): Node {
  return new Node(value, lattice);
}
function isoLens(parent: Node, fwd: (t: number) => number, bwd: (t: number) => number): Node {
  const n = new Node(undefined, interval as unknown as Lat);
  n.getter = () => fwd(read(parent) as number);
  n.parent = parent;
  n.fwd = fwd;
  n.bwd = bwd;
  return n;
}

// ── topology: ONE condensation, maintained only over participants ────
interface Rule {
  reads: Node[];
  writes: Node[];
  body: (get: (c: Node) => unknown, emit: (c: Node, k: unknown) => void) => void;
}
const cond = new DynCondensation<Node>();
const participants = new Set<Node>(); // the relation sub-graph (the gate)
const rules = new Set<Rule>();
const freeVars = new Set<Node>();
let topoGen = 0;

function participate(n: Node): void {
  if (!participants.has(n)) {
    participants.add(n);
    cond.addNode(n);
  }
}

/** Fold a lens member's structural parent edges into the condensation, so
 *  lens-coupled cells condense together (mirrors relate.ts registerLensParents).
 *  Permanent edges (lens structure is fixed for the cell's life). */
function registerLensParents(m: Node): void {
  let child: Node = m;
  for (let p = child.parent; p !== undefined; p = child.parent) {
    participate(p);
    participate(child);
    cond.addEdge(p, child);
    child = p;
  }
}

function relate(reads: Node[], writes: Node[], body: Rule["body"]): () => void {
  const r: Rule = { reads, writes, body };
  rules.add(r);
  for (const w of writes) {
    participate(w);
    registerLensParents(w);
    for (const rd of reads) {
      participate(rd);
      cond.addEdge(rd, w);
    }
  }
  topoGen++;
  epoch++;
  return () => {
    rules.delete(r);
    for (const w of writes) for (const rd of reads) cond.removeEdge(rd, w);
    topoGen++;
    epoch++;
  };
}

/** a = b (bidirectional ⇒ merges into one SCC). */
function equal(a: Node, b: Node): () => void {
  const d1 = relate([a], [b], (get, emit) => emit(b, get(a)));
  const d2 = relate([b], [a], (get, emit) => emit(a, get(b)));
  return () => {
    d1();
    d2();
  };
}

/** One-way knowledge flow a ⇒ b (keeps a and b in SEPARATE groups; a DAG edge
 *  between regions — the cross-group case). */
function flow(a: Node, b: Node): () => void {
  return relate([a], [b], (get, emit) => emit(b, get(a)));
}

function free(c: Node): void {
  freeVars.add(c);
}
function write(n: Node, v: unknown): void {
  n.value = v; // just update the standing; the next read re-validates + re-solves
  epoch++;
}

// ── region memo: keyed by condensation representative ────────────────
interface Memo {
  topoGen: number;
  validatedAt: number; // epoch at which this memo was last confirmed current
  members: Node[];
  solved: Map<Node, unknown>;
  // snapshot of every INPUT the solve consumed, for pull validation:
  seedSnap: Map<Node, unknown>; // member → its seed value at solve time
  extSnap: Map<Node, unknown>; // external read → its concrete value at solve time
}
const memos = new Map<Node, Memo>();
const solving = new Set<Node>(); // re-entrancy guard (DAG ⇒ should never trip)
let solveCount = 0; // instrumentation: actual fixpoint solves
let validateCount = 0; // instrumentation: O(inputs) snapshot validations
// Global change epoch: bumped on ANY write or topology edit. A memo validated
// at the current epoch is trivially current ⇒ repeated reads between writes are
// O(1) (no input re-read). Only an epoch advance triggers a snapshot check.
let epoch = 0;

function degenerate(n: Node): unknown {
  return n.getter !== undefined ? n.getter() : n.value;
}

// ── THE read path ────────────────────────────────────────────────────
function read(n: Node): unknown {
  if (!participants.has(n)) return degenerate(n); // byte-identical acyclic gate
  const rep = cond.representative(n);
  if (!cond.isCyclic(rep)) return degenerate(n); // singleton ⇒ plain read
  return ensure(rep).solved.get(n);
}

/** Ensure the region rooted at `rep` is solved and current; return its memo. */
function ensure(rep: Node): Memo {
  const memo = memos.get(rep);
  if (memo !== undefined) {
    if (memo.validatedAt === epoch) return memo; // O(1): nothing changed anywhere
    if (valid(memo)) {
      memo.validatedAt = epoch;
      return memo;
    }
  }
  return solveGroup(rep);
}

/** Pull validation: a memo is current iff the partition is unchanged AND every
 *  input it consumed still reads the same. Re-reading an external recurses
 *  through `read` ⇒ upstream regions are validated/re-solved FIRST (glitch-free,
 *  in dependency order). This is the whole of cross-group freshness — no push,
 *  no manual invalidate. */
function valid(memo: Memo): boolean {
  validateCount++;
  if (memo.topoGen !== topoGen) return false;
  for (const [m, snap] of memo.seedSnap) {
    if (!eq(m, seedOf(m), snap)) return false;
  }
  for (const [c, snap] of memo.extSnap) {
    if (!eq(c, read(c), snap)) return false; // recurses upstream
  }
  return true;
}

function eq(n: Node, a: unknown, b: unknown): boolean {
  // Compare concretes; use the lattice's equals if present (e.g. ε on reals).
  return n.lattice ? n.lattice.equals(n.lattice.abstract(a), n.lattice.abstract(b)) : Object.is(a, b);
}

/** A member's seed = its intrinsic input: a source's standing, a lens's forward
 *  (read through the graph). Derived lens members (parent is a co-member) carry
 *  no seed — they're filled by the lifted lens rule. */
function seedOf(m: Node): unknown {
  return m.getter !== undefined ? m.getter() : m.value;
}

function solveGroup(rep: Node): Memo {
  if (solving.has(rep)) {
    // Should be unreachable: the condensation is a DAG across regions.
    return (
      memos.get(rep) ?? { topoGen, validatedAt: epoch, members: [], solved: new Map(), seedSnap: new Map(), extSnap: new Map() }
    );
  }
  solving.add(rep);
  solveCount++;

  const members = cond.membersOf(rep).filter(m => m.lattice !== undefined);
  const n = members.length;
  const idx = new Map<Node, number>();
  members.forEach((m, i) => idx.set(m, i));
  const lat = (m: Node) => m.lattice as Lat;
  const work = new Array<unknown>(n);
  const fb = new Array<unknown>(n);
  const seedSnap = new Map<Node, unknown>();
  const extSnap = new Map<Node, unknown>();

  const get = (c: Node): unknown => {
    const i = idx.get(c);
    if (i !== undefined) return work[i]; // in-region: live knowledge
    // External read: pull it (recurses ⇒ upstream region solved first), record
    // the concrete for later validation, lift to K.
    const cv = read(c);
    extSnap.set(c, cv);
    const l = c.lattice;
    return l ? l.abstract(cv) : cv;
  };
  const emit = (c: Node, k: unknown): void => {
    const i = idx.get(c);
    if (i === undefined) return; // emit to a non-member is a no-op
    work[i] = lat(c).meet(work[i], k);
  };

  // Derived = lens whose parent is a co-member (both sides inside the cycle).
  const derived = members.map(m => m.parent !== undefined && idx.has(m.parent));
  const groupRules: Rule["body"][] = [];
  for (const r of rules) if (r.writes.some(w => idx.has(w))) groupRules.push(r.body);
  members.forEach((m, i) => {
    if (derived[i] && m.fwd !== undefined) liftLens(m, idx, groupRules);
  });

  for (let i = 0; i < n; i++) {
    const m = members[i]!;
    const l = lat(m);
    if (derived[i]) {
      work[i] = l.top;
      fb[i] = read(m.parent!); // frozen fallback ≈ forward of current parent
      continue;
    }
    const seed = seedOf(m);
    seedSnap.set(m, seed);
    work[i] = freeVars.has(m) ? l.top : l.abstract(seed);
    fb[i] = seed;
  }

  for (let pass = 0; pass < 1000; pass++) {
    let changed = false;
    for (const body of groupRules) {
      const before = work.slice();
      body(get, emit);
      for (let i = 0; i < n; i++) if (!lat(members[i]!).equals(before[i], work[i])) changed = true;
    }
    if (!changed) break;
  }

  const solved = new Map<Node, unknown>();
  for (let i = 0; i < n; i++) solved.set(members[i]!, lat(members[i]!).concretize(work[i], fb[i]));

  const memo: Memo = { topoGen, validatedAt: epoch, members, solved, seedSnap, extSnap };
  memos.set(rep, memo);
  solving.delete(rep);
  return memo;
}

function liftLens(child: Node, idx: Map<Node, number>, out: Rule["body"][]): void {
  const p = child.parent!;
  if (!idx.has(p)) return;
  const l = child.lattice as Lat;
  const img = l.image;
  if (img === undefined) return;
  const f = child.fwd!;
  const b = child.bwd!;
  out.push((get, emit) => emit(child, img(get(p), f)));
  out.push((get, emit) => emit(p, img(get(child), b)));
}

// ── scenarios ────────────────────────────────────────────────────────
let failures = 0;
function check(label: string, got: unknown, want: unknown): void {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) failures++;
  console.log(`  ${ok ? "✓" : "✗"} ${label}: got ${JSON.stringify(got)}${ok ? "" : ` want ${JSON.stringify(want)}`}`);
}
function reset(): void {
  // fresh world per scenario (prototype convenience)
  memos.clear();
  solveCount = 0;
  validateCount = 0;
}

function scFreeRing(): void {
  console.log("• free ring: a=7 fact; free b,c; equal(a,b),(b,c)");
  reset();
  const a = source(7, flat() as unknown as Lat);
  const b = source(0, flat() as unknown as Lat);
  const c = source(0, flat() as unknown as Lat);
  free(b);
  free(c);
  equal(a, b);
  equal(b, c);
  check("read a", read(a), 7);
  check("read b", read(b), 7);
  check("read c", read(c), 7);
}

function scConflict(): void {
  console.log("• conflict: two facts each keep their own");
  reset();
  const a = source(7, flat() as unknown as Lat);
  const b = source(5, flat() as unknown as Lat);
  equal(a, b);
  check("a", read(a), 7);
  check("b", read(b), 5);
}

function scAcyclicLens(): void {
  console.log("• degenerate: a lens NOT in a cycle reads via getter, no solve");
  reset();
  const a = source(5, interval as unknown as Lat);
  const b = isoLens(a, t => t * 2, t => t / 2);
  // b is a participant (lens edge registered) but a singleton ⇒ no solve.
  // force a to be a participant too via a trivial self-relation? no — keep b's
  // edge only; b singleton.
  check("b = 10 via getter", read(b), 10);
  check("no region solved", solveCount, 0);
}

function scCaching(): void {
  console.log("• caching: many reads ⇒ one solve; unchanged ⇒ no re-solve");
  reset();
  const a = source(7, flat() as unknown as Lat);
  const b = source(0, flat() as unknown as Lat);
  free(b);
  equal(a, b);
  read(b);
  read(b);
  read(a);
  check("solved once for 3 reads", solveCount, 1);
}

function scStandingWriteNoInvalidate(): void {
  console.log("• member standing write ⇒ re-solve on read, NO manual invalidate");
  reset();
  const a = source(7, flat() as unknown as Lat);
  const b = source(0, flat() as unknown as Lat);
  free(b);
  equal(a, b);
  check("b follows a=7", read(b), 7);
  check("one solve", solveCount, 1);
  write(a, 10); // just changed the standing
  check("b re-solves to 10", read(b), 10);
  check("two solves total", solveCount, 2);
  read(b);
  check("still two (cached)", solveCount, 2);
}

function scCrossGroupGlitchFree(): void {
  console.log("• cross-group: region B reads a member of region A (DAG edge)");
  reset();
  const a1 = source(7, flat() as unknown as Lat);
  const a2 = source(0, flat() as unknown as Lat);
  free(a2);
  equal(a1, a2); // region A = {a1,a2}
  const b1 = source(0, flat() as unknown as Lat);
  const b2 = source(0, flat() as unknown as Lat);
  free(b1);
  free(b2);
  equal(b1, b2); // region B = {b1,b2}
  flow(a1, b1); // one-way A ⇒ B (keeps them separate; B downstream of A)
  check("B narrows to A's value", read(b2), 7);
  const afterFirst = solveCount; // A + B solved
  check("two regions solved", afterFirst, 2);
  read(b1);
  check("cached: no extra solve", solveCount, afterFirst);
  write(a1, 20);
  check("B re-solves through A, glitch-free", read(b2), 20);
  check("A then B re-solved (+2)", solveCount, afterFirst + 2);
}

function scEpochFastPath(): void {
  console.log("• epoch fast-path: reads between writes are O(1) (no input re-read)");
  reset();
  const a = source(7, flat() as unknown as Lat);
  const b = source(0, flat() as unknown as Lat);
  free(b);
  equal(a, b);
  read(b); // solves once
  const vAfterSolve = validateCount;
  read(b);
  read(b);
  read(a);
  check("no snapshot validations across repeat reads", validateCount, vAfterSolve);
  check("still one solve", solveCount, 1);
  write(a, 9); // epoch++ ⇒ next read pays exactly one validation, then re-solves
  read(b);
  check("one validation after a write", validateCount, vAfterSolve + 1);
}

function scUnrelatedWrite(): void {
  console.log("• unrelated write ⇒ no re-solve");
  reset();
  const a = source(7, flat() as unknown as Lat);
  const b = source(0, flat() as unknown as Lat);
  free(b);
  equal(a, b);
  read(b);
  const base = solveCount;
  const u = source(123, flat() as unknown as Lat); // not in any relation
  write(u, 999);
  read(b);
  check("no re-solve from unrelated write", solveCount, base);
}

function scTeardownNoRelax(): void {
  console.log("• teardown WITHOUT relax: dispose rules ⇒ singletons again");
  reset();
  const a = source(3, flat() as unknown as Lat);
  const b = source(99, flat() as unknown as Lat);
  free(b);
  const undo = equal(a, b);
  check("while related b→a", read(b), 3);
  undo();
  freeVars.delete(b);
  write(b, 42);
  check("b keeps own standing after teardown", read(b), 42);
  check("a keeps own standing", read(a), 3);
}

console.log("\n=== regions prototype (condensation-owns-the-memo) ===\n");
scFreeRing();
scConflict();
scAcyclicLens();
scCaching();
scStandingWriteNoInvalidate();
scCrossGroupGlitchFree();
scEpochFastPath();
scUnrelatedWrite();
scTeardownNoRelax();
console.log(`\n${failures === 0 ? "ALL PASS" : `${failures} FAILED`}\n`);
