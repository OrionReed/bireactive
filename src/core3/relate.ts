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
  type CompiledRule,
  Component,
  captureBase,
  isLens,
  K,
  type Lattice,
  type RelationBody,
  relaxToBase,
} from "./cell";
import { DynCondensation } from "./condense";
import { interval } from "./lattice";

export type { RelationBody } from "./cell";

// biome-ignore lint/suspicious/noExplicitAny: heterogeneous relation graph
type AnyCell = Cell<any>;

// ── interval-knowledge helpers (shared by the lens lift and contractors) ──
const NINF = Number.NEGATIVE_INFINITY;
const PINF = Number.POSITIVE_INFINITY;
interface Iv {
  readonly min: number;
  readonly max: number;
}
const iv = (k: unknown): Iv => k as Iv;
/** Map a band through a MONOTONE scalar `f` (endpoint image, re-normalised so a
 *  decreasing `f` still yields min ≤ max). Sound for Iso homomorphisms
 *  (shift/scale/affine/exp) — invertible ⇒ monotone. */
const mapBand = (k: Iv, f: (t: number) => number): Iv => {
  const a = f(k.min);
  const b = f(k.max);
  return a <= b ? { min: a, max: b } : { min: b, max: a };
};

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
 *  intermediate lenses become condensation nodes but never solve (no base;
 *  `buildComponent` filters them out). Must run while `m` still holds its
 *  original identity (before it is re-wired). */
function registerLensParents(m: AnyCell): void {
  const seen = new Set<AnyCell>();
  const visit = (child: AnyCell): void => {
    if (seen.has(child) || !isLens(child)) return;
    seen.add(child);
    const parent = child._rel!.parents;
    const parents = parent instanceof Cell ? [parent] : Array.isArray(parent) ? parent : [];
    for (const p of parents) {
      const pc = p as AnyCell;
      cond.addNode(pc);
      cond.addEdge(pc, child); // p → child: child reads p (permanent lens edge)
      // Give every cell in the chain a base, so an INTERMEDIATE lens that
      // lands inside an SCC solves as a real member (the chain folds in
      // K-space via constraint transformers) instead of being skipped and
      // re-entering the solve through a live `.value` read. Capture now, while
      // the chain still holds its original identity. A cell that never enters
      // a cycle keeps its base unused (it solves nothing — a plain channel).
      if (latticeOf(pc) !== undefined) memberCells.add(pc);
      visit(pc);
    }
  };
  visit(m);
}

/** The live SCC solver that currently owns each member, so a topology change
 *  rebuilds ONLY the components it actually touched. Keyed by member: across an
 *  edit a member still points at its OLD `Component` (the NEW partition is read
 *  from `cond`), which is how `recompile` finds what to dispose. */
const owner = new WeakMap<AnyCell, Component>();

/** Cells that are relation members (write-targets, plus lens-chain cells folded
 *  in for SCC detection). A pure membership MARKER: the standing-assertion
 *  channel itself lives on the member's own transfer (`_rel.base`, set when it
 *  attaches), not in a side table. Used to tell a real member apart from a
 *  read-only external that merely shares the condensation graph. */
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

/** Re-assert a knowledge cell's standing value. While the cell is a member
 *  this writes its base (re-invalidating its region); otherwise it writes
 *  the cell directly. Plain `cell.value = …` does the same — `assert` is
 *  just the explicit spelling. */
export function assert<T>(c: Cell<T>, value: T): void {
  const b = (c as AnyCell)._rel?.base;
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
    // Mark `w` a member the first time it joins a relation. Its standing-
    // assertion channel is captured lazily at build time (while it still holds
    // its original identity) and then lives on its own transfer. Also fold the
    // lens's structural read-edges into the condensation so lens-coupled
    // regions condense into one SCC instead of oscillating across components.
    if (latticeOf(w) !== undefined && !memberCells.has(w)) {
      memberCells.add(w);
      registerLensParents(w);
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
    for (const r of rule.reads) cond.removeEdge(r, w);
  }
  recompile(rule.writes);
}

// ── incremental compilation: one Component per cyclic SCC ───────────
//
// A topology change rebuilds ONLY the components it touched. `affected` =
// the cells the condensation re-grouped (merges via window-recondense,
// splits via resplit) plus the cells the new/removed rule writes. Every
// `Component` owning an affected cell is disposed, then each distinct current
// component over the affected region is rebuilt — so merges (N → 1) and splits
// (1 → N) both fall out correctly. The `Component` node and its member
// projections run through the normal dep/sub graph, so any watching effects
// are scheduled onto the microtask and coalesced.

function recompile(writes: readonly AnyCell[]): void {
  const affected = cond.drainDirty();
  for (const w of writes) affected.add(w);

  const reps = new Set<AnyCell>();
  const orphans = new Set<AnyCell>();
  for (const n of affected) {
    const comp = owner.get(n);
    if (comp !== undefined) {
      comp.dispose();
      for (const m of comp.members) {
        owner.delete(m);
        orphans.add(m);
      }
    }
    reps.add(cond.representative(n));
  }
  for (const rep of reps) buildComponent(rep);

  // A cell that lost its last rule (no longer owned by any Component) relaxes
  // back to its standing assertion as a plain source.
  for (const m of orphans) {
    if (!owner.has(m)) {
      const b = m._rel?.base;
      if (b !== undefined) relaxToBase(m, b);
    }
  }
}

/** Lift a constraint lens's transfer into K-space relation bodies, reading the
 *  SAME `Transfer` the acyclic executor uses (its maps are abstracted, never
 *  re-authored). Forward: `m ⊒ abstract(fwd(pinned(parent)))`, once the parent's
 *  knowledge pins a value — for every single-parent kind. Backward:
 *  `parent ⊒ abstract(bwd(pinned(m)))` only for a source-INDEPENDENT inverse
 *  (`Iso`: shift/scale/affine/add/not/xor — the homomorphisms). A source-reading
 *  inverse (`Lens`: field spread-replace, clamp) abstains backward, still sound. */
function liftToKSpace(
  rel: NonNullable<AnyCell["_rel"]>,
  m: AnyCell,
  latM: Lattice<unknown, unknown>,
  p: AnyCell,
  latP: Lattice<unknown, unknown>,
  rules: CompiledRule[],
): void {
  const fwd = rel.fwd;
  // Iso over two scalar intervals: a monotone homomorphism, so map the WHOLE
  // band both ways (a real two-way interval transformer). Partial knowledge — a
  // free var bounded `≥ 3` — now flows through `.add`/`.scale`/`.affine`/`.exp`
  // instead of waiting for the parent to pin a point.
  if (rel.kind === K.Iso && latM === interval && latP === interval) {
    const bwd = rel.bwd;
    rules.push({ reads: [p], body: (get, emit) => emit(m, mapBand(iv(get(p)), fwd as F)) });
    rules.push({ reads: [m], body: (get, emit) => emit(p, mapBand(iv(get(m)), bwd as F)) });
    return;
  }
  // Pin-gated fallback (any lattice / any kind): forward once the parent's
  // knowledge pins a value; backward only for a source-independent (Iso)
  // inverse. A non-monotone inverse (sin/clamp/quantize — `Lens` kind) abstains
  // backward, still sound.
  rules.push({
    reads: [p],
    body: (get, emit) => {
      const pv = latP.pinned(get(p));
      if (pv !== undefined) emit(m, latM.abstract(fwd(pv)));
    },
  });
  if (rel.kind === K.Iso) {
    const bwd = rel.bwd;
    rules.push({
      reads: [m],
      body: (get, emit) => {
        const mv = latM.pinned(get(m));
        if (mv !== undefined) emit(p, latP.abstract(bwd(mv)));
      },
    });
  }
}

type F = (t: number) => number;

function buildComponent(rep: AnyCell): void {
  // Real members are marked in `memberCells` (write-targets + lens-chain cells).
  // Lens parents pulled in only as condensation nodes (for SCC detection) have a
  // lattice but no mark — they're channels into the component, not solved.
  const members = cond.membersOf(rep).filter(c => memberCells.has(c));
  if (members.length === 0) return;

  const memberSet = new Set(members);
  const ruleSet = new Set<Rule>();
  for (const m of members) for (const r of rulesByMember.get(m) ?? []) ruleSet.add(r);
  if (ruleSet.size === 0) return; // no rules → nothing to solve; relax as orphan

  // Reuse the member's existing channel (re-join / relaxed: it lives on `_rel`),
  // else capture it now while the cell still holds its original identity. The
  // channel is durable thereafter — `attachMember` stows it back on `_rel.base`.
  const bases = members.map(m => m._rel?.base ?? captureBase(m));
  const lattices = members.map(m => latticeOf(m)!);
  const rules: CompiledRule[] = [...ruleSet].map(r => ({ body: r.body, reads: r.reads }));
  const derived = members.map(() => false);
  const isFree = members.map(m => freeVars.has(m));
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
    const rel = base._rel!;
    const parent = rel.parents;
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

    if (singleMemberParent) {
      const p = parent as AnyCell;
      liftToKSpace(rel, m, lattices[i]!, p, latticeOf(p)!, rules);
    }
  });

  // The Component constructor projects each member onto its solved slot.
  const comp = new Component(members, bases, lattices, rules, derived, fallbacks, isFree);
  for (const m of members) owner.set(m, comp);
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
