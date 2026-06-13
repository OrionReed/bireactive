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
// backward pass just recolours the line), and each shades a translucent
// "cone of change" — the convex hull of the nodes that actually changed.
//
// Early cutoff is the star: equality halts propagation in BOTH directions.
//   • Backward, a lens whose `put` reproduces the value the source already
//     holds absorbs the edit — the walk stops before the source (a ring, not
//     a disc), so that branch never commits and never fires forward.
//   • Forward, a dependent that recomputes to its previous value short-
//     circuits — its own dependents are never visited.
// Cut nodes are drawn as coloured rings at the cone's frontier; nothing
// beyond them lights. Click any node to write there; else it idles.

import { type Animator, cell, cut, Diagram, label, type Mount, untilChange, vec } from "@bireactive";
import { graph, type GraphShape, layeredDag } from "./graph";

const W = 680;
const H = 460;
const SEED = 7;
const STEP = 0.3; // seconds per propagation layer
const GAP = 0.45; // pause between the backward and forward passes
const HOLD = 1.9; // seconds the settled wave lingers before the next
const CUT_BWD = 0.16; // chance a lens absorbs the back-edit (stops early)
const CUT_FWD = 0.22; // chance a dependent recomputes unchanged (stops early)

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
        "click a node to write it · blue cone resolves its sources, ember cone recomputes dependents · rings are early cutoffs — equal value, propagation stops",
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

  // The two-pass wave with early cutoff. Edges join adjacent layers, so layer
  // index *is* longest-path depth — fire backward by descending layer, forward
  // by ascending. Each pass partitions touched nodes into CHANGED (the edit
  // flows on) and CUT (visited, but equal → stop). Re-randomised per pulse:
  // which branches cut depends on the specific delta.
  *#pulse(g: GraphShape, order: number[], layerOf: number[], src: number): Animator<void> {
    g.clear();
    const maxLayer = Math.max(0, ...layerOf);
    const bucket = (ids: Iterable<number>): number[][] => {
      const lv: number[][] = Array.from({ length: maxLayer + 1 }, () => []);
      for (const id of ids) lv[layerOf[id]!]!.push(id);
      return lv;
    };

    // ── Backward: walk up from src. A non-source ancestor may absorb the
    // edit (CUT) — then the walk doesn't continue past it. Sources commit.
    const computeBack = (cuts: boolean): { changed: Set<number>; cutSet: Set<number> } => {
      const changed = new Set<number>([src]);
      const cutSet = new Set<number>();
      for (let i = order.length - 1; i >= 0; i--) {
        const u = order[i]!;
        if (!changed.has(u)) continue;
        for (const p of g.incoming(u)) {
          if (changed.has(p) || cutSet.has(p)) continue;
          if (cuts && g.incoming(p).length > 0 && Math.random() < CUT_BWD) cutSet.add(p);
          else changed.add(p);
        }
      }
      return { changed, cutSet };
    };
    let { changed: bChanged, cutSet: bCut } = computeBack(true);
    let roots = [...bChanged].filter(id => g.incoming(id).length === 0);
    // Every branch absorbed before a source ⇒ the write resolves to nothing.
    // Fall back to a no-cutoff walk so at least one source commits.
    if (roots.length === 0) {
      ({ changed: bChanged, cutSet: bCut } = computeBack(false));
      roots = [...bChanged].filter(id => g.incoming(id).length === 0);
    }

    const up = bucket(new Set([...bChanged, ...bCut]));
    for (let L = up.length - 1; L >= 0; L--) {
      const lvl = up[L]!;
      if (!lvl.length) continue;
      for (const v of lvl) {
        if (bChanged.has(v)) {
          g.fire(v, "bwd");
          for (const p of g.incoming(v)) {
            if (bChanged.has(p) || bCut.has(p)) g.pulseEdge(p, v, "bwd");
          }
        } else {
          g.cutoff(v, "bwd");
        }
      }
      yield STEP;
    }

    yield GAP;

    // ── Forward: from the committed sources down. A dependent is visited iff
    // some parent changed; if it recomputes unchanged (CUT) it stops the wave.
    const fChanged = new Set<number>(roots);
    const fCut = new Set<number>();
    for (const u of order) {
      if (fChanged.has(u)) continue;
      let hit = false;
      for (const p of g.incoming(u)) {
        if (fChanged.has(p)) {
          hit = true;
          break;
        }
      }
      if (!hit) continue;
      if (Math.random() < CUT_FWD) fCut.add(u);
      else fChanged.add(u);
    }

    const down = bucket(new Set([...fChanged, ...fCut]));
    for (let L = 0; L < down.length; L++) {
      const lvl = down[L]!;
      if (!lvl.length) continue;
      for (const v of lvl) {
        const changed = fChanged.has(v);
        if (changed) g.fire(v, "fwd");
        else g.cutoff(v, "fwd");
        for (const u of g.incoming(v)) if (fChanged.has(u)) g.pulseEdge(u, v, "fwd");
      }
      yield STEP;
    }
  }
}
