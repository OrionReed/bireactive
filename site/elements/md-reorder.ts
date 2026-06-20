// Reorderable grid — Dragology's flagship, on the general drag algebra. The
// model is the order array; dragging tile `id` makes reachable the states where
// `id` is reinserted at each slot (the paper's bead example, verbatim). The
// whole interaction is one expression:
//
//     d.withFloating(pointer, d.closest(states.map(st => d.fixed(...))))
//
// `closest` picks the nearest reinsertion from live layout cells (no speculative
// re-render), `withFloating` lets the tile follow the pointer, and `dragModel`
// commits the winner on release. Non-dragged tiles spring to their previewed
// slots; the reflow just falls out of the preview being reactive.

import {
  cell,
  Diagram,
  d,
  dragModel,
  effect,
  label,
  type Mount,
  raise,
  rect,
  spring,
  Vec,
  vec,
} from "@bireactive";

const COLORS = [
  "#5b8def",
  "#e25c5c",
  "#f5a623",
  "#3bb273",
  "#9b5de5",
  "#00b8a9",
  "#ef476f",
  "#118ab2",
];
const LETTERS = ["A", "B", "C", "D", "E", "F", "G", "H"];

const COLS = 4;
const N = 8;
const TW = 104;
const TH = 74;
const GAP = 16;

export class MdReorder extends Diagram {
  protected scene(s: Mount): void {
    const view = this.view(640, 380);

    const gridW = COLS * TW + (COLS - 1) * GAP;
    const ox = (view.w.value - gridW) / 2 + TW / 2;
    const oy = 130;
    const stepX = TW + GAP;
    const stepY = TH + GAP;
    const slot = (j: number) => ({
      x: ox + (j % COLS) * stepX,
      y: oy + Math.floor(j / COLS) * stepY,
    });

    for (let j = 0; j < N; j++) {
      const c = slot(j);
      s(rect(vec(c.x, c.y), TW, TH, { corner: 12, fill: "#8881", opacity: 0.18 }));
    }

    // Model: order[slot] = tile id. Dragging `id` reinserts it at each slot —
    // the reachable states. `closest` snaps; `withFloating` follows the pointer.
    const order = cell(Array.from({ length: N }, (_, i) => i));
    const dm = dragModel<number[], number>(order, (id, pointer) => {
      const rest = order.peek().filter(x => x !== id);
      const states = Array.from({ length: N }, (_, t) => {
        const a = rest.slice();
        a.splice(t, 0, id);
        return a;
      });
      const locate = (o: number[]) => slot(o.indexOf(id));
      return d.withFloating(pointer, d.closest(states.map(st => d.fixed(pointer, st, locate))));
    });

    for (let id = 0; id < N; id++) {
      const start = slot(id);
      const pos = vec(start.x, start.y);
      const tile = s(
        rect(pos, TW, TH, {
          corner: 12,
          fill: COLORS[id]!,
          stroke: "var(--bg-color, #fff)",
          strokeWidth: 2,
        }),
      );
      const lbl = s(label(pos, LETTERS[id]!, { size: 26, bold: true, fill: "#fff" }));
      tile.el.style.cursor = "grab";

      // Home = the tile's slot in the previewed order. The dragged tile is
      // pinned to the floating pointer (`dm.at`); the rest spring to reflow.
      const home = Vec.derive(() => slot(dm.preview.value.indexOf(id)));
      this.anim.start(
        spring(pos, home, {
          omega: 26,
          zeta: 0.85,
          precision: 0,
          rate: () => (dm.active.value === id ? 0 : 1),
        }),
      );
      effect(() => {
        if (dm.active.value === id) pos.value = dm.at.value;
      });
      dm.grip(
        tile,
        id,
        () => pos.peek(),
        () => raise(tile, lbl),
      );
    }

    s(
      label(view.top.down(22), "drag any tile — the others reflow, the order commits on drop", {
        size: 14,
        bold: true,
      }),
      label(
        view.bottom.up(18),
        "d.closest(states.map(d.fixed)).withFloating · one spec, no speculative re-render · drop is one array write",
        { size: 10, fill: "var(--text-muted)" },
      ),
    );
  }
}
