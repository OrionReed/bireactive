// relate.ts — first-class cyclic relationships over knowledge cells.
//
// You declare relationships DIRECTLY as plain functions over lattice cells —
// no `network()` handle, no `solve()` wrapper. Any subset of cells may
// participate in a cycle; the engine partitions the relational graph into
// SCCs and solves each as a unit.
//
// Integration thesis — "an SCC is a generalized COMPUTED" (taken literally):
//   • The relational graph is condensed (incrementally) into SCCs.
//   • Each SCC becomes ONE internal computed `G` (the solver) that, when
//     PULLED, reads the component's inputs (externals + each member's base
//     assertion) and solves the component to a lattice fixpoint.
//   • Each member stays the SAME cell the user created, but becomes a
//     writable PROJECTION of `G`: reading it pulls `G` (lazy, glitch-free,
//     in dependency order — the ordinary computed path); writing it flows to
//     its base assertion, which `G` reads, so a write re-invalidates and the
//     next read re-solves. No member is ever split into input/output cells.
//   • Cross-component ordering is automatic and pull-driven: a downstream
//     SCC's solver reads an upstream member, so pulling it pulls the upstream
//     solver first. The forward engine's lazy pull IS the scheduler.
//
// Why pull, not push: a computed is glitch-free because it's pulled and
// validated on read; an effect is pushed and can run stale (and re-run).
// Modelling the solver as a computed inherits the engine's glitch-freedom
// for free, runs each component once per settle, and is indifferent to
// whether effects are flushed synchronously or on a microtask.
//
// Cost isolation: a plain cell has no lattice and joins no relation, so it
// never touches any of this. Only declared cyclic regions pay, and each
// solve is bounded to its own component.

import {
  becomeMember,
  type Cell,
  captureBase,
  disposeInternalComputed,
  internalComputed,
  type Lattice,
  resignMember,
} from "./cell";
import { DynCondensation } from "./condense";

// biome-ignore lint/suspicious/noExplicitAny: heterogeneous relation graph
type AnyCell = Cell<any>;

/** A cell's lattice, declared as a static on its value CLASS
 *  (`Range.lattice`, `Box.lattice`, `Flags.lattice`, …) and resolved here
 *  only when needed — never stored on the cell, never overriding its
 *  `equals`. `undefined` ⇒ a plain cell that can't be a relation member (it
 *  only ever acts as an external input feeding a component). */
function latticeOf(c: AnyCell): Lattice<unknown> | undefined {
  return (c.constructor as { lattice?: Lattice<unknown> }).lattice;
}

/** A relation rule: reads cells, writes (narrows) cells. `body` reads via
 *  `get` and contributes via `emit`; the solver folds emissions by `meet`. */
export type RelationBody = (get: <T>(c: Cell<T>) => T, emit: <T>(c: Cell<T>, v: T) => void) => void;

interface Rule {
  readonly reads: readonly AnyCell[];
  readonly writes: readonly AnyCell[];
  readonly body: RelationBody;
}

/** Safety bound for slow-converging real-interval cycles. Finite lattices
 *  reach a fixpoint well before this; never throws — a stalled run holds a
 *  sound over-approximation. */
const MAX_WAVES = 10_000;

// ── module scheduler state ──────────────────────────────────────────

const cond = new DynCondensation<AnyCell>();
/** Rules that WRITE each cell — the per-component rule index. */
const rulesByMember = new Map<AnyCell, Rule[]>();
/** Reference counts per dataflow edge r→w. The condensation holds an edge
 *  iff ≥1 rule induces it, so disposing one of several parallel rules
 *  doesn't wrongly drop the edge (and trigger a spurious split). */
const edgeRefs = new Map<AnyCell, Map<AnyCell, number>>();

function addEdgeRef(r: AnyCell, w: AnyCell): void {
  let m = edgeRefs.get(r);
  if (m === undefined) edgeRefs.set(r, (m = new Map()));
  const n = m.get(w) ?? 0;
  m.set(w, n + 1);
  if (n === 0) cond.addEdge(r, w);
}

function removeEdgeRef(r: AnyCell, w: AnyCell): void {
  const m = edgeRefs.get(r);
  if (m === undefined) return;
  const n = m.get(w) ?? 0;
  if (n <= 1) {
    m.delete(w);
    cond.removeEdge(r, w);
  } else {
    m.set(w, n - 1);
  }
}

interface Group {
  /** The internal solver computed for this SCC. */
  readonly g: Cell<number>;
  readonly members: readonly AnyCell[];
}
/** Which live SCC group currently owns each member, so a topology change
 *  rebuilds ONLY the components it actually touched. */
const owner = new Map<AnyCell, Group>();

/** A knowledge cell's standing self-assertion, held as a real source cell so
 *  the solver depends on it (a write re-invalidates) and so a member that
 *  leaves every relation can relax back to it. Created — capturing the cell's
 *  current value — the first time the cell becomes a relation member, while
 *  it is still a plain source. */
const baseOf = new Map<AnyCell, AnyCell>();

/** Re-assert a knowledge cell's standing value. While the cell is a member
 *  this writes its base (re-invalidating its region); otherwise it writes
 *  the cell directly. Plain `cell.value = …` does the same — `assert` is
 *  just the explicit spelling. */
export function assert<T>(c: Cell<T>, value: T): void {
  const b = baseOf.get(c);
  if (b !== undefined) (b as Cell<T>)._writeSource(value);
  else (c as Cell<T>)._writeSource(value);
}

/** Declare a relationship. Registers the rule + its dataflow edges and
 *  (re)compiles the affected SCCs. Live immediately — no wrapper. */
export function constrain(
  reads: readonly AnyCell[],
  writes: readonly AnyCell[],
  body: RelationBody,
): () => void {
  const rule: Rule = { reads, writes, body };
  for (const w of writes) {
    // Capture the standing-assertion channel the first time `w` becomes a
    // member — while it still holds its original identity. For a source that's
    // a value snapshot; for a lens it's a clone of the lens (so upstream flows
    // in and writes flow back through it). See `captureBase`.
    if (latticeOf(w) !== undefined && !baseOf.has(w)) baseOf.set(w, captureBase(w));
    const rs = rulesByMember.get(w);
    if (rs === undefined) rulesByMember.set(w, [rule]);
    else rs.push(rule);
    cond.addNode(w);
    for (const r of reads) addEdgeRef(r, w);
  }
  recompile(writes);
  return () => disposeRule(rule);
}

/** Remove a relationship: drop its rule + edges. A removed edge may SPLIT an
 *  SCC (the condensation resplits locally); the affected components are
 *  rebuilt incrementally, same as for a join. */
function disposeRule(rule: Rule): void {
  for (const w of rule.writes) {
    const rs = rulesByMember.get(w);
    if (rs !== undefined) {
      const i = rs.indexOf(rule);
      if (i >= 0) rs.splice(i, 1);
      if (rs.length === 0) rulesByMember.delete(w);
    }
    for (const r of rule.reads) removeEdgeRef(r, w);
  }
  recompile(rule.writes);
}

// ── incremental compilation: one solver computed per SCC ────────────
//
// A topology change rebuilds ONLY the components it touched. `affected` =
// the cells the condensation re-grouped (merges via window-recondense,
// splits via resplit) plus the cells the new/removed rule writes. Every
// group owning an affected cell is torn down, then each distinct current
// component over the affected region is rebuilt — so merges (N groups → 1)
// and splits (1 group → N) both fall out correctly. No `batch` wrapper: the
// engine hooks (`becomeMember`/`resignMember`) schedule any watching effects
// onto the microtask, which coalesces them into one run.

function recompile(writes: readonly AnyCell[]): void {
  const affected = cond.drainDirty();
  for (const w of writes) affected.add(w);

  const reps = new Set<AnyCell>();
  const orphans = new Set<AnyCell>();
  for (const n of affected) {
    const g = owner.get(n);
    if (g !== undefined) {
      disposeInternalComputed(g.g);
      for (const m of g.members) {
        owner.delete(m);
        orphans.add(m);
      }
    }
    reps.add(cond.component(n));
  }
  for (const rep of reps) buildGroup(rep);

  // A cell that lost its last rule (no longer owned by any group) relaxes
  // back to its standing assertion as a plain source.
  for (const m of orphans) {
    if (!owner.has(m)) {
      const b = baseOf.get(m);
      if (b !== undefined) resignMember(m, b);
    }
  }
}

function buildGroup(rep: AnyCell): void {
  const members = cond.membersOf(rep).filter(c => latticeOf(c) !== undefined);
  if (members.length === 0) return;

  const memberSet = new Set(members);
  const ruleSet = new Set<Rule>();
  for (const m of members) for (const r of rulesByMember.get(m) ?? []) ruleSet.add(r);
  if (ruleSet.size === 0) return; // no rules → nothing to solve; relax as orphan
  const compRules = [...ruleSet];

  // The solver's output, filled on each pull and read by member projections.
  const solved = new Map<AnyCell, unknown>();
  let version = 0;
  // A member's assertion (a lens's `base`) may read a FELLOW member of this
  // same component — relating `p.shift(k)` to `p`, say. That re-enters this
  // very solver mid-fixpoint, which the engine reports as "read its own
  // value". The propagator fold can't see the lens transfer-function to solve
  // such a region, so we surface a CLEAR domain error instead of the engine's
  // internal one. (Any self-read DURING a solve is precisely this case.)
  const g = internalComputed<number>(() => {
    try {
      solveInto(solved, members, memberSet, compRules);
    } catch (e) {
      if (e instanceof RangeError)
        throw new Error(
          "relate: relation cycle through a lens — a member's assertion " +
            "depends on a fellow member it derives from. A lens and a cell it " +
            "reads cannot both be members of the same relation; relate their " +
            "shared source instead.",
        );
      throw e;
    }
    return ++version;
  });

  const group: Group = { g, members };
  for (const m of members) {
    owner.set(m, group);
    becomeMember(
      m,
      () => {
        void g.value; // pull the solver (lazy fixpoint, in dependency order)
        return solved.get(m);
      },
      baseOf.get(m)!,
    );
  }
}

/** Solve one component to a lattice fixpoint, storing each member's result.
 *  Runs inside the solver computed `g`, so every input read here — externals
 *  via `get`, each member's base — becomes a dependency of `g`, and any of
 *  them changing re-invalidates the whole component. Recomputes from base
 *  each pull (sound when inputs relax). */
function solveInto(
  solved: Map<AnyCell, unknown>,
  members: AnyCell[],
  memberSet: Set<AnyCell>,
  compRules: Rule[],
): void {
  const lat = new Map<AnyCell, Lattice<unknown>>();
  const work = new Map<AnyCell, unknown>();
  for (const m of members) {
    lat.set(m, latticeOf(m)!);
    work.set(m, baseOf.get(m)!.value); // tracked: solver depends on the base
  }

  // Members read from the work map (no dependency — internal to the solve);
  // externals read live via `.value` (tracked → solver depends on them, and
  // an external that is itself another SCC's member pulls that solve first).
  const get = <T>(c: Cell<T>): T => (memberSet.has(c) ? (work.get(c) as T) : c.value);
  const emit = <T>(c: Cell<T>, v: T): void => {
    if (!memberSet.has(c)) return;
    work.set(c, lat.get(c)!.meet(work.get(c), v));
  };

  let waves = 0;
  let moved = true;
  while (moved && waves < MAX_WAVES) {
    waves++;
    moved = false;
    const before = new Map(work);
    for (const r of compRules) r.body(get, emit);
    for (const m of members) {
      if (!lat.get(m)!.equals(before.get(m), work.get(m))) moved = true;
    }
  }

  solved.clear();
  for (const m of members) solved.set(m, work.get(m));
}

// ── interval combinators (declared directly, no wrapper) ────────────

/** a = b — both narrow to the intersection. */
export function equal<T>(a: Cell<T>, b: Cell<T>): () => void {
  const d1 = constrain([a], [b], (get, emit) => emit(b, get(a)));
  const d2 = constrain([b], [a], (get, emit) => emit(a, get(b)));
  return () => {
    d1();
    d2();
  };
}
