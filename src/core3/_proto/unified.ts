// unified.ts — NORTH-STAR PROTOTYPE (scratch, not wired to the engine).
//
//   run: node node_modules/.bin/vite-node src/core3/_proto/unified.ts
//
// Question we're pressure-testing: can the SCC solve "fall out" of an ordinary
// read, with NO per-cell membership overlay (`_region`), NO separate solver
// node (`Component`), NO manual node lifecycle (`owner`/`dispose`), and — the
// one the user keeps flagging — NO `relax()`?
//
// The bet: stop storing "member" as a mutable mode on the cell. Make group
// membership a FUNCTION of the live rule graph, looked up (and cached) at read
// time. Then:
//   • there is no mode to enter/leave ⇒ no `relax` (leaving a relation is just
//     "your group shrank to a singleton", observed on the next read);
//   • there is no second node ⇒ no `_region`, no projection, no `owner`;
//   • a plain cell (no lattice) never consults any of it ⇒ the degenerate
//     acyclic path is byte-identical to today.
//
// What this prototype DELIBERATELY elides (and why it's honest to do so): the
// real engine's glitch-free caching + external-dep tracking. Here `read` solves
// eagerly each time. §"RESIDUE" at the bottom states exactly what that caching
// would add back, and confirms it does NOT bring `_region`/`relax` back.

import { flat, interval } from "../lattice";

// A single node type. The discriminants are DATA, not subclasses:
//   • lattice === undefined          → plain cell (source if no getter, else lens)
//   • getter  === undefined          → source (its `value` is the standing)
//   • getter  !== undefined          → lens/computed (forward derivation)
// "Knowledge cell" = has a lattice. "Member" is NOT stored here — it's derived.
interface Lat {
  top: unknown;
  meet(a: unknown, b: unknown): unknown;
  equals(a: unknown, b: unknown): boolean;
  abstract(v: unknown): unknown;
  concretize(k: unknown, fb: unknown): unknown;
  pinned(k: unknown): unknown;
  image?(k: unknown, f: (t: number) => number): unknown;
}

class Node {
  value: unknown;
  lattice: Lat | undefined;
  getter: (() => unknown) | undefined;
  // lens structure (parent + invertible maps), for the in-cycle lift:
  parent: Node | undefined;
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

/** A scalar Iso lens `child = fwd(parent)` over the interval lattice. Writable
 *  via `bwd`. Mirrors core3's `lens(parent, fwd, bwd)` for an invertible map. */
function isoLens(parent: Node, fwd: (t: number) => number, bwd: (t: number) => number): Node {
  const n = new Node(undefined, interval as unknown as Lat);
  n.getter = () => fwd(read(parent) as number);
  n.parent = parent;
  n.fwd = fwd;
  n.bwd = bwd;
  return n;
}

// ── rule registry = the relation graph (the ONLY topology state) ─────
interface Rule {
  reads: Node[];
  writes: Node[];
  body: (get: (c: Node) => unknown, emit: (c: Node, k: unknown) => void) => void;
}
const rules = new Set<Rule>();
let graphGen = 0; // bumps on any topology change (add/remove rule)

function relate(
  reads: Node[],
  writes: Node[],
  body: Rule["body"],
): () => void {
  const r: Rule = { reads, writes, body };
  rules.add(r);
  graphGen++;
  return () => {
    rules.delete(r);
    graphGen++;
  };
}

/** a = b: knowledge flows both ways (each meets the other). */
function equal(a: Node, b: Node): () => void {
  const d1 = relate([a], [b], (get, emit) => emit(b, get(a)));
  const d2 = relate([b], [a], (get, emit) => emit(a, get(b)));
  return () => {
    d1();
    d2();
  };
}

// FREE variables: no standing FACT, so a free cell seeds ⊤ and meets toward
// whatever the constraints say (its value is only a soft fallback). Mirrors
// relate.ts's `free`. A plain (non-free) cell's value is a hard fact, so two
// conflicting facts each keep their own — the engine's exact/algebraic stance.
const freeVars = new Set<Node>();
function free(c: Node): void {
  freeVars.add(c);
}

// ── partition cache: groupOf(node), rebuilt only when graphGen changes ──
//
// This is the WHOLE of the "is this cell in a cycle" question — a side table
// keyed by node identity, recomputed lazily. No flag is ever written onto a
// cell. (Real engine: replace this whole-graph Tarjan with the incremental
// DynCondensation; the lookup shape is the same.)
let partGen = -1;
let groupOf = new Map<Node, Node[]>();

function partition(): void {
  if (partGen === graphGen) return;
  partGen = graphGen;
  // Relation edges: u→v whenever a rule reads u and writes v. PLUS each lens's
  // structural edge parent→child (a lens reads its parent), so lens-coupled
  // cells condense together — exactly relate.ts's `registerLensParents`.
  const succ = new Map<Node, Set<Node>>();
  const nodes = new Set<Node>();
  const touch = (n: Node) => {
    nodes.add(n);
    if (!succ.has(n)) succ.set(n, new Set());
  };
  for (const r of rules) {
    for (const u of r.reads) {
      touch(u);
      for (const v of r.writes) {
        touch(v);
        succ.get(u)!.add(v);
      }
    }
    for (const v of r.writes) touch(v);
  }
  // Fold lens parent edges for every node currently known to the graph.
  for (const n of [...nodes]) {
    if (n.parent !== undefined) {
      touch(n.parent);
      succ.get(n.parent)!.add(n);
    }
  }
  groupOf = tarjan(nodes, succ);
}

/** Tiny iterative Tarjan → map each node to its SCC member list (the real
 *  engine uses the incremental DynCondensation; same output shape). */
function tarjan(nodes: Set<Node>, succ: Map<Node, Set<Node>>): Map<Node, Node[]> {
  let idx = 0;
  const index = new Map<Node, number>();
  const low = new Map<Node, number>();
  const onStack = new Set<Node>();
  const stack: Node[] = [];
  const out = new Map<Node, Node[]>();

  for (const start of nodes) {
    if (index.has(start)) continue;
    // explicit work stack: frames are (node, iterator over successors)
    const work: { n: Node; it: Iterator<Node> }[] = [];
    const push = (n: Node) => {
      index.set(n, idx);
      low.set(n, idx);
      idx++;
      stack.push(n);
      onStack.add(n);
      work.push({ n, it: (succ.get(n) ?? new Set()).values() });
    };
    push(start);
    while (work.length > 0) {
      const frame = work[work.length - 1]!;
      const { n } = frame;
      let advanced = false;
      for (let step = frame.it.next(); !step.done; step = frame.it.next()) {
        const w = step.value;
        if (!index.has(w)) {
          push(w);
          advanced = true;
          break;
        }
        if (onStack.has(w)) low.set(n, Math.min(low.get(n)!, index.get(w)!));
      }
      if (advanced) continue;
      if (low.get(n) === index.get(n)) {
        const comp: Node[] = [];
        for (;;) {
          const w = stack.pop()!;
          onStack.delete(w);
          comp.push(w);
          if (w === n) break;
        }
        for (const c of comp) out.set(c, comp);
      }
      work.pop();
      if (work.length > 0) {
        const parent = work[work.length - 1]!.n;
        low.set(parent, Math.min(low.get(parent)!, low.get(n)!));
      }
    }
  }
  return out;
}

// ── THE read path — the one entry point ──────────────────────────────
//
// Compare to today's `Cell.value` getter: the only addition for a NON-knowledge
// cell is reaching the `lattice === undefined` branch (one field test), then the
// ordinary source/lens read. Knowledge cells pay a group lookup.
function read(n: Node): unknown {
  if (n.lattice === undefined) {
    return n.getter !== undefined ? n.getter() : n.value; // degenerate path
  }
  partition();
  const group = groupOf.get(n);
  if (group === undefined || group.length === 1) {
    // Singleton knowledge cell: it IS itself — a source returns its standing,
    // a lens its forward. THIS is where `relax` used to be needed: a cell that
    // left its last relation is simply a singleton now. Nothing was toggled.
    return n.getter !== undefined ? n.getter() : n.value;
  }
  solveGroup(group);
  return n.value; // published in-place by solveGroup
}

// ── the group solve (the fixpoint), writing results back onto the cells ──
function solveGroup(members: Node[]): void {
  const n = members.length;
  const idx = new Map<Node, number>();
  members.forEach((m, i) => idx.set(m, i));
  const lat = (m: Node) => m.lattice as Lat;
  const work = new Array<unknown>(n);
  const fb = new Array<unknown>(n);

  // External read: a cell outside the group, lifted via its lattice (or its raw
  // value). Members read their in-progress knowledge.
  const get = (c: Node): unknown => {
    const i = idx.get(c);
    if (i !== undefined) return work[i];
    const l = c.lattice;
    return l ? l.abstract(read(c)) : read(c);
  };
  const emit = (c: Node, k: unknown): void => {
    const i = idx.get(c);
    if (i === undefined) return;
    const l = lat(c);
    const next = l.meet(work[i], k);
    work[i] = next;
  };

  // Seed: a lens whose parent is a fellow member is DERIVED (seed ⊤, frozen
  // fallback) — its lifted rule fills it. Otherwise seed from the cell's own
  // intrinsic value (source standing, or lens forward via its getter).
  const derived = members.map(m => m.parent !== undefined && idx.has(m.parent));
  // Collect the rules that write into this group, plus lifted lens rules.
  const groupRules: Rule["body"][] = [];
  for (const r of rules) if (r.writes.some(w => idx.has(w))) groupRules.push(r.body);
  members.forEach((m, i) => {
    if (derived[i] && m.fwd !== undefined) liftLens(m, idx, groupRules);
  });

  for (let i = 0; i < n; i++) {
    const m = members[i]!;
    const l = lat(m);
    if (derived[i]) {
      work[i] = l.top; // lens fills it via its lifted rule
      fb[i] = m.value;
      continue;
    }
    const seed = m.getter !== undefined ? m.getter() : m.value;
    // Free ⇒ no fact (seed ⊤, narrow toward constraints); else the seed is a
    // hard fact folded by meet. Either way `seed` is the concretize fallback.
    work[i] = freeVars.has(m) ? l.top : l.abstract(seed);
    fb[i] = seed;
  }

  // Naive fold to a fixpoint (the real engine uses the freshness-gated
  // worklist; for the prototype, run-to-stable is enough to judge the shape).
  for (let pass = 0; pass < 1000; pass++) {
    let changed = false;
    for (const body of groupRules) {
      const before = work.slice();
      body(get, emit);
      for (let i = 0; i < n; i++) {
        if (!lat(members[i]!).equals(before[i], work[i])) changed = true;
      }
    }
    if (!changed) break;
  }

  for (let i = 0; i < n; i++) members[i]!.value = lat(members[i]!).concretize(work[i], fb[i]);
}

/** Lift an in-cycle Iso lens (`child = fwd(parent)`) into two band-mapping K
 *  rules — the prototype's `liftLens`, using the lattice's `image`. */
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

function scenarioFreeRing(): void {
  console.log("• free narrowing ring: a=7 (fact), free b,c; equal(a,b),(b,c)");
  const a = source(7, flat() as unknown as Lat);
  const b = source(0, flat() as unknown as Lat);
  const c = source(0, flat() as unknown as Lat);
  free(b);
  free(c);
  equal(a, b);
  equal(b, c);
  // The SCC {a,b,c} solves on read: a's fact meets free b,c ⇒ all 7. No
  // Component node, no _region — `read` looked the group up and solved in place.
  check("read a", read(a), 7);
  check("read b (free) narrows to a", read(b), 7);
  check("read c (free) narrows to a", read(c), 7);
}

function scenarioConflictKeepsOwn(): void {
  console.log("• meet semantics: two conflicting FACTS each keep their own");
  const a = source(7, flat() as unknown as Lat);
  const b = source(5, flat() as unknown as Lat); // NOT free ⇒ a hard fact
  equal(a, b); // 7 ⊓ 5 = ⊥ ⇒ each falls back to its own standing
  check("a keeps 7", read(a), 7);
  check("b keeps 5", read(b), 5);
}

function scenarioAcyclicLens(): void {
  console.log("• degenerate path: a lens NOT in a cycle just reads via its getter");
  const a = source(5, interval as unknown as Lat);
  const b = isoLens(a, t => t * 2, t => t / 2); // b = 2a, singleton
  // b has a lattice but is a singleton SCC ⇒ `read` takes the getter path, no
  // solve. This is the "lenses keep their speed in the common case" claim.
  check("b reads 10 via getter (no solve)", read(b), 10);
}

function scenarioRelaxFree(): void {
  console.log("• teardown WITHOUT relax(): dispose rules ⇒ cells are singletons again");
  const a = source(3, flat() as unknown as Lat);
  const b = source(99, flat() as unknown as Lat);
  free(b); // while related, b narrows to a
  const undo = equal(a, b);
  check("while related, b narrows to a", read(b), 3);
  // Drop the relation. NO relax() call anywhere — just remove the rules.
  undo();
  freeVars.delete(b);
  b.value = 42; // b is its own plain source again
  check("after teardown, b keeps its OWN standing", read(b), 42);
  check("after teardown, a keeps its OWN standing", read(a), 3);
}

console.log("\n=== unified-node prototype ===\n");
scenarioFreeRing();
scenarioConflictKeepsOwn();
scenarioAcyclicLens();
scenarioRelaxFree();
console.log(`\n${failures === 0 ? "ALL PASS" : `${failures} FAILED`}\n`);

// ── RESIDUE: what the real engine adds back, and what it does NOT ─────
//
// Adds back (the "good part of Component", as an INTERNAL memo — never a
// user-facing node, never a per-cell mode):
//   • per-group cache: skip re-solving when nothing the group reads changed
//     (here we re-solve every read);
//   • external-dep tracking + a version, so a downstream group re-solves when
//     an upstream member changes (cross-group glitch-freedom). In the real
//     engine this rides the existing dep/sub graph: the group's solve is a pull
//     that links its external reads, exactly like a computed.
//   • the incremental DynCondensation instead of whole-graph Tarjan.
//
// Does NOT add back:
//   • `_region` — membership stays a `groupOf` lookup, never a cell field.
//   • `relax` — leaving a relation is a smaller partition, observed on read.
//   • `owner`/`Component.dispose` — the group memo is keyed by the partition
//     entry and dies with it; relate never hand-wires or frees engine nodes.
