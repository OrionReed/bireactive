// SCC condensation + scheduled solve. The thesis to verify: the acyclic
// functional core pays ZERO iteration (fires each rule once), and ONLY a
// genuine cycle pays the bounded fixpoint — and both solvers agree.

import { describe, expect, it } from "vitest";
import { type Cell, source } from "./engine";
import { type Interval, interval } from "./lattice";
import { condense } from "./scc";
import { FlatSolver, type Rel, rel, SccSolver } from "./solver-scc";

const NINF = Number.NEGATIVE_INFINITY;
const PINF = Number.POSITIVE_INFINITY;

const ival = (lo = NINF, hi = PINF): Cell<Interval> => source<Interval>([lo, hi], interval);

/** b := a (functional, one-directional → acyclic edge a→b). */
const copy = (a: Cell<Interval>, b: Cell<Interval>): Rel =>
  rel([a], [b], emit => () => emit(b, a.peek()));

/** a = b (bidirectional → a 2-cycle). */
const equalI = (a: Cell<Interval>, b: Cell<Interval>): Rel[] => [
  rel([a], [b], emit => () => emit(b, a.peek())),
  rel([b], [a], emit => () => emit(a, b.peek())),
];

describe("condense", () => {
  it("acyclic chain → all singleton, topological order", () => {
    const [a, b, c] = ["a", "b", "c"];
    const { order, comp, cyclic } = condense(
      [a, b, c],
      [
        [a, b],
        [b, c],
      ],
    );
    expect(order.map(g => [...g])).toEqual([["a"], ["b"], ["c"]]);
    expect(cyclic).toEqual([false, false, false]);
    expect(comp.get("a")! < comp.get("b")!).toBe(true);
    expect(comp.get("b")! < comp.get("c")!).toBe(true);
  });

  it("2-cycle → one cyclic component", () => {
    const { order, cyclic } = condense(
      ["a", "b"],
      [
        ["a", "b"],
        ["b", "a"],
      ],
    );
    expect(order.length).toBe(1);
    expect(new Set(order[0])).toEqual(new Set(["a", "b"]));
    expect(cyclic).toEqual([true]);
  });

  it("self-loop is cyclic", () => {
    const { cyclic } = condense(["a"], [["a", "a"]]);
    expect(cyclic).toEqual([true]);
  });

  it("mixed: chain → cycle → chain, cycle isolated", () => {
    // a → b ⇄ c → d
    const { order, comp, cyclic } = condense(
      ["a", "b", "c", "d"],
      [
        ["a", "b"],
        ["b", "c"],
        ["c", "b"],
        ["c", "d"],
      ],
    );
    // a before {b,c} before d; exactly one cyclic component of size 2.
    expect(comp.get("a")! < comp.get("b")!).toBe(true);
    expect(comp.get("b")).toBe(comp.get("c"));
    expect(comp.get("c")! < comp.get("d")!).toBe(true);
    const cyclicComps = order.filter((_, i) => cyclic[i]);
    expect(cyclicComps.length).toBe(1);
    expect(new Set(cyclicComps[0])).toEqual(new Set(["b", "c"]));
  });

  it("handles a deep chain without recursion (no stack overflow)", () => {
    const n = 50_000;
    const nodes = Array.from({ length: n }, (_, i) => i);
    const edges: Array<[number, number]> = [];
    for (let i = 0; i < n - 1; i++) edges.push([i, i + 1]);
    const { order, cyclic } = condense(nodes, edges);
    expect(order.length).toBe(n);
    expect(cyclic.every(c => !c)).toBe(true);
  });
});

describe("scheduled solve — acyclic pays once", () => {
  it("a copy chain fires each rule exactly once, zero waves", () => {
    const N = 20;
    const chain = () => {
      const cells = [ival(10, 20), ...Array.from({ length: N }, () => ival())];
      const rules = cells.slice(1).map((c, i) => copy(cells[i]!, c));
      return { cells, rules };
    };

    const s = chain();
    const scc = new SccSolver().add(...s.rules).solve();
    expect(scc.stats.ruleFires).toBe(N); // one fire per rule
    expect(scc.stats.waves).toBe(0); // no cyclic component → no waves
    expect(s.cells.at(-1)!.value).toEqual([10, 20]); // propagated end-to-end

    // The flat solver gets the same answer, but propagates the chain one
    // layer per wave — O(depth) waves, each re-scanning every rule. The
    // acyclic cost SCC removed shows up here as waves.
    const f = chain();
    const flat = new FlatSolver().add(...f.rules).solve();
    expect(f.cells.at(-1)!.value).toEqual([10, 20]);
    expect(flat.stats.waves).toBeGreaterThanOrEqual(N - 1);
  });
});

describe("scheduled solve — cycles", () => {
  it("a 2-cycle converges to the intersection", () => {
    const a = ival(0, 50);
    const b = ival(20, 100);
    new SccSolver().add(...equalI(a, b)).solve();
    expect(a.value).toEqual([20, 50]);
    expect(b.value).toEqual([20, 50]);
  });

  it("mixed graph: only the cyclic component iterates", () => {
    // src → a ⇄ b → sink   (a=b is the only cycle)
    const src = ival(30, 30);
    const a = ival();
    const b = ival();
    const sink = ival();
    const rules: Rel[] = [copy(src, a), ...equalI(a, b), copy(b, sink)];
    const scc = new SccSolver().add(...rules).solve();

    expect(sink.value).toEqual([30, 30]);
    // 2 acyclic copies fire once each = 2; the rest of the fires are the
    // cycle's. Waves come ONLY from the cyclic component.
    expect(scc.stats.waves).toBeGreaterThan(0);
    expect(scc.stats.waves).toBeLessThan(10);
  });
});

describe("SCC ≡ flat (same answer, different schedule)", () => {
  const build = (aLo: number, aHi: number) => {
    const c: Record<string, Cell<Interval>> = {
      a: ival(aLo, aHi),
      b: ival(),
      x: ival(),
      y: ival(),
      z: ival(),
      out: ival(),
    };
    const rules: Rel[] = [
      copy(c.a!, c.b!), // a → b
      ...equalI(c.x!, c.y!), // x ⇄ y (the only cycle)
      copy(c.b!, c.x!), // b → x  (feed the cycle)
      copy(c.y!, c.z!), // y → z  (drain the cycle)
      copy(c.z!, c.out!), // z → out
    ];
    return { c, rules };
  };

  it("agrees on a mixed DAG-with-cycles graph", () => {
    const A = build(25, 60);
    new SccSolver().add(...A.rules).solve();

    const B = build(25, 60);
    new FlatSolver().add(...B.rules).solve();

    for (const k of Object.keys(A.c)) {
      expect(A.c[k]!.value).toEqual(B.c[k]!.value);
    }
    expect(A.c.out!.value).toEqual([25, 60]); // propagated through the cycle
  });
});
