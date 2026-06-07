// Sugiyama-style graph layout on the propagator interval atoms. Pick a
// topology and a layout; nodes spring to their solved positions. Layer
// assignment is longest-path — `order(layer(u), layer(v), 1)` per edge —
// run to a fixpoint by the same solver as flex and sudoku. Crossing
// reduction and coordinate assignment are the usual barycenter + PAVA
// passes layered on top. Drag any node; it springs back to its slot.
//
// Cycles are first-class, shown two ways at once. (1) An edge running
// *against* the layer order is a back edge — the one the ranker reversed
// — drawn as a curved orange arc, so a feedback edge reads as a loop.
// (2) `scc()` (Tarjan) finds the strongly-connected components; each
// cyclic core (size > 1) is wrapped in a tidy violet region, so the
// cyclic *structure* reads as grouped loops, condensed to a DAG.
//
// Every layout is fitted into the frame via the graph group's transform
// (`screen = translate + scale · local`), which is itself sprung — so
// switching layout morphs smoothly and no topology overflows.

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
  pathD,
  rect,
  type Shape,
  spring,
  Vec,
  vec,
} from "@bireactive";
import {
  extent,
  type Graph,
  lanes,
  layered,
  type Placement,
  radial,
  rank,
  recurrent,
  scc,
  tree,
} from "@bireactive/propagators";

type Size = { w: number; h: number };

interface Topo {
  name: string;
  graph: Graph<string>;
}

const E = (s: string): Array<[string, string]> =>
  s
    .trim()
    .split(/\s+/)
    .map(p => p.split("->") as [string, string]);

const nodesOf = (edges: Array<[string, string]>): string[] => {
  const seen = new Set<string>();
  const order: string[] = [];
  for (const [u, v] of edges)
    for (const n of [u, v])
      if (!seen.has(n)) {
        seen.add(n);
        order.push(n);
      }
  return order;
};

const graph = (edges: Array<[string, string]>): Graph<string> => ({ nodes: nodesOf(edges), edges });

const TOPOS: Topo[] = [
  {
    name: "Pipeline",
    graph: graph(
      E(
        "clone->install install->lint install->test install->build lint->bundle test->bundle build->bundle bundle->deploy",
      ),
    ),
  },
  {
    name: "CI loop",
    // Mostly forward, with a retry and a rollback that close cycles.
    graph: graph(
      E("commit->build build->test test->stage stage->prod test->build prod->build prod->done"),
    ),
  },
  {
    name: "Tree",
    graph: graph(E("1->2 1->3 2->4 2->5 3->6 3->7 4->8 5->9 6->10 7->11")),
  },
  {
    name: "Git",
    graph: graph(E("c0->c1 c1->c2 c1->f1 f1->f2 c2->c3 f2->m c3->m m->c4 c4->rel")),
  },
  {
    name: "States",
    // A state machine — several cycles back to earlier states.
    graph: graph(
      E("idle->load load->ready ready->idle ready->save save->ready ready->err err->idle"),
    ),
  },
  {
    name: "Cycles",
    // A chain of three independent strongly-connected components.
    graph: graph(E("a->b b->c c->a c->d d->e e->f f->d f->g g->h h->g")),
  },
];

interface LayoutDef {
  name: string;
  run: (g: Graph<string>, sizeOf: (n: string) => Size) => Map<string, Placement>;
  /** Cyclic cores are placed as rings — draw their edges around the ring
   *  rather than as backward arrows. */
  ring?: boolean;
}

const LAYOUTS: LayoutDef[] = [
  {
    name: "Layered ↓",
    run: (g, s) => layered(g, { direction: "TB", sizeOf: s, layerGap: 78, nodeGap: 26 }),
  },
  {
    name: "Layered →",
    run: (g, s) => layered(g, { direction: "LR", sizeOf: s, layerGap: 120, nodeGap: 22 }),
  },
  {
    name: "Recurrent",
    run: (g, s) => recurrent(g, { direction: "TB", sizeOf: s, layerGap: 40, nodeGap: 34 }),
    ring: true,
  },
  {
    name: "Tree",
    run: (g, s) => tree(g, { direction: "TB", sizeOf: s, layerGap: 74, nodeGap: 26 }),
  },
  { name: "Radial", run: (g, s) => radial(g, { sizeOf: s, layerGap: 84 }) },
  { name: "Lanes", run: (g, s) => lanes(g, { sizeOf: s, rowGap: 52, laneGap: 60 }) },
];

const W = 680;
const H = 540;
const TOP = 92;
const PADX = 26;
const BOTTOM = 34;

const ACCENT = "#5b8def";
const BACK = "#e0883a";
const SCC_COLOR = "#8b5cf6";
const BORDER = "var(--border-color, #b9c0cc)";
const MUTED = "var(--text-secondary, #8a8a8a)";

const sizeOf = (n: string): Size => ({ w: Math.max(46, n.length * 7.2 + 22), h: 30 });

interface NodeView {
  pos: ReturnType<typeof vec>;
  target: ReturnType<typeof vec>;
  dragging: ReturnType<typeof cell<boolean>>;
}

export class MdSugiyama extends Diagram {
  #teardown: Array<() => void> = [];
  #persist: Array<() => void> = [];
  #nodes = new Map<string, NodeView>();
  #graph: Graph<string> = TOPOS[0]!.graph;
  #gfx!: Shape;
  // Edges live in their own sub-group so the policy (straight / back-arc /
  // ring-arc) can be rebuilt per layout while nodes persist and spring.
  #edges!: Shape;
  #rects = new Map<string, Shape>();
  #layer = new Map<string, number>();
  #compOf = new Map<string, number>();
  #bigSCC = new Set<number>();
  #centroid = new Map<number, Vec>();
  // Sprung fit transform — set the *targets*; the group eases there so a
  // layout change morphs rather than snaps.
  #fitScale = vec(1, 1);
  #fitTranslate = vec(0, 0);
  #fitted = false;

  disconnectedCallback(): void {
    for (const d of [...this.#teardown, ...this.#persist]) d();
    this.#teardown = [];
    this.#persist = [];
    super.disconnectedCallback();
  }

  protected scene(s: Mount): void {
    const view = this.view(W, H);
    const topo = cell(0);
    const layout = cell(0);
    this.#gfx = s(group());
    // The fit transform eases to its target (persists across rebuilds).
    this.#persist.push(
      this.anim.start(
        spring(this.#gfx.scale, this.#fitScale, { omega: 8, zeta: 0.9, precision: 0 }),
      ),
      this.anim.start(
        spring(this.#gfx.translate, this.#fitTranslate, { omega: 8, zeta: 0.9, precision: 0 }),
      ),
    );

    // Imperative rebuild/apply on toggle — shapes must NOT be created inside
    // a reactive effect (a layout-only change would re-run it and dispose the
    // node shapes' attribute bindings). The toggle highlight stays reactive.
    this.#toggle(
      s,
      14,
      16,
      "graph",
      TOPOS.map(t => t.name),
      topo,
      i => {
        this.#rebuild(TOPOS[i]!);
        this.#applyLayout(LAYOUTS[layout.peek()]!);
      },
    );
    this.#toggle(
      s,
      14,
      50,
      "layout",
      LAYOUTS.map(l => l.name),
      layout,
      i => {
        this.#applyLayout(LAYOUTS[i]!);
      },
    );

    this.#rebuild(TOPOS[0]!);
    this.#applyLayout(LAYOUTS[0]!);

    s(
      label(
        view.bottom.up(16),
        "longest-path rank via order() atoms · violet = strongly-connected components · Recurrent draws each cycle as a ring · drag a node",
        { size: 10, fill: MUTED },
      ),
    );
  }

  #rebuild(topo: Topo): void {
    for (const d of this.#teardown) d();
    this.#teardown = [];
    this.#gfx.clear();
    this.#nodes.clear();
    this.#graph = topo.graph;

    // Seed nodes near a local origin; the fit transform maps to screen.
    topo.graph.nodes.forEach((n, i) => {
      const a = (i / topo.graph.nodes.length) * Math.PI * 2;
      const pos = vec(150 + Math.cos(a) * 22, 110 + Math.sin(a) * 22);
      this.#nodes.set(n, { pos, target: vec(150, 110), dragging: cell(false) });
    });

    this.#layer = rank(topo.graph);
    this.#rects = new Map<string, Shape>();
    for (const n of topo.graph.nodes) {
      const { pos } = this.#nodes.get(n)!;
      const { w, h } = sizeOf(n);
      this.#rects.set(
        n,
        rect(pos, w, h, { fill: ACCENT, opacity: 0.16, stroke: ACCENT, corner: 7 }),
      );
    }

    // Strongly-connected components. Record membership + a reactive
    // centroid per cyclic core (for ring-edge bowing), and draw each core
    // as a tidy violet region — the backdrop, under everything.
    this.#compOf = new Map();
    this.#bigSCC = new Set();
    this.#centroid = new Map();
    scc(topo.graph).forEach((comp, i) => {
      for (const n of comp) this.#compOf.set(n, i);
      if (comp.length < 2) return;
      this.#bigSCC.add(i);
      this.#centroid.set(
        i,
        Vec.derive(() => {
          let x = 0;
          let y = 0;
          for (const n of comp) {
            const p = this.#nodes.get(n)!.pos.value;
            x += p.x;
            y += p.y;
          }
          return { x: x / comp.length, y: y / comp.length };
        }),
      );
      this.#gfx.add(
        rect(this.#sccHull(comp), {
          fill: SCC_COLOR,
          opacity: 0.08,
          stroke: SCC_COLOR,
          corner: 12,
          dashed: true,
        }),
      );
    });

    // Edge sub-group sits above the hulls, below the nodes; populated per
    // layout by #buildEdges.
    this.#edges = group();
    this.#gfx.add(this.#edges);

    for (const n of topo.graph.nodes) {
      const { pos, target, dragging } = this.#nodes.get(n)!;
      const r = this.#rects.get(n)!;
      this.#gfx.add(r, label(pos, n, { size: 11.5, bold: true }));
      this.#teardown.push(this.#dragNode(r, pos, dragging));
      this.#teardown.push(
        this.anim.start(
          spring(pos, target, {
            omega: 9,
            zeta: 0.85,
            precision: 0,
            rate: () => (dragging.value ? 0 : 1),
          }),
        ),
      );
    }
  }

  #applyLayout(def: LayoutDef): void {
    const place = def.run(this.#graph, sizeOf);
    const ext = extent(place);
    // Fit the layout into the frame via the group transform; node-local
    // targets stay in natural coordinates so springs and drag are simple.
    // The transform target eases, so layout switches morph smoothly.
    const availW = W - 2 * PADX;
    const availH = H - TOP - BOTTOM;
    const scale = Math.min(1.1, availW / Math.max(1, ext.w), availH / Math.max(1, ext.h));
    this.#fitScale.value = { x: scale, y: scale };
    this.#fitTranslate.value = {
      x: PADX + (availW - ext.w * scale) / 2,
      y: TOP + (availH - ext.h * scale) / 2,
    };
    // First fit jumps into place (nothing to morph from yet); a fresh
    // topology also jumps the frame, while the new nodes spring in.
    if (!this.#fitted) {
      this.#gfx.scale.value = this.#fitScale.peek();
      this.#gfx.translate.value = this.#fitTranslate.peek();
      this.#fitted = true;
    }
    for (const [n, p] of place) {
      const nv = this.#nodes.get(n);
      if (nv) nv.target.value = { x: p.x + p.w / 2, y: p.y + p.h / 2 };
    }
    this.#buildEdges(def.ring ?? false);
  }

  /** (Re)draw edges for the active layout. Non-ring layouts use the
   *  rank rule: forward arrow if the edge descends a layer, else a curved
   *  back-arc. Ring layouts route intra-component edges around the SCC's
   *  centre, so a cycle reads as a loop with no backward arrow. */
  #buildEdges(ring: boolean): void {
    this.#edges.clear();
    for (const [u, v] of this.#graph.edges) {
      const ru = this.#rects.get(u)!;
      const rv = this.#rects.get(v)!;
      const comp = this.#compOf.get(u)!;
      const intraCore = ring && comp === this.#compOf.get(v) && this.#bigSCC.has(comp);
      if (intraCore) {
        this.#edges.add(ringArc(ru, rv, this.#centroid.get(comp)!, 24));
      } else if (ring) {
        this.#edges.add(arrow(ru, rv, { thin: true, opacity: 0.5 }));
      } else if (this.#layer.get(v)! > this.#layer.get(u)!) {
        this.#edges.add(arrow(ru, rv, { thin: true, opacity: 0.5 }));
      } else {
        const span = Math.abs(this.#layer.get(u)! - this.#layer.get(v)!);
        this.#edges.add(backArc(ru, rv, 30 + span * 10));
      }
    }
  }

  /** Reactive box hugging a strongly-connected component's members. */
  #sccHull(members: string[]): Box {
    return Box.derive(() => {
      let xmin = Number.POSITIVE_INFINITY;
      let ymin = Number.POSITIVE_INFINITY;
      let xmax = Number.NEGATIVE_INFINITY;
      let ymax = Number.NEGATIVE_INFINITY;
      for (const n of members) {
        const p = this.#nodes.get(n)!.pos.value;
        const { w, h } = sizeOf(n);
        xmin = Math.min(xmin, p.x - w / 2);
        ymin = Math.min(ymin, p.y - h / 2);
        xmax = Math.max(xmax, p.x + w / 2);
        ymax = Math.max(ymax, p.y + h / 2);
      }
      const PAD = 16;
      return { x: xmin - PAD, y: ymin - PAD, w: xmax - xmin + 2 * PAD, h: ymax - ymin + 2 * PAD };
    });
  }

  /** Drag a node by writing its position in the graph group's local frame
   *  (so the active fit transform is accounted for). */
  #dragNode(r: Shape, pos: NodeView["pos"], dragging: NodeView["dragging"]): () => void {
    let gx = 0;
    let gy = 0;
    let pid = -1;
    r.el.style.cursor = "grab";
    const offs = [
      r.on("pointerdown", e => {
        const pe = e as PointerEvent;
        pid = pe.pointerId;
        r.el.setPointerCapture(pid);
        const l = this.#gfx.toLocal(pe);
        const v = pos.value;
        gx = l.x - v.x;
        gy = l.y - v.y;
        dragging.value = true;
      }),
      r.on("pointermove", e => {
        if (pid === -1) return;
        const l = this.#gfx.toLocal(e as PointerEvent);
        pos.value = { x: l.x - gx, y: l.y - gy };
      }),
    ];
    const stop = (): void => {
      if (pid !== -1) {
        try {
          r.el.releasePointerCapture(pid);
        } catch {
          /* ok */
        }
        pid = -1;
      }
      dragging.value = false;
    };
    offs.push(r.on("pointerup", stop), r.on("pointercancel", stop));
    return () => offs.forEach(d => d());
  }

  #toggle(
    s: Mount,
    x: number,
    y: number,
    caption: string,
    names: string[],
    sel: ReturnType<typeof cell<number>>,
    onPick: (i: number) => void,
  ): void {
    s(label(vec(x, y + 11), caption, { size: 10, fill: MUTED, align: Anchor.Left }));
    let cur = x + 48;
    names.forEach((name, i) => {
      const w = Math.max(40, name.length * 6.8 + 16);
      const bx = cur;
      const on = derive(() => sel.value === i);
      const r = rect(bx, y, w, 22, {
        corner: 6,
        fill: derive(() => (on.value ? ACCENT : "transparent")),
        stroke: BORDER,
        thin: true,
      });
      const tx = label(vec(bx + w / 2, y + 11), name, {
        size: 10.5,
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

/** Curved arrow for a back edge: a quadratic arc bulging `bulge` px to
 *  one side of the u→v line, meeting each node at its boundary. */
function backArc(ru: Shape, rv: Shape, bulge: number): Shape {
  const uc = ru.center;
  const vc = rv.center;
  const mid = uc.lerp(vc, 0.5);
  const ctrl = mid.add(vc.sub(uc).perp().normalize().scale(bulge));
  const start = ru.boundary(ctrl);
  const end = rv.boundary(ctrl);
  const d = derive(() => {
    const s = start.value;
    const c = ctrl.value;
    const e = end.value;
    return `M ${s.x} ${s.y} Q ${c.x} ${c.y} ${e.x} ${e.y}`;
  });
  const p = pathD(d, { stroke: BACK, thin: true });
  p.attr("marker-end", "url(#bireactive-arrow)");
  return p;
}

/** Edge of a cyclic component, bowed `bow` px *away* from the ring centre
 *  so it traces the perimeter — a cycle reads as a loop. When the edge's
 *  midpoint coincides with the centre (a 2-cycle), it bows perpendicular,
 *  the two directions falling to opposite sides (a lens). */
function ringArc(ru: Shape, rv: Shape, center: Vec, bow: number): Shape {
  const ctrl = Vec.derive(() => {
    const a = ru.center.value;
    const b = rv.center.value;
    const c = center.value;
    const mx = (a.x + b.x) / 2;
    const my = (a.y + b.y) / 2;
    let ox = mx - c.x;
    let oy = my - c.y;
    const ol = Math.hypot(ox, oy);
    if (ol < 1) {
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const dl = Math.hypot(dx, dy) || 1;
      ox = -dy / dl;
      oy = dx / dl;
    } else {
      ox /= ol;
      oy /= ol;
    }
    return { x: mx + ox * bow, y: my + oy * bow };
  });
  const start = ru.boundary(ctrl);
  const end = rv.boundary(ctrl);
  const d = derive(() => {
    const s = start.value;
    const c = ctrl.value;
    const e = end.value;
    return `M ${s.x} ${s.y} Q ${c.x} ${c.y} ${e.x} ${e.y}`;
  });
  const p = pathD(d, { stroke: BACK, thin: true });
  p.attr("marker-end", "url(#bireactive-arrow)");
  return p;
}
