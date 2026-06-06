// Circles slide along a figure-8: a `generic` constraint couples each
// circle's (t, P) via the Lissajous map, with pairwise `gap` to avoid overlap.

import {
  Diagram,
  handle,
  label,
  type Mount,
  num,
  Path,
  type Vec,
  vec,
  type Writable,
} from "@bireactive";
import { constraints, gap, generic } from "@bireactive/constraints";

type WVec = Writable<Vec>;
type WNum = Writable<import("@bireactive").Num>;

const N = 7;
const R = 13;
const A = 140;
const COLORS = ["#5b8def", "#e25c5c", "#f5a623", "#7ed321", "#9b59b6", "#1abc9c", "#e67e22"];

export class MdFigure8 extends Diagram {
  protected scene(s: Mount): void {
    const view = this.view(560, 380);
    const cx = view.center.value.x;
    const cy = view.center.value.y;

    const curve = (t: number): { x: number; y: number } => ({
      x: cx + A * Math.sin(t),
      y: cy + (A * Math.sin(2 * t)) / 2,
    });

    const trace: Vec[] = [];
    for (let i = 0; i <= 240; i++) {
      const t = (i / 240) * 2 * Math.PI;
      trace.push(vec(curve(t).x, curve(t).y));
    }
    s(new Path(trace, { thin: true, opacity: 0.35, closed: true }));

    const positions: WVec[] = [];
    const params: WNum[] = [];
    const cluster = constraints({ iterations: 16 });

    for (let i = 0; i < N; i++) {
      const t0 = (i / N) * 2 * Math.PI;
      const p = curve(t0);
      const P = vec(p.x, p.y);
      const t = num(t0);
      positions.push(P);
      params.push(t);

      cluster.add(
        generic([t, P], 2, (pos, out) => {
          const tt = pos[0]![0]!;
          const want = curve(tt);
          out[0]! = pos[1]![0]! - want.x;
          out[1]! = pos[1]![1]! - want.y;
        }),
      );
    }
    for (let i = 0; i < N; i++) {
      for (let j = i + 1; j < N; j++) cluster.add(gap(positions[i]!, positions[j]!, 2 * R));
    }

    for (let i = 0; i < N; i++) {
      s(handle(positions[i]!, { r: R, fill: COLORS[i % COLORS.length]! }));
    }

    s(
      label(
        view.top.down(20),
        "drag any circle — it slides along the figure-8, others scoot aside",
      ),
      label(
        view.bottom.up(16),
        `${N} circles · per-shape (t, P) coupled via generic · pairwise gap`,
        { size: 10 },
      ),
    );
  }
}
