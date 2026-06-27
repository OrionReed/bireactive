// Flexbox as interval propagation: a nested col/row layout whose sizes
// are solved by narrowing. Drag the container's right edge — panes
// grow/shrink within their [min, max] bands; shrink past the sum of the
// mins and the layout reports "infeasible" instead of silently
// overflowing.

import {
  box,
  cell,
  Diagram,
  derive,
  handle,
  label,
  type Mount,
  rect,
  SKIP,
  Vec,
} from "@bireactive";
import { col, row, solve } from "@bireactive/propagators";

const PANE = ["#5b8def", "#e25c5c", "#f5a623"];
const OK = "#86b966";
const BAD = "#e25c5c";
const MIN = 90;

export class MdFlex extends Diagram {
  protected scene(s: Mount): void {
    const view = this.view(620, 420);
    const cx = view.center.value.x;

    // Resizable container. One free edge (right); the rest is solved.
    const container = box(cx - 220, 70, 440, 250);
    const infeasible = cell(false);

    // col → [toolbar, body]; body → three panes with min widths + grow.
    const toolbar = box();
    const body = box();
    const panes = [box(), box(), box()];

    solve(
      col(container, [{ box: toolbar, min: 44, max: 44, grow: 0 }, body], { gap: 10, padding: 10 }),
      row(
        body,
        panes.map((b, i) => ({ box: b, min: MIN, grow: i === 1 ? 2 : 1, basis: 0 })),
        { gap: 10, align: "stretch", report: v => (infeasible.value = v) },
      ),
    );

    // Container chrome + a draggable right edge (writes container.w).
    const rightEdge = Vec.lens(
      [container.x, container.w, container.y, container.h] as const,
      ([x, w, y, h]) => ({ x: x + w, y: y + h / 2 }),
      (v, [x]) => {
        const nw = v.x - x;
        return nw > 40 ? [SKIP, nw, SKIP, SKIP] : [SKIP, SKIP, SKIP, SKIP];
      },
    );

    s(
      rect(container.x, container.y, container.w, container.h, {
        stroke: derive(() => (infeasible.value ? BAD : "#888")),
        fill: derive(() => (infeasible.value ? "#e25c5c12" : "#00000008")),
        thin: true,
        corner: 6,
      }),
      rect(toolbar.x, toolbar.y, toolbar.w, toolbar.h, { fill: "#8884", corner: 4 }),
      label(toolbar.center, "toolbar · fixed 44", { size: 10 }),
    );

    panes.forEach((b, i) => {
      s(
        rect(b.x, b.y, b.w, b.h, { fill: PANE[i]!, opacity: 0.4, corner: 4 }),
        label(
          b.center,
          derive(() => `${Math.round(b.w.value)}`),
          { size: 13, bold: true },
        ),
        label(b.center.down(18), `min ${MIN} · grow ${i === 1 ? 2 : 1}`, {
          size: 9,
        }),
      );
    });

    s(handle(rightEdge, { r: 7, fill: "var(--text-color, #444)", cursor: "ew-resize" }));

  }
}
