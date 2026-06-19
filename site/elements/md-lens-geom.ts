// The same triangle + centroid + midpoints as md-prop-geom, but the
// derived points are lenses (`mean`) instead of propagators. No network:
// each derived point IS a value, and its backward policy is the drag.

import { Diagram, handle, label, line, type Mount, mean, vec } from "@bireactive";

const VERT = "#5b8def";
const CENT = "#f5a623";
const MID = "#86b966";

export class MdLensGeom extends Diagram {
  protected scene(s: Mount): void {
    const view = this.view(620, 400);
    const { x: cx, y: cy } = view.center.value;

    const A = vec(cx - 140, cy + 80);
    const B = vec(cx + 140, cy + 80);
    const C = vec(cx, cy - 100);

    // Derived: centroid + per-side midpoints — all the same primitive.
    const G = mean([A, B, C]);
    const Mab = mean([A, B]);
    const Mbc = mean([B, C]);
    const Mca = mean([C, A]);

    const SIDE = { thin: true, opacity: 0.6 };
    const MEDIAN = { thin: true, opacity: 0.25 };
    const VERTEX = { fill: VERT, r: 7 };
    const CENTROID = { fill: CENT, r: 8 };
    const MIDPOINT = { fill: MID, r: 5 };

    s(
      line(A, B, SIDE),
      line(B, C, SIDE),
      line(C, A, SIDE),
      line(G, Mab, MEDIAN),
      line(G, Mbc, MEDIAN),
      line(G, Mca, MEDIAN),
      handle(A, VERTEX),
      handle(B, VERTEX),
      handle(C, VERTEX),
      handle(G, CENTROID),
      handle(Mab, MIDPOINT),
      handle(Mbc, MIDPOINT),
      handle(Mca, MIDPOINT),

      label(
        view.top.down(20),
        "drag any vertex • centroid (orange) follows • drag centroid → triangle translates",
      ),
      label(view.bottom.up(16), "centroid · mid — bidirectional lenses (mean) on Vec signals"),
    );
  }
}
