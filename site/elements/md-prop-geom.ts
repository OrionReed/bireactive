// Bidirectional geometric construction (triangle + centroid + midpoints) via a propagator network.

import { Diagram, handle, label, line, type Mount, vec } from "@bireactive";
import { centroid, mid, propagators } from "@bireactive/propagators";

const VERT = "#5b8def";
const CENT = "#f5a623";
const MID = "#86b966";

export class MdPropGeom extends Diagram {
  protected scene(s: Mount): void {
    const view = this.view(620, 400);
    const { x: cx, y: cy } = view.center.value;

    const A = vec(cx - 140, cy + 80);
    const B = vec(cx + 140, cy + 80);
    const C = vec(cx, cy - 100);

    // Derived: centroid + per-side midpoints.
    const G = vec();
    const Mab = vec();
    const Mbc = vec();
    const Mca = vec();

    propagators().add(centroid(G, A, B, C), mid(A, B, Mab), mid(B, C, Mbc), mid(C, A, Mca));

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
      label(view.bottom.up(16), "centroid · mid — bidirectional propagators on Vec signals"),
    );
  }
}
