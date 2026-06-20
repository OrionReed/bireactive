// Twisted Trees — Dragology's `between`, the continuous sibling of `closest`.
// The model is the 2-DOF morph state: barycentric weights over three reference
// layouts. `d.between(pointer, corners, mix)` reads the pointer's position in
// the corners' convex hull as those weights, and every node renders as the
// weighted blend of its three preset positions. Drag the control point — or any
// node — and the same `between` steers the one morph: a node's three presets are
// just its own set of corners, so grabbing it moves the shared weights too.

import {
  cell,
  circle,
  Diagram,
  d,
  derive,
  dragModel,
  hullWeights,
  label,
  line,
  type Mount,
  raise,
  Vec,
  vec,
} from "@bireactive";

type V = { x: number; y: number };

const EDGES: [number, number][] = [
  [0, 1],
  [0, 2],
  [0, 3],
  [1, 4],
  [2, 5],
  [3, 6],
];
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
  [91, 141, 239],
  [155, 93, 229],
  [0, 184, 169],
];

export class MdTwisted extends Diagram {
  protected scene(s: Mount): void {
    const view = this.view(640, 430);
    const mx = 410;
    const my = 200;

    // Three reference layouts (node positions), and the control triangle whose
    // corners are the basis of the morph.
    const layouts: V[][] = [STACK, RING, SPLAY].map(L =>
      L.map(([dx, dy]) => ({ x: mx + dx, y: my + dy })),
    );
    const cpts: V[] = [
      { x: 95, y: 360 },
      { x: 95, y: 250 },
      { x: 235, y: 360 },
    ];
    const cornerNames = ["stack", "ring", "splay"];
    const basis = [
      [1, 0, 0],
      [0, 1, 0],
      [0, 0, 1],
    ];

    // mix over the basis = the weights themselves; this is what `between`
    // blends, so the model `M` IS the barycentric weight vector.
    const mixW = (ms: readonly number[][], ws: readonly number[]): number[] => {
      const out = [0, 0, 0];
      ms.forEach((m, i) => {
        for (let k = 0; k < 3; k++) out[k] += ws[i]! * m[k]!;
      });
      return out;
    };

    const w0 = hullWeights({ x: 140, y: 320 }, cpts);
    const weights = cell<number[]>([...w0]);

    // Anchors are the dragged thing's three corners: the triangle for the
    // control point, a node's three preset positions for that node.
    const dm = dragModel<number[], "ctrl" | number>(weights, (id, pointer) => {
      const anchors: V[] = id === "ctrl" ? cpts : layouts.map(L => L[id]!);
      const corners = anchors.map((a, i) => d.fixed(pointer, basis[i]!, () => a));
      return d.between(pointer, corners, mixW);
    });

    const blend = (ws: readonly number[], pts: readonly V[]): V => {
      let x = 0;
      let y = 0;
      ws.forEach((wi, i) => {
        x += wi * pts[i]!.x;
        y += wi * pts[i]!.y;
      });
      return { x, y };
    };
    const nodeFill = derive(() => {
      const ws = dm.preview.value;
      let r = 0;
      let g = 0;
      let b = 0;
      ws.forEach((wi, i) => {
        const t = TINTS[i]!;
        r += Math.max(0, wi) * t[0]!;
        g += Math.max(0, wi) * t[1]!;
        b += Math.max(0, wi) * t[2]!;
      });
      return `rgb(${Math.round(r)}, ${Math.round(g)}, ${Math.round(b)})`;
    });

    // Each node IS the weighted blend of its presets — a pure function of the
    // morph weights, so no spring: it tracks the pointer exactly. (The dragged
    // node's blend equals the clamped pointer, so it needs no special case.)
    const pos = Array.from({ length: 7 }, (_, k) =>
      Vec.derive(() =>
        blend(
          dm.preview.value,
          layouts.map(L => L[k]!),
        ),
      ),
    );
    for (const [a, b] of EDGES) {
      s(line(pos[a]!, pos[b]!, { stroke: nodeFill, strokeWidth: 3, opacity: 0.55 }));
    }
    pos.forEach((p, k) => {
      const c = s(
        circle(p, k === 0 ? 16 : 12, {
          fill: nodeFill,
          stroke: "var(--bg-color, #fff)",
          strokeWidth: 2,
        }),
      );
      c.el.style.cursor = "grab";
      dm.grip(
        c,
        k,
        () => p.peek(),
        () => raise(c),
      );
    });

    // Control triangle chrome.
    for (const [a, b] of [
      [0, 1],
      [1, 2],
      [2, 0],
    ] as [number, number][]) {
      s(
        line(vec(cpts[a]!.x, cpts[a]!.y), vec(cpts[b]!.x, cpts[b]!.y), {
          stroke: "#888",
          strokeWidth: 1,
          opacity: 0.5,
        }),
      );
    }
    cpts.forEach((c, i) => {
      const t = TINTS[i]!;
      s(circle(vec(c.x, c.y), 5, { fill: `rgb(${t[0]}, ${t[1]}, ${t[2]})` }));
      s(
        label(vec(c.x, c.y + (i === 1 ? -16 : 18)), cornerNames[i]!, {
          size: 11,
          fill: "var(--text-muted)",
        }),
      );
    });

    // The control point: the same weights, mapped back into the triangle.
    const ctrlPos = Vec.derive(() => blend(dm.preview.value, cpts));
    const ctrl = s(
      circle(ctrlPos, 9, {
        fill: "var(--bireactive-handle, #2563eb)",
        stroke: "var(--bg-color, #fff)",
        strokeWidth: 2,
      }),
    );
    ctrl.el.style.cursor = "grab";
    dm.grip(
      ctrl,
      "ctrl",
      () => ctrlPos.peek(),
      () => raise(ctrl),
    );

    s(
      label(view.top.down(22), "drag the point — or any node — to morph between three layouts", {
        size: 14,
        bold: true,
      }),
      label(
        view.bottom.up(16),
        "d.between(pointer, corners, mix) → weights · every node is the weighted blend · clamped to the hull",
        { size: 10, fill: "var(--text-muted)" },
      ),
    );
  }
}
