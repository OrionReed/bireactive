// doc-cell.ts — bridge an Automerge document to the reactive graph.
//
// An Automerge `DocHandle` is a writable source of truth that lives outside the
// cell graph: it emits `change` events and is mutated through `handle.change`.
// `connectDoc` wires it to a `Writable<Cell<T>>` in both directions so the doc
// becomes an ordinary cell you can lens, `store`, and bind in JSX.
//
//   doc → cell : on every `change`, snapshot the doc into the cell.
//   cell → doc : an effect mirrors each commit back via `reconcile` (minimal
//                ops, so concurrent edits merge).
//
// The cell uses structural equality, so the two directions converge in one hop:
// a write reconciles into the doc, the doc echoes a `change`, the snapshot is
// deep-equal to what we already hold, and the engine stops. No flags, no echo
// storm. Because the doc is the apex, many independent lens/`store` views can
// hang off one `connectDoc` — that's the symmetric, no-primary topology: the
// CRDT is the shared core, every schema is just a projection.

import type { DocHandle } from "@automerge/automerge-repo";
import { type Cell, cell, effect, type Writable } from "../core/cell";
import { type Store, store } from "../core/store";
import { type By, type Replace, reconcile } from "./reconcile";

/** Bridge options shared by every `connect*` entry. */
export interface DocOptions {
  /** Identity key for list elements, enabling keyed reconciliation (see `reconcile`). */
  by?: By;
  /** Keys whose values are written wholesale (a `put`) rather than deep-merged —
   *  for opaque blobs a downstream bridge can only apply as whole-object puts
   *  (see `reconcile`'s `Replace`). */
  replace?: Replace;
}

function deepEqual(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (a === null || b === null || typeof a !== "object" || typeof b !== "object") return false;
  const aArr = Array.isArray(a);
  if (aArr !== Array.isArray(b)) return false;
  const ak = Object.keys(a as object);
  const bk = Object.keys(b as object);
  if (ak.length !== bk.length) return false;
  for (const k of ak) {
    if (!Object.hasOwn(b as object, k)) return false;
    if (!deepEqual((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]))
      return false;
  }
  return true;
}

/** Lifecycle shared by every bridge: retarget the doc, detach both directions. */
export interface DocLifecycle<T> {
  /** Point the same cell at a different doc, keeping every bound lens/view alive. */
  retarget: (handle: DocHandle<T>) => void;
  /** Detach both directions (call from `disconnectedCallback`). */
  dispose: () => void;
}

/** Doc bridged to a writable cell; writes (direct or via a lens) flow to the CRDT. */
export interface CellBridge<T> extends DocLifecycle<T> {
  cell: Writable<Cell<T>>;
}

/** Doc bridged to a deep `store` — `bridge.store.a.b.value = x` commits to the doc. */
export interface StoreBridge<T> extends DocLifecycle<T> {
  store: Store<T>;
}

/** Doc bridged to both a cell and a deep store. */
export interface DocBridge<T> extends CellBridge<T>, StoreBridge<T> {}

/** Wire an existing cell to a handle in both directions; returns an unbind. */
function bind<T extends object>(
  c: Writable<Cell<T>>,
  handle: DocHandle<T>,
  by?: By,
  replace?: Replace,
): () => void {
  const onChange = (): void => {
    c.value = structuredClone(handle.doc()) as T;
  };
  handle.on("change", onChange);
  const stop = effect(() => {
    const next = c.value;
    handle.change((d: T) => reconcile(d, next, by, replace));
  });
  return () => {
    stop();
    handle.off("change", onChange);
  };
}

/** Core: a doc-backed cell plus lifecycle. The cell projections layer on top. */
function connect<T extends object>(handle: DocHandle<T>, opts?: DocOptions): CellBridge<T> {
  const by = opts?.by;
  const replace = opts?.replace;
  const c = cell<T>(structuredClone(handle.doc()) as T, { equals: deepEqual, name: "doc" });
  let unbind = bind(c, handle, by, replace);
  return {
    cell: c,
    retarget: next => {
      unbind();
      // Seed the cell from the new doc *before* re-binding, so the cell→doc
      // effect doesn't push the old value into the freshly targeted doc.
      c.value = structuredClone(next.doc()) as T;
      unbind = bind(c, next, by, replace);
    },
    dispose: () => unbind(),
  };
}

/** Connect a `DocHandle` to a reactive cell, syncing both ways. */
export function connectCell<T extends object>(
  handle: DocHandle<T>,
  opts?: DocOptions,
): CellBridge<T> {
  return connect(handle, opts);
}

/** Connect a `DocHandle` to a deep `store`, syncing both ways. */
export function connectStore<T extends object>(
  handle: DocHandle<T>,
  opts?: DocOptions,
): StoreBridge<T> {
  const { cell: c, retarget, dispose } = connect(handle, opts);
  return { store: store(c), retarget, dispose };
}

/** Connect a `DocHandle` to a reactive cell + store, syncing both ways. */
export function connectDoc<T extends object>(
  handle: DocHandle<T>,
  opts?: DocOptions,
): DocBridge<T> {
  const b = connect(handle, opts);
  return { ...b, store: store(b.cell) };
}
