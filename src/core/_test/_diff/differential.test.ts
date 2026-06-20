// Differential fuzz: live engine vs frozen pre-rewrite copy, on random
// bidirectional graphs. Plus an engine-independent PutGet ground truth.
//
// This is the green-light instrument for the backward rewrite — see harness.ts.

import { describe, expect, it } from "vitest";
import * as live from "../../cell";
import * as frozen from "./cell-frozen";
import {
  build,
  type Engine,
  type NodeSpec,
  type Op,
  type Recipe,
  run,
  tracesEqual,
  writable,
} from "./harness";

function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t ^= t + Math.imul(t ^ (t >>> 7), 61 | t);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const int = (r: () => number, lo: number, hi: number) => lo + Math.floor(r() * (hi - lo + 1));
const vecEq = (a: number[], b: number[]) =>
  a.length === b.length &&
  a.every((x, i) => x === b[i] || (Number.isNaN(x) && Number.isNaN(b[i]!)));
const nonzeroK = (r: () => number) => [-2, -1, 1, 2, 3][int(r, 0, 4)]!;

function genRecipe(r: () => number, allowDerive: boolean): Recipe {
  const nNodes = int(r, 1, 12);
  const nodes: NodeSpec[] = [{ kind: "source", init: int(r, -5, 5) }];
  const pickParents = (i: number): number[] => {
    const cnt = int(r, 1, Math.min(4, i));
    const pool = Array.from({ length: i }, (_, j) => j);
    for (let j = pool.length - 1; j > 0; j--) {
      const k = int(r, 0, j);
      [pool[j], pool[k]] = [pool[k]!, pool[j]!];
    }
    return pool.slice(0, cnt).sort((a, b) => a - b);
  };
  for (let i = 1; i < nNodes; i++) {
    const roll = r();
    if (allowDerive && roll < 0.15) {
      nodes.push({ kind: "derive1", parent: int(r, 0, i - 1), k: nonzeroK(r), b: int(r, -3, 3) });
    } else if (roll < 0.45) {
      nodes.push({
        kind: "lens1",
        parent: int(r, 0, i - 1),
        k: nonzeroK(r),
        b: int(r, -3, 3),
        readsSource: r() < 0.5,
      });
    } else if (roll < 0.6) {
      nodes.push({ kind: "merge", parent: int(r, 0, i - 1) });
    } else if (roll < 0.66) {
      nodes.push({ kind: "stateful1", parent: int(r, 0, i - 1) });
    } else if (roll < 0.72) {
      nodes.push({ kind: "stateMemo", parent: int(r, 0, i - 1) });
    } else if (roll < 0.85) {
      nodes.push({ kind: "skipN", parents: pickParents(i) });
    } else {
      nodes.push({ kind: "lensN", parents: pickParents(i), b: int(r, -3, 3) });
    }
  }
  const effects: number[] = [];
  for (let i = 0; i < nNodes; i++) if (r() < 0.3) effects.push(i);
  const writableIdx = nodes.map((n, i) => (writable(n) ? i : -1)).filter(i => i >= 0);
  const ops: Op[] = [];
  const nOps = int(r, 1, 20);
  for (let k = 0; k < nOps; k++) {
    if (r() < 0.6 && writableIdx.length > 0) {
      ops.push({ kind: "write", node: writableIdx[int(r, 0, writableIdx.length - 1)]!, val: int(r, -10, 10) });
    } else {
      ops.push({ kind: "read", node: int(r, 0, nNodes - 1) });
    }
  }
  return { nodes, effects, ops };
}

describe("differential: live engine matches frozen pre-rewrite copy", () => {
  it("agrees on observables across 20000 random mixed graphs", () => {
    const r = rng(0xbada55);
    let fails = 0;
    let firstFail: { iter: number; recipe: Recipe } | undefined;
    for (let iter = 0; iter < 20000; iter++) {
      const recipe = genRecipe(r, true);
      const a = run(live, recipe);
      const b = run(frozen, recipe);
      // Both engines must agree on whether an op is illegal (a throw). The reads
      // recorded up to that point must match. Post-throw `final`/`fires` are NOT
      // a behavioral contract — a caught illegal write (e.g. write-through a
      // computed) leaves implementation-defined retained state — so only clean
      // (non-throwing) runs are held to full trace equality.
      const ok =
        a.threw === b.threw &&
        (a.threw ? vecEq(a.reads, b.reads) : tracesEqual(a, b));
      if (!ok) {
        fails++;
        if (firstFail === undefined) firstFail = { iter, recipe };
      }
    }
    if (firstFail !== undefined) {
      console.error("DIFF first failing recipe:", JSON.stringify(firstFail.recipe));
      console.error("live :", JSON.stringify(run(live, firstFail.recipe)));
      console.error("frozen:", JSON.stringify(run(frozen, firstFail.recipe)));
    }
    expect(fails).toBe(0);
  });
});

describe("ground truth (trusts neither engine): PutGet on invertible-affine chains", () => {
  // A pure invertible lens1 chain is end-to-end invertible (no shared sources,
  // no lossiness), so writing a target to the top must read back exactly. This
  // is a spec, not a diff: it adjudicates a live-vs-frozen disagreement. (Fan-in
  // PutGet needs disjoint-source trees; covered by laws/soundness.)
  function genChain(r: () => number): Recipe {
    const depth = int(r, 1, 10);
    const nodes: NodeSpec[] = [{ kind: "source", init: int(r, -5, 5) }];
    for (let i = 1; i <= depth; i++) {
      nodes.push({
        kind: "lens1",
        parent: i - 1,
        k: nonzeroK(r),
        b: int(r, -3, 3),
        readsSource: r() < 0.5,
      });
    }
    return { nodes, effects: [], ops: [] };
  }

  function putGetHolds(rx: Engine, recipe: Recipe, target: number): boolean {
    const top = recipe.nodes.length - 1;
    const t = run(rx, {
      ...recipe,
      ops: [
        { kind: "write", node: top, val: target },
        { kind: "read", node: top },
      ],
    });
    if (t.threw) return false;
    return Math.abs(t.reads[t.reads.length - 1]! - target) < 1e-6;
  }

  it("both engines satisfy PutGet across 3000 invertible chains", () => {
    const r = rng(0x1cedc0de);
    let liveFails = 0;
    let frozenFails = 0;
    for (let iter = 0; iter < 3000; iter++) {
      const recipe = genChain(r);
      const target = int(r, -50, 50);
      if (!putGetHolds(live, recipe, target)) liveFails++;
      if (!putGetHolds(frozen, recipe, target)) frozenFails++;
    }
    expect({ liveFails, frozenFails }).toEqual({ liveFails: 0, frozenFails: 0 });
  });
});

describe("structural: deep back-write is stack-safe (de-recursion)", () => {
  // chain of `depth` invertible lens1 (fwd x+1). top = source + depth.
  function chain(depth: number): Recipe {
    const nodes: NodeSpec[] = [{ kind: "source", init: 0 }];
    for (let i = 1; i <= depth; i++) {
      nodes.push({ kind: "lens1", parent: i - 1, k: 1, b: 1, readsSource: false });
    }
    return { nodes, effects: [], ops: [] };
  }

  // Read the SOURCE (O(1), no getter) to isolate the BACKWARD traversal — a deep
  // forward read recurses in the lens getter, which is a separate concern.
  it("live resolves a 100k-deep back-write (no overflow); source absorbs it", () => {
    const depth = 100_000;
    const g = build(live, chain(depth));
    g.write(depth, 5); // write the top view; markDown + writeBack span 100k levels
    g.settle();
    expect(g.read(0)).toBe(5 - depth); // source absorbed the whole offset
  });

  it("frozen overflows at that depth — the back-recursion this rewrite removed", () => {
    const depth = 100_000;
    const g = build(frozen, chain(depth));
    expect(() => {
      g.write(depth, 5);
      g.settle();
      void g.read(0); // reading the source drives the (recursive) back-resolve
    }).toThrow(RangeError);
  });
});
