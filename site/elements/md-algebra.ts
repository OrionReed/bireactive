// Animate Algebra — commuting a sum. The three terms can be reordered
// freely (a + b + c = b + c + a = …) and the rewrite is animated, not
// snapped. Scrub the playhead: tent weights over the keyframe orderings
// feed one `mix` per term, so the tiles slide continuously between
// arrangements (continuous `between`). On release `closest` picks the
// nearest clean ordering and the gated spring eases there — fling past a
// tick and it chains on to the next. The sum never changes: the rewrite
// preserves meaning by construction.

import {
  cell,
  circle,
  Diagram,
  derive,
  drag,
  label,
  type Mount,
  mix,
  Num,
  nearestIndex,
  spring,
  Vec,
  vec,
  type Writable,
} from "@bireactive";

const TERMS = [
  { label: "a", value: 3, fill: "#5b8def" },
  { label: "b", value: 1, fill: "#f5a623" },
  { label: "c", value: 2, fill: "#3bb273" },
];
// Keyframe orderings (rotations) — every one a valid commutation.
const ORDERS = [
  [0, 1, 2],
  [1, 2, 0],
  [2, 0, 1],
];

export class MdAlgebra extends Diagram {
  protected scene(s: Mount): void {
    const view = this.view(640, 340);

    const rowY = 130;
    const sStep = 132;
    const sx0 = view.w.value / 2 - sStep;
    const slot = (j: number) => ({ x: sx0 + j * sStep, y: rowY });

    const trackY = 250;
    const tStep = 116;
    const tx0 = view.w.value / 2 - tStep;
    const tick = (k: number) => ({ x: tx0 + k * tStep, y: trackY });
    const tickCells = ORDERS.map((_, k) => {
      const t = tick(k);
      return vec(t.x, t.y);
    });

    // Playhead: dragged horizontally, clamped to the track.
    const playRaw = vec(tx0, trackY);
    const play = Vec.lens(
      playRaw,
      v => v,
      (t: { x: number }) => ({
        x: Math.max(tx0, Math.min(tx0 + (ORDERS.length - 1) * tStep, t.x)),
        y: trackY,
      }),
    );

    // Scrub parameter u ∈ [0, K−1] and the tent (hat) weights that give
    // piecewise-linear interpolation across the keyframes.
    const u = derive(() => (play.value.x - tx0) / tStep);
    const weights = ORDERS.map((_, k) => Num.derive(() => Math.max(0, 1 - Math.abs(u.value - k))));

    // Operators and running sum (the invariant the rewrite preserves).
    const sum = TERMS.reduce((a, t) => a + t.value, 0);
    s(label(vec(slot(0).x + sStep / 2, rowY), "+", { size: 24, bold: true }));
    s(label(vec(slot(1).x + sStep / 2, rowY), "+", { size: 24, bold: true }));
    s(label(vec(slot(2).x + 78, rowY), `= ${sum}`, { size: 22, bold: true }));

    // Each term blends its slot across the keyframe orderings.
    TERMS.forEach((term, i) => {
      const branches = ORDERS.map(ord => {
        const c = slot(ord.indexOf(i));
        return vec(c.x, c.y);
      }) as Writable<Vec>[];
      const pos = mix(weights, branches);
      s(circle(pos, 26, { fill: term.fill, stroke: "var(--bg-color, #fff)", strokeWidth: 2 }));
      s(label(pos, term.label, { size: 22, bold: true, fill: "#fff" }));
      s(label(pos.down(40), String(term.value), { size: 11 }));
    });

    // Keyframe ticks along the track.
    for (let k = 0; k < ORDERS.length; k++) {
      const t = tick(k);
      s(circle(vec(t.x, t.y), 4, { fill: "#888" }));
      s(
        label(vec(t.x, t.y + 22), ORDERS[k]!.map(j => TERMS[j]!.label).join("+"), {
          size: 11,
        }),
      );
    }

    // The playhead dot + drag wiring.
    const dot = s(
      circle(play, 11, {
        fill: "var(--bireactive-handle, #2563eb)",
        stroke: "var(--bg-color,#fff)",
        strokeWidth: 2,
      }),
    );
    dot.el.style.cursor = "grab";
    const dragging = cell(false);
    drag(dot, play, dragging);

    // Snap-on-release + chaining: when not dragging, the playhead springs
    // to the nearest tick; a fast fling overshoots and chains to the next.
    const nearest = nearestIndex(play, tickCells);
    const home = Vec.derive(() => tick(nearest.value));
    this.anim.start(
      spring(playRaw, home, {
        omega: 16,
        zeta: 0.85,
        precision: 0,
        rate: () => (dragging.value ? 0 : 1),
      }),
    );

    s(
      label(view.top.down(20), "drag the playhead — the terms commute, animated", {
        size: 14,
        bold: true,
      }),
      label(
        view.bottom.up(14),
        "mix(tent weights, orderings) morphs continuously · closest snaps to a clean form on release",
        { size: 10 },
      ),
    );
  }
}
