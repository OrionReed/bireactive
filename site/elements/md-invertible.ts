import { circle, Diagram, drag, label, line, type Mount, vec } from "@bireactive";

export class MdInvertible extends Diagram {
  protected scene(s: Mount): void {
    const view = this.view(480, 240);

    const a = vec(view.w.value * 0.3, view.h.value * 0.7);

    // `.right`/`.up` are invertible, so writes to `b` flow back through to `a`.
    const b = a.right(160).up(80);

    s(line(a, b));

    const ca = s(circle(a, 16, { fill: "#5b8def" }));
    const cb = s(circle(b, 16, { fill: "#e25c5c" }));
    drag(ca, a);
    drag(cb, b);

    s(
      label(view.top.down(20), "drag either shape — the invertible chain writes both ways"),
      label(view.bottom.up(16), "b = a.right(160).up(80) · same lens read & written", {
        size: 10,
      }),
    );
  }
}
