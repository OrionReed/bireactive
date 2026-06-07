// Scene + topology view of edge-local bidirectionality: dragging a shape
// fires phase 1 (reverse edges up to roots), then phase 2 (forward fan-out).

import {
  type CurveSegment,
  cell,
  circle,
  curve,
  Diagram,
  derive,
  drag,
  easeIn,
  easeOut,
  effect,
  label,
  line,
  type Mount,
  mean,
  Num,
  num,
  path,
  play,
  rect,
  Vec,
  vec,
  type Writable,
} from "@bireactive";
import { propagator, solve } from "@bireactive/propagators";

const RED = "#e25c5c";
const BLUE = "#5b8def";
const GREEN = "#86b966";
const ORANGE = "#f5a623";
const MUTED = "var(--text-color, #888)";
const INK = "var(--text-color, #333)";

// H slider — track is centred on the scene pane (cx = 200).
// `height = hKnob.x - SLIDER_OFFSET`, where SLIDER_OFFSET = TRACK_LO - H_MIN
// so the visible track endpoints map cleanly to the clamp bounds.
const H_MIN = 30;
const H_INIT = 95;
const TRACK_LO = 125; // 200 − (H_MAX − H_MIN) / 2
const TRACK_HI = 275; // 200 + (H_MAX − H_MIN) / 2
const SLIDER_Y = 400;
const SLIDER_OFFSET = TRACK_LO - H_MIN;

const SCENE_R = 14;
const SHAPE_R = 12;
const NODE_R = SHAPE_R;
const H_R = 6;
const LENS_W = 76;
const LENS_H = 24;
const LABEL_SIZE = 15;
const LINE_W = 24;

const ARC_BOW = 22;

const REST_W = 2;
const ACTIVE_W = 3.4;
const FIRE_PEAK_DUR = 0.1;
const FIRE_FADE_DUR = 0.4;

const PHASE_GAP = 0.18;
const HOP_STAGGER = 0.06;
const EMIT_THROTTLE_MS = 200;

const PANE_X = 400;
const PANE_Y = 70;
const PANE_W = 480;
const PANE_H = 360;

// Circular arc whose midpoint sits `bow` pixels perpendicular to the chord
// (sign flips to the other side).
type V = { x: number; y: number };
function arcSegment(from: V, to: V, bow: number): CurveSegment {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const L = Math.hypot(dx, dy);
  const s = Math.abs(bow);
  const R = (L * L) / (8 * s) + s / 2;
  const ux = dx / (L || 1);
  const uy = dy / (L || 1);
  const px = -uy;
  const py = ux;
  const sgn = Math.sign(bow);
  const cx = (from.x + to.x) / 2 - sgn * px * (R - s);
  const cy = (from.y + to.y) / 2 - sgn * py * (R - s);
  const a0 = Math.atan2(from.y - cy, from.x - cx);
  let dθ = Math.atan2(to.y - cy, to.x - cx) - a0;
  while (dθ > Math.PI) dθ -= 2 * Math.PI;
  while (dθ < -Math.PI) dθ += 2 * Math.PI;
  return { kind: "ellipseArc", center: { x: cx, y: cy }, a: R, b: R, rotation: 0, a0, a1: a0 + dθ };
}

// CSS `color-mix()` resolves against `var(--text-color)` so both themes work.
function mixColor(activity: number, fireColor: string): string {
  if (activity <= 1e-3) return MUTED;
  if (activity >= 1 - 1e-3) return fireColor;
  const a = Math.round(activity * 100);
  return `color-mix(in srgb, ${MUTED} ${100 - a}%, ${fireColor} ${a}%)`;
}

/** Anchor on `from → to`, pulled back toward `from` by `r` px so a line
 *  stops at the node boundary; collapses to `from` if shorter than `2r`. */
function shrink(from: Vec, to: Vec, r: number): Vec {
  return Vec.derive(() => {
    const f = from.value;
    const t = to.value;
    const dx = t.x - f.x;
    const dy = t.y - f.y;
    const L = Math.hypot(dx, dy);
    if (L < 2 * r) return f;
    return { x: f.x + (dx / L) * r, y: f.y + (dy / L) * r };
  });
}

function layersOf(ns: readonly Vec[], parents: Map<Vec, Vec[]>): Map<Vec, number> {
  const layer = new Map<Vec, number>(ns.map(n => [n, 0]));
  let changed = true;
  let safety = ns.length + 1;
  while (changed && safety-- > 0) {
    changed = false;
    for (const n of ns) {
      let m = 0;
      for (const p of parents.get(n) ?? []) m = Math.max(m, layer.get(p)! + 1);
      if (m > layer.get(n)!) {
        layer.set(n, m);
        changed = true;
      }
    }
  }
  return layer;
}

type Edge = readonly [Vec, Vec, boolean?];

/** Edges fired during the engine's response to a write at `origin`. */
function firingsFor(origin: Vec, edges: readonly Edge[]) {
  const reverseFromTo = new Map<Vec, Map<Vec, Edge>>();
  const fwdFrom = new Map<Vec, Edge[]>();
  const parentsOf = new Map<Vec, Vec[]>();
  for (const e of edges) {
    const [from, to, rev] = e;
    if (rev) {
      let inner = reverseFromTo.get(from);
      if (!inner) reverseFromTo.set(from, (inner = new Map()));
      inner.set(to, e);
    }
    let fb = fwdFrom.get(from);
    if (!fb) fwdFrom.set(from, (fb = []));
    fb.push(e);
    let pb = parentsOf.get(to);
    if (!pb) parentsOf.set(to, (pb = []));
    pb.push(from);
  }

  // Phase 1: walk reverse-capable parents from origin upstream;
  // collect fired edges and the "reached roots" (nodes with no
  // further reverse-edge upstream) in a single BFS.
  const phase1: { edge: Edge; hop: number }[] = [];
  const reached: Vec[] = [];
  const visited = new Set<Vec>([origin]);
  const q1: { node: Vec; hop: number }[] = [{ node: origin, hop: 0 }];
  while (q1.length > 0) {
    const { node: cur, hop } = q1.shift()!;
    let hasUp = false;
    for (const p of parentsOf.get(cur) ?? []) {
      const e = reverseFromTo.get(p)?.get(cur);
      if (!e) continue;
      hasUp = true;
      phase1.push({ edge: e, hop });
      if (!visited.has(p)) {
        visited.add(p);
        q1.push({ node: p, hop: hop + 1 });
      }
    }
    if (!hasUp) reached.push(cur);
  }

  // Phase 2: BFS forward from each reached root through every edge.
  const phase2: { edge: Edge; hop: number }[] = [];
  const v2 = new Set<Vec>();
  for (const root of reached) {
    const q2: { node: Vec; hop: number }[] = [{ node: root, hop: 0 }];
    while (q2.length > 0) {
      const { node: cur, hop } = q2.shift()!;
      if (v2.has(cur)) continue;
      v2.add(cur);
      for (const e of fwdFrom.get(cur) ?? []) {
        phase2.push({ edge: e, hop });
        q2.push({ node: e[1], hop: hop + 1 });
      }
    }
  }

  return { phase1, phase2 };
}

export class MdBireactive extends Diagram {
  protected scene(s: Mount): void {
    this.view(900, 480);

    const A = vec(90, 150);
    const B = vec(290, 150);
    const M = mean([A, B]);
    // `Num.pin` absorbs y-writes so the knob drag is axis-locked; x clamps to
    // the track range and `height = knob.x − SLIDER_OFFSET` feeds `M.down`.
    const hKnob = vec(num(SLIDER_OFFSET + H_INIT).clamp(TRACK_LO, TRACK_HI), Num.pin(SLIDER_Y));
    const height = hKnob.x.sub(SLIDER_OFFSET);
    const D = M.down(height);

    const cells = [
      { cell: A, color: BLUE, text: "A", shape: vec() },
      { cell: B, color: GREEN, text: "B", shape: vec() },
      { cell: hKnob, color: INK, text: "H", shape: vec() },
      { cell: M, color: ORANGE, text: "M", shape: vec() },
      { cell: D, color: RED, text: "D", shape: vec() },
    ] as const;
    const [cA, cB, cH, cM, cD] = cells;

    const tMidpoint = vec(),
      tDown = vec();
    const tLineAB = vec(),
      tLineMD = vec();
    const tLabA = vec(),
      tLabB = vec(),
      tLabM = vec(),
      tLabD = vec();

    // [from, to] forward only; [from, to, true] also reverse.
    const edges: Edge[] = [
      [cA.shape, tMidpoint, true],
      [cB.shape, tMidpoint, true],
      [tMidpoint, cM.shape, true],
      // H feeds `down(...)` but takes no writeback (height has weight 0;
      // D-drag is absorbed entirely by M), so this edge is forward-only.
      [cH.shape, tDown],
      [cM.shape, tDown, true],
      [tDown, cD.shape, true],
      [cA.shape, tLabA],
      [cB.shape, tLabB],
      [cM.shape, tLabM],
      [cD.shape, tLabD],
      [cA.shape, tLineAB],
      [cB.shape, tLineAB],
      [cM.shape, tLineMD],
      [cD.shape, tLineMD],
    ];

    const origin = cell<Vec | null>(null);
    const anim = this.anim;

    // Mount order = z-order (no groups): back to front.
    s(
      rect(20, 70, 360, 360, { thin: true, opacity: 0.12, corner: 4 }),
      rect(PANE_X, PANE_Y, PANE_W, PANE_H, { thin: true, opacity: 0.12, corner: 4 }),
      label(vec(200, 58), "scene", { size: 13, bold: true, fill: MUTED, opacity: 0.7 }),
      label(vec(PANE_X + PANE_W / 2, 58), "bireactive signals graph", {
        size: 13,
        bold: true,
        fill: MUTED,
        opacity: 0.7,
      }),
    );

    s(
      line(A, B),
      line(M, D),
      line(vec(TRACK_LO, SLIDER_Y), vec(TRACK_HI, SLIDER_Y), {
        thin: true,
        opacity: 0.3,
        cap: "round",
      }),
    );
    for (const c of cells) {
      const small = c === cH;
      const ch = s(
        circle(c.cell, small ? H_R + 1 : SCENE_R, {
          fill: c.color,
          stroke: "var(--bg-color, white)",
          strokeWidth: small ? 0 : 2,
        }),
      );
      drag(ch, c.cell);
      ch.on("pointerdown", () => {
        origin.value = c.shape;
      });
      if (!small) {
        s(
          label(c.text === "D" ? c.cell.down(24) : c.cell.up(24), c.text, {
            size: LABEL_SIZE,
            bold: true,
          }),
        );
      }
    }

    function fireProps(activity: Writable<Num>, fireColor: string) {
      return {
        stroke: derive(() => mixColor(activity.value, fireColor)),
        strokeWidth: derive(() => REST_W + (ACTIVE_W - REST_W) * activity.value),
        cap: "round" as const,
      };
    }
    const edgeAct = new Map<Edge, { fwd: Writable<Num>; rev?: Writable<Num> }>();
    const anchorR = (n: Vec): number => (n === cH.shape ? H_R : NODE_R);
    for (const e of edges) {
      const [from, to, rev] = e;
      const start = shrink(from, to, anchorR(from));
      const end = shrink(to, from, anchorR(to));
      const fwdAct = num(0);
      s(path(start, fireProps(fwdAct, BLUE)).to(end));
      const revAct = rev ? num(0) : undefined;
      if (revAct) {
        s(
          curve(() => [arcSegment(end.value, start.value, ARC_BOW)], {
            ...fireProps(revAct, RED),
            dashed: true,
          }),
        );
      }
      edgeAct.set(e, { fwd: fwdAct, rev: revAct });
    }

    for (const c of cells) {
      s(circle(c.shape, c === cH ? H_R : SHAPE_R, { fill: c.color }));
    }
    const lenses: [Writable<Vec>, string][] = [
      [tMidpoint, "midpoint"],
      [tDown, "down"],
    ];
    for (const [p, text] of lenses) {
      const tl = p.left(LENS_W / 2).up(LENS_H / 2);
      s(
        rect(tl.x, tl.y, LENS_W, LENS_H, {
          fill: "var(--bg-color, white)",
          stroke: MUTED,
          strokeWidth: 1.2,
          corner: 3,
        }),
        label(p, text, { size: LABEL_SIZE, bold: true, fill: MUTED }),
      );
    }
    for (const p of [tLineAB, tLineMD]) {
      s(
        line(p.left(LINE_W / 2), p.right(LINE_W / 2), {
          stroke: MUTED,
          strokeWidth: 1.6,
          cap: "round",
        }),
        circle(p.left(LINE_W / 2), 2, { fill: MUTED }),
        circle(p.right(LINE_W / 2), 2, { fill: MUTED }),
      );
    }
    const labelLeaves: [Writable<Vec>, string, string][] = [
      [tLabA, BLUE, "A"],
      [tLabB, GREEN, "B"],
      [tLabM, ORANGE, "M"],
      [tLabD, RED, "D"],
    ];
    for (const [p, color, text] of labelLeaves) {
      s(label(p, `"${text}"`, { size: LABEL_SIZE, bold: true, fill: color }));
    }

    const allNodes = [...new Set(edges.flatMap(([f, t]) => [f, t]))];
    const parents = new Map<Vec, Vec[]>();
    for (const [from, to] of edges) {
      let p = parents.get(to);
      if (!p) parents.set(to, (p = []));
      p.push(from);
    }
    const layer = layersOf(allNodes, parents);
    const numLayers = Math.max(...layer.values()) + 1;
    const byLayer: Vec[][] = Array.from({ length: numLayers }, () => []);
    for (const n of allNodes) byLayer[layer.get(n)!]!.push(n);
    const xOf = (n: Vec) => n.x as Writable<Num>;

    solve(
      // y: each node's y is its layer's centerline.
      propagator(
        [],
        allNodes.map(n => n.y as Writable<Num>),
        () => {
          const slot = PANE_H / numLayers;
          for (const n of allNodes) {
            (n.y as Writable<Num>).value = PANE_Y + (layer.get(n)! + 0.5) * slot;
          }
        },
      ),
      // x: sort each layer by parent-barycenter, then spread evenly across
      // the pane width so siblings don't cluster at their parents' midpoint.
      ...byLayer.map(nodes =>
        propagator(
          nodes.flatMap(n => (parents.get(n) ?? []).map(p => p.x)),
          nodes.map(xOf),
          () => {
            const bary = (n: Vec): number => {
              const ps = parents.get(n) ?? [];
              return ps.length ? ps.reduce((s, p) => s + p.x.value, 0) / ps.length : 0;
            };
            const sorted = [...nodes].sort((a, b) => bary(a) - bary(b));
            const lo = PANE_X + 30;
            const hi = PANE_X + PANE_W - 30;
            const step = (hi - lo) / (sorted.length + 1);
            sorted.forEach((n, i) => {
              xOf(n).value = lo + (i + 1) * step;
            });
          },
        ),
      ),
    );

    // Re-fire cancels any in-flight tween and ramps back up from the current
    // value, so continuous drags hold the line warm.
    const cancelFire = new Map<Writable<Num>, () => void>();
    function fire(activity: Writable<Num>, delay: number): void {
      cancelFire.get(activity)?.();
      const flight = activity.to(1, FIRE_PEAK_DUR, easeOut).to(0, FIRE_FADE_DUR, easeIn);
      cancelFire.set(activity, anim.start(delay > 0 ? play(delay).then(flight) : flight));
    }

    const cellSigs = cells.map(c => c.cell) as Writable<Vec>[];
    const prev = new Map<Writable<Vec>, V>();
    for (const c of cellSigs) prev.set(c, { ...c.peek() });
    let initialised = false;
    let lastEmit = 0;

    this.root.track(
      effect(() => {
        let changed = false;
        for (const c of cellSigs) {
          const v = c.value;
          const p = prev.get(c)!;
          if (Math.abs(v.x - p.x) > 1e-6 || Math.abs(v.y - p.y) > 1e-6) {
            prev.set(c, { x: v.x, y: v.y });
            changed = true;
          }
        }
        if (!initialised) {
          initialised = true;
          return;
        }
        if (!changed) return;
        const o = origin.peek();
        if (o === null) return;
        const now = performance.now();
        if (now - lastEmit < EMIT_THROTTLE_MS) return;
        lastEmit = now;

        const f = firingsFor(o, edges);
        for (const { edge: e, hop } of f.phase1) {
          fire(edgeAct.get(e)!.rev!, hop * HOP_STAGGER);
        }
        const totalFire = FIRE_PEAK_DUR + FIRE_FADE_DUR;
        const phase2Start = f.phase1.length > 0 ? totalFire * 0.65 + PHASE_GAP : 0;
        for (const { edge: e, hop } of f.phase2) {
          fire(edgeAct.get(e)!.fwd, phase2Start + hop * HOP_STAGGER);
        }
      }),
    );
  }
}
