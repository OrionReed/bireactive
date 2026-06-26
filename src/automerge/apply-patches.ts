// apply-patches.ts — doc → cell incremental invalidation.
//
// The naive bridge re-snapshots the whole doc on every change
// (`structuredClone(handle.doc())`), giving every sub-object a fresh identity, so
// every field lens recomputes even where nothing changed. `applyPatches` instead
// walks the Automerge `change` patches and rebuilds only the spine to each changed
// value: ancestors are shallow-cloned (new identity), the changed value is taken
// from the post-change doc, and every untouched sibling keeps its prior reference.
// Unchanged slices stay `Object.is`-equal, so their lenses never fire.

import type { Patch, Prop } from "@automerge/automerge-repo";

type Bag = Record<Prop, unknown>;

const shallow = (v: unknown): unknown => (Array.isArray(v) ? v.slice() : { ...(v as object) });

function getIn(root: unknown, path: readonly Prop[]): unknown {
  let cur = root;
  for (const k of path) cur = (cur as Bag)[k];
  return cur;
}

/** Rebuild `prev` to match the post-change doc `after`, cloning only the spine to
 *  each patched value and sharing every untouched subtree by reference. */
export function applyPatches<T extends object>(prev: T, patches: Patch[], after: T): T {
  if (patches.length === 0) return prev;

  const root = shallow(prev) as Bag;
  const owned = new Set<unknown>([root]);

  // Descend `path`, shallow-cloning each container the first time we enter it so a
  // shared (prev) object is never mutated; returns the owned container at `path`.
  const spine = (path: readonly Prop[]): Bag => {
    let cur = root;
    for (const k of path) {
      let child = cur[k];
      if (!owned.has(child)) {
        child = shallow(child);
        owned.add(child);
        cur[k] = child;
      }
      cur = child as Bag;
    }
    return cur;
  };

  for (const p of patches) {
    const path = p.path;
    if (path.length === 0) return structuredClone(after);
    const last = path[path.length - 1]!;

    // Object-key deletion: rebuild the container minus the key, surviving siblings shared.
    if (p.action === "del" && typeof last === "string") {
      delete spine(path.slice(0, -1))[last];
      continue;
    }

    // Sequence ops (list splice/insert/del, text splice, range marks) point *into*
    // their container; drop the trailing index to replace the whole list/string.
    const seqOp =
      p.action === "del" ||
      p.action === "insert" ||
      p.action === "splice" ||
      p.action === "mark" ||
      p.action === "unmark";
    const vp = seqOp && typeof last === "number" ? path.slice(0, -1) : path;
    if (vp.length === 0) return structuredClone(after);
    spine(vp.slice(0, -1))[vp[vp.length - 1]!] = structuredClone(getIn(after, vp));
  }

  return root as T;
}
