// Sketchpad-style construction: a rigid bracket whose outer vertices are
// constrained to a draggable circle and line; the inner vertex articulates
// while keeping both on their loci.

import {
  circle,
  Diagram,
  handle,
  label,
  line,
  type Mount,
  type Vec,
  vec,
  type Writable,
} from "@bireactive";
import {
  collinear,
  constraints,
  distance,
  equalDist,
  onCircle,
  pin,
  rightAngle,
} from "@bireactive/constraints";

type WVec = Writable<Vec>;

const RADIUS = 65;
const BAR = 70;

export class MdIncidence extends Diagram {
  protected scene(s: Mount): void {
    const view = this.view(620, 400);
    const cx = view.center.value.x;
    const cy = view.center.value.y;

    const center = vec(cx - 140, cy);
    const L1 = vec(cx + 70, cy + 110);
    const L2 = vec(cx + 220, cy - 110);

    const P = vec(cx - 140 + RADIUS, cy); // on the circle
    const Q = vec(cx + 145, cy); // on the line
    const M = vec(cx - 30, cy); // free inner vertex

    const cluster = constraints({ iterations: 24 });
    cluster.add(
      onCircle(P, center, RADIUS),
      collinear(Q, L1, L2),
      distance(P, M, BAR),
      distance(M, Q, BAR),
      equalDist(P, M, M, Q),
      rightAngle(P, M, Q),
    );

    s(circle(center, RADIUS, { thin: true, opacity: 0.4 }));
    s(circle(center, 3, { fill: true }));
    s(line(L1, L2, { thin: true, opacity: 0.4 }));

    s(line(P, M));
    s(line(M, Q));
    s(circle(M, 8, { thin: true, opacity: 0.45 }));

    const handles: ReadonlyArray<[WVec, ReturnType<typeof handle>, string]> = [
      [center, s(handle(center, { r: 6 })), "center"],
      [L1, s(handle(L1, { r: 6 })), "L1"],
      [L2, s(handle(L2, { r: 6 })), "L2"],
      [P, s(handle(P, { fill: "#5b8def", r: 7 })), "P"],
      [Q, s(handle(Q, { fill: "#e25c5c", r: 7 })), "Q"],
      [M, s(handle(M, { fill: "#f5a623", r: 7 })), "M"],
    ];
    for (const [sig, h] of handles) {
      cluster.addWhile(h.dragging, pin(sig));
    }

    s(
      label(
        view.top.down(20),
        "P stays on the circle, Q stays on the line, |PM| = |MQ| at a right angle",
      ),
      label(
        view.bottom.up(16),
        "onCircle · collinear · distance · equalDist · rightAngle — six constraints, one cluster",
        { size: 10 },
      ),
    );
  }
}
