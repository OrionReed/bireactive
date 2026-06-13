import {
  type Animator,
  arrow,
  type Cell,
  cell,
  circle,
  derive,
  drive,
  group,
  type Num,
  num,
  Shape,
  type Vec,
  vec,
  type Writable,
} from "@bireactive";

const INK = "var(--text-color)";
const HOLLOW = "var(--bg-color, #ffffff)";
const FORWARD = "#e8623a"; // ember — the forward recompute
const BACKWARD = "#4c8dff"; // blue — the backward resolve
const RADIUS = 6.5;

/** Propagation direction: backward (write → sources) or forward (recompute). */
export type Dir = "fwd" | "bwd";

/** A node in the terse builder: callable to wire forward edges, returns
 *  itself so calls chain. */
export interface Node {
  (...targets: Node[]): Node;
  readonly id: number;
}

/** The builder's node source: iterate/destructure for fresh nodes, or
 *  `take(k)` a batch. The iterator is infinite — destructuring pulls only
 *  as many as you name. */
export interface NodeGen extends Iterable<Node> {
  take(k: number): Node[];
}

interface NodeView {
  id: number;
  pos: Writable<Vec>;
  activeF: Writable<Cell<boolean>>;
  activeB: Writable<Cell<boolean>>;
  glowF: Writable<Num>;
  glowB: Writable<Num>;
  shape: Shape;
  incoming: number[];
  outgoing: number[];
}

interface EdgeView {
  u: number;
  v: number;
  glowF: Writable<Num>;
  glowB: Writable<Num>;
}

export interface GraphOpts {
  /** Node centre in the diagram's frame, by id. */
  positions: (id: number) => { x: number; y: number };
  /** Base node radius (px). Default 6.5. */
  radius?: number;
  /** Forward (recompute) accent. Default ember. */
  forward?: string;
  /** Backward (resolve) accent. Default blue. */
  backward?: string;
  /** Drag to rearrange. Default true. */
  draggable?: boolean;
  /** Click a node (a press with no drag). */
  onPick?: (id: number) => void;
}

/** Run the terse builder, collecting node count + forward edges. */
function collect(build: (n: NodeGen) => void): { count: number; edges: Array<[number, number]> } {
  const edges: Array<[number, number]> = [];
  let count = 0;
  const make = (): Node => {
    const id = count++;
    const node = ((...targets: Node[]): Node => {
      for (const t of targets) edges.push([id, t.id]);
      return node;
    }) as Node;
    Object.defineProperty(node, "id", { value: id });
    return node;
  };
  const gen: NodeGen = {
    take: k => Array.from({ length: k }, make),
    [Symbol.iterator]: () => ({ next: () => ({ value: make(), done: false }) }),
  };
  build(gen);
  return { count, edges };
}

function rgba(hex: string, a: number): string {
  const r = Number.parseInt(hex.slice(1, 3), 16);
  const g = Number.parseInt(hex.slice(3, 5), 16);
  const b = Number.parseInt(hex.slice(5, 7), 16);
  return `rgba(${r}, ${g}, ${b}, ${a})`;
}

/** Compact directed-graph shape. Mount it like any shape; drive the
 *  animation via `fire(id, dir)` / `pulseEdge(u, v, dir)` / `clear()`, with
 *  `decay()` started on an animator to ease glows back down. */
export class GraphShape extends Shape {
  readonly nodes: NodeView[] = [];
  readonly edges: EdgeView[] = [];
  #edgeIndex = new Map<string, EdgeView>();

  constructor(build: (n: NodeGen) => void, opts: GraphOpts) {
    super();
    const { count, edges } = collect(build);
    const fwd = opts.forward ?? FORWARD;
    const bwd = opts.backward ?? BACKWARD;
    const r = opts.radius ?? RADIUS;

    for (let id = 0; id < count; id++) {
      const p = opts.positions(id);
      const pos = vec(p.x, p.y);
      const activeF = cell(false);
      const activeB = cell(false);
      const glowF = num(0);
      const glowB = num(0);
      const radius = derive(() => r * (1 + 0.85 * Math.max(glowF.value, glowB.value)));
      const fill = derive(() => {
        if (activeF.value) return rgba(fwd, 0.92);
        if (activeB.value) return rgba(bwd, 0.92);
        const gf = glowF.value;
        const gb = glowB.value;
        const g = Math.max(gf, gb);
        return g > 0.01 ? rgba(gf >= gb ? fwd : bwd, g) : HOLLOW;
      });
      const stroke = derive(() => {
        if (activeF.value || glowF.value > 0.01) return fwd;
        if (activeB.value || glowB.value > 0.01) return bwd;
        return INK;
      });
      const shape = circle(pos, radius, { fill, stroke, thin: true });
      this.nodes.push({
        id,
        pos,
        activeF,
        activeB,
        glowF,
        glowB,
        shape,
        incoming: [],
        outgoing: [],
      });
    }

    // Edges sit under the nodes; arrowheads stay ink (monochrome) and point
    // forward only — the backward pass simply recolours the same line. The
    // stroke glows in whichever direction's colour last crossed it.
    const edgeLayer = group();
    this.add(edgeLayer);
    for (const [u, v] of edges) {
      const key = `${u}->${v}`;
      if (this.#edgeIndex.has(key) || u === v) continue;
      const eu = this.nodes[u];
      const ev = this.nodes[v];
      if (!eu || !ev) continue;
      eu.outgoing.push(v);
      ev.incoming.push(u);
      const glowF = num(0);
      const glowB = num(0);
      const opacity = derive(() => 0.22 + 0.64 * Math.max(glowF.value, glowB.value));
      const stroke = derive(() => {
        const gf = glowF.value;
        const gb = glowB.value;
        if (Math.max(gf, gb) < 0.01) return INK;
        return gf >= gb ? fwd : bwd;
      });
      edgeLayer.add(arrow(eu.shape, ev.shape, { thin: true, opacity, stroke, gap: 1 }));
      const view: EdgeView = { u, v, glowF, glowB };
      this.edges.push(view);
      this.#edgeIndex.set(key, view);
    }

    const nodeLayer = group();
    this.add(nodeLayer);
    for (const nv of this.nodes) {
      nodeLayer.add(nv.shape);
      this.#interact(nv, opts);
    }
  }

  /** A node activates in `dir`: light it and kick that direction's glow. */
  fire(id: number, dir: Dir): void {
    const n = this.nodes[id];
    if (!n) return;
    if (dir === "fwd") {
      n.activeF.value = true;
      n.glowF.value = 1;
    } else {
      n.activeB.value = true;
      n.glowB.value = 1;
    }
  }

  /** Flash an edge in `dir` — a change just crossed `u→v` that way. */
  pulseEdge(u: number, v: number, dir: Dir): void {
    const e = this.#edgeIndex.get(`${u}->${v}`);
    if (!e) return;
    if (dir === "fwd") e.glowF.value = 1;
    else e.glowB.value = 1;
  }

  /** Drop every node back to its resting (hollow) state. */
  clear(): void {
    for (const n of this.nodes) {
      n.activeF.value = false;
      n.activeB.value = false;
    }
  }

  /** Forward-edge targets of `id`. */
  outgoing(id: number): readonly number[] {
    return this.nodes[id]?.outgoing ?? [];
  }

  /** Forward-edge sources into `id`. */
  incoming(id: number): readonly number[] {
    return this.nodes[id]?.incoming ?? [];
  }

  /** Ever-running glow decay; start it on an animator. `rate` ≈ 1/τ. */
  decay(rate = 4.2): Animator {
    return drive(tick => {
      const k = Math.exp(-tick.dt * rate);
      const ease = (g: Writable<Num>): void => {
        const v = g.peek();
        if (v > 1e-3) g.value = v * k;
        else if (v !== 0) g.value = 0;
      };
      for (const n of this.nodes) {
        ease(n.glowF);
        ease(n.glowB);
      }
      for (const e of this.edges) {
        ease(e.glowF);
        ease(e.glowB);
      }
    });
  }

  #interact(nv: NodeView, opts: GraphOpts): void {
    const el = nv.shape.el;
    el.style.cursor = "pointer";
    let pid = -1;
    let gx = 0;
    let gy = 0;
    let moved = false;
    let downX = 0;
    let downY = 0;
    nv.shape.on("pointerdown", e => {
      const pe = e as PointerEvent;
      pid = pe.pointerId;
      el.setPointerCapture(pid);
      const l = this.toLocal(pe);
      const v = nv.pos.value;
      gx = l.x - v.x;
      gy = l.y - v.y;
      moved = false;
      downX = pe.clientX;
      downY = pe.clientY;
      pe.stopPropagation();
    });
    nv.shape.on("pointermove", e => {
      if (pid === -1) return;
      const pe = e as PointerEvent;
      if (Math.hypot(pe.clientX - downX, pe.clientY - downY) > 4) moved = true;
      if (moved && opts.draggable !== false) {
        const l = this.toLocal(pe);
        nv.pos.value = { x: l.x - gx, y: l.y - gy };
      }
    });
    const up = (): void => {
      if (pid === -1) return;
      try {
        el.releasePointerCapture(pid);
      } catch {
        /* ok */
      }
      pid = -1;
      if (!moved) opts.onPick?.(nv.id);
    };
    nv.shape.on("pointerup", up);
    nv.shape.on("pointercancel", () => {
      pid = -1;
    });
  }
}

/** Terse factory mirroring the sketch: `graph(n => …, opts)`. */
export function graph(build: (n: NodeGen) => void, opts: GraphOpts): GraphShape {
  return new GraphShape(build, opts);
}

// ── random layered DAG ──────────────────────────────────────────────
//
// A *proper* layered DAG — every edge joins consecutive layers — drawn with
// rows by layer. We deliberately allow crossings: rather than a monotone
// staircase (which forces a rigid lattice zig-zag), each upper node fans out
// to 1–3 lower nodes chosen near its own column with some jitter. Targets can
// invert against a neighbour's, so edges sometimes cross — the point is
// variety of in/out arity, not a planar embedding. A column-proximity bias
// keeps density and crossing count low enough that a wave still reads clearly.
//
// Connectivity is guaranteed both ways: every upper node emits ≥1 edge (no
// childless interior node) and any lower node left without a parent adopts a
// nearby one (no orphan). So the only sources are the top row and the only
// sinks the bottom row, and layer index is a valid topological order.
//
// The per-layer node counts are a tunable profile: a wide top row (many
// roots), a wide bottom row (many leaves), and a bulging middle (~2× the
// ends), giving a barrel/cut-diamond whose widening-then-narrowing shape is
// the propagation cone itself.

export interface LayeredDag {
  count: number;
  edges: Array<[number, number]>;
  positions: (id: number) => { x: number; y: number };
  /** Layer index per node — a valid topological order key. */
  layerOf: number[];
}

export interface LayeredFrame {
  w: number;
  h: number;
  padX?: number;
  top?: number;
  bottom?: number;
  /** Cap on column spacing so wide layers stay airy, not stretched. */
  maxColGap?: number;
}

export interface LayeredShape {
  /** Number of rows. Default 7. */
  layers?: number;
  /** Roots in the top row. Default 4. */
  topWidth?: number;
  /** Bulge at the middle row. Default 8. */
  midWidth?: number;
  /** Leaves in the bottom row. Default 4. */
  bottomWidth?: number;
  /** ± random wobble on interior rows (ends stay exact). Default 1. */
  jitter?: number;
  /** Explicit per-row widths; overrides the profile params for full control. */
  widths?: number[];
  /** Probability of each extra child beyond the first (out-degree spread).
   *  Out-degree ≈ 1 + branch + branch·0.3. Default 0.5. */
  branch?: number;
  /** Column jitter (in columns) when choosing a child — higher → more
   *  crossings and longer diagonals. Default 1.4. */
  spread?: number;
  seed?: number;
}

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t ^= t + Math.imul(t ^ (t >>> 7), 61 | t);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Per-row widths: a tent from `top` up to `mid` at the centre and back down
 *  to `bottom`, with interior rows wobbled by `jitter` (ends kept exact). */
function widthProfile(s: LayeredShape, rng: () => number): number[] {
  if (s.widths) return s.widths;
  const L = Math.max(2, s.layers ?? 7);
  const top = s.topWidth ?? 4;
  const mid = s.midWidth ?? 8;
  const bot = s.bottomWidth ?? 4;
  const jit = s.jitter ?? 1;
  const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;
  const widths: number[] = [];
  for (let k = 0; k < L; k++) {
    const t = k / (L - 1);
    const base = t <= 0.5 ? lerp(top, mid, t / 0.5) : lerp(mid, bot, (t - 0.5) / 0.5);
    let w = Math.round(base);
    if (k > 0 && k < L - 1 && jit > 0) w += Math.round((rng() * 2 - 1) * jit);
    widths.push(Math.max(2, w));
  }
  widths[0] = top;
  widths[L - 1] = bot;
  return widths;
}

/** A seeded random layered DAG embedded in `frame`; the row-width profile
 *  (`shape`) controls how many roots/leaves and how fat the middle. Edges
 *  join adjacent rows and may cross — see the section header. */
export function layeredDag(frame: LayeredFrame, shape: LayeredShape = {}): LayeredDag {
  const rng = mulberry32(shape.seed ?? 1);
  const profile = widthProfile(shape, rng);

  // Lay the rows out by the width profile, numbering nodes row-major.
  const layers: number[][] = [];
  const layerOf: number[] = [];
  const colOf: number[] = [];
  let id = 0;
  for (let k = 0; k < profile.length; k++) {
    const row: number[] = [];
    for (let c = 0; c < profile[k]!; c++) {
      layerOf[id] = k;
      colOf[id] = c;
      row.push(id);
      id++;
    }
    layers.push(row);
  }
  const n = id;

  // Random adjacent-layer wiring (crossings allowed). Each upper node fans
  // out to 1–3 lower nodes near its own column; then any orphaned lower node
  // adopts the nearest upper one. See the section header for the invariants.
  const branch = shape.branch ?? 0.5;
  const spread = shape.spread ?? 1.4;
  const edges: Array<[number, number]> = [];
  const seen = new Set<number>();
  const clamp = (x: number, lo: number, hi: number): number => Math.max(lo, Math.min(hi, x));
  const add = (u: number, v: number): void => {
    const key = u * n + v;
    if (seen.has(key)) return;
    seen.add(key);
    edges.push([u, v]);
  };

  for (let k = 0; k < layers.length - 1; k++) {
    const up = layers[k]!;
    const down = layers[k + 1]!;
    const covered = new Set<number>();
    for (let ui = 0; ui < up.length; ui++) {
      const u = up[ui]!;
      const frac = up.length > 1 ? ui / (up.length - 1) : 0.5;
      const centre = frac * (down.length - 1);
      let outN = 1 + (rng() < branch ? 1 : 0) + (rng() < branch * 0.3 ? 1 : 0);
      outN = Math.min(outN, down.length);
      for (let t = 0; t < outN; t++) {
        const c = clamp(Math.round(centre + (rng() * 2 - 1) * spread), 0, down.length - 1);
        const v = down[c]!;
        add(u, v);
        covered.add(v);
      }
    }
    for (let di = 0; di < down.length; di++) {
      const v = down[di]!;
      if (covered.has(v)) continue;
      const frac = down.length > 1 ? di / (down.length - 1) : 0.5;
      const c = clamp(Math.round(frac * (up.length - 1)), 0, up.length - 1);
      add(up[c]!, v);
    }
  }

  const padX = frame.padX ?? 24;
  const top = frame.top ?? 16;
  const bottom = frame.bottom ?? 28;
  const availW = frame.w - 2 * padX;
  const availH = frame.h - top - bottom;
  const rows = layers.length;
  const rowGap = rows > 1 ? availH / (rows - 1) : 0;
  const maxWidth = Math.max(...layers.map(l => l.length));
  const colGap = maxWidth > 1 ? Math.min(availW / (maxWidth - 1), frame.maxColGap ?? 110) : 0;
  const cx = frame.w / 2;

  const positions = (node: number): { x: number; y: number } => {
    const ly = layerOf[node]!;
    const w = layers[ly]!.length;
    return {
      x: cx + (colOf[node]! - (w - 1) / 2) * colGap,
      y: top + ly * rowGap,
    };
  };

  return { count: n, edges, positions, layerOf };
}
