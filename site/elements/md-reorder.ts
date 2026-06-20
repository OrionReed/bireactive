// A model-driven reorderable grid — Dragology's flagship (and worst-case)
// example, computed the other way around. Dragology re-renders every
// candidate permutation each frame and reads the dragged tile's position
// out of each (quadratic). Here the slot centers are live cells, so
// `closest` picks the target slot directly — O(slots), no speculative
// render — and the drop is a single array write. The non-dragged tiles
// reflow by springing to their previewed slots; the dragged tile floats to
// the pointer (`floating`) and settles into place on release.

import {
  cell,
  closest,
  Diagram,
  derive,
  effect,
  floating,
  label,
  type Mount,
  rect,
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

    /** Center of slot `j` in the grid (the live "layout cell" `closest`
     *  reads — no DOM measurement, no re-render). */
    const slotCenter = (j: number) => ({
      x: ox + (j % COLS) * stepX,
      y: oy + Math.floor(j / COLS) * stepY,
    });
    const slotCells = Array.from({ length: N }, (_, j) => {
      const c = slotCenter(j);
      return vec(c.x, c.y);
    });

    // Faint slot backgrounds so the discrete drop targets are visible.
    for (let j = 0; j < N; j++) {
      const c = slotCenter(j);
      s(rect(vec(c.x, c.y), TW, TH, { corner: 12, fill: "#8881", opacity: 0.18 }));
    }

    // The model: `order[j]` is the id of the tile occupying slot j.
    const order = cell<number[]>(Array.from({ length: N }, (_, i) => i));
    const draggingId = cell<number | null>(null);

    // The dragged tile's live position doubles as the pointer for `closest`.
    const dragPointer = Vec.derive(() => {
      const d = draggingId.value;
      return d === null ? { x: -1e4, y: -1e4 } : tiles[d]!.pos.value;
    });
    // Which slot is the pointer over? Hysteresis keeps the pick stable at
    // slot boundaries (Dragology's stickiness, here in the lens complement).
    const { index: slotPick } = closest(dragPointer, slotCells, { sticky: stepX * 0.34 });

    // The previewed order: the dragged tile moved to the picked slot, the
    // rest closing ranks. One pure function of (committed order, pick).
    const previewOrder = derive(() => {
      const base = order.value;
      const d = draggingId.value;
      if (d === null) return base;
      const k = slotPick.value;
      const without = base.filter(x => x !== d);
      const at = Math.max(0, Math.min(k, without.length));
      const arr = without.slice();
      arr.splice(at, 0, d);
      return arr;
    });

    interface Tile {
      id: number;
      pos: Vec;
    }
    const tiles: Tile[] = [];

    for (let id = 0; id < N; id++) {
      const start = slotCenter(id);
      const pos = vec(start.x, start.y);
      tiles.push({ id, pos });

      // Each tile's home is the center of whatever slot it occupies in the
      // previewed order. Reflow falls out: when the preview changes, the
      // spring in `floating` eases every non-dragged tile to its new home.
      const home = Vec.derive(() => slotCenter(previewOrder.value.indexOf(id)));

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

      const { dragging, anim } = floating(tile, pos, home, { omega: 26, zeta: 0.85 });
      this.anim.start(anim);

      // Drag lifecycle: claim the drag on press; on release, COMMIT the
      // previewed order with one write and clear the drag.
      let was = false;
      effect(() => {
        const now = dragging.value;
        if (now && !was) {
          draggingId.value = id;
          // Raise the dragged tile above the others.
          tile.el.parentElement?.appendChild(tile.el);
          lbl.el.parentElement?.appendChild(lbl.el);
        } else if (!now && was) {
          order.value = previewOrder.peek();
          draggingId.value = null;
        }
        was = now;
      });
    }

    s(
      label(view.top.down(22), "drag any tile — the others reflow, the order commits on drop", {
        size: 14,
        bold: true,
      }),
      label(
        view.bottom.up(18),
        "closest() picks the slot from live layout cells · move is one array write · no speculative re-render",
        { size: 10, fill: "var(--text-muted)" },
      ),
    );
  }
}
