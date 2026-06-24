// Reorderable grid as ONE lens chain — the answer to "md-reorder doesn't use
// lenses, it enumerates states and carries a separate locate pathway". There
// are no candidate states and no `d.` algebra here at all. The model is an
// `arr` of tiles; order is STRUCTURAL (the element cells in order), and
// `order.indexOf(tile)` is a writable `Num` lens over it (read = the tile's
// index, write = a reorder that splices the reference — no rank field, no
// midpoint to run out of).
//
// Each tile is two composed lenses:
//
//   const idx  = order.indexOf(tile);            // Writable<Num> — the reorder lens
//   const home = Vec.lens(idx, place, locate);   // the layout lens
//
// `place : index → point` is the render function; `locate : point → index` is
// its inverse — two halves of ONE layout map, so the diagram keeps a single
// source of truth (no parallel locate fn). Dragging writes the box's position
// straight down the chain — point → index → reference splice — in O(n); every
// other tile reflows because its own `idx`/`home` re-derive from the new order.
//
// The display `pos` and its settle spring are transient drag state (held in the
// animator); the model only ever sees the structural reorder the layout lens
// produces.

import {
  arr,
  cell,
  Diagram,
  drag,
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

interface Tile {
  id: number;
  color: string;
  letter: string;
}

const clamp = (v: number, lo: number, hi: number) => (v < lo ? lo : v > hi ? hi : v);

export class MdReorder extends Diagram {
  protected scene(s: Mount): void {
    const view = this.view(640, 380);

    const gridW = COLS * TW + (COLS - 1) * GAP;
    const ox = (view.w.value - gridW) / 2 + TW / 2;
    const oy = 130;
    const stepX = TW + GAP;
    const stepY = TH + GAP;

    // One layout map, used both ways. `place` lays an order-index out on the
    // grid (this is the render function); `locate` reads a point back to an
    // index (its inverse). The drag system needs nothing else.
    const place = (i: number) => ({
      x: ox + (i % COLS) * stepX,
      y: oy + Math.floor(i / COLS) * stepY,
    });
    const locate = (p: { x: number; y: number }) => {
      const col = clamp(Math.round((p.x - ox) / stepX), 0, COLS - 1);
      const row = Math.max(0, Math.round((p.y - oy) / stepY));
      return clamp(row * COLS + col, 0, N - 1);
    };

    for (let j = 0; j < N; j++) {
      const c = place(j);
      s(rect(vec(c.x, c.y), TW, TH, { corner: 12, fill: "#8881", opacity: 0.18 }));
    }

    const tiles: Tile[] = Array.from({ length: N }, (_, i) => ({
      id: i,
      color: COLORS[i]!,
      letter: LETTERS[i]!,
    }));
    const order = arr<Tile>(tiles);

    for (const cellOf of order.cells) {
      const tile = cellOf.value;
      const idx = order.indexOf(cellOf); // Writable<Num>: read = index, write = reorder
      const home = Vec.lens(idx, place, locate); // layout lens: fwd renders, bwd locates

      const seed = place(tile.id);
      const pos = vec(seed.x, seed.y); // transient display position
      const dragging = cell(false);

      const r = s(
        rect(pos, TW, TH, {
          corner: 12,
          fill: tile.color,
          stroke: "var(--bg-color, #fff)",
          strokeWidth: 2,
        }),
      );
      const lbl = s(label(pos, tile.letter, { size: 26, bold: true, fill: "#fff" }));

      // Non-dragged tiles ease to `home` (the layout lens read forward from
      // their current index); the dragged tile's spring is frozen so it floats.
      this.anim.start(
        spring(pos, home, {
          omega: 26,
          zeta: 0.85,
          precision: 0,
          rate: () => (dragging.value ? 0 : 1),
        }),
      );

      drag(r, pos, dragging);
      // The whole interaction: while held, the display position writes back
      // through the layout lens — point → index → reference splice — so the
      // order updates live and the rest reflow. Release lets the spring settle.
      effect(() => {
        if (dragging.value) home.value = pos.value;
      });
      effect(() => {
        if (dragging.value) raise(r, lbl);
      });
    }

    s(
      label(
        view.top.down(22),
        "drag any tile — the others reflow live, the order is structural (no rank field)",
        {
          size: 14,
          bold: true,
        },
      ),
      label(
        view.bottom.up(18),
        "Vec.lens(order.indexOf(tile), place, locate) · one lens chain · no candidate states, no separate locate",
        { size: 10 },
      ),
    );
  }
}
