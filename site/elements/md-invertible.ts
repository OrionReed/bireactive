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

const BLUE = { r: 91, g: 141, b: 239 };
const RED = { r: 226, g: 92, b: 92 };

export class MdInvertible extends Diagram {
  protected scene(s: Mount): void {
    const view = this.view(520, 300);

    const pivot = vec(265, 160);
    const STEP = 0.6; // radians per link
    const SHRINK = 0.85; // radius ratio per link
    const N = 7; // links → N + 1 dots

    // One similarity edge — rotate then scale about a shared pivot —
    // composed down the chain. Each dot is the previous run through the
    // same two invertible steps, so writing any dot inverts back up the
    // chain and re-derives the rest: the whole spiral reflows.
    const a = vec(155, 208);
    const dots: Writable<Vec>[] = [a];
    let p: Writable<Vec> = a;
    for (let i = 0; i < N; i++) {
      p = p.rotate(STEP, pivot).scale(SHRINK, pivot);
      dots.push(p);
    }

    for (let i = 0; i < dots.length - 1; i++) {
      s(line(dots[i]!, dots[i + 1]!, { thin: true, opacity: 0.45 }));
    }

    s(circle(pivot, 3, { fill: "#9aa0ad" }));

    // Colour ramp blue → red so the chain direction reads at a glance.
    dots.forEach((d, i) => {
      const t = i / (dots.length - 1);
      const r = Math.round(BLUE.r + t * (RED.r - BLUE.r));
      const g = Math.round(BLUE.g + t * (RED.g - BLUE.g));
      const b = Math.round(BLUE.b + t * (RED.b - BLUE.b));
      s(handle(d, { fill: `rgb(${r}, ${g}, ${b})` }));
    });

    s(
      label(view.top.down(20), "drag any dot — one rotate+scale edge composed down the chain"),
      label(
        view.bottom.up(16),
        "next = p.rotate(θ, pivot).scale(k, pivot) · same similarity, every direction",
        { size: 10 },
      ),
    );
  }
}
