// y = f(x) plotted as a graph whose single edge runs both ways. `y` is a
// `Num` lens chain off `x`, so dragging the curve point drives x (y
// follows forward) and dragging the y-axis knob writes y (x back-solves).
// A bijection (eˣ) round-trips exactly; a sinusoid's inverse is
// multi-valued, so the backward pass keeps the branch nearest the point.

import {
  Anchor,
  cell,
  circle,
  Diagram,
  derive,
  drag,
  label,
  line,
  type Mount,
  Num,
  num,
  pathD,
  rect,
  Vec,
  vec,
  type Writable,
} from "@bireactive";

const PW = 270;
const PH = 240;
const OY = 36;
const PAD = { l: 40, r: 16, t: 26, b: 34 };
const SAMPLES = 160;

interface PanelCfg {
  ox: number;
  kind: "exp" | "sin";
  title: string;
  color: string;
  x: Writable<Num>;
  xmin: number;
  xmax: number;
  ymin: number;
  ymax: number;
}

export class MdFunction extends Diagram {
  protected scene(s: Mount): void {
    this.view(2 * PW + 16, OY + PH + 8);

    this.panel(s, {
      ox: 8,
      kind: "exp",
      title: "y = eˣ — bijection, exact round-trip",
      color: "#5b8def",
      x: num(0.6),
      xmin: -2.2,
      xmax: 2.2,
      ymin: -0.5,
      ymax: 8,
    });

    this.panel(s, {
      ox: PW + 8,
      kind: "sin",
      title: "y = sin x — inverse picks the nearest branch",
      color: "#e25c5c",
      x: num(0.7),
      xmin: -2 * Math.PI,
      xmax: 2 * Math.PI,
      ymin: -1.3,
      ymax: 1.3,
    });
  }

  private panel(s: Mount, cfg: PanelCfg): void {
    const { ox, kind, title, color, x, xmin, xmax, ymin, ymax } = cfg;
    // y derives from x through the new Num methods — the bidirectional edge.
    const fwd = kind === "exp" ? Math.exp : Math.sin;
    const y: Writable<Num> = kind === "exp" ? x.exp() : x.sin();

    const L = ox + PAD.l;
    const R = ox + PW - PAD.r;
    const T = OY + PAD.t;
    const B = OY + PH - PAD.b;
    const sX = (R - L) / (xmax - xmin);
    const sY = (B - T) / (ymax - ymin);
    const xPixOf = (v: number) => L + (v - xmin) * sX;
    const yPixOf = (v: number) => B - (v - ymin) * sY;

    // Frame, faint zero-axes where they fall inside the window.
    s(rect(ox + 8, OY, PW - 16, PH, { fill: "none", stroke: "#cfcfd6", corner: 6 }));
    if (ymin < 0 && ymax > 0) {
      s(line(vec(L, yPixOf(0)), vec(R, yPixOf(0)), { thin: true, opacity: 0.3 }));
    }
    if (xmin < 0 && xmax > 0) {
      s(line(vec(xPixOf(0), T), vec(xPixOf(0), B), { thin: true, opacity: 0.3 }));
    }

    // The curve, sampled once (f is fixed).
    let d = "";
    for (let i = 0; i <= SAMPLES; i++) {
      const xv = xmin + (i / SAMPLES) * (xmax - xmin);
      d += `${i === 0 ? "M" : "L"}${xPixOf(xv).toFixed(2)} ${yPixOf(fwd(xv)).toFixed(2)} `;
    }
    s(pathD(cell(d), { stroke: color, strokeWidth: 2 }));

    // Pixel-space lenses onto the value cells. The y-knob clamps to the
    // curve's real range (positive for eˣ — its inverse is log — and
    // [-1, 1] for sin), so a write never leaves the function's image.
    const [yLo, yHi] = kind === "exp" ? [Math.exp(xmin), ymax] : [-1, 1];
    const xPix = x.affine(sX, L - xmin * sX);
    const yPix = y.clamp(yLo, yHi).affine(-sY, B + ymin * sY);

    // Point on the curve: drives x (drag horizontally, y follows forward).
    const point = Vec.lens(
      x,
      xv => ({ x: xPixOf(xv), y: yPixOf(fwd(xv)) }),
      target => {
        const xv = (target.x - L) / sX + xmin;
        return xv < xmin ? xmin : xv > xmax ? xmax : xv;
      },
    ) as Writable<Vec>;

    const yKnob = vec(Num.pin(L), yPix);
    const xFoot = vec(xPix, Num.pin(B));

    s(
      line(yKnob, point, { thin: true, dashed: true, opacity: 0.5 }),
      line(xFoot, point, { thin: true, dashed: true, opacity: 0.5 }),
    );

    s(circle(xFoot, 3, { fill: "#9aa0ad" }));
    const knob = s(circle(yKnob, 7, { fill: "white", stroke: "#888", strokeWidth: 2 }));
    drag(knob, yKnob);
    knob.el.style.cursor = "ns-resize";

    const dot = s(circle(point, 7, { fill: color, stroke: "white", strokeWidth: 2 }));
    drag(dot, point);

    s(
      label(vec(ox + PW / 2, OY + 12), title, { size: 10.5, align: Anchor.Center, opacity: 0.8 }),
      label(
        vec(ox + PW / 2, B + 22),
        derive(() => `x = ${x.value.toFixed(2)}    y = ${y.value.toFixed(2)}`),
        { size: 11, align: Anchor.Center, opacity: 0.7 },
      ),
    );
  }
}
