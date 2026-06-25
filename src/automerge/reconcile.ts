// reconcile.ts — bring an Automerge document to equal a plain POJO with the
// *minimum* mutations, so concurrent edits merge instead of clobbering.
//
// Automerge's docs warn that spread-assignment (`d.x = {...d.x, k}`) replaces the
// whole object and destroys its merge history. The reactive side, by contrast,
// hands us a fresh immutable snapshot on every write (spread-replace all the way
// up). `reconcile` bridges the two: called inside `handle.change`, it walks the
// live doc against the snapshot and emits only the ops that actually differ —
// `updateText` for strings (char-level), in-place splices for lists, recursive
// descent for objects, scalar sets for the rest.
//
// List handling is positional by default: element-wise in place, with a tail
// push/truncate. Correct for edits/appends/truncations, but a reorder or mid
// insert rewrites every shifted slot's scalars — merge-hostile. Pass `by` for
// identity-keyed reconciliation (mirrors the `eachBy` lens's `by`): a longest
// common subsequence keeps shared elements in place and emits minimal keyed
// splices/inserts for the rest, so reorders and mid-inserts merge cleanly.

import { updateText } from "@automerge/automerge-repo";

// biome-ignore lint/suspicious/noExplicitAny: Automerge change proxies are untyped
type Any = any;

/** Stable identity key for a list element; return a primitive. `undefined` (or a
 *  collision) on any element makes that list fall back to positional. */
export type By = (element: unknown) => unknown;

/** Predicate over an object key (or list index): return `true` to *replace* that
 *  field's value wholesale (a scalar assignment → an Automerge `put`) instead of
 *  recursively merging into it. Use this for opaque JSON blobs that a downstream
 *  bridge can only consume as whole-object puts — e.g. tldraw's `richText`, whose
 *  patch applier rejects nested text `splice`s and mis-reads nested `del`s. The
 *  value is still only written when it actually differs, so unrelated commits
 *  don't churn it. */
export type Replace = (key: string | number) => boolean;

/** Reconcile context threaded through the recursion: keyed-list identity (`by`)
 *  and the wholesale-`replace` predicate. */
interface Ctx {
  by?: By;
  replace?: Replace;
}

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === "object" && !Array.isArray(v);

/** Structural equality, used to skip a wholesale `replace` write when the field
 *  is already deep-equal (so reconciling an unrelated change doesn't rewrite it).
 *  Note `a` may be a live Automerge proxy: its *lists* don't expose indices via
 *  `Object.keys`, so arrays are walked by length/index, not key enumeration. */
function deepEq(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (a === null || b === null || typeof a !== "object" || typeof b !== "object") return false;
  const aArr = Array.isArray(a);
  if (aArr !== Array.isArray(b)) return false;
  if (aArr) {
    const av = a as unknown[];
    const bv = b as unknown[];
    if (av.length !== bv.length) return false;
    for (let i = 0; i < av.length; i++) if (!deepEq(av[i], bv[i])) return false;
    return true;
  }
  const ak = Object.keys(a as object);
  const bk = Object.keys(b as object);
  if (ak.length !== bk.length) return false;
  for (const k of ak) {
    if (!Object.hasOwn(b as object, k)) return false;
    if (!deepEq((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k])) return false;
  }
  return true;
}

/** Minimally mutate the Automerge node `target` (inside `handle.change`) to equal
 *  the plain value `next`. Pass `by` for identity-keyed list reconciliation, and
 *  `replace` to assign chosen keys wholesale instead of merging into them. */
export function reconcile(target: Any, next: Any, by?: By, replace?: Replace): void {
  const ctx: Ctx = { by, replace };
  if (Array.isArray(next) && Array.isArray(target)) reconcileList(target, next, ctx);
  else reconcileObject(target, next, ctx);
}

function reconcileObject(target: Any, next: Any, ctx: Ctx): void {
  for (const k of Object.keys(target)) if (!(k in next)) delete target[k];
  for (const k of Object.keys(next)) setKey(target, k, target[k], next[k], false, ctx);
}

function reconcileList(target: Any[], next: Any[], ctx: Ctx): void {
  if (ctx.by !== undefined && reconcileKeyed(target, next, ctx)) return;
  const shared = Math.min(target.length, next.length);
  for (let i = 0; i < shared; i++) setKey(target, i, target[i], next[i], true, ctx);
  if (next.length < target.length) target.splice(next.length);
  else for (let i = target.length; i < next.length; i++) target.push(next[i]);
}

/** Keyed list reconcile via LCS. Returns false (→ positional fallback) when keys
 *  aren't total + unique on either side. */
function reconcileKeyed(target: Any[], next: Any[], ctx: Ctx): boolean {
  const by = ctx.by as By;
  const tKeys = target.map(by);
  const nKeys = next.map(by);
  if (!totalUnique(tKeys) || !totalUnique(nKeys)) return false;

  const keep = lcs(tKeys, nKeys);
  let i = 0; // cursor into `target`, which mutates as we splice
  for (let n = 0; n < next.length; n++) {
    if (keep.has(nKeys[n])) {
      while (i < target.length && !keep.has(by(target[i]))) target.splice(i, 1);
      setKey(target, i, target[i], next[n], true, ctx); // same identity → merge edits
      i++;
    } else {
      target.splice(i, 0, next[n]); // insert (new key, or a moved element re-placed)
      i++;
    }
  }
  if (i < target.length) target.splice(i);
  return true;
}

function totalUnique(keys: unknown[]): boolean {
  if (keys.some(k => k === undefined)) return false;
  return new Set(keys).size === keys.length;
}

/** Keys of the longest common subsequence of `a` and `b` (`===` on keys). */
function lcs(a: unknown[], b: unknown[]): Set<unknown> {
  const n = a.length;
  const m = b.length;
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--)
    for (let j = m - 1; j >= 0; j--)
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
  const keep = new Set<unknown>();
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      keep.add(a[i]);
      i++;
      j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) i++;
    else j++;
  }
  return keep;
}

function setKey(
  parent: Any,
  key: string | number,
  a: unknown,
  b: unknown,
  inList: boolean,
  ctx: Ctx,
): void {
  // Wholesale-replace keys bypass the merge entirely: assign the value so
  // Automerge emits a single `put` of the (re)built subtree — no nested text
  // `splice`s, no `del`s — which is all some bridges can apply. Guard on
  // deep-equality so reconciling an unrelated change doesn't rewrite it.
  if (ctx.replace?.(key)) {
    if (!deepEq(a, b)) parent[key] = b;
    return;
  }
  if (typeof b === "string" && typeof a === "string") {
    // Char-level merge for object text fields; list string elements just assign
    // (path-relative updateText targets a keyed field, not an array slot).
    if (a !== b) {
      if (inList) parent[key] = b;
      else updateText(parent, [key as string], b);
    }
  } else if (Array.isArray(b) && Array.isArray(a)) {
    reconcileList(a, b, ctx);
  } else if (isPlainObject(b) && isPlainObject(a)) {
    reconcileObject(a, b, ctx);
  } else if (a !== b) {
    parent[key] = b;
  }
}
