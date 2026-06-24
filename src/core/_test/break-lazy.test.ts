// Adversarial breakers for the lazy backward engine. These target seams the
// generic suite can't reach: read-timing (laziness) transparency, shared-source
// DIAMONDS, deep-recursion stack safety, merge composition, re-entrancy, and
// stateful-complement correctness under random interleaving (the buffer-
// rotation / own-vs-external machinery touched by the latest representation
// work).
//
// Two valid metamorphic oracles, chosen to avoid false positives from the
// engine's *intentional* order-dependence on conflicting writes:
//
//   A. Independent-cone transparency: when writes touch pairwise-disjoint
//      cones they COMMUTE, so demand-gating must be transparent — final state
//      is identical whether reads are deferred or interleaved (incrementally
//      forcing resolution). A divergence is a lost/stranded write or leaked
//      global state across cones.
//   B. Single-write read-order independence: one write can't conflict with
//      itself, so resolving its cone by reading sources in ANY order must land
//      every source in the same place. A divergence is the "reading one source
//      strands a co-writer of a shared source" bug class, over random diamonds.

import { describe, expect, it } from "vitest";
import { batch, type Cell, cell, derive, effect, lens, SKIP, settle } from "../index";

// ── seeded PRNG (mulberry32) ──────────────────────────────────────────────
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
const pick = <T>(r: () => number, xs: T[]): T => xs[int(r, 0, xs.length - 1)]!;
const close = (a: number, b: number) =>
  Math.abs(a - b) < 1e-6 || (!Number.isFinite(a) && !Number.isFinite(b));

interface Node {
  cell: Cell<number>;
  read(): number;
  write(v: number): void;
}
const wrap = (c: Cell<number>): Node => ({
  cell: c,
  read: () => c.value as number,
  write: v => ((c as { value: number }).value = v),
});
const affineView = (parent: Cell<number>, k: 1 | -1, b: number): Cell<number> =>
  lens(
    parent as never,
    ((x: number) => x * k + b) as never,
    ((t: number) => (t - b) / k) as never,
  ) as unknown as Cell<number>;
const fanView = (parents: Cell<number>[]): Cell<number> => {
  const n = parents.length;
  return lens(
    parents as never,
    ((vals: number[]) => vals.reduce((a, b) => a + b, 0)) as never,
    ((t: number) => parents.map(() => t / n)) as never,
  ) as unknown as Cell<number>;
};

// ════════════════════════════════════════════════════════════════════════
// A. Independent-cone transparency (writes commute ⇒ lazy ≡ eager).
// ════════════════════════════════════════════════════════════════════════

// A tree of affine + fan views over its OWN fresh sources (no sharing).
type TreeSpec =
  | { kind: "src"; init: number }
  | { kind: "affine"; k: 1 | -1; b: number; child: TreeSpec }
  | { kind: "fan"; kids: TreeSpec[] };

function genTree(r: () => number, depth: number): TreeSpec {
  if (depth <= 0 || r() < 0.3) return { kind: "src", init: int(r, -5, 5) };
  if (r() < 0.6)
    return {
      kind: "affine",
      k: r() < 0.5 ? 1 : -1,
      b: int(r, -4, 4),
      child: genTree(r, depth - 1),
    };
  const w = int(r, 2, 3);
  return { kind: "fan", kids: Array.from({ length: w }, () => genTree(r, depth - 1)) };
}

function buildTree(t: TreeSpec, all: Node[]): { root: Node; sources: Node[] } {
  if (t.kind === "src") {
    const node = wrap(cell(t.init) as unknown as Cell<number>);
    all.push(node);
    return { root: node, sources: [node] };
  }
  if (t.kind === "affine") {
    const { root, sources } = buildTree(t.child, all);
    const node = wrap(affineView(root.cell, t.k, t.b));
    all.push(node);
    return { root: node, sources };
  }
  const built = t.kids.map(k => buildTree(k, all));
  const node = wrap(fanView(built.map(b => b.root.cell)));
  all.push(node);
  return { root: node, sources: built.flatMap(b => b.sources) };
}

describe("lazy ≡ eager: transparency over independent (commuting) cones", () => {
  for (const mode of ["defer", "partial"] as const) {
    it(`interleaved reads don't change final state (${mode})`, () => {
      const r = rng(mode === "defer" ? 0x51a1 : 0x7e2d);
      for (let iter = 0; iter < 1500; iter++) {
        const k = int(r, 1, 4);
        const specs = Array.from({ length: k }, () => genTree(r, int(r, 1, 4)));
        const lazyAll: Node[] = [];
        const eagerAll: Node[] = [];
        const lazyRoots: Node[] = [];
        const eagerRoots: Node[] = [];
        const lazySrc: Node[] = [];
        const eagerSrc: Node[] = [];
        for (const s of specs) {
          const l = buildTree(s, lazyAll);
          const e = buildTree(s, eagerAll);
          lazyRoots.push(l.root);
          eagerRoots.push(e.root);
          lazySrc.push(...l.sources);
          eagerSrc.push(...e.sources);
        }
        const ops = int(r, 1, 12);
        for (let o = 0; o < ops; o++) {
          const ri = int(r, 0, k - 1);
          const val = int(r, -20, 20);
          lazyRoots[ri]!.write(val);
          eagerRoots[ri]!.write(val);
          for (const s of eagerSrc) s.read(); // eager twin: force resolution every step
          if (mode === "partial") lazyAll[int(r, 0, lazyAll.length - 1)]!.read();
        }
        for (let s = 0; s < lazySrc.length; s++) {
          const a = lazySrc[s]!.read();
          const b = eagerSrc[s]!.read();
          if (!close(a, b))
            throw new Error(`src#${s} lazy=${a} eager=${b} iter=${iter}\n${JSON.stringify(specs)}`);
        }
        for (let v = 0; v < lazyAll.length; v++) {
          const a = lazyAll[v]!.read();
          const b = eagerAll[v]!.read();
          if (!close(a, b))
            throw new Error(
              `view#${v} lazy=${a} eager=${b} iter=${iter}\n${JSON.stringify(specs)}`,
            );
        }
      }
    });
  }
});

// ════════════════════════════════════════════════════════════════════════
// B. Single-write read-order independence over shared-source / diamond DAGs.
// ════════════════════════════════════════════════════════════════════════

type ViewSpec = { kind: "affine"; p: number; k: 1 | -1; b: number } | { kind: "fan"; ps: number[] };
interface DagSpec {
  m: number;
  inits: number[];
  views: ViewSpec[];
}

function genDag(r: () => number): DagSpec {
  const m = int(r, 1, 4);
  const inits = Array.from({ length: m }, () => int(r, -5, 5));
  const nViews = int(r, 1, 8);
  const views: ViewSpec[] = [];
  for (let i = 0; i < nViews; i++) {
    const avail = m + i;
    if (r() < 0.5) {
      views.push({
        kind: "affine",
        p: int(r, 0, avail - 1),
        k: r() < 0.5 ? 1 : -1,
        b: int(r, -4, 4),
      });
    } else {
      const want = Math.min(avail, int(r, 2, 3));
      const ps = new Set<number>();
      let g = 0;
      while (ps.size < want && g++ < 40) ps.add(int(r, 0, avail - 1));
      const arr = [...ps];
      views.push(
        arr.length >= 2 ? { kind: "fan", ps: arr } : { kind: "affine", p: arr[0] ?? 0, k: 1, b: 0 },
      );
    }
  }
  return { m, inits, views };
}

function buildDag(spec: DagSpec): Node[] {
  const nodes: Node[] = [];
  for (let i = 0; i < spec.m; i++)
    nodes.push(wrap(cell(spec.inits[i]!) as unknown as Cell<number>));
  for (const vs of spec.views) {
    nodes.push(
      wrap(
        vs.kind === "affine"
          ? affineView(nodes[vs.p]!.cell, vs.k, vs.b)
          : fanView(vs.ps.map(p => nodes[p]!.cell)),
      ),
    );
  }
  return nodes;
}

describe("single-write read-order independence over diamonds", () => {
  it("one write resolves identically under any source read order", () => {
    const r = rng(0xd1a3);
    for (let iter = 0; iter < 3000; iter++) {
      const spec = genDag(r);
      const tgt = spec.m + int(r, 0, spec.views.length - 1);
      const val = int(r, -30, 30);
      const orders: number[][] = [];
      const idents = Array.from({ length: spec.m }, (_u, i) => i);
      orders.push(idents);
      orders.push([...idents].reverse());
      orders.push([...idents].sort(() => r() - 0.5));
      const finals: number[][] = orders.map(order => {
        const nodes = buildDag(spec);
        nodes[tgt]!.write(val);
        for (const i of order) nodes[i]!.read(); // resolve sources in this order
        return idents.map(i => nodes[i]!.read());
      });
      for (let c = 1; c < finals.length; c++) {
        for (let s = 0; s < spec.m; s++) {
          if (!close(finals[0]![s]!, finals[c]![s]!)) {
            throw new Error(
              `read-order strand iter=${iter} src#${s}: ${finals[0]![s]} vs ${finals[c]![s]}\n${JSON.stringify(spec)} tgt=${tgt} val=${val}`,
            );
          }
        }
      }
    }
  });
});

// ════════════════════════════════════════════════════════════════════════
// C. Deep-recursion stack safety.
// ════════════════════════════════════════════════════════════════════════

describe("deep recursion: backward resolve/write stack safety", () => {
  // FINDING: backward resolution recurses per chain level TWICE (resolveCone
  // ascends + writeBack descends), so a 1→1 lens chain overflows the stack at
  // depth ~1.5k. The forward engine also recurses (overflows ~50k) — neither is
  // fully iterative — but backward's ceiling is ~30× lower. Both depths are
  // pathological for lens chains; this pins a healthy depth and documents the
  // ceiling. (A fully iterative spine would lift it; see report.)
  for (const D of [1000]) {
    it(`affine chain depth ${D}: back-write resolves correctly`, () => {
      let cur = cell(0) as unknown as Cell<number>;
      const src = cur;
      for (let i = 0; i < D; i++) cur = affineView(cur, 1, 1);
      (cur as { value: number }).value = 123456;
      expect(src.value).toBe(123456 - D);
      expect(cur.value).toBe(123456);
    });
  }

  it(`fan width 8000: one view write fans out to all sources`, () => {
    const W = 8000;
    const sources = Array.from({ length: W }, () => cell(0) as unknown as Cell<number>);
    const view = fanView(sources as unknown as Cell<number>[]);
    (view as { value: number }).value = W;
    expect(sources[0]!.value).toBeCloseTo(1, 9);
    expect(view.value).toBeCloseTo(W, 6);
  });
});

// ════════════════════════════════════════════════════════════════════════
// D. Stateful complement under random interleaving (exact reference).
//    "stash" lens: view = source + offset; writing the view stores the offset
//    (offset = target − source) WITHOUT moving the source. Timing-stable
//    (step never mutates the complement), so the reference is exact — it
//    pins the buffer-rotation + source-reading-bwd + stash-propagation paths.
// ════════════════════════════════════════════════════════════════════════

describe("stateful stash lens: exact reference under interleaving", () => {
  it("matches the reference model over random op sequences", () => {
    const r = rng(0x57a5);
    for (let iter = 0; iter < 2000; iter++) {
      const s0 = int(r, -10, 10);
      const src = cell(s0) as unknown as Cell<number>;
      const view = lens(
        [src] as never,
        {
          init: () => 0,
          step: (_s: number[], c: number) => c,
          fwd: ([s]: number[], c: number) => s + c,
          bwd: (t: number, [s]: number[], _c: number) => ({
            updates: [SKIP],
            complement: t - s,
          }),
        } as never,
      ) as unknown as Cell<number>;
      let refS = s0;
      let refC = 0;
      const ops = int(r, 1, 16);
      for (let o = 0; o < ops; o++) {
        const k = int(r, 0, 3);
        if (k === 0) {
          const v = int(r, -20, 20);
          (src as { value: number }).value = v;
          refS = v;
        } else if (k === 1) {
          const t = int(r, -20, 20);
          (view as { value: number }).value = t;
          refC = t - refS;
        } else if (k === 2) {
          expect(view.value).toBeCloseTo(refS + refC, 9);
        } else {
          expect(src.value).toBeCloseTo(refS, 9);
        }
      }
      expect(view.value).toBeCloseTo(refS + refC, 9);
      expect(src.value).toBeCloseTo(refS, 9);
    }
  });
});

describe("stateful multi-source stash (n≥2): exact reference, exercises buffer rotation", () => {
  it("matches the reference over random interleavings", () => {
    const r = rng(0x5e2f);
    for (let iter = 0; iter < 1500; iter++) {
      const n = int(r, 2, 4);
      const inits = Array.from({ length: n }, () => int(r, -10, 10));
      const srcs = inits.map(v => cell(v) as unknown as Cell<number>);
      const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);
      const view = lens(
        srcs as never,
        {
          init: () => 0,
          step: (_s: number[], c: number) => c,
          fwd: (s: number[], c: number) => sum(s) + c,
          bwd: (t: number, s: number[], _c: number) => ({
            updates: s.map(() => SKIP),
            complement: t - sum(s),
          }),
        } as never,
      ) as unknown as Cell<number>;
      const refS = [...inits];
      let refC = 0;
      const ops = int(r, 1, 16);
      for (let o = 0; o < ops; o++) {
        const k = int(r, 0, 3);
        if (k === 0) {
          const i = int(r, 0, n - 1);
          const v = int(r, -20, 20);
          (srcs[i] as { value: number }).value = v;
          refS[i] = v;
        } else if (k === 1) {
          const t = int(r, -40, 40);
          (view as { value: number }).value = t;
          refC = t - sum(refS);
        } else if (k === 2) {
          expect(view.value).toBeCloseTo(sum(refS) + refC, 9);
        } else {
          const i = int(r, 0, n - 1);
          expect(srcs[i]!.value).toBeCloseTo(refS[i]!, 9);
        }
      }
      expect(view.value).toBeCloseTo(sum(refS) + refC, 9);
    }
  });
});

describe("stateful own-vs-external detection (the version-stamp gate)", () => {
  it("forgets the complement on an external source change but not on its own back-write", () => {
    const src = cell(10) as unknown as Cell<number>;
    // No `step`: the default refresh is `init` (→ 0), and the engine runs it only
    // when the source's version moves (an outside change), not on an own back-write.
    const view = lens(
      src as never,
      {
        init: () => 0,
        fwd: (s: number, c: number) => s + c,
        bwd: (t: number, s: number, _c: number) => ({
          update: SKIP,
          complement: t - s,
        }),
      } as never,
    ) as unknown as Cell<number>;

    expect(view.value).toBe(10); // first read: complement seeded to 0 → 10 + 0
    (view as { value: number }).value = 15; // own back-write: stores offset c = 5, source unmoved
    expect(view.value).toBe(15); // own: source version unchanged → no step → c = 5 kept
    expect(view.value).toBe(15); // idempotent re-read
    (src as { value: number }).value = 20; // EXTERNAL source change (bumps src.version)
    expect(view.value).toBe(20); // version moved → step (default init) → c forgotten (0)
  });
});

// ════════════════════════════════════════════════════════════════════════
// E. Merge composition.
// ════════════════════════════════════════════════════════════════════════

describe("merge composition breakers", () => {
  it("merge of two lens contributors folds last-writer-wins", () => {
    const s = cell(0) as unknown as Cell<number> & { merge(): Cell<number> };
    const m = (s as unknown as { merge: () => Cell<number> }).merge();
    const a = affineView(m, 1, 10); // a = m + 10
    const b = affineView(m, 1, 100); // b = m + 100
    (a as { value: number }).value = 15; // → m = 5
    (b as { value: number }).value = 205; // → m = 105
    // last-writer-wins fold on m: 105 (b's contribution dominates the merge)
    expect((s as unknown as Cell<number>).value).toBe(105);
  });

  it("merge with sum fold accumulates all contributors", () => {
    const s = cell(0) as unknown as Cell<number>;
    const m = (
      s as unknown as { merge: (f: (xs: readonly number[]) => number) => Cell<number> }
    ).merge((xs: readonly number[]) => xs.reduce((p, q) => p + q, 0));
    const a = affineView(m, 1, 0);
    const b = affineView(m, 1, 0);
    (a as { value: number }).value = 3;
    (b as { value: number }).value = 4;
    expect(s.value).toBe(7);
  });

  it("nested merge: a merge feeding another merge", () => {
    const root = cell(0) as unknown as Cell<number>;
    const m1 = (root as unknown as { merge: () => Cell<number> }).merge();
    const m2 = (m1 as unknown as { merge: () => Cell<number> }).merge();
    const v = affineView(m2, 1, 1);
    (v as { value: number }).value = 9; // m2 ← 8 → m1 ← 8 → root ← 8
    expect(root.value).toBe(8);
    expect(v.value).toBe(9);
  });
});

// ════════════════════════════════════════════════════════════════════════
// F. Re-entrancy & effects.
// ════════════════════════════════════════════════════════════════════════

describe("re-entrancy: back-writes observed by effects", () => {
  it("an effect observing a fan-in view sees a consistent post-write total", () => {
    const xs = [cell(0), cell(0), cell(0)] as unknown as Cell<number>[];
    const view = fanView(xs);
    const total = derive(() => xs.reduce((a, c) => a + (c.value as number), 0));
    const seen: number[] = [];
    effect(() => {
      seen.push(total.value as number);
    });
    (view as { value: number }).value = 9; // fans out to 3, 3, 3
    settle();
    expect(total.value).toBeCloseTo(9, 9);
    expect(seen[seen.length - 1]).toBeCloseTo(9, 9); // single consistent observation
  });

  it("a thrown bwd self-heals: a later valid write still commits", () => {
    const s = cell(0) as unknown as Cell<number>;
    const v = lens(
      s as never,
      ((x: number) => x) as never,
      ((t: number) => {
        if (t === 13) throw new Error("nope");
        return t;
      }) as never,
    ) as unknown as Cell<number>;
    (v as { value: number }).value = 13; // armed; put throws at resolution time
    expect(() => s.value).toThrow();
    (v as { value: number }).value = 7; // must not be stranded by the prior throw
    expect(s.value).toBe(7);
    expect(v.value).toBe(7);
  });

  it("reads interleaved inside a batch stay consistent", () => {
    const a = cell(0) as unknown as Cell<number>;
    const b = cell(0) as unknown as Cell<number>;
    const va = affineView(a, 1, 0);
    const vb = affineView(b, 1, 0);
    let mid = 0;
    batch(() => {
      (va as { value: number }).value = 5;
      mid = a.value; // resolve a mid-batch
      (vb as { value: number }).value = 9;
    });
    expect(mid).toBe(5);
    expect(a.value).toBe(5);
    expect(b.value).toBe(9);
  });

  it("a stash view (no source move) re-fires its observing effect", () => {
    const src = cell(10) as unknown as Cell<number>;
    const view = lens(
      [src] as never,
      {
        init: () => 0,
        step: (_s: number[], c: number) => c,
        fwd: ([x]: number[], c: number) => x + c,
        bwd: (t: number, [x]: number[], _c: number) => ({
          updates: [SKIP],
          complement: t - x,
        }),
      } as never,
    ) as unknown as Cell<number>;
    let seen = -1;
    effect(() => {
      seen = view.value as number;
    });
    expect(seen).toBe(10);
    (view as { value: number }).value = 15; // stash: stores offset, source unmoved
    settle();
    expect(seen).toBe(15); // effect must observe the view change despite no source write
    expect(src.value).toBe(10);
  });

  it("writing a sibling view from within an effect settles without glitch", () => {
    const a = cell(1) as unknown as Cell<number>;
    const b = cell(0) as unknown as Cell<number>;
    const mirror = affineView(a, 1, 0); // mirror == a
    // effect: keep b equal to a (via a write to b's identity view) whenever a changes
    const bView = affineView(b, 1, 0);
    effect(() => {
      const av = mirror.value as number;
      (bView as { value: number }).value = av;
    });
    (a as { value: number }).value = 42;
    settle();
    expect(b.value).toBe(42);
    expect(mirror.value).toBe(42);
  });
});

// ════════════════════════════════════════════════════════════════════════
// G. No unbounded reverse-edge growth (leak guard).
//
// The reverse edge a view registers on its parent (a `LensLink` in the parent's
// `childEdges` up-list) is a PERMANENT structural fact, spliced exactly once and
// deduped by the edge's own `linked` flag. It lives OFF the `flags`/`bflags`
// words precisely so a forward recompute (`_update`) that resets flags can't
// wipe it — a wipe would make every later back-write re-splice a duplicate, an
// unbounded `childEdges` + per-tick-time leak that only shows under sustained
// write→read churn.
// ════════════════════════════════════════════════════════════════════════

describe("no reverse-edge leak under sustained churn", () => {
  const subsLen = (c: Cell<number>) => {
    let n = 0;
    for (
      let e = (c as unknown as { childEdges?: { nextChild?: unknown } }).childEdges;
      e !== undefined;
      e = (e as { nextChild?: { nextChild?: unknown } }).nextChild
    )
      n++;
    return n;
  };

  it("source-reading chain: childEdges stays flat over many write→read ticks", () => {
    let cur = cell(0) as unknown as Cell<number>;
    const src = cur;
    const nodes: Cell<number>[] = [cur];
    for (let d = 0; d < 8; d++) {
      cur = lens(
        cur as never,
        ((x: number) => x + 1) as never,
        ((t: number, _s: number) => t - 1) as never, // arity-2 ⇒ source-reading put
      ) as unknown as Cell<number>;
      nodes.push(cur);
    }
    const top = cur;
    (top as { value: number }).value = 0;
    void src.value;
    const before = nodes.map(subsLen);
    for (let i = 1; i <= 500; i++) {
      (top as { value: number }).value = i;
      void src.value;
    }
    expect(nodes.map(subsLen)).toEqual(before); // no per-tick growth
    expect(Math.max(...before)).toBeLessThanOrEqual(1);
  });

  it("observed chain (forward recompute each tick) does not re-link duplicates", () => {
    let cur = cell(0) as unknown as Cell<number>;
    const src = cur;
    const mid = (cur = affineView(cur, 1, 1));
    const top = (cur = affineView(cur, 1, 1));
    (top as { value: number }).value = 0;
    void top.value; // realize the chain forward (recompute clears nothing it shouldn't)
    const m0 = subsLen(src) + subsLen(mid);
    for (let i = 1; i <= 300; i++) {
      (top as { value: number }).value = i;
      void top.value; // forward recompute every tick — would wipe a flags-bit dedup
    }
    expect(subsLen(src) + subsLen(mid)).toBe(m0);
  });
});

// ════════════════════════════════════════════════════════════════════════
// H. Last-settled primal (source-reading `bwd`) semantics.
//
// A source-reading `bwd(t, s)` linearizes at the parent's PRIMAL, read without
// a cascading recompute: the staged value for a source, the last-SETTLED
// `currentValue` for a derived (reverse-mode-AD's "reuse the stored
// linearization point"). The grounding (Foster/Pierce; Bancilhon–Spyratos):
//
//   • PutGet — get(put(v,s)) = v — is universally quantified over s, so a stale
//     primal STILL round-trips the view. Headline safety: no read timing can
//     break PutGet for a well-behaved lens.
//   • The only behaviour that shifts is PutPut (very-well-behaved) coalescing:
//     an unobserved burst linearizes every write at the last OBSERVED state
//     ("all at once"); reading between writes settles each ("incremental").
//     That is exactly the lazy engine's coalescing contract.
// ════════════════════════════════════════════════════════════════════════

interface AB {
  a: number;
  b: number;
}
// get = a (the view); put keeps the hidden field b, bumping it only when the
// view actually moves. Well-behaved (PutGet+GetPut) but NOT PutPut: b counts
// distinct view moves, so a burst's intermediate states matter.
const counterLens = (s: Cell<AB>): Cell<number> =>
  lens(
    s as never,
    ((st: AB) => st.a) as never,
    ((t: number, st: AB) => ({ a: t, b: t === st.a ? st.b : st.b + 1 })) as never,
  ) as unknown as Cell<number>;

describe("source-reading bwd: last-settled primal", () => {
  it("PutGet holds under any read interleaving (stale primal still round-trips)", () => {
    for (let seed = 1; seed <= 300; seed++) {
      const r = rng(seed);
      const s = cell({ a: 0, b: 0 }) as unknown as Cell<AB>;
      const view = counterLens(s);
      let last = 0;
      for (let k = 0; k < 40; k++) {
        if (r() < 0.65) {
          last = int(r, -50, 50);
          (view as { value: number }).value = last;
        }
        if (r() < 0.5) expect(view.value).toBe(last); // get(put(v,·)) = v, always
      }
      expect(view.value).toBe(last);
    }
  });

  it("realize-once: a never-read source-reading chain seeds valid primals", () => {
    let cur = cell(100) as unknown as Cell<number>;
    const src = cur;
    const D = 12;
    for (let d = 0; d < D; d++)
      cur = lens(
        cur as never,
        ((x: number) => x + 1) as never,
        // s used arithmetically: an unrealized (undefined) primal ⇒ NaN ⇒ caught
        ((t: number, s: number) => t - 1 + (s - s)) as never,
      ) as unknown as Cell<number>;
    const top = cur;
    (top as { value: number }).value = 500; // intermediates never read forward
    expect(Number.isNaN(src.value as number)).toBe(false);
    expect(src.value).toBe(500 - D);
  });

  it("clamp lens: an unobserved burst coalesces, an observed burst ratchets", () => {
    const clampView = (s: Cell<number>) =>
      lens(
        s as never,
        ((x: number) => x) as never,
        ((t: number, cur: number) => Math.max(cur - 1, Math.min(cur + 1, t))) as never,
      ) as unknown as Cell<number>;
    // unobserved: two pulls to 100 with no read between ⇒ both linearize at
    // the settled s=0 ⇒ clamp ONCE ⇒ 1.
    {
      const s = cell(0) as unknown as Cell<number>;
      const v = clampView(s);
      (v as { value: number }).value = 100;
      (v as { value: number }).value = 100;
      expect(s.value).toBe(1);
    }
    // observed: read settles s between pulls ⇒ each clamp steps ⇒ 2.
    {
      const s = cell(0) as unknown as Cell<number>;
      const v = clampView(s);
      (v as { value: number }).value = 100;
      expect(s.value).toBe(1);
      (v as { value: number }).value = 100;
      expect(s.value).toBe(2);
    }
  });

  it("PutPut boundary: hidden counter coalesces unobserved, steps observed; view round-trips both", () => {
    // unobserved burst ⇒ counter bumps once
    {
      const s = cell({ a: 0, b: 0 }) as unknown as Cell<AB>;
      const view = counterLens(s);
      (view as { value: number }).value = 5;
      (view as { value: number }).value = 7;
      expect(view.value).toBe(7); // PutGet
      expect((s.value as unknown as AB).b).toBe(1); // coalesced
    }
    // observed burst ⇒ counter bumps per move
    {
      const s = cell({ a: 0, b: 0 }) as unknown as Cell<AB>;
      const view = counterLens(s);
      (view as { value: number }).value = 5;
      expect(view.value).toBe(5);
      (view as { value: number }).value = 7;
      expect(view.value).toBe(7); // PutGet
      expect((s.value as unknown as AB).b).toBe(2); // incremental
    }
  });

  it("identity-write is a no-op even after the source drifts (GetPut respected)", () => {
    const s = cell({ a: 3, b: 9 }) as unknown as Cell<AB>;
    const view = counterLens(s);
    expect(view.value).toBe(3);
    (view as { value: number }).value = 3; // put(get(s), s) must not move b
    expect((s.value as unknown as AB).b).toBe(9);
    expect(view.value).toBe(3);
  });

  it("proportional fan-in (source-reading split): one write is read-order independent", () => {
    // bwd splits the target across parents in proportion to their CURRENT
    // primals — the result depends on the linearization point, so a stale or
    // order-dependent primal would show up as a divergence.
    const propFan = (parents: Cell<number>[]) =>
      lens(
        parents as never,
        ((vals: number[]) => vals.reduce((a, b) => a + b, 0)) as never,
        ((t: number, vals: number[]) => {
          const tot = vals.reduce((a, b) => a + b, 0) || vals.length;
          return vals.map(v => (t * (v || 1)) / tot);
        }) as never,
      ) as unknown as Cell<number>;
    for (let seed = 1; seed <= 300; seed++) {
      const r = rng(seed);
      const init = [int(r, 1, 20), int(r, 1, 20), int(r, 1, 20)];
      const t = int(r, -100, 100);
      // forward read order [0,1,2]
      const a = init.map(v => cell(v) as unknown as Cell<number>);
      const va = propFan(a);
      (va as { value: number }).value = t;
      const ra = [a[0]!.value, a[1]!.value, a[2]!.value];
      // reverse read order [2,1,0]
      const b = init.map(v => cell(v) as unknown as Cell<number>);
      const vb = propFan(b);
      (vb as { value: number }).value = t;
      const rb = [b[2]!.value, b[1]!.value, b[0]!.value].reverse();
      for (let i = 0; i < 3; i++) expect(close(ra[i]!, rb[i]!)).toBe(true);
    }
  });

  it("stacked source-reading chain: observed steps match a hand reference", () => {
    // each level clamps to ±1 of its parent's current primal; observed every
    // step, the lazy result must match an explicit eager reference model.
    const D = 6;
    const ref = Array.from({ length: D + 1 }, () => 0); // ref[0]=source … ref[D]=top
    const s = cell(0) as unknown as Cell<number>;
    let cur: Cell<number> = s;
    const nodes = [s];
    for (let d = 0; d < D; d++) {
      cur = lens(
        cur as never,
        ((x: number) => x) as never,
        ((target: number, parent: number) =>
          Math.max(parent - 1, Math.min(parent + 1, target))) as never,
      ) as unknown as Cell<number>;
      nodes.push(cur);
    }
    const top = cur;
    const r = rng(99);
    for (let k = 0; k < 60; k++) {
      const t = int(r, -10, 10);
      // eager reference: clamp top→source, level by level, against ref primals
      let tgt = t;
      for (let lvl = D; lvl >= 1; lvl--) {
        tgt = Math.max(ref[lvl - 1]! - 1, Math.min(ref[lvl - 1]! + 1, tgt));
        ref[lvl - 1] = tgt;
      }
      // forward refresh of the reference (get = identity ⇒ all equal the source)
      for (let lvl = 1; lvl <= D; lvl++) ref[lvl] = ref[0]!;
      (top as { value: number }).value = t;
      // observe every node each step (settles the chain ⇒ incremental semantics)
      for (let lvl = 0; lvl <= D; lvl++) expect(nodes[lvl]!.value).toBe(ref[0]);
    }
  });
});

// ════════════════════════════════════════════════════════════════════════
// G. Co-writer LWW over a shared source, both ends STATEFUL.
// ════════════════════════════════════════════════════════════════════════
//
// The version-stamp post-pass marks an own back-write as "synced", so it cannot
// (the way the retired value-witness did) tell that a *sibling* co-writer's
// last-write-wins overwrote the shared source out from under this lens. That
// difference is invisible to the forward view here (the complement is a constant
// memory offset, recomputed-free), but we pin the invariants any correct engine
// must keep regardless of which writer wins: forward consistency, LWW (the source
// equals one of the two intended writes), stability, and GetPut idempotence.
describe("co-writer LWW: two STATEFUL lenses sharing one source", () => {
  it("stays consistent, stable, and idempotent under batched conflicting writes", () => {
    const s = cell(0) as unknown as Cell<number>;
    // view = source + a constant memory offset; `step` keeps the offset (genuine
    // complement memory, not derivable from the source), `bwd` keeps it too.
    const mk = (off: number) =>
      lens(
        s as never,
        {
          init: () => off,
          step: (_x: number, c: number) => c,
          fwd: (x: number, c: number) => x + c,
          bwd: (t: number, _x: number, c: number) => ({ update: t - c, complement: c }),
        } as never,
      ) as unknown as Cell<number>;
    const a = mk(10);
    const b = mk(20);
    expect(a.value).toBe(10);
    expect(b.value).toBe(20);

    const r = rng(7);
    for (let k = 0; k < 50; k++) {
      const ta = int(r, -50, 50);
      const tb = int(r, -50, 50);
      batch(() => {
        (a as { value: number }).value = ta;
        (b as { value: number }).value = tb;
      });
      const sv = s.value;
      const av = a.value;
      const bv = b.value;
      // forward consistency: each view equals source + its own memory offset
      expect(av).toBe(sv + 10);
      expect(bv).toBe(sv + 20);
      // LWW: the source landed on exactly one of the two intended back-writes
      expect(sv === ta - 10 || sv === tb - 20).toBe(true);
      // stability: an extra settle + re-read changes nothing
      settle();
      expect(a.value).toBe(av);
      expect(b.value).toBe(bv);
      expect(s.value).toBe(sv);
      // GetPut: writing each view's current value back is a no-op
      (a as { value: number }).value = av;
      expect(s.value).toBe(sv);
      (b as { value: number }).value = bv;
      expect(s.value).toBe(sv);
    }
  });
});
