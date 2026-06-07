// Best-fit line and circle over one point cloud: `bestFitLine` and
// `bestFitCircle` share the centroid, with centroid/rotation/radius
// handles that translate, rotate, and scale the cluster.

import {
  bestFitCircle,
  bestFitLine,
  Diagram,
  ellipse,
  handle,
  label,
  line,
  type Mount,
  Vec,
  vec,
} from "@bireactive";

export class MdBestFit extends Diagram {
  protected scene(s: Mount): void {
    const view = this.view(620, 380);
    const cx = view.center.value.x;
    const cy = view.center.value.y;

    const pts = [
      vec(cx - 90, cy - 55),
      vec(cx - 40, cy - 30),
      vec(cx + 10, cy + 5),
      vec(cx + 60, cy + 30),
      vec(cx + 100, cy + 50),
      vec(cx - 20, cy + 20),
      vec(cx + 30, cy - 10),
    ];

    const { point, direction } = bestFitLine(pts);
    const { center, radius } = bestFitCircle(pts);

    const LEN = 250;
    const lineA = Vec.derive([point, direction] as const, ([p, θ]) => ({
      x: p.x - LEN * Math.cos(θ),
      y: p.y - LEN * Math.sin(θ),
    }));
    const lineB = Vec.derive([point, direction] as const, ([p, θ]) => ({
      x: p.x + LEN * Math.cos(θ),
      y: p.y + LEN * Math.sin(θ),
    }));

    const rotHandle = Vec.lens(
      [point, direction] as const,
      ([p, θ]) => ({ x: p.x + 90 * Math.cos(θ), y: p.y + 90 * Math.sin(θ) }),
      (t, [p]) => [undefined, Math.atan2(t.y - p.y, t.x - p.x)] as never,
    );

    // Perpendicular to the line direction so it doesn't overlap rotHandle.
    const radiusHandle = Vec.lens(
      [center, radius, direction] as const,
      ([c, r, θ]) => ({
        x: c.x - r * Math.sin(θ),
        y: c.y + r * Math.cos(θ),
      }),
      (t, [c, _r, θ]) => {
        const dx = t.x - c.x;
        const dy = t.y - c.y;
        const proj = -dx * Math.sin(θ) + dy * Math.cos(θ);
        return [undefined, Math.max(0, proj), undefined] as never;
      },
    );

    s(
      // Dashed because these curves are derived from the points, not vice versa.
      ellipse(center, radius, radius, 0, { thin: true, opacity: 0.5, dashed: true }),
      line(lineA, lineB, { thin: true, stroke: "#5b8def", opacity: 0.7, dashed: true }),
      ...pts.map(p => handle(p, { fill: "#5b8def", r: 5 })),
      handle(point, { fill: "#f5a623", r: 9 }),
      handle(rotHandle, { fill: "#7ed321", r: 8 }),
      handle(radiusHandle, { fill: "#e25c5c", r: 8 }),
      label(
        view.top.down(20),
        "drag any point • orange centroid • green direction (rotation) • red radius (scale)",
      ),
      label(
        view.bottom.up(16),
        "bestFitLine + bestFitCircle · two decompositions, same centroid, exact",
        { size: 10 },
      ),
    );
  }
}
