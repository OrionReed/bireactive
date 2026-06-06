// `Num.clamp` and `Num.quantize` as chained projective lenses over one source
// `t`: each row reads a longer prefix (t → t.clamp → .quantize) and writes flow
// back through every prior lens. Each knob's y-axis is a `Num.pin` so a plain
// `drag(knob, vec)` stays axis-locked.

import {
  Anchor,
  circle,
  Diagram,
  derive,
  drag,
  label,
  line,
  type Mount,
  Num,
  num,
  range,
  rect,
  vec,
  type Writable,
} from "@bireactive";

const W = 600;
const H = 240;
const X0 = 70;
const X1 = W - 70;
const SPAN = X1 - X0;
const ROWS = { raw: 70, clamp: 130, quant: 190 } as const;

export class MdClampQuantize extends Diagram {
  protected scene(s: Mount): void {
    const view = this.view(W, H);

    const t = num(0.5);
    const lo = num(0.2);
    const hi = num(0.8);
    const tC = t.clamp(lo, hi);
    const tQ = tC.quantize(0.1);

    s(label(view.top.down(16), "chained projections — writes flow back through every prior lens"));

    this.row(s, ROWS.raw, "t", t, "#5b8def", () => t.value.toFixed(3));

    // Shaded margins flag the dead zones; the pinch handles edit the bounds.
    const loX = range(X0, X1).slider(lo);
    const hiX = range(X0, X1).slider(hi);
    const shade = { fill: "rgba(127,127,127,0.18)", stroke: "transparent" } as const;
    s(
      rect(
        X0,
        ROWS.clamp - 4,
        derive(() => loX.value - X0),
        8,
        shade,
      ),
      rect(
        hiX,
        ROWS.clamp - 4,
        derive(() => X1 - hiX.value),
        8,
        shade,
      ),
    );
    this.row(
      s,
      ROWS.clamp,
      "↳ .clamp(lo, hi)",
      tC,
      "#e25c5c",
      () => `[${lo.value.toFixed(2)}, ${hi.value.toFixed(2)}]`,
    );
    for (const pxX of [loX, hiX]) {
      const pos = vec(pxX, Num.pin(ROWS.clamp));
      const h = s(circle(pos, 6, { fill: "white", stroke: "#888", strokeWidth: 1.5 }));
      drag(h, pos);
      h.el.style.cursor = "ew-resize";
    }

    // Detents outside [lo, hi] fade: the clamp upstream of `tQ` rejects writes
    // before quantize can snap, so the row-3 knob can't reach them.
    for (let i = 0; i <= 10; i++) {
      const x = X0 + (i / 10) * SPAN;
      s(
        line(vec(x, ROWS.quant - 5), vec(x, ROWS.quant + 5), {
          thin: true,
          opacity: derive(() => (i / 10 >= lo.value && i / 10 <= hi.value ? 0.45 : 0.12)),
        }),
      );
    }
    this.row(s, ROWS.quant, "↳ .quantize(0.1)", tQ, "#7ed321", () => tQ.value.toFixed(1));

    s(
      label(
        view.bottom.up(10),
        "drag any rail — writes propagate up the chain through each prior projection",
        { size: 9.5 },
      ),
    );
  }

  private row(
    s: Mount,
    y: number,
    name: string,
    t: Writable<Num>,
    color: string,
    readout: () => string,
  ): void {
    s(
      label(vec(X0, y - 16), name, { align: Anchor.Left }),
      label(vec(X1, y - 16), derive(readout), { align: Anchor.Right }),
      line(vec(X0, y), vec(X1, y), { thin: true, opacity: 0.35, cap: "round" }),
    );
    const pos = vec(range(X0, X1).slider(t), Num.pin(y));
    const knob = s(circle(pos, 9, { fill: color, stroke: "white", strokeWidth: 2 }));
    drag(knob, pos);
    knob.el.style.cursor = "ew-resize";
  }
}
