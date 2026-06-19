// Resize a cluster by dragging its bounding box: a closed-form `bbox`
// over five points, with derived center and corner handles.

import {
  bbox,
  Diagram,
  derive,
  handle,
  label,
  type Mount,
  rect,
  SKIP,
  Vec,
  vec,
} from "@bireactive";

const PT = "#5b8def";
const CTR = "#f5a623";
const COR = "#e25c5c";

export class MdBboxHandles extends Diagram {
  protected scene(s: Mount): void {
    const view = this.view(620, 360);
    const cx = view.center.value.x;
    const cy = view.center.value.y;

    const pts = [
      vec(cx - 140, cy - 60),
      vec(cx + 130, cy - 80),
      vec(cx + 100, cy + 70),
      vec(cx - 90, cy + 90),
      vec(cx + 20, cy - 30),
    ];

    const { center, size } = bbox(pts);

    // Bottom-right corner: writes back to size, keeping center put.
    const corner = Vec.lens(
      [center, size] as const,
      ([c, sz]) => ({ x: c.x + sz.x / 2, y: c.y + sz.y / 2 }),
      (t, [c]) => [SKIP, { x: 2 * (t.x - c.x), y: 2 * (t.y - c.y) }],
    );

    s(
      rect(
        center,
        derive(() => size.value.x),
        derive(() => size.value.y),
        {
          thin: true,
          stroke: "#9b9b9b",
          opacity: 0.6,
        },
      ),
      ...pts.map(p => handle(p, { fill: PT, r: 7 })),
      handle(center, { fill: CTR, r: 9 }),
      handle(corner, { fill: COR, r: 7 }),
      label(
        view.top.down(20),
        "drag any blue point • drag orange to translate • drag red corner to resize",
      ),
      label(
        view.bottom.up(16),
        "bbox(points) → {center, size} · closed-form, exact cross-channel invariance",
        { size: 10 },
      ),
    );
  }
}
