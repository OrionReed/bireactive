// One world point, five maps of the plane. Each panel is a single
// `Vec.lens` (forward chart + closed-form inverse), so the same point is
// editable in every panel at once — and an idle orbit renders the same
// loop five ways. The unit-conversion thesis lifted from a scalar to the
// plane itself.

import {
  cell,
  circle,
  clipPath,
  Diagram,
  drag,
  drive,
  group,
  label,
  type Mount,
  pathD,
  rect,
  vec,
} from "@bireactive";

type V = { x: number; y: number };

const ACCENT = "#5b8def";
const GRID = "#b9bccb";
const BORDER = "#cfcfd6";

const P = 150; // panel side, px
const GAP = 16;
const TOP = 30;
const H = P / 2; // panel half-extent (local origin)

const S = 20; // euclidean / oblique: px per world unit
const RS = 26; // polar: px per radial unit
const US = 40; // log-polar: px per ln-unit
const LT = 1.5; // toroidal: tile half-width (world units)
const ST = H / LT; // toroidal: px per world unit (tile fills the panel)

const TAU = Math.PI * 2;

/** Representative of cyclic angle `target` nearest `cur` (shortest arc),
 *  so a drag across the ±π seam never jumps a full turn. */
const nearestAngle = (target: number, cur: number): number =>
  cur + (target - cur - TAU * Math.round((target - cur) / TAU));

/** Wrap to the fundamental tile `(-LT, LT]`. */
const wrap = (x: number): number => x - 2 * LT * Math.round(x / (2 * LT));

// Each space maps world ⇌ panel-LOCAL pixels (origin at panel centre).
// `bwd` reads the current world value so the cyclic charts pick the
// representative nearest where the point already is.
interface Space {
  name: string;
  fwd: (v: V) => V;
  bwd: (q: V, cur: V) => V;
}

const euclid: Space = {
  name: "euclidean",
  fwd: v => ({ x: H + S * v.x, y: H - S * v.y }),
  bwd: q => ({ x: (q.x - H) / S, y: (H - q.y) / S }),
};

// Constant shear + vertical squash — reads as one receding face of a box.
const oblique: Space = {
  name: "oblique",
  fwd: v => ({ x: H + S * (v.x + 0.5 * v.y), y: H - S * (0.62 * v.y) }),
  bwd: q => {
    const wx = (q.x - H) / S;
    const wy = (H - q.y) / S;
    const y = wy / 0.62;
    return { x: wx - 0.5 * y, y };
  },
};

// Panel axes are (angle → x, radius → y). World circles become horizontal
// lines; rays become vertical lines.
const polar: Space = {
  name: "polar",
  fwd: v => ({
    x: H + (Math.atan2(v.y, v.x) / Math.PI) * (H - 12),
    y: P - 12 - Math.hypot(v.x, v.y) * RS,
  }),
  bwd: (q, cur) => {
    const r = Math.max(0, (P - 12 - q.y) / RS);
    const th = nearestAngle(((q.x - H) / (H - 12)) * Math.PI, Math.atan2(cur.y, cur.x));
    return { x: r * Math.cos(th), y: r * Math.sin(th) };
  },
};

// Same axes, but the radial one is ln r — conformal, so the mesh stays
// orthogonal where plain polar bunches up.
const logpolar: Space = {
  name: "log-polar",
  fwd: v => {
    const r = Math.hypot(v.x, v.y) || 1e-6;
    return { x: H + (Math.atan2(v.y, v.x) / Math.PI) * (H - 12), y: H - Math.log(r) * US };
  },
  bwd: (q, cur) => {
    const r = Math.exp((H - q.y) / US);
    const th = nearestAngle(((q.x - H) / (H - 12)) * Math.PI, Math.atan2(cur.y, cur.x));
    return { x: r * Math.cos(th), y: r * Math.sin(th) };
  },
};

// The plane modulo the tile — drag off one edge, re-enter the other.
// `bwd` keeps the winding nearest the current point.
const torus: Space = {
  name: "toroidal",
  fwd: v => ({ x: H + ST * wrap(v.x), y: H - ST * wrap(v.y) }),
  bwd: (q, cur) => {
    const tx = (q.x - H) / ST;
    const ty = (H - q.y) / ST;
    return {
      x: tx - 2 * LT * Math.round((tx - cur.x) / (2 * LT)),
      y: ty - 2 * LT * Math.round((ty - cur.y) / (2 * LT)),
    };
  },
};

const SPACES = [euclid, oblique, polar, logpolar, torus];

// World gridlines, sampled. Singular samples (log-polar near the origin)
// become `null` to force a break.
function gridSamples(): (V | null)[][] {
  const lines: (V | null)[][] = [];
  const step = 0.15;
  for (let c = -3; c <= 3; c++) {
    const vert: (V | null)[] = [];
    const horiz: (V | null)[] = [];
    for (let t = -3.6; t <= 3.6 + 1e-9; t += step) {
      const pv = { x: c, y: t };
      const ph = { x: t, y: c };
      vert.push(Math.hypot(pv.x, pv.y) < 0.08 ? null : pv);
      horiz.push(Math.hypot(ph.x, ph.y) < 0.08 ? null : ph);
    }
    lines.push(vert, horiz);
  }
  return lines;
}

const GRID_LINES = gridSamples();

/** Polyline `d` over local points, breaking on `null` or a jump larger
 *  than half a panel (a seam crossing) so wraps don't draw stray chords. */
function poly(pts: (V | null)[]): string {
  const thresh = P * 0.6;
  let d = "";
  let prev: V | null = null;
  for (const p of pts) {
    if (!p) {
      prev = null;
      continue;
    }
    const cmd = !prev || Math.hypot(p.x - prev.x, p.y - prev.y) > thresh ? "M" : "L";
    d += `${cmd}${p.x.toFixed(1)} ${p.y.toFixed(1)} `;
    prev = p;
  }
  return d;
}

export class MdCoordinateSpaces extends Diagram {
  protected scene(s: Mount): void {
    const W = GAP + SPACES.length * (P + GAP);
    const view = this.view(W, TOP + P + 34);

    // The one source of truth, plus a trail of where it has been.
    const world = vec(1.6, 0);
    const dragging = cell(false);

    this.anim.start(
      drive(t => {
        if (!dragging.value) {
          this.#phase += t.dt * 0.45;
          // A Lissajous loop tuned to miss the origin (log-polar's pole).
          world.value = {
            x: 1.6 * Math.cos(this.#phase) + 0.4,
            y: 1.1 * Math.sin(2 * this.#phase),
          };
        }
      }),
    );

    SPACES.forEach((sp, i) => {
      const ox = GAP + i * (P + GAP);
      const oy = TOP;
      // Lift the local chart into the SVG-root frame (drag reads/writes
      // root coords), so every layer in the panel shares one coordinate.
      const fr = (v: V): V => {
        const p = sp.fwd(v);
        return { x: p.x + ox, y: p.y + oy };
      };
      const br = (q: V, cur: V): V => sp.bwd({ x: q.x - ox, y: q.y - oy }, cur);

      // Geometry-only frame for clipping (invisible); visible border on top.
      const clipFrame = rect(ox, oy, P, P, { fill: "transparent", stroke: "none" });
      const gridD = GRID_LINES.map(line => poly(line.map(p => (p ? fr(p) : null)))).join("");
      const grid = pathD(cell(gridD), { stroke: GRID, thin: true, opacity: 0.3 });
      const point = world.lens(fr, br);
      const dot = circle(point, 5.5, { fill: ACCENT, stroke: "#1f4fb0", thin: true });

      const g = s(group({}, clipFrame, grid, dot));
      g.el.style.clipPath = clipPath(clipFrame);
      drag(dot, point, dragging);

      // Border and label live outside the clip.
      s(
        rect(ox, oy, P, P, { fill: "none", stroke: BORDER, corner: 6 }),
        label(vec(ox + H, oy + P + 16), sp.name, { size: 11 }),
      );
    });

    s(
      label(
        vec(view.center.value.x, 16),
        "one point, five charts of the plane — drag it in any panel",
      ),
    );
  }

  #phase = 0;
}
