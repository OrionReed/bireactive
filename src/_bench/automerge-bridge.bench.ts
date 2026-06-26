// doc → cell invalidation cost: the old full-snapshot path
// (`structuredClone(handle.doc())`) vs patch-driven `applyPatches`, on a
// tldraw-shaped store (many shapes, each carrying a fat base64-ish asset). The
// baseline walks the whole doc per change; applyPatches walks only the spine to
// the edited shape — so the gap should widen with shape count and asset size.

import "../_test/setup";
import type { DocHandle, Patch } from "@automerge/automerge-repo";
import { initSubduction, Repo } from "@automerge/automerge-repo";
import { applyPatches } from "@bireactive/automerge/apply-patches";
import { bench, do_not_optimize, group, run } from "mitata";

await initSubduction();

type Shape = { props: { text: string; asset: string } };
type Doc = { store: Record<string, Shape> };

function makeDoc(nShapes: number, assetBytes: number): Doc {
  const asset = "x".repeat(assetBytes);
  const store: Record<string, Shape> = {};
  for (let i = 0; i < nShapes; i++) store[`shape:${i}`] = { props: { text: `t${i}`, asset } };
  return { store };
}

// Capture the patches/after of the most recent change so the bench body can feed
// them to applyPatches (mirrors what the doc-cell `onChange` receives).
function lastChange<T>(h: DocHandle<T>) {
  const box: { patches: Patch[]; after: T } = { patches: [], after: undefined as T };
  h.on("change", p => {
    box.patches = p.patches;
    box.after = p.patchInfo.after as T;
  });
  return box;
}

for (const N of [100, 1000]) {
  for (const assetBytes of [200, 4000]) {
    group(`one shape text edit — N=${N} shapes, asset=${assetBytes}B`, () => {
      {
        const h = new Repo({}).create<Doc>(makeDoc(N, assetBytes));
        bench("baseline: structuredClone(whole doc)", () => {
          h.change(d => {
            d.store["shape:0"]!.props.text += "!";
          });
          do_not_optimize(structuredClone(h.doc()));
        });
      }
      {
        const h = new Repo({}).create<Doc>(makeDoc(N, assetBytes));
        const last = lastChange<Doc>(h);
        let prev = structuredClone(h.doc());
        bench("applyPatches: spine clone", () => {
          h.change(d => {
            d.store["shape:0"]!.props.text += "!";
          });
          prev = applyPatches(prev, last.patches, last.after);
          do_not_optimize(prev);
        });
      }
    });
  }
}

await run({ format: "mitata" });
