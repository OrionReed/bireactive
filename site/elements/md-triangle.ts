// Triangle as a small lens DAG: three vertices are the only roots; every
// other point is a `mean` lens over them. Drag a vertex and its incident
// derived points follow; drag an edge-midpoint and its two endpoints move;
// drag the centroid and all three vertices translate. The medial triangle
// is just lines between the derived midpoints, so the whole figure stays
// consistent from whichever handle you grab.

import { Diagram, handle, label, line, type Mount, mean, vec } from "@bireactive";

const VERT = "#5b8def";
const MID = "#f5a623";
const CENTROID = "#e25c5c";

export class MdTriangle extends Diagram {
  protected scene(s: Mount): void {
    const view = this.view(560, 380);
    const cx = view.center.value.x;
    const cy = view.center.value.y;

    const a = vec(cx, cy - 120);
    const b = vec(cx - 160, cy + 100);
    const c = vec(cx + 160, cy + 100);

    // Every derived point is an N→1 `mean` lens (writing it moves its inputs).
    const mAB = mean([a, b]);
    const mBC = mean([b, c]);
    const mCA = mean([c, a]);
    const g = mean([a, b, c]);

    // Edges.
    s(line(a, b, { thin: true }), line(b, c, { thin: true }), line(c, a, { thin: true }));

    // Medial triangle (connects the edge midpoints).
    s(
      line(mAB, mBC, { thin: true, dashed: true, opacity: 0.4 }),
      line(mBC, mCA, { thin: true, dashed: true, opacity: 0.4 }),
      line(mCA, mAB, { thin: true, dashed: true, opacity: 0.4 }),
    );

    // Handles last, so they sit on top.
    s(handle(a, { fill: VERT }), handle(b, { fill: VERT }), handle(c, { fill: VERT }));
    s(
      handle(mAB, { fill: MID, r: 5 }),
      handle(mBC, { fill: MID, r: 5 }),
      handle(mCA, { fill: MID, r: 5 }),
    );
    s(handle(g, { fill: CENTROID, r: 8 }));

    s(
      label(
        view.top.down(20),
        "drag a vertex, an edge-midpoint (moves its two ends), or the centroid (moves all three)",
      ),
      label(view.bottom.up(16), "every point but the three vertices is a mean-lens", { size: 10 }),
    );
  }
}
