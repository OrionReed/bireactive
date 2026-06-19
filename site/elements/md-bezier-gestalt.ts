// Gestalt handles vs raw control points on a cubic Bezier:
// `bezierGestalt` projects the four controls into start/end/tangent
// handles that preserve curve-shape invariants.

import {
  bezierGestalt,
  Diagram,
  derive,
  handle,
  label,
  line,
  type Mount,
  pathD,
  SKIP,
  Vec,
  vec,
} from "@bireactive";

export class MdBezierGestalt extends Diagram {
  protected scene(s: Mount): void {
    const view = this.view(620, 360);
    const cx = view.center.value.x;
    const cy = view.center.value.y;

    const p0 = vec(cx - 220, cy + 50);
    const p1 = vec(cx - 100, cy - 100);
    const p2 = vec(cx + 100, cy + 150);
    const p3 = vec(cx + 220, cy - 30);

    const { start, end, startTangent, endTangent } = bezierGestalt(p0, p1, p2, p3);

    const startTanHandle = Vec.lens(
      [start, startTangent] as const,
      ([a, t]) => ({ x: a.x + t.x, y: a.y + t.y }),
      (target, [a]) => [SKIP, { x: target.x - a.x, y: target.y - a.y }],
    );
    const endTanHandle = Vec.lens(
      [end, endTangent] as const,
      ([a, t]) => ({ x: a.x + t.x, y: a.y + t.y }),
      (target, [a]) => [SKIP, { x: target.x - a.x, y: target.y - a.y }],
    );

    const d = derive(() => {
      const a = p0.value;
      const b = p1.value;
      const c = p2.value;
      const e = p3.value;
      return `M ${a.x} ${a.y} C ${b.x} ${b.y} ${c.x} ${c.y} ${e.x} ${e.y}`;
    });

    s(
      pathD(d, { stroke: "#5b8def", strokeWidth: 2.5 }),
      line(p0, p1, { thin: true, opacity: 0.25, dashed: true }),
      line(p1, p2, { thin: true, opacity: 0.25, dashed: true }),
      line(p2, p3, { thin: true, opacity: 0.25, dashed: true }),
      line(start, startTanHandle, { thin: true, opacity: 0.45 }),
      line(end, endTanHandle, { thin: true, opacity: 0.45 }),
      handle(p1, { fill: "#bbbbbb", r: 5 }),
      handle(p2, { fill: "#bbbbbb", r: 5 }),
      handle(start, { fill: "#f5a623", r: 9 }),
      handle(end, { fill: "#f5a623", r: 9 }),
      handle(startTanHandle, { fill: "#7ed321", r: 7 }),
      handle(endTanHandle, { fill: "#7ed321", r: 7 }),
      label(
        view.top.down(20),
        "drag orange (start/end) → p1/p2 follow · drag green (tangent) → only p1/p2 move",
      ),
      label(
        view.bottom.up(16),
        "grey dots are raw control points · orange/green are the bezierGestalt",
        { size: 10 },
      ),
    );
  }
}
