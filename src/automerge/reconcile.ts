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
// List handling is intentionally simple for now: element-wise in place, with a
// tail push/truncate. Correct for edits/appends/truncations; a reorder or mid
// insert produces more ops than ideal. Identity-keyed list reconciliation is the
// obvious upgrade (mirror the `eachBy` lens's `by`).

import { updateText } from "@automerge/automerge-repo";

// biome-ignore lint/suspicious/noExplicitAny: Automerge change proxies are untyped
type Any = any;

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === "object" && !Array.isArray(v);

/** Minimally mutate the Automerge node `target` (inside `handle.change`) to equal
 *  the plain value `next`. */
export function reconcile(target: Any, next: Any): void {
  if (Array.isArray(next) && Array.isArray(target)) reconcileList(target, next);
  else reconcileObject(target, next);
}

function reconcileObject(target: Any, next: Any): void {
  for (const k of Object.keys(target)) if (!(k in next)) delete target[k];
  for (const k of Object.keys(next)) setKey(target, k, target[k], next[k], false);
}

function reconcileList(target: Any[], next: Any[]): void {
  const shared = Math.min(target.length, next.length);
  for (let i = 0; i < shared; i++) setKey(target, i, target[i], next[i], true);
  if (next.length < target.length) target.splice(next.length);
  else for (let i = target.length; i < next.length; i++) target.push(next[i]);
}

function setKey(parent: Any, key: string | number, a: unknown, b: unknown, inList: boolean): void {
  if (typeof b === "string" && typeof a === "string") {
    // Char-level merge for object text fields; list string elements just assign
    // (path-relative updateText targets a keyed field, not an array slot).
    if (a !== b) {
      if (inList) parent[key] = b;
      else updateText(parent, [key as string], b);
    }
  } else if (Array.isArray(b) && Array.isArray(a)) {
    reconcileList(a, b);
  } else if (isPlainObject(b) && isPlainObject(a)) {
    reconcileObject(a, b);
  } else if (a !== b) {
    parent[key] = b;
  }
}
