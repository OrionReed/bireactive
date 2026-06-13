// Change propagation, made visible. A random layered DAG stands in for a
// reactive dependency graph: nodes are cells, a forward edge `u→v` means
// `v` reads `u`. Writing a cell propagates in two passes, the way the
// bidirectional engine does — so the wave runs backward, then forward.
//
//   • Backward (blue): from the written node up its incoming edges to the
//     sources it derives from — resolving what to actually set.
//   • Forward (ember): from those sources back down every outgoing edge to
//     the whole affected cone — recomputing dependents.
//
// Both passes reuse the same edges (the arrowhead points forward; the
// backward pass just recolours the line). A node fires once per pass, at its
// layer — the visual tell of glitch-free reconvergence. Click any node to
// write there; otherwise it idles, pulsing from a random node.

import { type Animator, cell, cut, Diagram, label, type Mount, untilChange, vec } from "@bireactive";
import { graph, type GraphShape, layeredDag } from "./graph";

const W = 680;
const H = 460;
const SEED = 7;
const STEP = 0.3; // seconds per propagation layer
const GAP = 0.45; // pause between the backward and forward passes
const HOLD = 1.6; // seconds the settled wave lingers before the next

export class MdPropagation extends Diagram {
  protected scene(s: Mount): void {
    this.view(W, H);
    // A layered DAG: rows are layers, edges descend (crossings allowed for
    // arity variety). The barrel profile — many roots/leaves, a fat middle —
    // is the propagation cone.
    const { count, edges, positions, layerOf } = layeredDag(
      { w: W, h: H, padX: 28, top: 18, bottom: 30 },
      { seed: SEED, layers: 7, topWidth: 4, midWidth: 8, bottomWidth: 4, jitter: 1, branch: 0.5, spread: 1.4 },
    );

    let requested = -1;
    const trigger = cell(0);
    const g = graph(
      n => {
        const node = n.take(count);
        for (const [u, v] of edges) node[u]!(node[v]!);
      },
      {
        positions,
        onPick: id => {
          requested = id;
          trigger.value = trigger.peek() + 1;
        },
      },
    );
    s(g);

    const order = [...Array(count).keys()].sort((a, b) => layerOf[a]! - layerOf[b]!);
    // Write at any non-root node — it has sources above (a visible backward
    // pass) and a forward cone below. Roots would skip the backward pass.
    const injectable = [...Array(count).keys()].filter(i => g.incoming(i).length > 0);
    const pickSource = (): number =>
      injectable.length ? injectable[Math.floor(Math.random() * injectable.length)]! : order[0]!;

    this.anim.start(g.decay());
    this.anim.start(this.#master(g, order, layerOf, trigger, pickSource, () => requested));

    s(
      label(
        vec(W / 2, H - 12),
        "a dependency graph · click a node to write it · backward pass (blue) resolves its sources, forward pass (ember) recomputes the cone",
        { size: 10.5, fill: "var(--text-secondary, #8a8a8a)" },
      ),
    );
  }

  // Alternate "run a wave, then hold" against "a node was clicked", letting
  // whichever finishes first cancel the other (cut). A click thus interrupts
  // an in-flight wave and restarts from the picked node.
  *#master(
    g: GraphShape,
    order: number[],
    layerOf: number[],
    trigger: ReturnType<typeof cell<number>>,
    pickSource: () => number,
    getRequested: () => number,
  ): Animator<void> {
    let src = pickSource();
    while (true) {
      const reason = (yield [
        this.#runAndHold(g, order, layerOf, src),
        this.#waitClick(trigger),
      ]) as unknown as string;
      if (reason === "click") {
        const r = getRequested();
        src = r >= 0 ? r : pickSource();
      } else {
        src = pickSource();
      }
    }
  }

  *#runAndHold(g: GraphShape, order: number[], layerOf: number[], src: number): Animator<unknown> {
    yield* this.#pulse(g, order, layerOf, src);
    yield HOLD;
    return cut("auto");
  }

  *#waitClick(trigger: ReturnType<typeof cell<number>>): Animator<unknown> {
    yield* untilChange(trigger);
    return cut("click");
  }

  // The two-pass wave. Edges join adjacent layers, so layer index *is*
  // longest-path depth: the backward pass walks `src`'s ancestor set up its
  // layers (deepest first), the forward pass floods the sources' descendant
  // cone down its layers. Each node fires once per pass.
  *#pulse(g: GraphShape, order: number[], layerOf: number[], src: number): Animator<void> {
    g.clear();

    // Ancestors: reverse-reachable from src (descending layers collects them
    // in one pass since a parent's layer is always below its child's).
    const anc = new Set<number>([src]);
    for (let i = order.length - 1; i >= 0; i--) {
      const u = order[i]!;
      if (anc.has(u)) for (const p of g.incoming(u)) anc.add(p);
    }
    // The sources reached: ancestors with no incoming (top row only).
    const roots = [...anc].filter(id => g.incoming(id).length === 0);
    // Forward cone: everything reachable from those sources.
    const cone = new Set<number>(roots);
    for (const u of order) if (cone.has(u)) for (const c of g.outgoing(u)) cone.add(c);

    const maxLayer = Math.max(0, ...layerOf);
    const bucket = (ids: Iterable<number>): number[][] => {
      const lv: number[][] = Array.from({ length: maxLayer + 1 }, () => []);
      for (const id of ids) lv[layerOf[id]!]!.push(id);
      return lv;
    };

    // Backward: src's layer up to the roots.
    const up = bucket(anc);
    for (let L = up.length - 1; L >= 0; L--) {
      const lvl = up[L]!;
      if (!lvl.length) continue;
      for (const v of lvl) {
        g.fire(v, "bwd");
        for (const p of g.incoming(v)) if (anc.has(p)) g.pulseEdge(p, v, "bwd");
      }
      yield STEP;
    }

    yield GAP;

    // Forward: roots down through the whole affected cone.
    const down = bucket(cone);
    for (let L = 0; L < down.length; L++) {
      const lvl = down[L]!;
      if (!lvl.length) continue;
      for (const v of lvl) {
        g.fire(v, "fwd");
        if (L > 0) for (const u of g.incoming(v)) if (cone.has(u)) g.pulseEdge(u, v, "fwd");
      }
      yield STEP;
    }
  }
}
