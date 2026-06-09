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
  Cell,
  Component,
  captureBase,
  isLens,
  type Lattice,
  type RelationBody,
  relaxToBase,
} from "./cell";
import { DynCondensation } from "./condense";

export type { RelationBody } from "./cell";

// biome-ignore lint/suspicious/noExplicitAny: heterogeneous relation graph
type AnyCell = Cell<any>;

/** A cell's lattice, declared as a static on its value CLASS
 *  (`Range.lattice`, `Box.lattice`, `Flags.lattice`, …) and resolved here
 *  only when needed — never stored on the cell, never overriding its
 *  `equals`. `undefined` ⇒ a plain cell that can't be a relation member (it
 *  only ever acts as an external input feeding a component). */
function latticeOf(c: AnyCell): Lattice<unknown, unknown> | undefined {
  return (c.constructor as { lattice?: Lattice<unknown, unknown> }).lattice;
}

interface Rule {
  readonly reads: readonly AnyCell[];
  readonly writes: readonly AnyCell[];
  readonly body: RelationBody;
}

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

/** Register the LENS-STRUCTURE edges of a member into the condensation.
 *
 *  A lens member reads its parent(s), a dataflow dependency the relation graph
 *  must see: otherwise two components coupled only through a lens channel form
 *  a cycle the condensation can't detect (it tracks only relation edges) and
 *  they oscillate — invalidating each other across settles forever. Folding
 *  the lens edges in keeps the condensation a true DAG: cells genuinely cycled
 *  through lenses land in ONE SCC and solve together.
 *
 *  Walks the whole lens chain (parent → child for each link), held through the
 *  permanent `edgeRefs` count and NEVER removed — the lens structure is fixed
 *  for the cell's life. Anonymous intermediate lenses become condensation
 *  nodes but never solve (no base; `buildGroup` filters them out). Must run
 *  while `m` still holds its original identity (before it is re-wired). */
function registerLensParents(m: AnyCell): void {
  const seen = new Set<AnyCell>();
  const visit = (child: AnyCell): void => {
    if (seen.has(child) || !isLens(child)) return;
    seen.add(child);
    const parent = child._bwd!.parent;
    const parents = parent instanceof Cell ? [parent] : Array.isArray(parent) ? parent : [];
    for (const p of parents) {
      const pc = p as AnyCell;
      cond.addNode(pc);
      addEdgeRef(pc, child); // p → child: child reads p
      // Give every cell in the chain a base, so an INTERMEDIATE lens that
      // lands inside an SCC solves as a real member (the chain folds in
      // K-space via constraint transformers) instead of being skipped and
      // re-entering the solve through a live `.value` read. Capture now, while
      // the chain still holds its original identity. A cell that never enters
      // a cycle keeps its base unused (it solves nothing — a plain channel).
      if (latticeOf(pc) !== undefined && !baseOf.has(pc)) baseOf.set(pc, captureBase(pc));
      visit(pc);
    }
  };
  visit(m);
}

interface Group {
  /** The first-class solver node for this SCC. */
  readonly comp: Component;
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
    // in and writes flow back through it). See `captureBase`. Also fold the
    // lens's structural read-edges into the condensation so lens-coupled
    // regions condense into one SCC instead of oscillating across components.
    if (latticeOf(w) !== undefined && !baseOf.has(w)) {
      baseOf.set(w, captureBase(w));
      registerLensParents(w);
    }
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

// ── incremental compilation: one Component per cyclic SCC ───────────
//
// A topology change rebuilds ONLY the components it touched. `affected` =
// the cells the condensation re-grouped (merges via window-recondense,
// splits via resplit) plus the cells the new/removed rule writes. Every
// group owning an affected cell is disposed, then each distinct current
// component over the affected region is rebuilt — so merges (N groups → 1)
// and splits (1 group → N) both fall out correctly. The `Component` node and
// its member projections run through the normal dep/sub graph, so any
// watching effects are scheduled onto the microtask and coalesced.

function recompile(writes: readonly AnyCell[]): void {
  const affected = cond.drainDirty();
  for (const w of writes) affected.add(w);

  const reps = new Set<AnyCell>();
  const orphans = new Set<AnyCell>();
  for (const n of affected) {
    const g = owner.get(n);
    if (g !== undefined) {
      g.comp.dispose();
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
      if (b !== undefined) relaxToBase(m, b);
    }
  }
}

function buildGroup(rep: AnyCell): void {
  // Real members carry a base (set when they became a write-member). Lens
  // parents pulled in only as condensation nodes (for SCC detection) have a
  // lattice but no base — they're channels into the component, not solved.
  const members = cond.membersOf(rep).filter(c => baseOf.has(c));
  if (members.length === 0) return;

  const memberSet = new Set(members);
  const ruleSet = new Set<Rule>();
  for (const m of members) for (const r of rulesByMember.get(m) ?? []) ruleSet.add(r);
  if (ruleSet.size === 0) return; // no rules → nothing to solve; relax as orphan

  const bases = members.map(m => baseOf.get(m)!);
  const lattices = members.map(m => latticeOf(m)!);
  const bodies: RelationBody[] = [...ruleSet].map(r => r.body);
  const derived = members.map(() => false);
  const fallbacks = new Array<unknown>(members.length);

  // A lens member whose PARENT is a fellow member is a constraint lens (the
  // "both sides in the component" case): its base reads the parent, so seeding
  // or falling back through it would re-enter the solve. Mark it DERIVED — seed
  // ⊤, fall back to its frozen value — and (for a single-parent invertible
  // lens) lift the lens into forward/backward knowledge transformers so the
  // relationship is honoured inside the cycle. A lens whose parent is OUTSIDE
  // stays a plain channel (today's behaviour); a lens by itself isn't a
  // constraint. See `unified-relations.md` §4–5.
  members.forEach((m, i) => {
    const base = bases[i];
    if (!isLens(base)) return;
    const bw = base._bwd!;
    const parent = bw.parent;
    const singleMemberParent = parent instanceof Cell && memberSet.has(parent);
    const multiMemberParent = Array.isArray(parent) && parent.some(p => memberSet.has(p));
    if (!singleMemberParent && !multiMemberParent) return; // channel: parent external

    derived[i] = true;
    // Frozen fallback = the lens's current forward value, read through its own
    // base (the live clone over the ORIGINAL parent). If that read can't be
    // evaluated mid-rewire (a parent in flux), fall back to the member's last
    // cached value — always a well-formed `T`.
    try {
      fallbacks[i] = base.peek();
    } catch {
      fallbacks[i] = m.peek();
    }

    if (singleMemberParent && bw.fwd !== undefined) {
      const p = parent as AnyCell;
      const latM = lattices[i]!;
      const latP = latticeOf(p)!;
      const fwd = bw.fwd;
      // forward: m ⊒ F(parent), once the parent's knowledge pins a value.
      bodies.push((get, emit) => {
        const pv = latP.pinned(get(p));
        if (pv !== undefined) emit(m, latM.abstract(fwd(pv)));
      });
      // backward: parent ⊒ B(m) for a source-INDEPENDENT inverse (1-arg `put`:
      // shift/scale/affine/add/not/xor — the homomorphisms). A source-reading
      // inverse (field spread-replace, clamp) abstains backward, still sound.
      const put = bw.put;
      if (put !== undefined && !bw.readsSource) {
        bodies.push((get, emit) => {
          const mv = latM.pinned(get(m));
          if (mv !== undefined) emit(p, latP.abstract(put(mv)));
        });
      }
    }
  });

  // The Component constructor projects each member onto its solved slot.
  const comp = new Component(members, bases, lattices, bodies, derived, fallbacks);
  const group: Group = { comp, members };
  for (const m of members) owner.set(m, group);
}

// ── relation combinators (declared directly, no wrapper) ────────────

/** a = b — each cell's knowledge meets the other's (their common refinement
 *  in the lattice). Knowledge flows both ways; conflicting concretes give a
 *  contradiction (`isBottom`). */
export function equal<T>(a: Cell<T>, b: Cell<T>): () => void {
  const ca = a as Cell<unknown>;
  const cb = b as Cell<unknown>;
  const d1 = constrain([a], [b], (get, emit) => emit(cb, get(ca)));
  const d2 = constrain([b], [a], (get, emit) => emit(ca, get(cb)));
  return () => {
    d1();
    d2();
  };
}
