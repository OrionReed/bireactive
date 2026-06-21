// @bireactive/automerge — view an Automerge CRDT through the reactive graph.
//
// `connectDoc(handle)` turns a `DocHandle` into a `Writable<Cell<T>>` plus a deep
// `store`, synced both ways. Lens/`store` projections off that one cell give you
// many schemas over a single shared doc with no privileged "primary" — the CRDT
// is the apex, every view is a leg. `reconcile` is the doc-side diff that keeps
// writes merge-friendly; it's exported for custom bridges.
//
// Automerge is an optional peer dependency: import this entry only when you've
// installed `@automerge/automerge-repo`.

export type { DocBridge } from "./doc-cell";
export { connectDoc, docCell, docStore } from "./doc-cell";
export { reconcile } from "./reconcile";
