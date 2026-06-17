// schema/lens.ts — a kit of composable, complement-carrying lenses between
// plain-POJO schema versions.
//
// Each primitive is a `Step`: a writable lens from one POJO shape to the
// next. `pipe` chains them, so a whole schema migration is a fold of tiny,
// individually-trivial lenses. Because every step is its own reactive cell
// with its own complement, the composite carries the *product* of the
// complements and round-trips even where individual steps drop information —
// the thing a stateless migration (Cambria) can't do.
//
// Orientation: the upstream cell is the *source* (the older / more canonical
// schema). The forward direction (`fwd`) builds the newer view; the backward
// direction (`bwd`) writes the edit back upstream. Information a newer schema
// adds, or distinctions an older schema can't represent, live in the step's
// complement — local view state, never in the shared source.

import { type Cell, lens, type Writable } from "../core/cell";

/** A plain JSON-ish record. */
export type Obj = Record<string, unknown>;

/** A migration step: a writable lens from one POJO schema to the next. */
export type Step = (src: Writable<Cell<Obj>>) => Writable<Cell<Obj>>;

/** Left-to-right composition: `pipe(a, b)(src)` applies `a`, then `b`. */
export function pipe(...steps: Step[]): Step {
  return src => steps.reduce<Writable<Cell<Obj>>>((acc, step) => step(acc), src);
}

// ── object helpers (all order-preserving, all pure) ───────────────────

function omit(v: Obj, key: string): Obj {
  const out: Obj = {};
  for (const k of Object.keys(v)) if (k !== key) out[k] = v[k];
  return out;
}

function renamedKeys(v: Obj, from: string, to: string): Obj {
  const out: Obj = {};
  for (const k of Object.keys(v)) out[k === from ? to : k] = v[k];
  return out;
}

function replaceKey(v: Obj, oldKey: string, newKey: string, newVal: unknown): Obj {
  const out: Obj = {};
  let placed = false;
  for (const k of Object.keys(v)) {
    if (k === oldKey) {
      out[newKey] = newVal;
      placed = true;
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

/** Replace `key` with two keys `ka`, `kb` at `key`'s position. */
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

/** Collapse keys `ka`, `kb` back into a single `key` at `ka`'s position. */
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

function nest(v: Obj, keys: readonly string[], under: string): Obj {
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

function unnest(v: Obj, keys: readonly string[], under: string): Obj {
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

// ── primitives ────────────────────────────────────────────────────────

/** Rename a top-level field. Bijective; empty complement. */
export function renameField(from: string, to: string): Step {
  return src =>
    lens(
      src,
      (v: Obj) => renamedKeys(v, from, to),
      (t: Obj) => renamedKeys(t, to, from),
    );
}

/** The newer view carries a field the source can't represent. Forward seeds
 *  it from the complement; editing it parks the value in the complement
 *  (so it survives even though no upstream schema knows about it). */
export function addField(key: string, initial: unknown): Step {
  return src =>
    lens<Obj, Obj, { val: unknown }>(src, {
      init: () => ({ val: initial }),
      step: (_s, c) => c,
      fwd: ([v], c) => ({ ...v, [key]: c.val }),
      bwd: (target: Obj, _s) => ({
        updates: [omit(target, key)],
        complement: { val: target[key] },
      }),
    });
}

/** The newer view drops a field the source has. The dropped value (and its
 *  position) live in the complement, so writing the view back restores it. */
export function removeField(key: string): Step {
  const capture = (v: Obj) => ({ val: v[key], idx: keyIndex(v, key) });
  return src =>
    lens<Obj, Obj, { val: unknown; idx: number }>(src, {
      init: ([v]) => capture(v),
      step: ([v], c) => (key in v ? capture(v) : c),
      fwd: ([v]) => omit(v, key),
      bwd: (target: Obj, _s, c) => ({
        updates: [insertAt(target, key, c.val, c.idx)],
        complement: c,
      }),
    });
}

/** Move several top-level fields into a sub-object. Bijective. */
export function nestFields(keys: readonly string[], under: string): Step {
  return src =>
    lens(
      src,
      (v: Obj) => nest(v, keys, under),
      (t: Obj) => unnest(t, keys, under),
    );
}

/** How to split one field into two and rejoin them. */
export interface SplitSpec {
  split: (whole: string) => [string, string];
  join: (a: string, b: string) => string;
}

/** Split one string field into two (e.g. `owner` → `firstName`/`lastName`).
 *  The split is generally ambiguous, so the chosen halves live in the
 *  complement: the exact split the user picked round-trips through the
 *  joined source instead of being re-guessed. This is the lens Cambria
 *  structurally can't express (no invertible `split`). */
export function splitField(key: string, into: readonly [string, string], spec: SplitSpec): Step {
  const [ka, kb] = into;
  const part = (whole: string) => {
    const [a, b] = spec.split(whole);
    return { a, b };
  };
  return src =>
    lens<Obj, Obj, { a: string; b: string }>(src, {
      init: ([v]) => part(String(v[key] ?? "")),
      step: ([v], c) => {
        const whole = String(v[key] ?? "");
        return spec.join(c.a, c.b) === whole ? c : part(whole);
      },
      fwd: ([v], c) => insertPair(v, key, ka, c.a, kb, c.b),
      bwd: (target: Obj, _s) => {
        const a = String(target[ka] ?? "");
        const b = String(target[kb] ?? "");
        return {
          updates: [collapsePair(target, ka, kb, key, spec.join(a, b))],
          complement: { a, b },
        };
      },
    });
}

/** A stateful 1→1 value transform on a single field, optionally renaming it.
 *  The workhorse for value-level schema change: enum widen/narrow, formatting
 *  codecs, array⇄string, unit changes. Anything the transform discards lives
 *  in the complement `C`. */
export interface FieldMap<C> {
  /** New key name in the view (defaults to the source key). */
  rename?: string;
  init: (srcVal: unknown) => C;
  /** Refresh the complement from a (possibly externally-changed) source. */
  step?: (srcVal: unknown, c: C) => C;
  fwd: (srcVal: unknown, c: C) => unknown;
  bwd: (viewVal: unknown, srcVal: unknown, c: C) => { src: unknown; complement: C };
}

export function mapField<C>(key: string, m: FieldMap<C>): Step {
  const viewKey = m.rename ?? key;
  return src =>
    lens<Obj, Obj, C>(src, {
      init: ([v]) => m.init(v[key]),
      step: ([v], c) => (m.step ? m.step(v[key], c) : c),
      fwd: ([v], c) => replaceKey(v, key, viewKey, m.fwd(v[key], c)),
      bwd: (target: Obj, [v], c) => {
        const r = m.bwd(target[viewKey], v[key], c);
        return { updates: [replaceKey(target, viewKey, key, r.src)], complement: r.complement };
      },
    });
}
