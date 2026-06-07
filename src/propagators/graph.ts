// graph.ts — graph layout on the interval atoms.
//
// The headline is `rank`: layer assignment is longest-path, and
// longest-path IS interval narrowing. For every edge u→v we assert
// `order(layer(u), layer(v), 1)` (v sits at least one layer below u);
// the solver narrows each layer cell's lower bound to the length of the
// longest path reaching it. A merge node — many edges into one cell —
// is fan-in narrowing, the thing a lens can't express.
//
// Everything after ranking (crossing reduction, coordinate assignment)
// is the standard Sugiyama machinery: barycenter sweeps to order each
// layer, then pool-adjacent-violators to place nodes as close to their
// neighbours' barycenter as non-overlap allows. Those are heuristics,
// not lattice operations, and are written as plain functions.
//
// Layouts share one engine: `layered` (4 directions), `tree`
// (parents centred over children), `radial` (layers as rings), and
// `lanes` (git-style column packing).

import { intervalCell } from "./lattice";
import { order } from "./numeric";
import { solve } from "./solver";

/** A directed graph. Edges are `[from, to]`; nodes carry any identity. */
export interface Graph<N> {
  readonly nodes: readonly N[];
  readonly edges: readonly (readonly [N, N])[];
}

export type Direction = "TB" | "BT" | "LR" | "RL";

/** Intrinsic size of a node's box. */
export interface Size {
  w: number;
  h: number;
}

/** Top-left placement of a node's box. */
export interface Placement {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface LayeredOpts<N> {
  direction?: Direction;
  /** Centre-to-centre distance between adjacent layers. Default 90. */
  layerGap?: number;
  /** Minimum edge-to-edge distance within a layer. Default 28. */
  nodeGap?: number;
  /** Intrinsic node size. Default 46×34. */
  sizeOf?: (n: N) => Size;
  /** Crossing-reduction sweeps. Default 6. */
  sweeps?: number;
  /** Barycenter source: "both" (DAG), "down" (parents over children,
   *  the tree look), "up". Default "both". */
  align?: "both" | "down" | "up";
}

const DEFAULT_SIZE: Size = { w: 46, h: 34 };

// ── ranking: longest-path via interval narrowing ────────────────────

/** Assign each node an integer layer so every edge increases layer by
 *  ≥1. Cycles are broken (back edges reversed for ranking only). The
 *  value is the longest path from a source — computed as the lower
 *  bound the `order` atoms narrow each layer cell to. */
export function rank<N>(g: Graph<N>): Map<N, number> {
  const acyclic = breakCycles(g);
  const cell = new Map<N, ReturnType<typeof intervalCell>>();
  const hi = Math.max(1, g.nodes.length);
  for (const n of g.nodes) cell.set(n, intervalCell(0, hi));

  const props = [];
  for (const [u, v] of acyclic) props.push(...order(cell.get(u)!, cell.get(v)!, 1));
  const s = solve(...props);

  const layer = new Map<N, number>();
  for (const n of g.nodes) layer.set(n, Math.round(cell.get(n)!.value[0]));
  s.dispose();
  return layer;
}

/** Strongly-connected components (Tarjan), each a list of mutually
 *  reachable nodes, in reverse-topological order of the condensation.
 *  Singletons are size-1 components; a self-loop still reports size 1.
 *  The cyclic cores of a graph are exactly the components of size > 1. */
export function scc<N>(g: Graph<N>): N[][] {
  const adj = new Map<N, N[]>();
  for (const n of g.nodes) adj.set(n, []);
  for (const [u, v] of g.edges) adj.get(u)?.push(v);

  let idx = 0;
  const index = new Map<N, number>();
  const low = new Map<N, number>();
  const onStack = new Set<N>();
  const stack: N[] = [];
  const out: N[][] = [];

  const connect = (v: N): void => {
    index.set(v, idx);
    low.set(v, idx);
    idx++;
    stack.push(v);
    onStack.add(v);
    for (const w of adj.get(v)!) {
      if (!index.has(w)) {
        connect(w);
        low.set(v, Math.min(low.get(v)!, low.get(w)!));
      } else if (onStack.has(w)) {
        low.set(v, Math.min(low.get(v)!, index.get(w)!));
      }
    }
    if (low.get(v) === index.get(v)) {
      const comp: N[] = [];
      let w: N;
      do {
        w = stack.pop()!;
        onStack.delete(w);
        comp.push(w);
      } while (w !== v);
      out.push(comp);
    }
  };
  for (const n of g.nodes) if (!index.has(n)) connect(n);
  return out;
}

/** Reverse edges that close a cycle (DFS back edges), returning an
 *  acyclic edge list. Order of `g.edges` is otherwise preserved. */
function breakCycles<N>(g: Graph<N>): Array<readonly [N, N]> {
  const adj = new Map<N, N[]>();
  for (const n of g.nodes) adj.set(n, []);
  for (const [u, v] of g.edges) adj.get(u)?.push(v);

  const WHITE = 0;
  const GREY = 1;
  const BLACK = 2;
  const color = new Map<N, number>(g.nodes.map(n => [n, WHITE]));
  const back = new Set<string>();
  const key = (u: N, v: N) => `${g.nodes.indexOf(u)}->${g.nodes.indexOf(v)}`;

  const visit = (u: N): void => {
    color.set(u, GREY);
    for (const v of adj.get(u) ?? []) {
      const c = color.get(v);
      if (c === GREY)
        back.add(key(u, v)); // edge into the active stack
      else if (c === WHITE) visit(v);
    }
    color.set(u, BLACK);
  };
  for (const n of g.nodes) if (color.get(n) === WHITE) visit(n);

  return g.edges.map(([u, v]) => (back.has(key(u, v)) ? ([v, u] as const) : ([u, v] as const)));
}

// ── crossing reduction ──────────────────────────────────────────────

/** Group nodes by layer, ordered to reduce edge crossings via
 *  barycenter sweeps. Returns the per-layer node arrays. */
function ordered<N>(g: Graph<N>, layer: Map<N, number>, sweeps: number): N[][] {
  const numLayers = Math.max(0, ...[...layer.values()].map(l => l + 1));
  const layers: N[][] = Array.from({ length: numLayers }, () => []);
  for (const n of g.nodes) layers[layer.get(n)!]!.push(n);

  const down = new Map<N, N[]>(); // node → neighbours in layer below
  const up = new Map<N, N[]>(); // node → neighbours in layer above
  for (const n of g.nodes) {
    down.set(n, []);
    up.set(n, []);
  }
  for (const [u, v] of g.edges) {
    const lu = layer.get(u)!;
    const lv = layer.get(v)!;
    if (lu === lv) continue;
    const [hiNode, loNode] = lu < lv ? [u, v] : [v, u];
    down.get(hiNode)!.push(loNode);
    up.get(loNode)!.push(hiNode);
  }

  const indexIn = (arr: N[]) => new Map<N, number>(arr.map((n, i) => [n, i]));
  const sweep = (from: number, to: number, step: number, side: Map<N, N[]>): void => {
    for (let l = from; l !== to; l += step) {
      const ref = indexIn(layers[l - step]!);
      const bary = (n: N): number => {
        const nb = side.get(n)!;
        if (nb.length === 0) return Number.POSITIVE_INFINITY; // keep relative order
        let acc = 0;
        for (const m of nb) acc += ref.get(m)!;
        return acc / nb.length;
      };
      const b = new Map<N, number>(layers[l]!.map(n => [n, bary(n)]));
      // Stable sort; nodes with no neighbours (Infinity) hold position.
      layers[l]!.sort((p, q) => {
        const bp = b.get(p)!;
        const bq = b.get(q)!;
        if (!Number.isFinite(bp) || !Number.isFinite(bq)) return 0;
        return bp - bq;
      });
    }
  };

  for (let s = 0; s < sweeps; s++) {
    if (numLayers > 1) sweep(1, numLayers, 1, up); // top→bottom by parents
    if (numLayers > 1) sweep(numLayers - 2, -1, -1, down); // bottom→top by children
  }
  return layers;
}

/** Count edge crossings given per-layer orderings (for tests / quality). */
export function crossings<N>(g: Graph<N>, layer: Map<N, number>, layers: N[][]): number {
  const pos = new Map<N, number>();
  for (const arr of layers) arr.forEach((n, i) => pos.set(n, i));
  let total = 0;
  const byLayerPair = new Map<number, Array<[number, number]>>();
  for (const [u, v] of g.edges) {
    const lu = layer.get(u)!;
    const lv = layer.get(v)!;
    if (Math.abs(lu - lv) !== 1) continue;
    const top = lu < lv ? lu : lv;
    const [a, b] = lu < lv ? [u, v] : [v, u];
    const list = byLayerPair.get(top) ?? byLayerPair.set(top, []).get(top)!;
    list.push([pos.get(a)!, pos.get(b)!]);
  }
  for (const list of byLayerPair.values()) {
    for (let i = 0; i < list.length; i++) {
      for (let j = i + 1; j < list.length; j++) {
        const [a1, b1] = list[i]!;
        const [a2, b2] = list[j]!;
        if ((a1 < a2 && b1 > b2) || (a1 > a2 && b1 < b2)) total++;
      }
    }
  }
  return total;
}

// ── coordinate assignment ───────────────────────────────────────────

/** Pool-adjacent-violators: the non-decreasing sequence closest (least
 *  squares) to `y`. The kernel of minimum-displacement, ordered,
 *  non-overlapping placement. */
function isotonic(y: number[]): number[] {
  const blocks: Array<{ sum: number; count: number }> = [];
  for (const yi of y) {
    let b = { sum: yi, count: 1 };
    while (
      blocks.length > 0 &&
      blocks[blocks.length - 1]!.sum / blocks[blocks.length - 1]!.count > b.sum / b.count
    ) {
      const prev = blocks.pop()!;
      b = { sum: prev.sum + b.sum, count: prev.count + b.count };
    }
    blocks.push(b);
  }
  const out: number[] = [];
  for (const b of blocks) {
    const avg = b.sum / b.count;
    for (let k = 0; k < b.count; k++) out.push(avg);
  }
  return out;
}

/** Place ordered nodes at centres as close to `desired` as possible
 *  subject to `gap` edge-to-edge separation. */
function placeRow(sizes: number[], desired: number[], gap: number): number[] {
  const n = sizes.length;
  if (n === 0) return [];
  const cumSep: number[] = new Array(n);
  cumSep[0] = 0;
  for (let i = 1; i < n; i++) cumSep[i] = cumSep[i - 1]! + sizes[i - 1]! / 2 + gap + sizes[i]! / 2;
  const q = desired.map((d, i) => d - cumSep[i]!);
  const qhat = isotonic(q);
  return qhat.map((v, i) => v + cumSep[i]!);
}

/** Full layered layout → top-left placement per node. */
export function layered<N>(g: Graph<N>, opts: LayeredOpts<N> = {}): Map<N, Placement> {
  const dir = opts.direction ?? "TB";
  const layerGap = opts.layerGap ?? 90;
  const nodeGap = opts.nodeGap ?? 28;
  const sizeOf = opts.sizeOf ?? (() => DEFAULT_SIZE);
  const sweeps = opts.sweeps ?? 6;
  const align = opts.align ?? "both";

  const layer = rank(g);
  const layers = ordered(g, layer, sweeps);
  const horizontal = dir === "LR" || dir === "RL";

  // Cross-axis size of a node (the extent we pack along within a layer).
  const cross = (n: N): number => (horizontal ? sizeOf(n).h : sizeOf(n).w);

  // Neighbour sets for barycenter, per `align`. `hi` is the upper
  // (smaller-layer) endpoint, `lo` the lower. "down" centres a node on
  // its lower neighbours (parents over children); "up" the reverse.
  const nbrs = new Map<N, N[]>();
  for (const n of g.nodes) nbrs.set(n, []);
  for (const [u, v] of g.edges) {
    const lu = layer.get(u)!;
    const lv = layer.get(v)!;
    if (lu === lv) continue;
    const hiNode = lu < lv ? u : v;
    const loNode = lu < lv ? v : u;
    if (align !== "up") nbrs.get(hiNode)!.push(loNode); // hi centred on its lo neighbours
    if (align !== "down") nbrs.get(loNode)!.push(hiNode); // lo centred on its hi neighbours
  }

  // Initial centres: pack each layer from 0.
  const center = new Map<N, number>();
  for (const arr of layers) {
    let c = 0;
    for (let i = 0; i < arr.length; i++) {
      const half = cross(arr[i]!) / 2;
      c += half;
      center.set(arr[i]!, c);
      c += half + nodeGap;
    }
  }

  // Refinement: pull toward neighbour barycenter, re-resolve overlaps.
  const refine = (order: number[]): void => {
    for (const li of order) {
      const arr = layers[li]!;
      if (arr.length === 0) continue;
      const desired = arr.map(n => {
        const nb = nbrs.get(n)!.filter(m => layer.get(m) !== li);
        if (nb.length === 0) return center.get(n)!;
        let acc = 0;
        for (const m of nb) acc += center.get(m)!;
        return acc / nb.length;
      });
      const placed = placeRow(arr.map(cross), desired, nodeGap);
      arr.forEach((n, i) => center.set(n, placed[i]!));
    }
  };
  const numLayers = layers.length;
  const downOrder = Array.from({ length: numLayers }, (_, i) => i);
  const upOrder = [...downOrder].reverse();
  for (let s = 0; s < sweeps; s++) {
    refine(downOrder);
    refine(upOrder);
  }

  // Layer-axis coordinate (centre of each layer).
  const layerCenter = (l: number): number => l * layerGap;

  // Assemble placements in (layerAxis, crossAxis) then orient.
  const maxLayer = numLayers - 1;
  const out = new Map<N, Placement>();
  for (const n of g.nodes) {
    const { w, h } = sizeOf(n);
    const l = layer.get(n)!;
    const cc = center.get(n)!; // cross-axis centre
    let lc = layerCenter(l); // layer-axis centre
    if (dir === "BT" || dir === "RL") lc = layerCenter(maxLayer) - lc;
    const cx = horizontal ? lc : cc;
    const cy = horizontal ? cc : lc;
    out.set(n, { x: cx - w / 2, y: cy - h / 2, w, h });
  }
  return normalize(out, 0);
}

/** Tree layout: parents centred over their children. A `layered` with
 *  downward barycenter and tighter defaults. */
export function tree<N>(g: Graph<N>, opts: LayeredOpts<N> = {}): Map<N, Placement> {
  return layered(g, { align: "down", sweeps: 8, layerGap: 80, ...opts });
}

/** Radial layout: layers become concentric rings, cross-axis position
 *  becomes angle. Reads a `layered` (TB) result and re-maps to polar. */
export function radial<N>(g: Graph<N>, opts: LayeredOpts<N> = {}): Map<N, Placement> {
  const flat = layered(g, { ...opts, direction: "TB", align: "down" });
  const layer = rank(g);
  const ringGap = opts.layerGap ?? 80;

  // Cross-axis span per ring → map to [0, 2π) (or a fan for the root ring).
  let minX = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  for (const p of flat.values()) {
    minX = Math.min(minX, p.x + p.w / 2);
    maxX = Math.max(maxX, p.x + p.w / 2);
  }
  const span = Math.max(1, maxX - minX);
  const out = new Map<N, Placement>();
  for (const n of g.nodes) {
    const p = flat.get(n)!;
    const cxFlat = p.x + p.w / 2;
    const l = layer.get(n)!;
    const radius = l * ringGap;
    const theta = l === 0 ? 0 : ((cxFlat - minX) / span) * Math.PI * 1.8 - Math.PI * 0.9;
    const cx = Math.sin(theta) * radius;
    const cy = -Math.cos(theta) * radius;
    out.set(n, { x: cx - p.w / 2, y: cy - p.h / 2, w: p.w, h: p.h });
  }
  return normalize(out, 0);
}

// ── recurrent (cyclic) layout ───────────────────────────────────────

/** A traversal order of an SCC's members that follows edges where it
 *  can — a greedy walk. For a simple cycle this is the cycle order, so
 *  laying the members out in this order around a circle traces the loop. */
function ringOrder<N>(members: readonly N[], adj: Map<N, N[]>): N[] {
  const set = new Set(members);
  const seen = new Set<N>();
  const out: N[] = [];
  let cur: N | undefined = members[0];
  while (out.length < members.length && cur !== undefined) {
    out.push(cur);
    seen.add(cur);
    const here: N = cur;
    const next: N | undefined = (adj.get(here) ?? []).find(w => set.has(w) && !seen.has(w));
    cur = next ?? members.find(m => !seen.has(m));
  }
  return out;
}

/** Recurrent-hierarchy layout: decompose into strongly-connected
 *  components, lay the condensation (a DAG of SCCs) out hierarchically,
 *  and draw every cyclic component as a ring centred on its condensation
 *  slot. The cycle closes by going around the circle — no backward edge.
 *  Singleton components are placed as ordinary nodes. */
export function recurrent<N>(g: Graph<N>, opts: LayeredOpts<N> = {}): Map<N, Placement> {
  const sizeOf = opts.sizeOf ?? (() => DEFAULT_SIZE);
  const ringGap = 16;

  const comps = scc(g);
  const compOf = new Map<N, number>();
  comps.forEach((c, i) => c.forEach(n => compOf.set(n, i)));

  const adj = new Map<N, N[]>();
  for (const n of g.nodes) adj.set(n, []);
  for (const [u, v] of g.edges) adj.get(u)?.push(v);

  // Ring radius for a component: chord between adjacent members ≥ their
  // widest extent plus a gap.
  const radiusOf = (members: readonly N[]): number => {
    if (members.length < 2) return 0;
    let widest = 0;
    for (const n of members) widest = Math.max(widest, sizeOf(n).w, sizeOf(n).h);
    return (widest + ringGap) / (2 * Math.sin(Math.PI / members.length));
  };

  // Each SCC is a meta-node sized to its ring's bounding box.
  const ringSize = (i: number): Size => {
    const members = comps[i]!;
    if (members.length < 2) return sizeOf(members[0]!);
    const r = radiusOf(members);
    let widest = 0;
    for (const n of members) widest = Math.max(widest, sizeOf(n).w, sizeOf(n).h);
    return { w: 2 * r + widest, h: 2 * r + widest };
  };

  const metaEdges = new Set<string>();
  const edges: Array<[number, number]> = [];
  for (const [u, v] of g.edges) {
    const cu = compOf.get(u)!;
    const cv = compOf.get(v)!;
    const key = `${cu}->${cv}`;
    if (cu !== cv && !metaEdges.has(key)) {
      metaEdges.add(key);
      edges.push([cu, cv]);
    }
  }

  const horizontal = opts.direction === "LR" || opts.direction === "RL";
  let maxAlong = 0;
  for (let i = 0; i < comps.length; i++) {
    const sz = ringSize(i);
    maxAlong = Math.max(maxAlong, horizontal ? sz.w : sz.h);
  }
  const metaPlace = layered(
    { nodes: comps.map((_, i) => i), edges },
    {
      direction: opts.direction ?? "TB",
      sizeOf: ringSize,
      layerGap: maxAlong + (opts.layerGap ?? 60),
      nodeGap: opts.nodeGap ?? 40,
    },
  );

  const out = new Map<N, Placement>();
  for (let i = 0; i < comps.length; i++) {
    const members = comps[i]!;
    const slot = metaPlace.get(i)!;
    const cx = slot.x + slot.w / 2;
    const cy = slot.y + slot.h / 2;
    if (members.length < 2) {
      const { w, h } = sizeOf(members[0]!);
      out.set(members[0]!, { x: cx - w / 2, y: cy - h / 2, w, h });
      continue;
    }
    const order = ringOrder(members, adj);
    const r = radiusOf(members);
    order.forEach((n, k) => {
      const theta = -Math.PI / 2 + (k / order.length) * Math.PI * 2;
      const { w, h } = sizeOf(n);
      out.set(n, {
        x: cx + Math.cos(theta) * r - w / 2,
        y: cy + Math.sin(theta) * r - h / 2,
        w,
        h,
      });
    });
  }
  return normalize(out, 0);
}

export interface LanesOpts<N> {
  /** Row height (topological order axis). Default 56. */
  rowGap?: number;
  /** Lane width (column axis). Default 46. */
  laneGap?: number;
  sizeOf?: (n: N) => Size;
}

/** Git-style lane packing: nodes flow top-to-bottom in topological
 *  order (one row each), each assigned the first free column ("lane")
 *  that no live edge occupies. Branch points open lanes, merges free
 *  them. Expects a DAG whose `nodes` are in commit order (parents
 *  before children). */
export function lanes<N>(g: Graph<N>, opts: LanesOpts<N> = {}): Map<N, Placement> {
  const rowGap = opts.rowGap ?? 56;
  const laneGap = opts.laneGap ?? 46;
  const sizeOf = opts.sizeOf ?? (() => DEFAULT_SIZE);

  const layer = rank(g);
  const rowOf = new Map<N, number>();
  [...g.nodes]
    .map((n, i) => [n, i] as const)
    .sort((a, b) => layer.get(a[0])! - layer.get(b[0])! || a[1] - b[1])
    .forEach(([n], row) => rowOf.set(n, row));

  const parentsOf = new Map<N, N[]>(g.nodes.map(n => [n, []]));
  const unplacedKids = new Map<N, number>(g.nodes.map(n => [n, 0]));
  for (const [u, v] of g.edges) {
    parentsOf.get(v)!.push(u);
    unplacedKids.set(u, unplacedKids.get(u)! + 1);
  }

  // Greedy lane assignment in row order: continue a parent's lane where
  // possible (the branch stays in its column), else take the first free
  // lane. A lane frees once its owner's last child is placed.
  const laneOf = new Map<N, number>();
  const owner: (N | null)[] = [];
  for (const n of [...g.nodes].sort((a, b) => rowOf.get(a)! - rowOf.get(b)!)) {
    const parentLane = owner.findIndex(o => o !== null && parentsOf.get(n)!.includes(o));
    let lane = parentLane;
    if (lane === -1) {
      lane = owner.findIndex(o => o === null);
      if (lane === -1) {
        lane = owner.length;
        owner.push(null);
      }
    }
    laneOf.set(n, lane);
    for (const p of parentsOf.get(n)!) {
      unplacedKids.set(p, unplacedKids.get(p)! - 1);
      if (unplacedKids.get(p)! === 0) {
        const pl = owner.indexOf(p);
        if (pl !== -1) owner[pl] = null;
      }
    }
    owner[lane] = unplacedKids.get(n)! > 0 ? n : null;
  }

  const out = new Map<N, Placement>();
  for (const n of g.nodes) {
    const { w, h } = sizeOf(n);
    const cx = laneOf.get(n)! * laneGap;
    const cy = rowOf.get(n)! * rowGap;
    out.set(n, { x: cx - w / 2, y: cy - h / 2, w, h });
  }
  return normalize(out, 0);
}

/** Shift placements so the bounding box starts at (pad, pad). */
function normalize<N>(p: Map<N, Placement>, pad: number): Map<N, Placement> {
  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  for (const b of p.values()) {
    minX = Math.min(minX, b.x);
    minY = Math.min(minY, b.y);
  }
  if (!Number.isFinite(minX)) return p;
  for (const [n, b] of p) p.set(n, { ...b, x: b.x - minX + pad, y: b.y - minY + pad });
  return p;
}

/** Bounding size of a placement map. */
export function extent<N>(p: Map<N, Placement>): Size {
  let w = 0;
  let h = 0;
  for (const b of p.values()) {
    w = Math.max(w, b.x + b.w);
    h = Math.max(h, b.y + b.h);
  }
  return { w, h };
}
