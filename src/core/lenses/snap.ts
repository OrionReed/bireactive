// Pointer math for the drag algebra: `hullWeights` (barycentric weights of a
// point in a convex hull) and `nearestIndex` (nearest candidate, with sticky
// hysteresis carried in the lens complement).

import { type Cell, lens, type Read, SKIP } from "../cell";

type V = { x: number; y: number };

const sub = (a: V, b: V): V => ({ x: a.x - b.x, y: a.y - b.y });
const dot = (a: V, b: V): number => a.x * b.x + a.y * b.y;
const dist2 = (a: V, b: V): number => {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  return dx * dx + dy * dy;
};

// ── convex-hull barycentric weights ─────────────────────────────────

/** Project `q` onto segment p0→p1; weights `[1−t, t]`, t clamped to [0,1]. */
function segmentWeights(q: V, p0: V, p1: V): [number, number] {
  const d = sub(p1, p0);
  const len2 = dot(d, d);
  if (len2 < 1e-18) return [0.5, 0.5];
  const t = Math.max(0, Math.min(1, dot(sub(q, p0), d) / len2));
  return [1 - t, t];
}

/** Barycentric weights of `q` in triangle (p0,p1,p2), CLAMPED to the
 *  triangle: inside → the true coords; outside → the nearest point on the
 *  hull (an edge projection or a vertex), so the blend never extrapolates. */
function triangleWeights(q: V, p0: V, p1: V, p2: V): [number, number, number] {
  const v0 = sub(p1, p0);
  const v1 = sub(p2, p0);
  const v2 = sub(q, p0);
  const d00 = dot(v0, v0);
  const d01 = dot(v0, v1);
  const d11 = dot(v1, v1);
  const d20 = dot(v2, v0);
  const d21 = dot(v2, v1);
  const denom = d00 * d11 - d01 * d01;
  if (Math.abs(denom) > 1e-18) {
    const b1 = (d11 * d20 - d01 * d21) / denom;
    const b2 = (d00 * d21 - d01 * d20) / denom;
    const b0 = 1 - b1 - b2;
    if (b0 >= -1e-9 && b1 >= -1e-9 && b2 >= -1e-9) {
      const s = b0 + b1 + b2;
      return [b0 / s, b1 / s, b2 / s];
    }
  }
  // Outside (or degenerate): nearest point on the three edges.
  const e01 = segmentWeights(q, p0, p1);
  const e12 = segmentWeights(q, p1, p2);
  const e20 = segmentWeights(q, p2, p0);
  const at01 = { x: p0.x * e01[0] + p1.x * e01[1], y: p0.y * e01[0] + p1.y * e01[1] };
  const at12 = { x: p1.x * e12[0] + p2.x * e12[1], y: p1.y * e12[0] + p2.y * e12[1] };
  const at20 = { x: p2.x * e20[0] + p0.x * e20[1], y: p2.y * e20[0] + p0.y * e20[1] };
  const c: Array<[number, [number, number, number]]> = [
    [dist2(q, at01), [e01[0], e01[1], 0]],
    [dist2(q, at12), [0, e12[0], e12[1]]],
    [dist2(q, at20), [e20[1], 0, e20[0]]],
  ];
  c.sort((a, b) => a[0] - b[0]);
  return c[0]![1];
}

/** Frank–Wolfe projection of `q` onto the convex hull of `pts` in
 *  barycentric coordinates (used for K > 3). Minimises |Σ wᵢ·pᵢ − q|² over
 *  the simplex; O(K·iters), plenty fast for the handful of targets a drag
 *  ever offers. */
function hullProjectWeights(q: V, pts: readonly V[], iters = 60): number[] {
  const K = pts.length;
  const w = new Array<number>(K).fill(1 / K);
  for (let t = 0; t < iters; t++) {
    let cx = 0;
    let cy = 0;
    for (let i = 0; i < K; i++) {
      cx += w[i]! * pts[i]!.x;
      cy += w[i]! * pts[i]!.y;
    }
    const rx = cx - q.x;
    const ry = cy - q.y;
    let best = 0;
    let bestG = Number.POSITIVE_INFINITY;
    for (let i = 0; i < K; i++) {
      const g = rx * pts[i]!.x + ry * pts[i]!.y;
      if (g < bestG) {
        bestG = g;
        best = i;
      }
    }
    const gamma = 2 / (t + 2);
    for (let i = 0; i < K; i++) w[i] = w[i]! * (1 - gamma);
    w[best] = w[best]! + gamma;
  }
  return w;
}

/** Convex-hull barycentric weights of `q` over `pts` (Σ = 1, all ≥ 0,
 *  clamped to the hull). Closed form for K ≤ 3; Frank–Wolfe for K > 3. */
export function hullWeights(q: V, pts: readonly V[]): number[] {
  const K = pts.length;
  if (K === 0) return [];
  if (K === 1) return [1];
  if (K === 2) return segmentWeights(q, pts[0]!, pts[1]!);
  if (K === 3) return triangleWeights(q, pts[0]!, pts[1]!, pts[2]!);
  return hullProjectWeights(q, pts);
}

// ── discrete nearest selection ──────────────────────────────────────

export interface ClosestOpts {
  /** Hysteresis margin (px): the current pick is kept until a rival is
   *  nearer by more than this. Default 0. */
  sticky?: number;
}

function pick(sources: readonly V[], prev: number, sticky: number): number {
  const p = sources[0]!;
  let best = -1;
  let bestD = Number.POSITIVE_INFINITY;
  for (let i = 1; i < sources.length; i++) {
    const d = dist2(sources[i]!, p);
    if (d < bestD) {
      bestD = d;
      best = i - 1;
    }
  }
  if (sticky > 0 && prev >= 0 && prev + 1 < sources.length) {
    const prevD = Math.sqrt(dist2(sources[prev + 1]!, p));
    if (prevD - Math.sqrt(bestD) < sticky) return prev;
  }
  return best;
}

/** Index of the candidate nearest `pointer`, with hysteresis. Read-only
 *  selection: the stickiness state lives in the lens complement (the
 *  sanctioned place for path-dependence), so reads stay pure. */
export function nearestIndex(
  pointer: Read<V>,
  candidates: readonly Read<V>[],
  opts: ClosestOpts = {},
): Cell<number> {
  const sticky = opts.sticky ?? 0;
  const parents = [pointer, ...candidates] as readonly Read<V>[];
  type C = { index: number };
  return lens(parents, {
    init: (sources: readonly V[]) => ({ index: pick(sources, -1, 0) }),
    step: (sources: readonly V[], c: C) => ({ index: pick(sources, c.index, sticky) }),
    fwd: (_sources: readonly V[], c: C) => c.index,
    bwd: (_t: number, sources: readonly V[], c: C) => ({
      updates: sources.map(() => SKIP) as never,
      complement: c,
    }),
  }) as Cell<number>;
}
