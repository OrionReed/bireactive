// Optical bench: a light ray from a draggable lamp bounces through a
// heterogeneous arrangement of flat mirrors and a concave elliptical
// mirror. The whole beam is one reactive `derive` over the roots — a
// nearest-hit reflection cascade — so dragging any lamp, aim knob, mirror,
// focus, or the ellipse size re-traces every bounce downstream. The
// interactive controls are lenses: each mirror's midpoint is a `mean`
// (drag it, both ends follow) and the ellipse's semi-major axis is a
// `Vec.lens` that projects the drag onto the major axis.

import {
  type CurveSegment,
  circle,
  curve,
  Diagram,
  derive,
  ellipse,
  handle,
  label,
  line,
  type Mount,
  num,
  SKIP,
  Vec,
  vec,
  type Writable,
} from "@bireactive";

type V = { x: number; y: number };

const MAX_BOUNCES = 16;
const EPS = 1e-3; // step off the surface so we don't re-hit it
const EXT = 4000; // length of an escaping (unhit) ray

const BEAM = "#ff9f1c";
const MIRROR = "#64748b";
const MIRROR_MID = "#94a3b8";
const FOCUS = "#5b8def";

const sub = (a: V, b: V): V => ({ x: a.x - b.x, y: a.y - b.y });
const mid = (a: V, b: V): V => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });
const cross = (a: V, b: V): number => a.x * b.y - a.y * b.x;
const norm = (v: V): V => {
  const l = Math.hypot(v.x, v.y) || 1;
  return { x: v.x / l, y: v.y / l };
};
// Reflection of a direction about a normal; invariant to the normal's sign.
const reflectDir = (d: V, n: V): V => {
  const k = 2 * (d.x * n.x + d.y * n.y);
  return { x: d.x - k * n.x, y: d.y - k * n.y };
};

type Surface =
  | { kind: "flat"; a: V; b: V }
  | { kind: "ellipse"; c: V; a: number; b: number; rot: number };

type Hit = { t: number; p: V; n: V };

/** Nearest forward intersection of ray `o + t·d` (t > 0) with a segment. */
function hitFlat(o: V, d: V, s: { a: V; b: V }): Hit | null {
  const e = sub(s.b, s.a);
  const denom = cross(d, e);
  if (Math.abs(denom) < 1e-9) return null; // parallel
  const ao = sub(s.a, o);
  const t = cross(ao, e) / denom;
  const u = cross(ao, d) / denom;
  if (t <= EPS || u < 0 || u > 1) return null;
  return { t, p: { x: o.x + d.x * t, y: o.y + d.y * t }, n: norm({ x: -e.y, y: e.x }) };
}

/** Nearest forward intersection of the ray with an ellipse, plus its
 *  outward normal — solved in the ellipse's own rotated frame. */
function hitEllipse(o: V, d: V, s: { c: V; a: number; b: number; rot: number }): Hit | null {
  const a2 = s.a * s.a;
  const b2 = s.b * s.b;
  if (a2 < 1e-9 || b2 < 1e-9) return null;
  const cos = Math.cos(-s.rot);
  const sin = Math.sin(-s.rot);
  const ox = o.x - s.c.x;
  const oy = o.y - s.c.y;
  const lo = { x: ox * cos - oy * sin, y: ox * sin + oy * cos };
  const ld = { x: d.x * cos - d.y * sin, y: d.x * sin + d.y * cos };
  const A = (ld.x * ld.x) / a2 + (ld.y * ld.y) / b2;
  const B = 2 * ((lo.x * ld.x) / a2 + (lo.y * ld.y) / b2);
  const C = (lo.x * lo.x) / a2 + (lo.y * lo.y) / b2 - 1;
  const disc = B * B - 4 * A * C;
  if (disc < 0 || Math.abs(A) < 1e-12) return null;
  const sq = Math.sqrt(disc);
  const t1 = (-B - sq) / (2 * A);
  const t2 = (-B + sq) / (2 * A);
  const t = t1 > EPS ? t1 : t2 > EPS ? t2 : Number.POSITIVE_INFINITY;
  if (!Number.isFinite(t)) return null;
  const lp = { x: lo.x + ld.x * t, y: lo.y + ld.y * t };
  const ln = norm({ x: lp.x / a2, y: lp.y / b2 });
  // Rotate point + normal back to world.
  const cosF = Math.cos(s.rot);
  const sinF = Math.sin(s.rot);
  const rot = (q: V): V => ({ x: q.x * cosF - q.y * sinF, y: q.x * sinF + q.y * cosF });
  const pw = rot(lp);
  return { t, p: { x: pw.x + s.c.x, y: pw.y + s.c.y }, n: rot(ln) };
}

/** Walk the ray surface-to-surface, reflecting off the nearest hit each
 *  step. Returns the polyline segments plus the bounce points. */
function trace(o0: V, d0: V, surfaces: readonly Surface[]): { segs: CurveSegment[]; dots: V[] } {
  const segs: CurveSegment[] = [];
  const dots: V[] = [];
  let o = o0;
  let d = d0;
  for (let i = 0; i < MAX_BOUNCES; i++) {
    let best: Hit | null = null;
    for (const s of surfaces) {
      const h = s.kind === "flat" ? hitFlat(o, d, s) : hitEllipse(o, d, s);
      if (h && (!best || h.t < best.t)) best = h;
    }
    if (!best) {
      segs.push({ kind: "line", from: o, to: { x: o.x + d.x * EXT, y: o.y + d.y * EXT } });
      return { segs, dots };
    }
    segs.push({ kind: "line", from: o, to: best.p });
    dots.push(best.p);
    d = reflectDir(d, best.n);
    o = { x: best.p.x + d.x * EPS, y: best.p.y + d.y * EPS };
  }
  return { segs, dots };
}

export class MdOpticalBench extends Diagram {
  protected scene(s: Mount): void {
    const view = this.view(700, 440);
    const cx = view.center.value.x;
    const cy = view.center.value.y;

    // Lamp + aim knob (initial ray = lamp → aim).
    const source = vec(cx - 300, cy + 130);
    const aim = vec(cx - 170, cy + 20);

    // Two flat mirrors, each a pair of writable endpoints.
    const m1a = vec(cx - 170, cy - 140);
    const m1b = vec(cx - 30, cy - 30);
    const m2a = vec(cx + 40, cy + 160);
    const m2b = vec(cx + 200, cy + 80);
    const flats: ReadonlyArray<readonly [Writable<Vec>, Writable<Vec>]> = [
      [m1a, m1b],
      [m2a, m2b],
    ];

    // Concave elliptical mirror: two foci + a semi-major length `a`.
    const f1 = vec(cx + 110, cy - 90);
    const f2 = vec(cx + 250, cy - 30);
    const aLen = num(120);

    const center = Vec.derive([f1, f2] as const, ([p, q]) => mid(p, q));
    const halfFocal = derive([f1, f2] as const, ([p, q]) => Math.hypot(q.x - p.x, q.y - p.y) / 2);
    const rot = derive([f1, f2] as const, ([p, q]) => Math.atan2(q.y - p.y, q.x - p.x));
    // Keep the ellipse valid (a > c) even as the foci spread.
    const semiA = derive([aLen, halfFocal] as const, ([a, c]) => Math.max(c + 8, a));
    const semiB = derive([semiA, halfFocal] as const, ([a, c]) => Math.sqrt(a * a - c * c));

    // Semi-major handle: reads foci + length, writes only the length by
    // projecting the drag onto the major axis.
    const sizeHandle = Vec.lens(
      [f1, f2, aLen] as const,
      ([p, q, a]) => {
        const c = mid(p, q);
        const u = norm(sub(q, p));
        return { x: c.x + u.x * a, y: c.y + u.y * a };
      },
      (target, [p, q]) => {
        const c = mid(p, q);
        const u = norm(sub(q, p));
        const half = Math.hypot(q.x - p.x, q.y - p.y) / 2;
        const proj = (target.x - c.x) * u.x + (target.y - c.y) * u.y;
        return [SKIP, SKIP, Math.max(half + 8, proj)];
      },
    );

    // The whole light path: one reactive cascade over every root.
    const beam = derive(() => {
      const o = source.value;
      const raw = sub(aim.value, o);
      const d = Math.hypot(raw.x, raw.y) < 1e-6 ? { x: 1, y: 0 } : norm(raw);
      const surfaces: Surface[] = [
        ...flats.map(([a, b]): Surface => ({ kind: "flat", a: a.value, b: b.value })),
        { kind: "ellipse", c: center.value, a: semiA.value, b: semiB.value, rot: rot.value },
      ];
      return trace(o, d, surfaces);
    });

    // Faint optics first, then the beam, then handles on top.
    s(ellipse(center, semiA, semiB, rot, { thin: true, opacity: 0.45, stroke: MIRROR }));
    s(line(source, aim, { thin: true, dashed: true, opacity: 0.3 }));

    for (const [a, b] of flats) {
      s(line(a, b, { stroke: MIRROR, strokeWidth: 5, cap: "round" }));
    }

    // Glow + core for the beam.
    s(curve(() => beam.value.segs, { stroke: BEAM, strokeWidth: 7, opacity: 0.16, cap: "round" }));
    s(curve(() => beam.value.segs, { stroke: BEAM, strokeWidth: 2.4, cap: "round" }));

    // Bounce glints, gated to the number of actual hits.
    for (let i = 0; i < MAX_BOUNCES; i++) {
      const at = Vec.derive(() => beam.value.dots[i] ?? { x: -9999, y: -9999 });
      const op = derive(() => (i < beam.value.dots.length ? 0.9 : 0));
      s(circle(at, 3.2, { fill: BEAM, opacity: op }));
    }

    // Ellipse focal hints.
    s(line(f1, f2, { thin: true, opacity: 0.3, dashed: true }));
    s(circle(f1, 2.5, { fill: FOCUS }), circle(f2, 2.5, { fill: FOCUS }));

    // Draggable controls.
    s(handle(source, { r: 9, fill: BEAM }));
    s(handle(aim, { r: 6, fill: "#cbd5e1" }));
    for (const [a, b] of flats) {
      s(
        handle(a, { r: 6 }),
        handle(b, { r: 6 }),
        handle.midpoint(a, b, { r: 5, fill: MIRROR_MID }),
      );
    }
    s(handle(f1, { r: 6, fill: FOCUS }), handle(f2, { r: 6, fill: FOCUS }));
    s(handle(sizeHandle, { r: 6, fill: MIRROR_MID }));

    s(
      label(
        view.top.down(20),
        "drag the lamp, the aim knob, any mirror, or the ellipse's foci — every bounce re-traces",
      ),
      label(
        view.bottom.up(16),
        "one nearest-hit reflection cascade · mirror midpoints are mean-lenses · ellipse size is a Vec.lens",
        { size: 10 },
      ),
    );
  }
}
