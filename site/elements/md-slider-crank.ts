// Slider-crank linkage: rotating crank, rigid rod, sliding piston.

import { circle, Diagram, drag, handle, label, line, type Mount, rect, vec } from "@bireactive";
import { collinear, constraints, distance, pin } from "@bireactive/constraints";

const CRANK = 50;
const ROD = 130;

export class MdSliderCrank extends Diagram {
  protected scene(s: Mount): void {
    const view = this.view(560, 360);
    const cx = view.center.value.x;
    const cy = view.center.value.y;

    const O1 = vec(cx - 80, cy);
    const A = vec(cx - 80, cy - CRANK);
    const B = vec(cx - 80 + Math.sqrt(ROD * ROD - CRANK * CRANK), cy);

    // Two anchors fix the horizontal slide axis through O1's y.
    const guide1 = vec(cx + 30, cy);
    const guide2 = vec(cx + 200, cy);

    const cluster = constraints({ iterations: 24 });
    cluster.add(
      distance(O1, A, CRANK),
      distance(A, B, ROD),
      collinear(B, guide1, guide2),
      pin(O1),
      pin(guide1),
      pin(guide2),
    );

    s(circle(O1, CRANK, { thin: true, opacity: 0.18 }));
    s(line(guide1, guide2, { thin: true, opacity: 0.25 }));
    s(line(O1, A, { thin: false }));
    s(line(A, B, { thin: false }));
    s(circle(O1, 5, { fill: true }));

    s(handle(A, { r: 8, fill: "#e25c5c" }));

    // Piston is a rect, not a dot — keep custom drag with ew-resize cursor.
    const piston = s(rect(B, 56, 20, { fill: "#5b8def", corner: 3 }));
    piston.el.style.cursor = "ew-resize";
    drag(piston, B);

    s(
      label(view.top.down(20), "drag the red crank tip — the piston follows on the guide"),
      label(
        view.bottom.up(16),
        "distance(crank) · distance(rod) · collinear(piston, guide₁, guide₂)",
        { size: 10 },
      ),
    );
  }
}
