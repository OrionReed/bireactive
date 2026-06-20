// schema/lens.ts — composable, complement-carrying lenses between plain POJOs.
//
// Two layers:
//
//   • VLens<S,V,C> — a *value-level* bidirectional transform carrying a
//     complement `C` (what the forward direction drops). VLenses compose
//     (`seq`), descend into a field (`into`), map over arrays element-wise
//     (`each`/`eachBy`), and recurse (`recurse`). The complement of a
//     composite is the product of its parts' complements, so a lossy
//     pipeline still round-trips — the property Cambria lacked.
//
//   • Step — a VLens lifted onto a reactive cell (`toStep`). `pipe` chains
//     Steps into the A→B→{C,D} reactive graph used by the demo.
//
// Orientation: the source `S` is the older / upstream schema; `fwd` builds
// the newer view, `bwd` writes an edit back. Information a newer schema adds,
// or distinctions an older one can't hold, lives in `C` — local view state,
// never in the shared source.

import { type Cell, lens, type Writable } from "../core/cell";

/** A plain JSON-ish record. */
export type Obj = Record<string, unknown>;

/** Sentinel for "this key was absent" (distinct from an explicit `undefined`). */
const ABSENT = Symbol("absent");

// ── the value-level lens ────────────────────────────────────────────

/** A value-level bidirectional transform carrying complement `C`. */
export interface VLens<S, V, C> {
  init: (s: S) => C;
  /** Refresh the complement from a (possibly externally-changed) source. */
  step?: (s: S, c: C) => C;
  fwd: (s: S, c: C) => V;
  bwd: (v: V, s: S, c: C) => { s: S; c: C };
}

/** An object→object lens (the common case). */
export type OLens = VLens<Obj, Obj, unknown>;

// ── object helpers (order-preserving, pure) ─────────────────────────

function omit(v: Obj, key: string): Obj {
  const out: Obj = {};
  for (const k of Object.keys(v)) if (k !== key) out[k] = v[k];
  return out;
}

function replaceKey(v: Obj, oldKey: string, newKey: string, newVal: unknown): Obj {
  const out: Obj = {};
  let placed = false;
  for (const k of Object.keys(v)) {
    if (k === oldKey) {
      out[newKey] = newVal;
      placed = true;
    } else if (k === newKey && oldKey !== newKey) {
      // drop a colliding target slot; the rename owns this key now
    } else {
      out[k] = v[k];
    }
  }
  if (!placed) out[newKey] = newVal;
  return out;
}

function keyIndex(v: Obj, key: string): number {
  return Object.keys(v).indexOf(key);
}

/** Reinsert `key` (absent from `v`) at position `idx`. */
function insertAt(v: Obj, key: string, val: unknown, idx: number): Obj {
  const keys = Object.keys(v).filter(k => k !== key);
  const at = idx < 0 ? keys.length : Math.min(idx, keys.length);
  keys.splice(at, 0, key);
  const out: Obj = {};
  for (const k of keys) out[k] = k === key ? val : v[k];
  return out;
}

function insertPair(v: Obj, key: string, ka: string, va: unknown, kb: string, vb: unknown): Obj {
  const out: Obj = {};
  for (const k of Object.keys(v)) {
    if (k === key) {
      out[ka] = va;
      out[kb] = vb;
    } else {
      out[k] = v[k];
    }
  }
  return out;
}

function collapsePair(v: Obj, ka: string, kb: string, key: string, whole: unknown): Obj {
  const out: Obj = {};
  let placed = false;
  for (const k of Object.keys(v)) {
    if (k === ka || k === kb) {
      if (!placed) {
        out[key] = whole;
        placed = true;
      }
    } else {
      out[k] = v[k];
    }
  }
  if (!placed) out[key] = whole;
  return out;
}

function nestObj(v: Obj, keys: readonly string[], under: string): Obj {
  const set = new Set(keys);
  const sub: Obj = {};
  for (const k of keys) if (k in v) sub[k] = v[k];
  const out: Obj = {};
  let placed = false;
  for (const k of Object.keys(v)) {
    if (set.has(k)) {
      if (!placed) {
        out[under] = sub;
        placed = true;
      }
    } else {
      out[k] = v[k];
    }
  }
  if (!placed) out[under] = sub;
  return out;
}

function unnestObj(v: Obj, keys: readonly string[], under: string): Obj {
  const sub = (v[under] as Obj | undefined) ?? {};
  const out: Obj = {};
  for (const k of Object.keys(v)) {
    if (k === under) {
      for (const kk of keys) out[kk] = sub[kk];
    } else {
      out[k] = v[k];
    }
  }
  return out;
}

// ── value-level primitives ──────────────────────────────────────────

/** Rename a top-level field. Complement-honest about a colliding target:
 *  if the source already has `to`, that shadowed value is parked and
 *  restored on the way back (so GetPut holds even on malformed input). */
export function renameV(from: string, to: string): VLens<Obj, Obj, { shadow: unknown }> {
  return {
    init: v => ({ shadow: to in v ? v[to] : ABSENT }),
    step: v => ({ shadow: to in v ? v[to] : ABSENT }),
    fwd: v => replaceKey(v, from, to, v[from]),
    bwd: (t, _v, c) => {
      let s = replaceKey(t, to, from, t[to]);
      if (c.shadow !== ABSENT) s = { ...s, [to]: c.shadow };
      return { s, c };
    },
  };
}

/** A field a newer schema adds; the value lives in the complement. */
export function addV(key: string, initial: unknown): VLens<Obj, Obj, { val: unknown }> {
  return {
    init: () => ({ val: initial }),
    fwd: (v, c) => ({ ...v, [key]: c.val }),
    bwd: t => ({ s: omit(t, key), c: { val: t[key] } }),
  };
}

/** A field a newer schema drops; the value (and position) live in the complement. */
export function removeV(key: string): VLens<Obj, Obj, { val: unknown; idx: number }> {
  const capture = (v: Obj) => ({ val: v[key], idx: keyIndex(v, key) });
  return {
    init: capture,
    step: (v, c) => (key in v ? capture(v) : c),
    fwd: v => omit(v, key),
    bwd: (t, _v, c) => ({ s: insertAt(t, key, c.val, c.idx), c }),
  };
}

/** Move several top-level fields into a sub-object. Bijective. */
export function nestV(keys: readonly string[], under: string): VLens<Obj, Obj, null> {
  return {
    init: () => null,
    fwd: v => nestObj(v, keys, under),
    bwd: t => ({ s: unnestObj(t, keys, under), c: null }),
  };
}

/** How to split one string field into two and rejoin them. */
export interface SplitSpec {
  split: (whole: string) => [string, string];
  join: (a: string, b: string) => string;
}

/** Split one string field into two. Complement-honest: it stores the chosen
 *  halves AND the exact original string, so a clean read-write round-trip
 *  reproduces the source verbatim (trailing spaces, odd separators) instead
 *  of being re-guessed by `join(split(·))`. The lens Cambria couldn't make
 *  bidirectional ("firstName/lastName → fullName runs reliably one way"). */
export function splitV(
  key: string,
  into: readonly [string, string],
  spec: SplitSpec,
): VLens<Obj, Obj, { a: string; b: string; whole: string }> {
  const [ka, kb] = into;
  const part = (whole: string) => {
    const [a, b] = spec.split(whole);
    return { a, b, whole };
  };
  return {
    init: v => part(String(v[key] ?? "")),
    step: (v, c) => {
      const whole = String(v[key] ?? "");
      return whole === c.whole ? c : part(whole);
    },
    fwd: (v, c) => insertPair(v, key, ka, c.a, kb, c.b),
    bwd: (t, _v, c) => {
      const a = String(t[ka] ?? "");
      const b = String(t[kb] ?? "");
      // Parts unchanged ⇒ restore the original whole exactly (GetPut).
      const whole = a === c.a && b === c.b ? c.whole : spec.join(a, b);
      return { s: collapsePair(t, ka, kb, key, whole), c: { a, b, whole } };
    },
  };
}

/** A stateful 1→1 value transform on a single field's value. */
export interface FieldMap<C> {
  init: (srcVal: unknown) => C;
  step?: (srcVal: unknown, c: C) => C;
  fwd: (srcVal: unknown, c: C) => unknown;
  bwd: (viewVal: unknown, srcVal: unknown, c: C) => { src: unknown; complement: C };
}

/** Apply a value-lens to a single field, optionally renaming the key. The
 *  workhorse behind `mapField`, `wrapField`, and `into`. */
export function onField<S, V, C>(
  key: string,
  viewKey: string,
  vl: VLens<S, V, C>,
): VLens<Obj, Obj, C> {
  return {
    init: v => vl.init(v[key] as S),
    step: (v, c) => (vl.step ? vl.step(v[key] as S, c) : c),
    fwd: (v, c) => replaceKey(v, key, viewKey, vl.fwd(v[key] as S, c)),
    bwd: (t, v, c) => {
      const r = vl.bwd(t[viewKey] as V, v[key] as S, c);
      return { s: replaceKey(t, viewKey, key, r.s), c: r.c };
    },
  };
}

function fieldMapToVL<C>(m: FieldMap<C>): VLens<unknown, unknown, C> {
  return {
    init: m.init,
    step: m.step,
    fwd: m.fwd,
    bwd: (v, s, c) => {
      const r = m.bwd(v, s, c);
      return { s: r.src, c: r.complement };
    },
  };
}

/** Scalar → array. Forward wraps the scalar as the array head; the *tail*
 *  (everything the older scalar schema can't see) lives in the complement.
 *  Writing the scalar replaces only the head and CONSERVES the tail — the
 *  consistency Cambria's `head`/`wrap` pair couldn't keep (its Appendix III
 *  "defective implementation" clobbered or dropped the unseen elements). */
export function wrapV(): VLens<unknown, unknown[], { tail: unknown[] }> {
  return {
    init: () => ({ tail: [] }),
    fwd: (s, c) => [s, ...c.tail],
    bwd: arr => {
      const a = Array.isArray(arr) ? arr : [arr];
      return { s: a.length ? a[0] : null, c: { tail: a.slice(1) } };
    },
  };
}

/** Array → scalar head (the dual of `wrapV`). The tail stays in the source
 *  array, so no complement is needed: the head view writes back as
 *  `[head, ...tail]`, conserving the rest. Reorder or grow the array and the
 *  scalar tracks the new head; edit the scalar and only the head moves. */
export function headV(): VLens<unknown[], unknown, null> {
  return {
    init: () => null,
    fwd: arr => (Array.isArray(arr) && arr.length ? arr[0] : null),
    bwd: (head, arr) => ({ s: [head, ...(Array.isArray(arr) ? arr.slice(1) : [])], c: null }),
  };
}

// ── combinators ──────────────────────────────────────────────────────

/** Compose two value-lenses (the product complement is `[c1, c2]`). */
function then2<A, B, D>(
  l1: VLens<A, B, unknown>,
  l2: VLens<B, D, unknown>,
): VLens<A, D, [unknown, unknown]> {
  return {
    init: a => {
      const c1 = l1.init(a);
      return [c1, l2.init(l1.fwd(a, c1))];
    },
    step: (a, [c1, c2]) => {
      const c1b = l1.step ? l1.step(a, c1) : c1;
      const b = l1.fwd(a, c1b);
      const c2b = l2.step ? l2.step(b, c2) : c2;
      return [c1b, c2b];
    },
    fwd: (a, [c1, c2]) => l2.fwd(l1.fwd(a, c1), c2),
    bwd: (d, a, [c1, c2]) => {
      const b = l1.fwd(a, c1);
      const r2 = l2.bwd(d, b, c2);
      const r1 = l1.bwd(r2.s, a, c1);
      return { s: r1.s, c: [r1.c, r2.c] };
    },
  };
}

/** Left-to-right composition of value-lenses. The complement type is the
 *  (heterogeneous) product of the parts', so it's existential here. */
// biome-ignore lint/suspicious/noExplicitAny: complements compose existentially
export function seq(...lenses: VLens<Obj, Obj, any>[]): VLens<Obj, Obj, unknown> {
  if (lenses.length === 0) {
    return { init: () => null, fwd: v => v, bwd: t => ({ s: t, c: null }) };
  }
  return lenses.reduce((acc, l) => then2(acc, l) as unknown as VLens<Obj, Obj, unknown>);
}

/** Descend into a field and apply a value-lens to whatever lives there
 *  (a nested object, or an array — see `each`). Cambria's `in`. */
export function into<S, V, C>(key: string, vl: VLens<S, V, C>): VLens<Obj, Obj, C> {
  return onField(key, key, vl);
}

/** Apply an element lens to every item of an array, keyed by `by` for stable
 *  identity. Inserts (new key), deletes (missing key), and reorders (view
 *  order) all round-trip, and each element keeps its OWN complement across
 *  the move — the array case Cambria flagged as unbuilt (`mapInto` plus
 *  "merging or splitting arrays"). */
export function eachBy(
  by: (e: Obj) => unknown,
  // biome-ignore lint/suspicious/noExplicitAny: per-element complement is existential
  elem: VLens<Obj, Obj, any>,
): VLens<Obj[], Obj[], Map<unknown, unknown>> {
  return {
    init: arr => {
      const m = new Map<unknown, unknown>();
      for (const el of arr) m.set(by(el), elem.init(el));
      return m;
    },
    step: (arr, c) => {
      const m = new Map<unknown, unknown>();
      for (const el of arr) {
        const k = by(el);
        const ci = c.has(k) ? c.get(k) : elem.init(el);
        m.set(k, elem.step ? elem.step(el, ci) : ci);
      }
      return m;
    },
    fwd: (arr, c) => arr.map(el => elem.fwd(el, c.has(by(el)) ? c.get(by(el)) : elem.init(el))),
    bwd: (view, arr, c) => {
      const srcByKey = new Map<unknown, Obj>();
      for (const el of arr) srcByKey.set(by(el), el);
      const nc = new Map<unknown, unknown>();
      const s = view.map(vel => {
        const k = by(vel);
        const s0 = srcByKey.get(k) ?? {};
        const ci = c.has(k) ? c.get(k) : elem.init(s0);
        const r = elem.bwd(vel, s0, ci);
        nc.set(k, r.c);
        return r.s;
      });
      return { s, c: nc };
    },
  };
}

/** Positional `each` (element i ↔ element i). Use `eachBy` when elements can
 *  reorder; this is fine for stable structures (e.g. recursive trees). */
// biome-ignore lint/suspicious/noExplicitAny: per-element complement is existential
export function each(elem: VLens<Obj, Obj, any>): VLens<Obj[], Obj[], unknown[]> {
  return {
    init: arr => arr.map(el => elem.init(el)),
    step: (arr, c) =>
      arr.map((el, i) => {
        const ci = i < c.length ? c[i] : elem.init(el);
        return elem.step ? elem.step(el, ci) : ci;
      }),
    fwd: (arr, c) => arr.map((el, i) => elem.fwd(el, i < c.length ? c[i] : elem.init(el))),
    bwd: (view, arr, c) => {
      const nc: unknown[] = [];
      const s = view.map((vel, i) => {
        const s0 = arr[i] ?? {};
        const ci = i < c.length ? c[i] : elem.init(s0);
        const r = elem.bwd(vel, s0, ci);
        nc.push(r.c);
        return r.s;
      });
      return { s, c: nc };
    },
  };
}

/** Build a self-referential lens. `recurse(self => …)` lets a lens use itself
 *  for nested occurrences — e.g. rename a field at every level of a subtask
 *  tree of arbitrary depth. Cambria's open "recursive schemas" case. */
export function recurse(build: (self: OLens) => OLens): OLens {
  // Lazy thunk: the body references `self`, whose methods defer to the built
  // lens. Construction terminates; recursion only unfolds against finite data.
  let built: OLens | null = null;
  const self: OLens = {
    init: s => (built ??= build(self)).init(s),
    step: (s, c) => {
      const b = (built ??= build(self));
      return b.step ? b.step(s, c) : c;
    },
    fwd: (s, c) => (built ??= build(self)).fwd(s, c),
    bwd: (v, s, c) => (built ??= build(self)).bwd(v, s, c),
  };
  return self;
}

// ── reactive lifting (cells) ─────────────────────────────────────────

/** Lift a value-lens onto a reactive cell. */
export function toStep<C>(vl: VLens<Obj, Obj, C>): Step {
  return src =>
    lens<Obj, Obj, C>(src, {
      init: v => vl.init(v),
      step: (v, c) => (vl.step ? vl.step(v, c) : c),
      fwd: (v, c) => vl.fwd(v, c),
      bwd: (t: Obj, v, c) => {
        const r = vl.bwd(t, v, c);
        return { update: r.s, complement: r.c };
      },
    });
}

/** A migration step: a writable lens from one POJO schema to the next. */
export type Step = (src: Writable<Cell<Obj>>) => Writable<Cell<Obj>>;

/** Left-to-right composition of reactive steps (chains cells). */
export function pipe(...steps: Step[]): Step {
  return src => steps.reduce<Writable<Cell<Obj>>>((acc, step) => step(acc), src);
}

// ── public Step-returning kit (sugar over the value-level core) ──────

/** Rename a top-level field. */
export function renameField(from: string, to: string): Step {
  return toStep(renameV(from, to));
}

/** Add a field the source can't represent (value parked in the complement). */
export function addField(key: string, initial: unknown): Step {
  return toStep(addV(key, initial));
}

/** Drop a field (value + position parked in the complement). */
export function removeField(key: string): Step {
  return toStep(removeV(key));
}

/** Move several top-level fields into a sub-object. */
export function nestFields(keys: readonly string[], under: string): Step {
  return toStep(nestV(keys, under));
}

/** Split one string field into two (complement-honest; see {@link splitV}). */
export function splitField(key: string, into: readonly [string, string], spec: SplitSpec): Step {
  return toStep(splitV(key, into, spec));
}

/** Scalar → array on a field, optionally renaming it (see {@link wrapV}). */
export function wrapField(key: string, rename?: string): Step {
  return toStep(onField(key, rename ?? key, wrapV()));
}

/** Array → scalar head on a field, optionally renaming it (see {@link headV}). */
export function headField(key: string, rename?: string): Step {
  return toStep(onField(key, rename ?? key, headV()));
}

/** A stateful 1→1 value transform on a single field, optionally renaming it. */
export function mapField<C>(key: string, m: FieldMap<C> & { rename?: string }): Step {
  return toStep(onField(key, m.rename ?? key, fieldMapToVL(m)));
}

/** Apply a whole sub-migration inside a nested object field. Cambria's `in`. */
export function inField(key: string, vl: VLens<Obj, Obj, unknown>): Step {
  return toStep(into(key, vl));
}

/** Apply an element migration to every item of an array field, keyed by `by`. */
// biome-ignore lint/suspicious/noExplicitAny: per-element complement is existential
export function mapElems(key: string, by: (e: Obj) => unknown, elem: VLens<Obj, Obj, any>): Step {
  return toStep(into(key, eachBy(by, elem)));
}
