// Fruchterman–Reingold-style force-directed layout: edge springs, long-range
// repulsion, hard non-overlap gaps, and a softTarget toward center (which also
// kills the rotational DOF a single pin would leave behind).

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
import { animate, gap, physics, pin, repel, softTarget, spring } from "@bireactive/constraints";

type WVec = Writable<Vec>;

interface Edge {
  a: number;
  b: number;
}

const EDGES: readonly Edge[] = [
  { a: 0, b: 1 },
  { a: 0, b: 2 },
  { a: 0, b: 3 },
  { a: 1, b: 4 },
  { a: 1, b: 5 },
  { a: 2, b: 6 },
  { a: 2, b: 7 },
  { a: 3, b: 8 },
  { a: 3, b: 9 },
  { a: 4, b: 10 },
  { a: 5, b: 10 },
  { a: 6, b: 11 },
  { a: 7, b: 11 },
  { a: 8, b: 12 },
  { a: 9, b: 12 },
  { a: 10, b: 13 },
  { a: 11, b: 13 },
  { a: 12, b: 13 },
  { a: 13, b: 14 },
  { a: 14, b: 15 },
  { a: 4, b: 6 },
  { a: 5, b: 7 },
  { a: 8, b: 9 },
];
const N = 16;
const REST = 70;
const SPRING_K = 600; // stiff enough to feel taut
const MIN_GAP = 22;
const REPEL_RANGE = 160; // beyond this, no repulsion
const REPEL_K = 30;
const CENTER_K = 12;

export class MdGraph extends Diagram {
  protected scene(s: Mount): void {
    const view = this.view(560, 400);
    const cx = view.center.value.x;
    const cy = view.center.value.y;

    const TAU = Math.PI * 2;
    let seed = 7;
    const rand = () => {
      seed = (seed * 1664525 + 1013904223) >>> 0;
      return seed / 0xffffffff;
    };
    const nodes: WVec[] = [];
    for (let i = 0; i < N; i++) {
      const a = (i / N) * TAU;
      const r = 70 + rand() * 30;
      nodes.push(vec(cx + r * Math.cos(a), cy + r * Math.sin(a)));
    }

    const cluster = physics({ iterations: 12, postStabilize: true, damping: 0.95 });

    for (const e of EDGES) cluster.add(spring(nodes[e.a]!, nodes[e.b]!, REST, SPRING_K));
    for (let i = 0; i < N; i++) {
      for (let j = i + 1; j < N; j++) {
        cluster.add(repel(nodes[i]!, nodes[j]!, REPEL_RANGE, REPEL_K));
        cluster.add(gap(nodes[i]!, nodes[j]!, MIN_GAP));
      }
    }
    for (let i = 0; i < N; i++) cluster.add(softTarget(nodes[i]!, [cx, cy], CENTER_K));

    this.anim.start(animate(cluster));

    for (const e of EDGES) s(line(nodes[e.a]!, nodes[e.b]!, { thin: true, opacity: 0.5 }));
    for (let i = 0; i < N; i++)
      s(circle(nodes[i]!, MIN_GAP / 2, { fill: "rgba(91, 141, 239, 0.18)", thin: true }));

    for (let i = 0; i < N; i++) {
      const sig = nodes[i]!;
      const h = s(handle(sig, { r: 6 }));
      cluster.addWhile(h.dragging, pin(sig));
    }

    s(
      label(
        view.top.down(20),
        "drag any node — Fruchterman–Reingold-style: edge springs + long-range repulsion + centering",
      ),
      label(
        view.bottom.up(16),
        `${N} nodes · ${EDGES.length} springs · ${(N * (N - 1)) / 2} pair repulsions + gaps · centering`,
        { size: 10 },
      ),
    );
  }
}
