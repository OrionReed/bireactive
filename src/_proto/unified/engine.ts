// engine.ts — unified staged settle-to-fixpoint engine (prototype).
//
// One model for signals, lenses, and propagators. The thesis (from the
// design conversation): there is no "forward engine" and "backward
// engine" and "propagator network" — there is ONE graph of cells, each
// carrying a lattice (its merge law), and ONE settle loop that drives
// contributions to a fixpoint.
//
//   • A cell's value = meet(base, fold of this settle's contributions),
//     where base = committed for monotone lattices (warm-start, cycles)
//     and base = top for discrete lattices (overwrite / conflict).
//   • A derived cell (computed/lens) has ONE forward contributor (its
//     getter) → discrete meet degenerates to overwrite: "a view is
//     always get(source)".
//   • Writing a lens stages BACKWARD contributions at the sources it
//     resolves to (walk via `put`); it never sets the lens's own value.
//   • A source written through two disagreeing views in one settle gets
//     meet(vA, vB): ⊥ (contradiction) for a discrete source, an honest
//     intersection for a lattice source. This REPLACES the old backward
//     `merge()` fold — same shape, but with laws (commutative,
//     idempotent, a bottom) so the result is order-independent.
//   • Cycles are not special: a constraint is just rules that contribute;
//     monotone lattices make the fixpoint terminate by height.
//
// Forward propagation here is PUSH (settle keeps committed current) for
// implementation clarity; the production engine's lazy pull is an
// orthogonal optimization (treat an acyclic functional region as a
// memo). See engine.test.ts for the semantics this buys.

import { discrete, type Lattice } from "./lattice";

// biome-ignore lint/suspicious/noExplicitAny: heterogeneous graph
type Any = any;

interface Rule {
  readonly reads: readonly Cell<Any>[];
  readonly writes: readonly Cell<Any>[];
  readonly key: symbol;
  step(): void;
}

interface Effect {
  fn: () => void;
  deps: Set<Cell<Any>>;
}

// ── engine state ────────────────────────────────────────────────────

let settling = false;
let batchDepth = 0;
let observer: Effect | undefined;
let activeKey: symbol | undefined; // contributor identity of the running rule

/** Cells with new contributions awaiting a fold. */
let frontier = new Set<Cell<Any>>();
/** Cells whose contribs map is non-empty (cleared at settle end). */
const touched = new Set<Cell<Any>>();
/** Cells whose committed value moved this settle (drives effects). */
const changed = new Set<Cell<Any>>();
const effects = new Set<Effect>();

/** Safety bound for slow-converging real-interval cycles. Finite
 *  lattices reach a fixpoint long before this; never throws. */
const MAX_WAVES = 10_000;

export let lastWaves = 0;
export let stalled = false;

// ── cell ────────────────────────────────────────────────────────────

export class Cell<T> {
  committed: T;
  readonly lattice: Lattice<T>;
  readonly source: boolean;
  /** Contributions this settle, keyed by contributor (forward rule,
   *  backward edge, or external write). */
  readonly contribs = new Map<symbol, T>();
  /** Rules that read this cell (re-fired when it changes). */
  readonly readers: Rule[] = [];
  contradiction = false;
  /** Backward (lens) wiring; undefined for sources / read-only derived. */
  inputs?: Cell<Any>[];
  put?: (target: T, parentVals: Any[]) => (Any | undefined)[];
  /** This cell's identity as a backward contributor to a parent. */
  readonly edgeKey = Symbol("edge");

  constructor(init: T, lattice: Lattice<T>, source: boolean) {
    this.committed = init;
    this.lattice = lattice;
    this.source = source;
  }

  get value(): T {
    if (observer !== undefined) {
      observer.deps.add(this);
    }
    return this.committed;
  }

  set value(v: T) {
    write(this, v);
    maybeSettle();
  }

  /** Untracked read. */
  peek(): T {
    return this.committed;
  }
}

// ── contribution + write ────────────────────────────────────────────

function contribute<T>(cell: Cell<T>, key: symbol, val: T): void {
  cell.contribs.set(key, val);
  frontier.add(cell);
  touched.add(cell);
}

const EXTERNAL = Symbol("external");

/** Route a write: sources take it directly; lenses walk backward and
 *  stage contributions at the sources they resolve to. */
function write<T>(cell: Cell<T>, v: T): void {
  if (cell.source) {
    contribute(cell, EXTERNAL, v);
    return;
  }
  backward(cell, v);
}

/** Walk a lens chain to its sources, depositing one contribution per
 *  source keyed by the immediate child edge (so re-writes from the same
 *  view coalesce, but distinct views fold). */
function backward<T>(cell: Cell<T>, target: T): void {
  if (cell.put === undefined || cell.inputs === undefined) {
    throw new TypeError("write: cell is read-only (no put)");
  }
  const pv = cell.inputs.map(p => p.committed);
  const puts = cell.put(target, pv);
  for (let i = 0; i < cell.inputs.length; i++) {
    const u = puts[i];
    if (u === undefined) continue;
    const p = cell.inputs[i]!;
    if (p.source) contribute(p, cell.edgeKey, u);
    else backward(p, u);
  }
}

// ── settle ──────────────────────────────────────────────────────────

function maybeSettle(): void {
  if (batchDepth === 0 && !settling) settle();
}

/** Drive the graph to a fixpoint: fold each frontier cell's
 *  contributions, commit if it moved, re-fire its reader rules, repeat. */
export function settle(): void {
  if (settling) return;
  settling = true;
  let waves = 0;
  try {
    while (frontier.size > 0 && waves < MAX_WAVES) {
      waves++;
      const wave = frontier;
      frontier = new Set<Cell<Any>>();
      const rerun = new Set<Rule>();
      for (const cell of wave) {
        const lat = cell.lattice;
        let folded = lat.monotone ? cell.committed : lat.top;
        for (const v of cell.contribs.values()) folded = lat.meet(folded, v);
        cell.contradiction = lat.isBottom(folded);
        if (!lat.equals(folded, cell.committed)) {
          cell.committed = folded;
          changed.add(cell);
          for (const r of cell.readers) rerun.add(r);
        }
      }
      for (const r of rerun) runRule(r);
    }
    lastWaves = waves;
    stalled = frontier.size > 0;
  } finally {
    // Robust teardown: one bad rule must not wedge the engine.
    if (stalled || frontier.size > 0) frontier = new Set<Cell<Any>>();
    for (const cell of touched) cell.contribs.clear();
    touched.clear();
    settling = false;
  }
  flushEffects();
}

function runRule(r: Rule): void {
  // A rule reading a contradicted cell can't compute (its getter would
  // see a ⊥ sentinel). Poison its writes instead of crashing — ⊥
  // propagates forward as a flag.
  for (const rc of r.reads) {
    if (rc.contradiction) {
      for (const w of r.writes) {
        if (!w.contradiction) {
          w.contradiction = true;
          changed.add(w);
        }
      }
      return;
    }
  }
  const prev = activeKey;
  activeKey = r.key;
  try {
    r.step();
  } finally {
    activeKey = prev;
  }
}

function flushEffects(): void {
  if (changed.size === 0) return;
  const dirty: Effect[] = [];
  for (const e of effects) {
    for (const d of e.deps) {
      if (changed.has(d)) {
        dirty.push(e);
        break;
      }
    }
  }
  changed.clear();
  for (const e of dirty) runEffect(e);
}

// ── rule registration ───────────────────────────────────────────────

/** Register a propagator rule: `reads` it subscribes to, `writes` it
 *  contributes to, `body` deposits via `emit`. Keyed so contributions
 *  from this rule coalesce. First-fires immediately. */
export function prop(
  reads: readonly Cell<Any>[],
  writes: readonly Cell<Any>[],
  body: (emit: <T>(cell: Cell<T>, val: T) => void) => () => void,
): Rule {
  const key = Symbol("rule");
  const emit = <T>(cell: Cell<T>, val: T): void => contribute(cell, key, val);
  const rule: Rule = { reads, writes, key, step: body(emit) };
  for (const r of reads) r.readers.push(rule);
  runRule(rule);
  maybeSettle();
  return rule;
}

// ── constructors ────────────────────────────────────────────────────

/** A writable source cell. Discrete by default; pass a lattice for a
 *  knowledge cell (interval/set). */
export function source<T>(init: T, lattice: Lattice<T> = discrete<T>()): Cell<T> {
  return new Cell<T>(init, lattice, true);
}

/** A read-only derived cell: value = `fn(inputs)`, recomputed when any
 *  input changes. One forward contributor → discrete overwrite. */
export function computed<T>(inputs: readonly Cell<Any>[], fn: (vals: Any[]) => T): Cell<T> {
  const lat = discrete<T>();
  const cell = new Cell<T>(lat.top, lat, false);
  prop(inputs, [cell], emit => () => emit(cell, fn(inputs.map(c => c.committed))));
  return cell;
}

/** A writable lens over N parents: `get` is the forward view, `put`
 *  maps a written view value to per-parent contributions (undefined ⇒
 *  leave that parent). */
export function lens<T>(
  parents: readonly Cell<Any>[],
  get: (vals: Any[]) => T,
  put: (target: T, vals: Any[]) => (Any | undefined)[],
): Cell<T> {
  const lat = discrete<T>();
  const cell = new Cell<T>(lat.top, lat, false);
  cell.inputs = parents as Cell<Any>[];
  cell.put = put as (t: T, v: Any[]) => (Any | undefined)[];
  prop(parents, [cell], emit => () => emit(cell, get(parents.map(c => c.committed))));
  return cell;
}

/** Single-parent lens sugar. */
export function lens1<S, T>(
  parent: Cell<S>,
  get: (v: S) => T,
  put: (target: T, v: S) => S,
): Cell<T> {
  return lens(
    [parent],
    vals => get(vals[0] as S),
    (target, vals) => [put(target, vals[0] as S)],
  );
}

// ── effects ─────────────────────────────────────────────────────────

export function effect(fn: () => void): () => void {
  const e: Effect = { fn, deps: new Set() };
  effects.add(e);
  runEffect(e);
  return () => effects.delete(e);
}

function runEffect(e: Effect): void {
  const prev = observer;
  observer = e;
  e.deps.clear();
  try {
    e.fn();
  } finally {
    observer = prev;
  }
}

// ── batching ────────────────────────────────────────────────────────

export function batch(fn: () => void): void {
  batchDepth++;
  try {
    fn();
  } finally {
    batchDepth--;
  }
  maybeSettle();
}

// ── inspection ──────────────────────────────────────────────────────

/** Reset a monotone cell back to `top` (drop warm-started narrowing). */
export function reset<T>(cell: Cell<T>): void {
  cell.committed = cell.lattice.top;
  cell.contradiction = false;
  frontier.add(cell);
  maybeSettle();
}

export function isContradiction(cell: Cell<Any>): boolean {
  return cell.contradiction;
}
