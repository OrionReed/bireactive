// Each dot is its own cell — no relation between them. Dragging one moves
// only it; the connecting lines still re-render because they read the two
// endpoint cells, but nothing propagates from one dot to another.

import { Diagram, handle, line, type Mount, type Vec, vec, type Writable } from "@bireactive";

const BLUE = { r: 91, g: 141, b: 239 };
const RED = { r: 226, g: 92, b: 92 };

const PIVOT = { x: 265, y: 160 };
const STEP = 0.6;
const SHRINK = 0.85;

function rotScale(p: { x: number; y: number }): { x: number; y: number } {
  const dx = p.x - PIVOT.x;
  const dy = p.y - PIVOT.y;
  const c = Math.cos(STEP);
  const s = Math.sin(STEP);
  return {
    x: PIVOT.x + (dx * c - dy * s) * SHRINK,
    y: PIVOT.y + (dx * s + dy * c) * SHRINK,
  };
}

export class MdIndependentCells extends Diagram {
  protected scene(s: Mount): void {
    const view = this.view(520, 300);
    const N = 7; // same starting layout as the forward chain — but unlinked

    const dots: Writable<Vec>[] = [];
    let p = { x: 155, y: 208 };
    for (let i = 0; i <= N; i++) {
      dots.push(vec(p.x, p.y));
      p = rotScale(p);
    }

    for (let i = 0; i < dots.length - 1; i++) {
      s(line(dots[i]!, dots[i + 1]!, { thin: true, opacity: 0.45 }));
    }

    dots.forEach((d, i) => {
      const t = i / (dots.length - 1);
      const r = Math.round(BLUE.r + t * (RED.r - BLUE.r));
      const g = Math.round(BLUE.g + t * (RED.g - BLUE.g));
      const b = Math.round(BLUE.b + t * (RED.b - BLUE.b));
      s(handle(d, { fill: `rgb(${r}, ${g}, ${b})` }));
    });
  }
}
