// data.ts — synthetic, reproducible datasets for the learning demos.
//
// Two families: 2D point clouds (moons / circles / xor / spirals) where the
// learned decision boundary is the visual; and rasterised shapes on a small
// pixel grid (circle vs square/triangle) generated on the fly, so training
// data is endless and the label is whatever the generator drew.

import { gaussian, rng, type Sample } from "./mlp";

/** A 2D point dataset: each sample's `x` is `[px, py]`, `y` is `0|1`. */
export type Points = Sample[];

/** Two interleaving half-moons (the reliable "is it learning" classic). */
export function moons(n: number, opts: { seed?: number; noise?: number } = {}): Points {
  const r = rng(opts.seed ?? 7);
  const noise = opts.noise ?? 0.12;
  const out: Points = [];
  for (let i = 0; i < n; i++) {
    const top = i % 2 === 0;
    const a = r() * Math.PI;
    let px: number;
    let py: number;
    if (top) {
      px = Math.cos(a);
      py = Math.sin(a) - 0.25;
    } else {
      px = 1 - Math.cos(a);
      py = 0.25 - Math.sin(a);
    }
    out.push({
      x: [px - 0.5 + gaussian(r) * noise, py + gaussian(r) * noise],
      y: top ? 0 : 1,
    });
  }
  return out;
}

/** Concentric rings: inner blob (class 0) inside an outer ring (class 1). */
export function circles(n: number, opts: { seed?: number; noise?: number } = {}): Points {
  const r = rng(opts.seed ?? 7);
  const noise = opts.noise ?? 0.1;
  const out: Points = [];
  for (let i = 0; i < n; i++) {
    const inner = i % 2 === 0;
    const rad = inner ? 0.35 : 0.9;
    const a = r() * 2 * Math.PI;
    out.push({
      x: [Math.cos(a) * rad + gaussian(r) * noise, Math.sin(a) * rad + gaussian(r) * noise],
      y: inner ? 0 : 1,
    });
  }
  return out;
}

/** Four quadrant clusters; class 1 where the coordinate signs differ. */
export function xor(n: number, opts: { seed?: number; noise?: number } = {}): Points {
  const r = rng(opts.seed ?? 7);
  const noise = opts.noise ?? 0.18;
  const out: Points = [];
  for (let i = 0; i < n; i++) {
    const sx = i & 1 ? 1 : -1;
    const sy = i & 2 ? 1 : -1;
    out.push({
      x: [sx * 0.6 + gaussian(r) * noise, sy * 0.6 + gaussian(r) * noise],
      y: sx === sy ? 0 : 1,
    });
  }
  return out;
}

/** Two intertwined spirals — the hard one (may need more steps/capacity). */
export function spirals(n: number, opts: { seed?: number; noise?: number } = {}): Points {
  const r = rng(opts.seed ?? 7);
  const noise = opts.noise ?? 0.06;
  const out: Points = [];
  const per = Math.ceil(n / 2);
  for (let c = 0; c < 2; c++) {
    for (let i = 0; i < per; i++) {
      const t = (i / per) * 3.2;
      const a = t * Math.PI + c * Math.PI;
      const rad = 0.15 + t * 0.26;
      out.push({
        x: [Math.cos(a) * rad + gaussian(r) * noise, Math.sin(a) * rad + gaussian(r) * noise],
        y: c,
      });
    }
  }
  return out;
}

/** A 2D dataset family selectable in the demo. */
export type PointsKind = "moons" | "circles" | "xor" | "spirals";

/** Build a 2D dataset by name. */
export function points(
  kind: PointsKind,
  n: number,
  opts: { seed?: number; noise?: number } = {},
): Points {
  switch (kind) {
    case "moons":
      return moons(n, opts);
    case "circles":
      return circles(n, opts);
    case "xor":
      return xor(n, opts);
    default:
      return spirals(n, opts);
  }
}

// ── pixel shapes ──────────────────────────────────────────────────────

/** A rasterisable shape. The binary task is `circle` (class 1) vs the rest. */
export type ShapeKind = "circle" | "square" | "triangle";

/** Placement of a shape in normalised `[0,1]²` grid space. */
export interface ShapePose {
  cx: number;
  cy: number;
  r: number;
  rot: number;
}

// Point-in-shape test in normalised coords.
function inside(kind: ShapeKind, p: ShapePose, x: number, y: number): boolean {
  const dx = x - p.cx;
  const dy = y - p.cy;
  if (kind === "circle") return dx * dx + dy * dy <= p.r * p.r;
  const cs = Math.cos(-p.rot);
  const sn = Math.sin(-p.rot);
  const rx = dx * cs - dy * sn;
  const ry = dx * sn + dy * cs;
  if (kind === "square") {
    const s = p.r * 0.86;
    return Math.abs(rx) <= s && Math.abs(ry) <= s;
  }
  // Equilateral triangle, circumradius r, vertices at 90°/210°/330°.
  for (let k = 0; k < 3; k++) {
    const a = (Math.PI / 2) * -1 + (k * 2 * Math.PI) / 3;
    // Inward normal of the edge opposite vertex k points toward center;
    // test the half-plane through the two other vertices.
    const a1 = -Math.PI / 2 + (((k + 1) % 3) * 2 * Math.PI) / 3;
    const a2 = -Math.PI / 2 + (((k + 2) % 3) * 2 * Math.PI) / 3;
    const x1 = Math.cos(a1) * p.r;
    const y1 = Math.sin(a1) * p.r;
    const x2 = Math.cos(a2) * p.r;
    const y2 = Math.sin(a2) * p.r;
    const ex = x2 - x1;
    const ey = y2 - y1;
    // Cross product sign: center (0,0) must be on the same side as (rx,ry).
    const side = ex * (ry - y1) - ey * (rx - x1);
    const cside = ex * (0 - y1) - ey * (0 - x1);
    if (Math.sign(side) !== Math.sign(cside) && side !== 0) return false;
    void a;
  }
  return true;
}

/** Rasterise a posed shape onto a `grid×grid` coverage buffer (0..1) via
 *  3×3 supersampling. */
export function rasterShape(kind: ShapeKind, grid: number, pose: ShapePose): Float64Array {
  const out = new Float64Array(grid * grid);
  const S = 3;
  for (let gy = 0; gy < grid; gy++) {
    for (let gx = 0; gx < grid; gx++) {
      let hit = 0;
      for (let sy = 0; sy < S; sy++) {
        for (let sx = 0; sx < S; sx++) {
          const x = (gx + (sx + 0.5) / S) / grid;
          const y = (gy + (sy + 0.5) / S) / grid;
          if (inside(kind, pose, x, y)) hit++;
        }
      }
      out[gy * grid + gx] = hit / (S * S);
    }
  }
  return out;
}

/** Random pose for a roughly-centred shape (small jitter, moderate size,
 *  free rotation) — learnable from raw pixels and legible when drawn. */
export function randomPose(r: () => number): ShapePose {
  return {
    cx: 0.5 + (r() - 0.5) * 0.16,
    cy: 0.5 + (r() - 0.5) * 0.16,
    r: 0.26 + r() * 0.12,
    rot: r() * Math.PI * 2,
  };
}

/** One labelled pixel sample: `circle` → class 1, `square`/`triangle` → 0. */
export function shapeSample(grid: number, r: () => number, noise = 0.04): Sample {
  const kind: ShapeKind = r() < 0.5 ? "circle" : r() < 0.5 ? "square" : "triangle";
  const buf = rasterShape(kind, grid, randomPose(r));
  if (noise > 0)
    for (let i = 0; i < buf.length; i++) buf[i] = clamp01(buf[i]! + gaussian(r) * noise);
  return { x: buf, y: kind === "circle" ? 1 : 0 };
}

/** A batch of `n` fresh pixel samples. */
export function shapeBatch(grid: number, n: number, r: () => number): Sample[] {
  const out: Sample[] = [];
  for (let i = 0; i < n; i++) out.push(shapeSample(grid, r));
  return out;
}

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}
