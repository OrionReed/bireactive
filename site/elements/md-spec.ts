// Drag the spec — a reflexive twist. The puck's drag *behaviour* is itself a
// value selected by dragging a knob: three `d` specs (snap-to-grid `closest`,
// free `vary`, snap-to-ring `vary`) live side by side, and the knob's mode
// picks which one drives the puck. The behaviour is just a cell, so swapping it
// is live and the preview re-resolves with no rewiring — the algebra
// configuring itself.

import {
  circle,
  Diagram,
  type Drag,
  d,
  derive,
  dragModel,
  effect,
  floating,
  label,
  line,
  type Mount,
  nearestIndex,
  type Read,
  rect,
  spring,
  Vec,
  vec,
} from "@bireactive";

type V = { x: number; y: number };
const MODES = ["snap to grid", "float free", "snap to ring"];

export class MdSpec extends Diagram {
  protected scene(s: Mount): void {
    const view = this.view(640, 420);

    const fcx = 230;
    const fcy = 235;
    s(rect(vec(fcx, fcy), 360, 300, { corner: 14, fill: "#8881", stroke: "#888", strokeWidth: 1 }));

    const gridPts: V[] = [];
    for (let r = 0; r < 3; r++) {
      for (let c = 0; c < 4; c++) gridPts.push({ x: fcx - 105 + c * 70, y: fcy - 90 + r * 90 });
    }
    const ringR = 110;
    const projRing = (p: V): V => {
      const dx = p.x - fcx;
      const dy = p.y - fcy;
      const len = Math.hypot(dx, dy);
      if (len < 1e-3) return { x: fcx + ringR, y: fcy }; // center is ambiguous → pick a point
      const k = ringR / len;
      return { x: fcx + dx * k, y: fcy + dy * k };
    };
    // The current mode applied to a position: snap to nearest grid point,
    // project onto the ring, or leave it free.
    const resolveByMode = (m: number, p: V): V => {
      if (m === 2) return projRing(p);
      if (m !== 0) return p;
      let best = gridPts[0]!;
      let bd = Number.POSITIVE_INFINITY;
      for (const g of gridPts) {
        const dd = Math.hypot(g.x - p.x, g.y - p.y);
        if (dd < bd) {
          bd = dd;
          best = g;
        }
      }
      return best;
    };

    // The selector: three markers and a draggable knob. `mode` is the nearest
    // marker — chosen with the same primitive the puck's grid mode uses.
    const selX = 520;
    const markerY = (m: number) => 150 + m * 75;
    const markers = MODES.map((_, m) => vec(selX, markerY(m)));
    const knobPos = vec(selX, markerY(0));
    const mode = nearestIndex(knobPos, markers, { sticky: 26 });
    const knobHome = Vec.derive(() => markers[mode.value]!.value);

    MODES.forEach((name, m) => {
      const active = derive(() => mode.value === m);
      s(circle(markers[m]!, 6, { fill: derive(() => (active.value ? "#5b8def" : "#888")) }));
      s(
        label(markers[m]!.right(16), name, {
          size: 12,
          align: { x: 0, y: 0.5 },
          fill: derive(() => (active.value ? "#5b8def" : "var(--text-color)")),
        }),
      );
    });
    s(line(markers[0]!, markers[2]!, { stroke: "#888", strokeWidth: 1, opacity: 0.4 }));

    const knob = s(
      circle(knobPos, 11, {
        fill: "var(--bireactive-handle, #2563eb)",
        stroke: "var(--bg-color, #fff)",
        strokeWidth: 2,
      }),
    );
    knob.el.style.cursor = "grab";
    this.anim.start(floating(knob, knobPos, knobHome, { omega: 20 }).anim);

    // The active mode's targets (faint when inactive).
    gridPts.forEach(p =>
      s(circle(vec(p.x, p.y), 4, { fill: derive(() => (mode.value === 0 ? "#5b8def" : "#8883")) })),
    );
    s(
      circle(vec(fcx, fcy), ringR, {
        fill: "none",
        stroke: derive(() => (mode.value === 2 ? "#3bb273" : "#8883")),
        strokeWidth: 2,
      }),
    );

    // The puck's model is its position, kept mode-resolved as an invariant. Its
    // drag behaviour is `[grid, free, ring][mode]` — three `d` specs selected
    // live by the knob (the reflexive bit).
    const start = resolveByMode(mode.peek(), { x: fcx, y: fcy });
    const puckModel = vec(start.x, start.y);
    const dm = dragModel<V, string>(puckModel, (_id, pointer) => {
      const grid = d.withFloating(
        pointer,
        d.closest(gridPts.map(p => d.fixed(pointer, p, q => q))),
      );
      const ring = d.withFloating(
        pointer,
        d.vary(pointer, projRing, q => q),
      );
      const free = d.vary<V>(
        pointer,
        p => p,
        q => q,
      );
      const by = [grid, free, ring];
      const sel = <T>(f: (b: Drag<V>) => Read<T>) => derive(() => f(by[mode.value]!).value);
      return {
        preview: sel(b => b.preview),
        drop: sel(b => b.drop),
        at: sel(b => b.at),
        gap: sel(b => b.gap),
      };
    });

    // Picking a mode re-resolves the committed position, so the puck moves onto
    // the ring (or a grid point) the moment the knob changes — no drag needed.
    let lastMode = mode.peek();
    effect(() => {
      const m = mode.value;
      if (m !== lastMode) {
        lastMode = m;
        puckModel.value = resolveByMode(m, puckModel.peek());
      }
    });

    const pos = vec(start.x, start.y);
    const puck = s(
      circle(pos, 16, { fill: "#e25c5c", stroke: "var(--bg-color, #fff)", strokeWidth: 2 }),
    );
    this.anim.start(
      spring(pos, puckModel, {
        omega: 22,
        zeta: 0.85,
        precision: 0,
        rate: () => (dm.active.value !== null ? 0 : 1),
      }),
    );
    effect(() => {
      if (dm.active.value !== null) pos.value = dm.at.value;
    });
    dm.grip(puck, "puck", () => pos.peek());

    s(
      label(view.top.down(20), "drag the knob to pick the behaviour, then drag the puck", {
        size: 14,
        bold: true,
      }),
      label(
        view.bottom.up(14),
        "the spec is [grid, free, ring][mode] — a cell · closest snaps, vary frees · swap it live, no rewiring",
        { size: 10 },
      ),
    );
  }
}
