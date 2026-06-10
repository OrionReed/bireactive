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
  beginRegionBuild,
  bumpTopoGen,
  type Cell,
  type CompiledRule,
  Component,
  endRegionBuild,
  isLens,
  isReadonly,
  type Lattice,
  markRelational,
  parentsOf,
  refireCells,
  regionGen,
  type RelationBody,
  setRegionResolver,
} from "./cell";
import { DynCondensation } from "./condense";

export type { RelationBody } from "./cell";

// biome-ignore lint/suspicious/noExplicitAny: heterogeneous relation graph
type AnyCell = Cell<any>;

// ── interval-knowledge helpers (the two-way numeric contractors) ──
const NINF = Number.NEGATIVE_INFINITY;
const PINF = Number.POSITIVE_INFINITY;
interface Iv {
  readonly min: number;
  readonly max: number;
}
const iv = (k: unknown): Iv => k as Iv;

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
/** Rules that WRITE each cell — the per-component rule index. The
 *  condensation itself refcounts edges (several rules, or a rule plus a lens's
 *  structural edge, may induce the same r→w), so there is no parallel edge
 *  store here: `constrain`/`disposeRule` just add/remove each rule's edges. */
const rulesByMember = new WeakMap<AnyCell, Rule[]>();

/** Register the LENS-STRUCTURE edges of a member into the condensation.
 *
 *  A lens member reads its parent(s), a dataflow dependency the relation graph
 *  must see: otherwise two components coupled only through a lens channel form
 *  a cycle the condensation can't detect (it tracks only relation edges) and
 *  they oscillate — invalidating each other across settles forever. Folding
 *  the lens edges in keeps the condensation a true DAG: cells genuinely cycled
 *  through lenses land in ONE SCC and solve together.
 *
 *  Walks the whole lens chain (parent → child for each link), added as a
 *  permanent edge in `cond` (refcounted, never removed — the lens structure is
 *  fixed for the cell's life; rule edges come and go on top of it). Anonymous
 *  intermediate lenses become condensation nodes but never solve (unmarked;
 *  `buildComponent` filters them out). */
function registerLensParents(m: AnyCell): void {
  const seen = new Set<AnyCell>();
  const visit = (child: AnyCell): void => {
    if (seen.has(child) || !isLens(child)) return;
    seen.add(child);
    for (const p of parentsOf(child)) {
      const pc = p as AnyCell;
      cond.addNode(pc);
      cond.addEdge(pc, child); // p → child: child reads p (permanent lens edge)
      // Mark every cell in the chain a member, so an INTERMEDIATE lens that
      // lands inside an SCC solves as a real member (the chain folds in
      // K-space via constraint transformers) instead of being skipped and
      // re-entering the solve through a live `.value` read. A cell that never
      // enters a cycle keeps the mark unused (it solves nothing — a plain
      // channel).
      if (latticeOf(pc) !== undefined) {
        memberCells.add(pc);
        markRelational(pc); // a lens parent can be a real member too
      }
      visit(pc);
    }
  };
  visit(m);
}

/** Materialized SCC solvers, keyed by condensation REPRESENTATIVE. The membership
 *  source of truth is `cond`; this is just the lazily-built solver cache for each
 *  cyclic region. An entry is born on the first read of any member (`resolveRegion`)
 *  and retired when its rep merges/splits or its rules change (`recompile`). A
 *  region declared but never read never appears here — so N incremental `constrain`
 *  calls don't rebuild a growing region N times. */
const regions = new Map<AnyCell, Component>();

/** Cells that are relation members (write-targets, plus lens-chain cells folded
 *  in for SCC detection). A pure membership MARKER: the standing assertion
 *  itself lives natively on the member (its `pendingValue`, or — for a lens
 *  member — its retained `_rel` + intrinsic forward getter), not in a side
 *  table. Used to tell a real member apart from a read-only external that merely
 *  shares the condensation graph. */
const memberCells = new WeakSet<AnyCell>();

/** Cells declared FREE variables (`free`): they carry no standing fact, so a
 *  component seeds them ⊤ and lets the interval contractors determine them. */
const freeVars = new WeakSet<AnyCell>();

/** Declare `c` a FREE variable. Without this a cell's current value is a FACT
 *  and an inequality that excludes it is a contradiction (notes §7a), so the
 *  contractors only validate consistency — they never narrow. A free variable
 *  is seeded ⊤ instead, with its value kept as the SOFT fallback (its preferred
 *  value when the constraints leave it underdetermined): `bound(x, 3, ∞)` then
 *  pulls `x = 0` up to `3` but leaves `x = 8` alone, and the band flows on
 *  through `order`/`add`/`total`. Re-declarable any time; takes effect on the
 *  next solve. The soft-constraint (preferred-value) propagator model. */
export function free<T>(c: Cell<T>): void {
  freeVars.add(c as AnyCell);
}

/** Re-assert a knowledge cell's standing value. While the cell is a member this
 *  re-seeds its standing and re-invalidates its region (a source member) or
 *  routes upstream through its lens (a lens member); otherwise it writes the
 *  cell directly. Plain `cell.value = …` does the same — `assert` is just the
 *  explicit spelling. */
export function assert<T>(c: Cell<T>, value: T): void {
  (c as { value: T }).value = value;
}

/** Resolve which region a member belongs to RIGHT NOW (the engine's lazy read
 *  path calls this via `setRegionResolver`). Returns the region for a cyclic
 *  SCC — building it on demand and caching by representative — or `undefined`
 *  for a singleton (⇒ the member reads degenerately; the implicit "left the
 *  relation" path). The region materializes here, on first read, NOT eagerly at
 *  `constrain` time. */
/** Reps whose region is mid-build — breaks the recursion when the `Component`
 *  ctor samples a co-member's value (which would otherwise re-enter here for the
 *  same rep). A re-entrant resolve reads the member intrinsically instead. */
const building = new Set<AnyCell>();

function resolveRegion(m: AnyCell): Component | undefined {
  const rep = cond.representative(m);
  if (building.has(rep)) return undefined; // mid-build ⇒ intrinsic read
  const g = regions.get(rep);
  if (g !== undefined && !g.disposed && g.builtGen === regionGen()) return g;
  if (g !== undefined && !g.disposed) g.dispose(); // stale structure ⇒ rebuild
  // Build whenever this group has solvable members with rules — a singleton
  // forward constraint (acyclic `narrow`) is a 1-member region, exactly like a
  // cyclic SCC. `buildRegion` returns `undefined` when the group has no rules
  // (a pure channel, or a member that lost its last rule) ⇒ degenerate read.
  building.add(rep);
  beginRegionBuild();
  try {
    return buildRegion(rep);
  } finally {
    building.delete(rep);
    endRegionBuild();
  }
}
setRegionResolver(resolveRegion as (m: Cell<unknown>) => Component | undefined);

/** Declare a relationship. Registers the rule + its dataflow edges and bumps the
 *  topology generation. No region is built here: affected regions re-derive
 *  lazily on the next read (`resolveRegion`). Live immediately — no wrapper. */
export function constrain(
  reads: readonly AnyCell[],
  writes: readonly AnyCell[],
  body: RelationBody,
): () => void {
  const rule: Rule = { reads, writes, body };
  for (const w of writes) {
    // A READ-ONLY cell (`derive`: a getter with no backward path) is fixed by
    // definition — it can contribute its value as an INPUT wherever a rule reads
    // it, but it can never be narrowed or written, so it never becomes a member/
    // governed view. Skip it as a write-target: a rule emitting to it simply
    // no-ops (it's in no region's index), and its value still flows in through
    // every `reads` edge. This keeps its lazy getter read-path intact rather than
    // overriding it with a projection that only ever re-derives the same value.
    if (isReadonly(w)) continue;
    // Mark `w` a relation member. `markRelational` flips it onto the lazy
    // region-resolution read path (idempotent, so it's safe even if `w` was
    // already pulled in as a lens parent). Its standing assertion lives natively
    // on the cell (see `memberCells`). The first time, also fold the lens's
    // structural read-edges into the condensation so lens-coupled regions
    // condense into one SCC instead of oscillating across regions.
    if (latticeOf(w) !== undefined) {
      markRelational(w);
      if (!memberCells.has(w)) {
        memberCells.add(w);
        registerLensParents(w);
      }
    }
    const rs = rulesByMember.get(w);
    if (rs === undefined) rulesByMember.set(w, [rule]);
    else rs.push(rule);
    cond.addNode(w);
    for (const r of reads) cond.addEdge(r, w);
  }
  recompile(writes);
  return () => disposeRule(rule);
}

/** Remove a relationship: drop its rule + edges. A removed edge may SPLIT an
 *  SCC (the condensation resplits locally); affected regions re-derive lazily on
 *  the next read, same as for a join. */
function disposeRule(rule: Rule): void {
  for (const w of rule.writes) {
    const rs = rulesByMember.get(w);
    if (rs !== undefined) {
      const i = rs.indexOf(rule);
      if (i >= 0) rs.splice(i, 1);
      if (rs.length === 0) rulesByMember.delete(w);
    }
    for (const r of rule.reads) cond.removeEdge(r, w);
  }
  recompile(rule.writes);
}

// ── lazy compilation: regions materialize on read, retire on edit ───
//
// A topology edit does NOT rebuild anything. It only retires the ALREADY-
// MATERIALIZED regions it disturbed (a region exists only if some member was
// read) and bumps the generation so caches re-resolve. Each disturbed region
// refires its linked members (so watching effects re-pull) and unlinks its
// inputs; the new grouping then re-derives on the next read of any member. So
// the cost of an edit is proportional to the regions actually in use, not to the
// size of the component — N incremental edits during construction (nothing read
// yet) touch zero regions.

function recompile(writes: readonly AnyCell[]): void {
  // Cells whose grouping changed (merge/split) plus the edited write-targets
  // (a rule-only change doesn't re-group but still changes values).
  const dirty = cond.drainDirty();
  for (const w of writes) if (!isReadonly(w)) dirty.add(w as AnyCell);

  // Materialized regions disturbed by this edit: the one each dirty cell used to
  // be in (cached on the cell), the one now sitting at its representative, and —
  // safety net — any whose representative was absorbed by a merge.
  const stale = new Set<Component>();
  const consider = (g: Component | undefined): void => {
    if (g !== undefined && !g.disposed) stale.add(g);
  };
  for (const n of dirty) {
    consider(n._region);
    consider(regions.get(cond.representative(n)));
  }
  for (const [rep, g] of regions) if (cond.representative(rep) !== rep) consider(g);

  // Bump FIRST so any re-pull triggered by the refire below re-resolves against
  // the new generation (and finds retired Map entries gone).
  bumpTopoGen();

  // Everything whose value may have moved: the re-grouped cells AND every member
  // of a retired region (a co-member's value can shift even if it didn't change
  // component). Their watchers re-pull and rebuild lazily; the regions then
  // unlink their inputs. All cheap when nothing has been read (no subs).
  const refire = new Set<AnyCell>(dirty);
  for (const g of stale) {
    regions.delete(g.rep);
    for (const m of g.members) refire.add(m as AnyCell);
  }
  for (const g of stale) g.dispose();
  refireCells(refire as Set<Cell<unknown>>);
}

function buildRegion(rep: AnyCell): Component | undefined {
  // Real members are marked in `memberCells` (write-targets + lens-chain cells).
  // Lens parents pulled in only as condensation nodes (for SCC detection) have a
  // lattice but no mark — they're channels into the region, not solved.
  const members = cond.membersOf(rep).filter(c => memberCells.has(c));
  if (members.length === 0) return undefined;

  const ruleSet = new Set<Rule>();
  for (const m of members) for (const r of rulesByMember.get(m) ?? []) ruleSet.add(r);
  if (ruleSet.size === 0) return undefined; // no rules → nothing to solve

  const lattices = members.map(m => latticeOf(m)!);
  const rules: CompiledRule[] = [...ruleSet].map(r => ({ body: r.body, reads: r.reads }));
  const isFree = members.map(m => freeVars.has(m));

  // Hand the engine the members, their lattices, the user rules, and which are
  // free. The `Component` folds its own lens members (constraint lenses lifted
  // from each cell's intrinsic transfer); members become governed VIEWS lazily,
  // each on its own first read — relate never inspects a `Transfer`.
  const comp = new Component(rep, members, lattices, rules, isFree);
  comp.builtGen = regionGen();
  regions.set(rep, comp);
  return comp;
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

// ── interval contractors (native two-way narrowers) ─────────────────
//
// Ported from `src/propagators/numeric.ts` onto core3's interval knowledge K
// (`{ min, max }`, the lattice every scalar value class — `Num` — declares).
// Each emits a one-sided band, so it NARROWS rather than asserts: it folds
// through the solver's `meet` and inherits termination + order-independence.
// Like every inequality, a contractor only refines a cell that is a BAND (an
// underdetermined/free member, seeded ⊤); a cell pinned to a concrete fact that
// the band excludes is a contradiction, not a narrowing (notes §7a). The cells
// must carry the interval lattice.

/** `x ∈ [lo, hi]` (pins when `hi` is omitted). Self-applying, so a widening
 *  re-seed gets re-narrowed. */
export function bound(x: Cell<number>, lo: number, hi: number = lo): () => void {
  const cx = x as Cell<unknown>;
  return constrain([x], [x], (_get, emit) => emit(cx, { min: lo, max: hi }));
}

/** `a + gap ≤ b`. Narrows `a` from above and `b` from below. */
export function order(a: Cell<number>, b: Cell<number>, gap = 0): () => void {
  const ca = a as Cell<unknown>;
  const cb = b as Cell<unknown>;
  const d1 = constrain([b], [a], (get, emit) =>
    emit(ca, { min: NINF, max: iv(get(cb)).max - gap }),
  );
  const d2 = constrain([a], [b], (get, emit) =>
    emit(cb, { min: iv(get(ca)).min + gap, max: PINF }),
  );
  return () => {
    d1();
    d2();
  };
}

/** `a + b = c`. Three narrowers; any two bound the third. */
export function add(a: Cell<number>, b: Cell<number>, c: Cell<number>): () => void {
  const ca = a as Cell<unknown>;
  const cb = b as Cell<unknown>;
  const cc = c as Cell<unknown>;
  const d1 = constrain([a, b], [c], (get, emit) => {
    const ia = iv(get(ca));
    const ib = iv(get(cb));
    emit(cc, { min: ia.min + ib.min, max: ia.max + ib.max });
  });
  const d2 = constrain([a, c], [b], (get, emit) => {
    const ia = iv(get(ca));
    const ic = iv(get(cc));
    emit(cb, { min: ic.min - ia.max, max: ic.max - ia.min });
  });
  const d3 = constrain([b, c], [a], (get, emit) => {
    const ib = iv(get(cb));
    const ic = iv(get(cc));
    emit(ca, { min: ic.min - ib.max, max: ic.max - ib.min });
  });
  return () => {
    d1();
    d2();
    d3();
  };
}

/** `Σ parts = whole`. N+1 narrowers: whole from the parts, each part from
 *  whole minus the others. Order-independent. */
export function total(parts: readonly Cell<number>[], whole: Cell<number>): () => void {
  if (parts.length === 0) return () => {};
  const cw = whole as Cell<unknown>;
  const cparts = parts as readonly Cell<unknown>[];
  const disposers: (() => void)[] = [];
  disposers.push(
    constrain(parts, [whole], (get, emit) => {
      let min = 0;
      let max = 0;
      for (const p of cparts) {
        const ip = iv(get(p));
        min += ip.min;
        max += ip.max;
      }
      emit(cw, { min, max });
    }),
  );
  for (let i = 0; i < parts.length; i++) {
    const target = cparts[i]!;
    const others = cparts.filter((_, j) => j !== i);
    disposers.push(
      constrain([whole, ...others], [parts[i]!], (get, emit) => {
        let oMin = 0;
        let oMax = 0;
        for (const o of others) {
          const io = iv(get(o));
          oMin += io.min;
          oMax += io.max;
        }
        const iw = iv(get(cw));
        emit(target, { min: iw.min - oMax, max: iw.max - oMin });
      }),
    );
  }
  return () => {
    for (const d of disposers) d();
  };
}
