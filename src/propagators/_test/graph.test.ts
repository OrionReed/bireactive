// graph.test.ts — layout: longest-path ranking, cycle handling,
// crossing reduction, layer consistency, tree centering, git lanes.

import { describe, expect, it } from "vitest";
import { crossings, type Graph, lanes, layered, rank, recurrent, scc, tree } from "../graph";

const g = <N>(nodes: N[], edges: Array<[N, N]>): Graph<N> => ({ nodes, edges });
const cx = (p: { x: number; w: number }) => p.x + p.w / 2;
const cy = (p: { y: number; h: number }) => p.y + p.h / 2;

describe("rank: longest-path via interval narrowing", () => {
  it("linear chain ranks 0,1,2,3", () => {
    const layer = rank(
      g(
        ["a", "b", "c", "d"],
        [
          ["a", "b"],
          ["b", "c"],
          ["c", "d"],
        ],
      ),
    );
    expect(layer.get("a")).toBe(0);
    expect(layer.get("d")).toBe(3);
  });

  it("diamond: the join takes the LONGEST path (fan-in narrowing)", () => {
    // a→b→d and a→c, plus a long arm a→b→e→d. d must sit below e.
    const layer = rank(
      g(
        ["a", "b", "c", "d", "e"],
        [
          ["a", "b"],
          ["a", "c"],
          ["b", "e"],
          ["e", "d"],
          ["c", "d"],
        ],
      ),
    );
    expect(layer.get("a")).toBe(0);
    expect(layer.get("e")).toBe(2);
    // d is reached by a→c (len 2) and a→b→e (len 3) → longest wins.
    expect(layer.get("d")).toBe(3);
  });

  it("multiple sources both rank 0", () => {
    const layer = rank(
      g(
        ["s1", "s2", "t"],
        [
          ["s1", "t"],
          ["s2", "t"],
        ],
      ),
    );
    expect(layer.get("s1")).toBe(0);
    expect(layer.get("s2")).toBe(0);
    expect(layer.get("t")).toBe(1);
  });

  it("cycles are broken — ranking stays finite, no throw", () => {
    const layer = rank(
      g(
        ["a", "b", "c"],
        [
          ["a", "b"],
          ["b", "c"],
          ["c", "a"],
        ],
      ),
    );
    for (const n of ["a", "b", "c"]) {
      expect(Number.isFinite(layer.get(n)!)).toBe(true);
      expect(layer.get(n)!).toBeGreaterThanOrEqual(0);
    }
  });
});

describe("layered: layer consistency + crossings", () => {
  it("every forward edge increases the layer coordinate (TB)", () => {
    const graph = g(
      ["a", "b", "c", "d", "e"],
      [
        ["a", "b"],
        ["a", "c"],
        ["b", "d"],
        ["c", "d"],
        ["c", "e"],
      ],
    );
    const p = layered(graph, { direction: "TB" });
    for (const [u, v] of graph.edges) expect(cy(p.get(v)!)).toBeGreaterThan(cy(p.get(u)!));
  });

  it("LR direction lays out left-to-right", () => {
    const graph = g(
      ["a", "b", "c"],
      [
        ["a", "b"],
        ["b", "c"],
      ],
    );
    const p = layered(graph, { direction: "LR" });
    expect(cx(p.get("c")!)).toBeGreaterThan(cx(p.get("a")!));
  });

  it("achieves zero crossings on a planar layered graph", () => {
    // Two parallel chains, no interleaving → an ordering exists with 0.
    const graph = g(
      ["a1", "a2", "a3", "b1", "b2", "b3"],
      [
        ["a1", "a2"],
        ["a2", "a3"],
        ["b1", "b2"],
        ["b2", "b3"],
      ],
    );
    const layer = rank(graph);
    const layers = Array.from({ length: 3 }, () => [] as string[]);
    // reconstruct via layered's ordering by reading positions:
    const p = layered(graph);
    for (const n of graph.nodes) layers[layer.get(n)!]!.push(n);
    for (const arr of layers) arr.sort((x, y) => cx(p.get(x)!) - cx(p.get(y)!));
    expect(crossings(graph, layer, layers)).toBe(0);
  });

  it("normalizes to non-negative coordinates", () => {
    const p = layered(g(["a", "b"], [["a", "b"]]));
    for (const b of p.values()) {
      expect(b.x).toBeGreaterThanOrEqual(0);
      expect(b.y).toBeGreaterThanOrEqual(0);
    }
  });
});

describe("tree: parents centred over children", () => {
  it("root sits at the midpoint of its two children", () => {
    const graph = g(
      ["r", "l", "m"],
      [
        ["r", "l"],
        ["r", "m"],
      ],
    );
    const p = tree(graph, { direction: "TB" });
    const mid = (cx(p.get("l")!) + cx(p.get("m")!)) / 2;
    expect(cx(p.get("r")!)).toBeCloseTo(mid, 1);
  });
});

describe("lanes: git-style column packing", () => {
  it("a linear history stays in one lane", () => {
    const graph = g(
      ["c0", "c1", "c2"],
      [
        ["c0", "c1"],
        ["c1", "c2"],
      ],
    );
    const p = lanes(graph);
    const lane = (n: string) => Math.round(cx(p.get(n)!));
    expect(lane("c0")).toBe(lane("c1"));
    expect(lane("c1")).toBe(lane("c2"));
  });

  it("a branch opens a second lane; rows follow topological order", () => {
    // c0 → c1 → c2 (main); c1 → f1 → m (feature merged back into m)
    const graph = g(
      ["c0", "c1", "f1", "c2", "m"],
      [
        ["c0", "c1"],
        ["c1", "c2"],
        ["c1", "f1"],
        ["c2", "m"],
        ["f1", "m"],
      ],
    );
    const p = lanes(graph);
    const lanesUsed = new Set([...p.values()].map(b => Math.round(cx(b))));
    expect(lanesUsed.size).toBeGreaterThanOrEqual(2);
    // m (the merge) is the deepest row.
    const row = (n: string) => Math.round(cy(p.get(n)!));
    expect(row("m")).toBeGreaterThan(row("c2"));
    expect(row("m")).toBeGreaterThan(row("f1"));
  });
});

describe("scc: strongly-connected components", () => {
  const setsOf = (comps: string[][]) => comps.map(c => [...c].sort().join(",")).sort();

  it("a DAG is all singletons", () => {
    const comps = scc(
      g(
        ["a", "b", "c"],
        [
          ["a", "b"],
          ["b", "c"],
        ],
      ),
    );
    expect(comps.length).toBe(3);
    expect(comps.every(c => c.length === 1)).toBe(true);
  });

  it("finds the cyclic core, leaving the tails singletons", () => {
    // commit → [build → test → stage → prod] → done, with two back edges.
    const comps = scc(
      g(
        ["commit", "build", "test", "stage", "prod", "done"],
        [
          ["commit", "build"],
          ["build", "test"],
          ["test", "stage"],
          ["stage", "prod"],
          ["test", "build"],
          ["prod", "build"],
          ["prod", "done"],
        ],
      ),
    );
    const core = comps.find(c => c.length > 1)!;
    expect([...core].sort()).toEqual(["build", "prod", "stage", "test"]);
    expect(
      comps
        .filter(c => c.length === 1)
        .map(c => c[0])
        .sort(),
    ).toEqual(["commit", "done"]);
  });

  it("separates a chain of independent cycles", () => {
    const comps = scc(
      g(
        ["a", "b", "c", "d", "e", "f", "g", "h"],
        [
          ["a", "b"],
          ["b", "c"],
          ["c", "a"],
          ["c", "d"],
          ["d", "e"],
          ["e", "f"],
          ["f", "d"],
          ["f", "g"],
          ["g", "h"],
          ["h", "g"],
        ],
      ),
    );
    expect(setsOf(comps.filter(c => c.length > 1))).toEqual(["a,b,c", "d,e,f", "g,h"]);
  });
});

describe("recurrent: SCCs as rings", () => {
  const dist = (a: { x: number; w: number; y: number; h: number }, b: typeof a) =>
    Math.hypot(cx(a) - cx(b), cy(a) - cy(b));

  it("lays a 3-cycle out as a ring (roughly equidistant from centre)", () => {
    const p = recurrent(
      g(
        ["a", "b", "c"],
        [
          ["a", "b"],
          ["b", "c"],
          ["c", "a"],
        ],
      ),
    );
    const ctr = {
      x: [...p.values()].reduce((s, b) => s + cx(b), 0) / 3,
      y: [...p.values()].reduce((s, b) => s + cy(b), 0) / 3,
    };
    const radii = ["a", "b", "c"].map(n =>
      Math.hypot(cx(p.get(n)!) - ctr.x, cy(p.get(n)!) - ctr.y),
    );
    const avg = radii.reduce((s, r) => s + r, 0) / 3;
    expect(avg).toBeGreaterThan(0);
    for (const r of radii) expect(Math.abs(r - avg)).toBeLessThan(avg * 0.25 + 1);
  });

  it("places acyclic tails outside the ring, in condensation order", () => {
    // commit → {build,test} cycle → done.
    const p = recurrent(
      g(
        ["commit", "build", "test", "done"],
        [
          ["commit", "build"],
          ["build", "test"],
          ["test", "build"],
          ["build", "done"],
        ],
      ),
    );
    // commit above the cyclic core, done below (TB).
    expect(cy(p.get("commit")!)).toBeLessThan(cy(p.get("build")!));
    expect(cy(p.get("done")!)).toBeGreaterThan(cy(p.get("test")!));
    // the two core nodes are separated (a ring, not coincident).
    expect(dist(p.get("build")!, p.get("test")!)).toBeGreaterThan(10);
  });
});
