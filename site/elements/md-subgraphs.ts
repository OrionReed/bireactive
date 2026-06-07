// Nested (compound) graph layout — the layout primitive applied to
// itself. Each cluster is a small graph laid out by `layered`; the
// clusters are then laid out *as a graph in turn*, sized to the extent
// of their own contents. Inter-cluster edges (grey) thread between
// nodes across boxes; intra-cluster edges (tinted) stay inside. The
// whole figure is fitted into the frame via the group transform, so it
// never overflows whichever direction you pick.

import {
  Anchor,
  arrow,
  Box,
  cell,
  Diagram,
  derive,
  group,
  label,
  type Mount,
  rect,
  type Shape,
  spring,
  vec,
} from "@bireactive";
import { extent, type Graph, layered, type Placement } from "@bireactive/propagators";

interface Cluster {
  name: string;
  color: string;
  nodes: string[];
  edges: Array<[string, string]>;
}

const CLUSTERS: Cluster[] = [
  {
    name: "Web",
    color: "#5b8def",
    nodes: ["home", "catalog", "cart", "product"],
    edges: [
      ["home", "catalog"],
      ["home", "cart"],
      ["catalog", "product"],
    ],
  },
  {
    name: "API",
    color: "#33a06f",
    nodes: ["gateway", "auth", "orders", "pay"],
    edges: [
      ["gateway", "auth"],
      ["gateway", "orders"],
      ["orders", "pay"],
    ],
  },
  {
    name: "Data",
    color: "#c2683a",
    nodes: ["primary", "replica", "cache", "search"],
    edges: [
      ["primary", "replica"],
      ["primary", "cache"],
    ],
  },
];

const INTER: Array<[string, string]> = [
  ["catalog", "gateway"],
  ["cart", "gateway"],
  ["product", "gateway"],
  ["product", "search"],
  ["auth", "primary"],
  ["orders", "primary"],
  ["pay", "cache"],
];

const NODE: Size = { w: 56, h: 26 };
const PAD = 14;
const HEADER = 22;

const W = 700;
const H = 560;
const TOP = 56;
const PADX = 24;
const BOTTOM = 30;
const INTER_COLOR = "#9aa3b0";

type Size = { w: number; h: number };

interface NodeView {
  pos: ReturnType<typeof vec>;
  target: ReturnType<typeof vec>;
}

const clusterOf = new Map<string, Cluster>();
for (const c of CLUSTERS) for (const n of c.nodes) clusterOf.set(n, c);

const nodeSize = (): Size => NODE;

interface LayoutDef {
  name: string;
  dir: "TB" | "LR";
}
const LAYOUTS: LayoutDef[] = [
  { name: "Layered ↓", dir: "TB" },
  { name: "Layered →", dir: "LR" },
];

export class MdSubgraphs extends Diagram {
  #disposers: Array<() => void> = [];
  #nodes = new Map<string, NodeView>();
  #gfx!: Shape;
  #fitScale = vec(1, 1);
  #fitTranslate = vec(0, 0);
  #fitted = false;

  disconnectedCallback(): void {
    for (const d of this.#disposers) d();
    this.#disposers = [];
    super.disconnectedCallback();
  }

  protected scene(s: Mount): void {
    this.view(W, H);
    const layout = cell(0);
    this.#gfx = s(group());
    // Sprung fit transform — set the target; the group eases there, so the
    // direction toggle morphs rather than snaps.
    this.#disposers.push(
      this.anim.start(
        spring(this.#gfx.scale, this.#fitScale, { omega: 8, zeta: 0.9, precision: 0 }),
      ),
      this.anim.start(
        spring(this.#gfx.translate, this.#fitTranslate, { omega: 8, zeta: 0.9, precision: 0 }),
      ),
    );

    // Inner layout per cluster (computed once — clusters keep their shape).
    const inner = new Map<string, Map<string, Placement>>();
    const clusterSize = new Map<string, Size>();
    for (const c of CLUSTERS) {
      const p = layered(
        { nodes: c.nodes, edges: c.edges },
        {
          direction: "TB",
          sizeOf: nodeSize,
          layerGap: 44,
          nodeGap: 16,
        },
      );
      inner.set(c.name, p);
      const e = extent(p);
      clusterSize.set(c.name, { w: e.w + 2 * PAD, h: e.h + 2 * PAD + HEADER });
    }

    // Node state.
    for (const c of CLUSTERS)
      for (const n of c.nodes)
        this.#nodes.set(n, { pos: vec(W / 2, H / 2), target: vec(W / 2, H / 2) });

    // ---- edges ---------------------------------------------------------
    // Cluster boxes hug their members reactively (so they breathe as the
    // springs settle), drawn first as the translucent backdrop.
    for (const c of CLUSTERS) {
      const cBox = this.#clusterBox(c);
      this.#gfx.add(
        rect(cBox, { fill: c.color, opacity: 0.08, stroke: c.color, corner: 10 }),
        label(cBox.top.down(HEADER / 2), c.name, { size: 11, bold: true, fill: c.color }),
      );
    }
    // Inter-cluster edges (grey), then intra-cluster edges (tinted).
    const rectOf = (n: string): Shape => rect(this.#nodeBox(n), { fill: "none", stroke: "none" });
    for (const [u, v] of INTER)
      this.#gfx.add(arrow(rectOf(u), rectOf(v), { thin: true, opacity: 0.7, stroke: INTER_COLOR }));
    for (const c of CLUSTERS)
      for (const [u, v] of c.edges)
        this.#gfx.add(arrow(rectOf(u), rectOf(v), { thin: true, opacity: 0.55, stroke: c.color }));

    // ---- nodes ---------------------------------------------------------
    for (const c of CLUSTERS)
      for (const n of c.nodes) {
        this.#gfx.add(
          rect(this.#nodeBox(n), { fill: c.color, opacity: 0.22, stroke: c.color, corner: 5 }),
          label(this.#nodes.get(n)!.pos, n, { size: 9.5, bold: true }),
        );
      }

    // ---- relayout on toggle -------------------------------------------
    const apply = (dir: "TB" | "LR"): void => this.#apply(dir, inner, clusterSize);
    this.#toggle(
      s,
      14,
      14,
      LAYOUTS.map(l => l.name),
      layout,
      i => apply(LAYOUTS[i]!.dir),
    );
    apply(LAYOUTS[0]!.dir);

    for (const { pos, target } of this.#nodes.values())
      this.#disposers.push(
        this.anim.start(spring(pos, target, { omega: 9, zeta: 0.85, precision: 0 })),
      );

    s(
      label(
        vec(W / 2, H - 13),
        "layered() laid out per cluster, then the clusters laid out as a graph in turn — the same solve, nested",
        { size: 10, fill: "var(--text-secondary, #8a8a8a)", align: Anchor.Center },
      ),
    );
  }

  /** Compose the two layers: meta-layout the clusters, then place each
   *  node at its cluster offset + inner placement. */
  #apply(
    dir: "TB" | "LR",
    inner: Map<string, Map<string, Placement>>,
    clusterSize: Map<string, Size>,
  ): void {
    const metaEdges = new Set<string>();
    const edges: Array<[string, string]> = [];
    for (const [u, v] of INTER) {
      const cu = clusterOf.get(u)!.name;
      const cv = clusterOf.get(v)!.name;
      const key = `${cu}->${cv}`;
      if (cu !== cv && !metaEdges.has(key)) {
        metaEdges.add(key);
        edges.push([cu, cv]);
      }
    }
    const meta: Graph<string> = { nodes: CLUSTERS.map(c => c.name), edges };
    // `layered` spaces layers a fixed `layerGap` apart, so the gap must
    // clear the largest cluster along the layer axis (else boxes overlap).
    let maxAlong = 0;
    for (const sz of clusterSize.values())
      maxAlong = Math.max(maxAlong, dir === "TB" ? sz.h : sz.w);
    const metaPlace = layered(meta, {
      direction: dir,
      sizeOf: n => clusterSize.get(n)!,
      layerGap: maxAlong + 56,
      nodeGap: 40,
    });

    for (const c of CLUSTERS) {
      const cp = metaPlace.get(c.name)!;
      const ip = inner.get(c.name)!;
      for (const n of c.nodes) {
        const p = ip.get(n)!;
        const t = this.#nodes.get(n)!.target;
        t.value = { x: cp.x + PAD + p.x + p.w / 2, y: cp.y + HEADER + PAD + p.y + p.h / 2 };
      }
    }

    // Fit the whole compound figure into the frame; the transform target
    // eases, so toggling direction morphs smoothly.
    const ext = extent(metaPlace);
    const availW = W - 2 * PADX;
    const availH = H - TOP - BOTTOM;
    const scale = Math.min(1.1, availW / Math.max(1, ext.w), availH / Math.max(1, ext.h));
    this.#fitScale.value = { x: scale, y: scale };
    this.#fitTranslate.value = {
      x: PADX + (availW - ext.w * scale) / 2,
      y: TOP + (availH - ext.h * scale) / 2,
    };
    if (!this.#fitted) {
      this.#gfx.scale.value = this.#fitScale.peek();
      this.#gfx.translate.value = this.#fitTranslate.peek();
      this.#fitted = true;
    }
  }

  /** A node's box, derived from its (springing) centre and fixed size. */
  #nodeBox(n: string): Box {
    const pos = this.#nodes.get(n)!.pos;
    return Box.derive(() => ({
      x: pos.value.x - NODE.w / 2,
      y: pos.value.y - NODE.h / 2,
      w: NODE.w,
      h: NODE.h,
    }));
  }

  /** A cluster's box, hugging its member nodes plus padding and a header. */
  #clusterBox(c: Cluster): Box {
    return Box.derive(() => {
      let xmin = Number.POSITIVE_INFINITY;
      let ymin = Number.POSITIVE_INFINITY;
      let xmax = Number.NEGATIVE_INFINITY;
      let ymax = Number.NEGATIVE_INFINITY;
      for (const n of c.nodes) {
        const p = this.#nodes.get(n)!.pos.value;
        xmin = Math.min(xmin, p.x - NODE.w / 2);
        ymin = Math.min(ymin, p.y - NODE.h / 2);
        xmax = Math.max(xmax, p.x + NODE.w / 2);
        ymax = Math.max(ymax, p.y + NODE.h / 2);
      }
      return {
        x: xmin - PAD,
        y: ymin - PAD - HEADER,
        w: xmax - xmin + 2 * PAD,
        h: ymax - ymin + 2 * PAD + HEADER,
      };
    });
  }

  #toggle(
    s: Mount,
    x: number,
    y: number,
    names: string[],
    sel: ReturnType<typeof cell<number>>,
    onPick: (i: number) => void,
  ): void {
    let cur = x;
    names.forEach((name, i) => {
      const w = Math.max(48, name.length * 7 + 18);
      const bx = cur;
      const on = derive(() => sel.value === i);
      const r = rect(bx, y, w, 24, {
        corner: 6,
        fill: derive(() => (on.value ? "#5b8def" : "transparent")),
        stroke: "var(--border-color, #b9c0cc)",
        thin: true,
      });
      const tx = label(vec(bx + w / 2, y + 12), name, {
        size: 11,
        align: Anchor.Center,
        fill: derive(() => (on.value ? "#ffffff" : "var(--text-color, #222)")),
      });
      r.el.style.cursor = "pointer";
      tx.el.style.cursor = "pointer";
      const pick = (): void => {
        sel.value = i;
        onPick(i);
      };
      r.on("click", pick);
      tx.on("click", pick);
      s(r, tx);
      cur += w + 6;
    });
  }
}
