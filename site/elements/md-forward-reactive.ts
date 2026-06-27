// Forward-only reactivity. The first dot is the only cell; every other dot
// is a `derive` over the one before it. Dragging the source reflows the whole
// chain, but the derived dots can't be grabbed — they have no backward edge.

import { circle, Diagram, handle, line, type Mount, Vec, vec, type Writable } from "@bireactive";

const BLUE = { r: 91, g: 141, b: 239 };
const RED = { r: 226, g: 92, b: 92 };

const PIVOT = { x: 265, y: 160 };
const STEP = 0.6; // radians per link
const SHRINK = 0.85; // radius ratio per link

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

export class MdForwardReactive extends Diagram {
  protected scene(s: Mount): void {
    const view = this.view(520, 300);
    const N = 7; // links → N + 1 dots

    const a: Writable<Vec> = vec(155, 208);
    const dots: Vec[] = [a];
    let prev: Vec = a;
    for (let i = 0; i < N; i++) {
      const p = prev;
      const d = Vec.derive(() => rotScale(p.value));
      dots.push(d);
      prev = d;
    }

    for (let i = 0; i < dots.length - 1; i++) {
      s(line(dots[i]!, dots[i + 1]!, { thin: true, opacity: 0.45 }));
    }

    s(circle(vec(PIVOT.x, PIVOT.y), 3, { fill: "#9aa0ad" }));

    dots.forEach((d, i) => {
      const t = i / (dots.length - 1);
      const r = Math.round(BLUE.r + t * (RED.r - BLUE.r));
      const g = Math.round(BLUE.g + t * (RED.g - BLUE.g));
      const b = Math.round(BLUE.b + t * (RED.b - BLUE.b));
      const fill = `rgb(${r}, ${g}, ${b})`;
      if (i === 0) s(handle(a, { fill }));
      else s(circle(d, 6, { fill, opacity: 0.85 }));
    });
  }
}
