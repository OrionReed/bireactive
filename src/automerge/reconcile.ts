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

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === "object" && !Array.isArray(v);

/** Minimally mutate the Automerge node `target` (inside `handle.change`) to equal
 *  the plain value `next`. Pass `by` for identity-keyed list reconciliation. */
export function reconcile(target: Any, next: Any, by?: By): void {
  if (Array.isArray(next) && Array.isArray(target)) reconcileList(target, next, by);
  else reconcileObject(target, next, by);
}

function reconcileObject(target: Any, next: Any, by?: By): void {
  for (const k of Object.keys(target)) if (!(k in next)) delete target[k];
  for (const k of Object.keys(next)) setKey(target, k, target[k], next[k], false, by);
}

function reconcileList(target: Any[], next: Any[], by?: By): void {
  if (by !== undefined && reconcileKeyed(target, next, by)) return;
  const shared = Math.min(target.length, next.length);
  for (let i = 0; i < shared; i++) setKey(target, i, target[i], next[i], true, by);
  if (next.length < target.length) target.splice(next.length);
  else for (let i = target.length; i < next.length; i++) target.push(next[i]);
}

/** Keyed list reconcile via LCS. Returns false (→ positional fallback) when keys
 *  aren't total + unique on either side. */
function reconcileKeyed(target: Any[], next: Any[], by: By): boolean {
  const tKeys = target.map(by);
  const nKeys = next.map(by);
  if (!totalUnique(tKeys) || !totalUnique(nKeys)) return false;

  const keep = lcs(tKeys, nKeys);
  let i = 0; // cursor into `target`, which mutates as we splice
  for (let n = 0; n < next.length; n++) {
    if (keep.has(nKeys[n])) {
      while (i < target.length && !keep.has(by(target[i]))) target.splice(i, 1);
      setKey(target, i, target[i], next[n], true, by); // same identity → merge edits
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
  by?: By,
): void {
  if (typeof b === "string" && typeof a === "string") {
    // Char-level merge for object text fields; list string elements just assign
    // (path-relative updateText targets a keyed field, not an array slot).
    if (a !== b) {
      if (inList) parent[key] = b;
      else updateText(parent, [key as string], b);
    }
  } else if (Array.isArray(b) && Array.isArray(a)) {
    reconcileList(a, b, by);
  } else if (isPlainObject(b) && isPlainObject(a)) {
    reconcileObject(a, b, by);
  } else if (a !== b) {
    parent[key] = b;
  }
}
