// Twisted Trees — Dragology's `between`, the continuous sibling of
// `closest`. Drag the control point inside the triangle: its barycentric
// position (clamped to the hull) gives the weights, and every node of the
// tree is a `mix` of its position in the three reference layouts. The tree
// morphs smoothly between "stack", "ring", and "splay" — one weighted
// lens, no per-frame re-layout of candidates.

import {
  between,
  circle,
  Diagram,
  derive,
  drag,
  handle,
  hullWeights,
  label,
  line,
  type Mount,
  mix,
  type Read,
  Vec,
  vec,
  type Writable,
} from "@bireactive";

// root, three children, three grandchildren.
const EDGES: [number, number][] = [
  [0, 1],
  [0, 2],
  [0, 3],
  [1, 4],
  [2, 5],
  [3, 6],
];

// Three reference layouts, as offsets from the morph center.
const STACK: [number, number][] = [
  [0, -120],
  [-95, -25],
  [0, -25],
  [95, -25],
  [-95, 80],
  [0, 80],
  [95, 80],
];
const RING: [number, number][] = [
  [0, 0],
  [0, 62],
  [-54, -31],
  [54, -31],
  [0, 124],
  [-108, -62],
  [108, -62],
];
const SPLAY: [number, number][] = [
  [-130, 0],
  [-25, -85],
  [-25, 0],
  [-25, 85],
  [95, -85],
  [95, 0],
  [95, 85],
];

const TINTS = [
  [91, 141, 239], // stack — blue
  [155, 93, 229], // ring — purple
  [0, 184, 169], // splay — teal
];

export class MdTwisted extends Diagram {
  protected scene(s: Mount): void {
    const view = this.view(640, 430);
    const mx = 410;
    const my = 200;

    // Per-layout preset positions, as constant (writable) Vec cells.
    const presets = [STACK, RING, SPLAY].map(layout =>
      layout.map(([dx, dy]) => vec(mx + dx, my + dy)),
    );

    // The control triangle: three corners, one draggable point inside it.
    const corners = [vec(95, 360), vec(95, 250), vec(235, 360)];
    const cornerNames = ["stack", "ring", "splay"];
    const ctrl = vec(140, 320);

    // The draggable dot, clamped to the triangle on the way in: a write
    // projects onto the convex hull (the same `hullWeights` `between` uses),
    // so the control point can never leave its gamut.
    const cpts = corners.map(c => c.peek());
    const ctrlDot = Vec.lens(
      ctrl,
      v => v,
      (t: { x: number; y: number }) => {
        const w = hullWeights(t, cpts);
        let x = 0;
        let y = 0;
        for (let k = 0; k < w.length; k++) {
          x += w[k]! * cpts[k]!.x;
          y += w[k]! * cpts[k]!.y;
        }
        return { x, y };
      },
    );

    // Barycentric weights of the control point in the triangle (clamped).
    const weights = between(ctrl, corners);

    // Each node is the weighted blend of its three layout positions.
    const nodes: Writable<Vec>[] = [];
    for (let i = 0; i < 7; i++) {
      nodes.push(mix(weights, presets.map(p => p[i]!) as Writable<Vec>[]));
    }

    // Node colour blends the three tints by the same weights (mix is just
    // as happy on RGB as on position — shown here by hand to stay in CSS).
    const blendColor = (w: Read<number>[]): string => {
      let r = 0;
      let g = 0;
      let b = 0;
      for (let k = 0; k < 3; k++) {
        const wk = Math.max(0, w[k]!.value);
        r += wk * TINTS[k]![0]!;
        g += wk * TINTS[k]![1]!;
        b += wk * TINTS[k]![2]!;
      }
      return `rgb(${Math.round(r)}, ${Math.round(g)}, ${Math.round(b)})`;
    };
    const nodeFill = derive(() => blendColor(weights));

    // Tree edges + nodes.
    for (const [a, b] of EDGES) {
      s(line(nodes[a]!, nodes[b]!, { stroke: nodeFill, strokeWidth: 3, opacity: 0.55 }));
    }
    nodes.forEach((n, i) => {
      const c = s(
        circle(n, i === 0 ? 16 : 12, {
          fill: nodeFill,
          stroke: "var(--bg-color, #fff)",
          strokeWidth: 2,
        }),
      );
      // A node is a way to steer the *one* control point, not a free handle.
      // ctrl → nodeᵢ is affine (it sends each corner to a preset), so
      // barycentric coords carry across: read the node's weights against its
      // own presets and replay them on the corners to recover ctrl (clamped
      // by `between`). Drag a node → the whole tree follows the 2-DOF morph.
      const presetsI = presets.map(p => p[i]!.peek());
      const nodeHandle = Vec.lens(
        ctrl,
        () => n.value,
        (p: { x: number; y: number }) => {
          const w = hullWeights(p, presetsI);
          let x = 0;
          let y = 0;
          for (let k = 0; k < w.length; k++) {
            x += w[k]! * cpts[k]!.x;
            y += w[k]! * cpts[k]!.y;
          }
          return { x, y };
        },
      );
      c.el.style.cursor = "grab";
      drag(c, nodeHandle);
    });

    // The control triangle chrome.
    for (const [a, b] of [
      [0, 1],
      [1, 2],
      [2, 0],
    ] as [number, number][]) {
      s(line(corners[a]!, corners[b]!, { stroke: "#888", strokeWidth: 1, opacity: 0.5 }));
    }
    corners.forEach((c, i) => {
      const t = TINTS[i]!;
      s(circle(c, 5, { fill: `rgb(${t[0]}, ${t[1]}, ${t[2]})` }));
      s(
        label(c.down(i === 1 ? -16 : 18), cornerNames[i]!, { size: 11, fill: "var(--text-muted)" }),
      );
    });

    s(handle(ctrlDot, { r: 9 }));

    s(
      label(view.top.down(22), "drag the point — or any node — to morph between three layouts", {
        size: 14,
        bold: true,
      }),
      label(
        view.bottom.up(16),
        "between(point, corners) → weights · each node is mix(weights, [layoutᵢ]) · clamped to the hull",
        { size: 10, fill: "var(--text-muted)" },
      ),
    );
  }
}
