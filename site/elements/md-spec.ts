// Drag the spec — a reflexive twist. The puck's drag *behaviour* (snap to
// grid, float free, or snap to a ring) is itself chosen by dragging a
// selector knob, with the very combinator the puck uses: `closest` picks
// the mode, `closest` snaps the puck. The behaviour is just another cell,
// so swapping it is live and the preview re-resolves with no rewiring —
// the system configured with its own primitives.

import {
  circle,
  Diagram,
  derive,
  effect,
  floating,
  label,
  line,
  type Mount,
  nearestIndex,
  rect,
  Vec,
  vec,
} from "@bireactive";

const MODES = ["snap to grid", "float free", "snap to ring"];

export class MdSpec extends Diagram {
  protected scene(s: Mount): void {
    const view = this.view(640, 420);

    // The playing field.
    const fcx = 230;
    const fcy = 235;
    const fw = 360;
    const fh = 300;
    s(rect(vec(fcx, fcy), fw, fh, { corner: 14, fill: "#8881", stroke: "#888", strokeWidth: 1 }));

    // Snap to grid is discrete (`closest` over points); snap to ring is
    // continuous (project onto a 1-manifold). Two flavours of the same idea.
    const gridPts: Vec[] = [];
    for (let r = 0; r < 3; r++) {
      for (let c = 0; c < 4; c++) gridPts.push(vec(fcx - 105 + c * 70, fcy - 90 + r * 90));
    }
    const ringR = 110;

    // The selector: three mode markers and a draggable knob. `mode` is the
    // nearest marker — the spec chosen by the same `closest` the puck uses.
    const selX = 520;
    const markerY = (m: number) => 150 + m * 75;
    const markers = MODES.map((_, m) => vec(selX, markerY(m)));
    const knobPos = vec(selX, markerY(0));
    const mode = nearestIndex(knobPos, markers, { sticky: 26 });
    const knobHome = Vec.derive(() => markers[mode.value]!.value);

    MODES.forEach((name, m) => {
      const active = derive(() => mode.value === m);
      s(
        circle(markers[m]!, 6, {
          fill: derive(() => (active.value ? "#5b8def" : "#888")),
        }),
      );
      s(
        label(markers[m]!.right(16), name, {
          size: 12,
          align: { x: 0, y: 0.5 },
          fill: derive(() => (active.value ? "#5b8def" : "var(--text-muted)")),
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

    // Show the active mode's targets (faint when inactive): grid points and
    // the ring outline.
    gridPts.forEach(p =>
      s(circle(p, 4, { fill: derive(() => (mode.value === 0 ? "#5b8def" : "#8883")) })),
    );
    s(
      circle(vec(fcx, fcy), ringR, {
        fill: "none",
        stroke: derive(() => (mode.value === 2 ? "#3bb273" : "#8883")),
        strokeWidth: 2,
      }),
    );

    // The puck. Its home is whichever target the chosen combinator resolves
    // to — grid-closest, ring-closest, or its own free resting place.
    const puckPos = vec(fcx, fcy);
    const gridClosest = nearestIndex(puckPos, gridPts);
    // Nearest point on the ring = project the pointer radially onto it.
    const ringClosest = Vec.derive(() => {
      const p = puckPos.value;
      const dx = p.x - fcx;
      const dy = p.y - fcy;
      const d = Math.hypot(dx, dy) || 1;
      return { x: fcx + (dx / d) * ringR, y: fcy + (dy / d) * ringR };
    });
    const puckFree = vec(fcx, fcy);
    const puckHome = Vec.derive(() => {
      const m = mode.value;
      if (m === 0) return gridPts[gridClosest.value]!.value;
      if (m === 2) return ringClosest.value;
      return puckFree.value;
    });

    const puck = s(
      circle(puckPos, 16, {
        fill: "#e25c5c",
        stroke: "var(--bg-color, #fff)",
        strokeWidth: 2,
      }),
    );
    puck.el.style.cursor = "grab";
    const { dragging, anim } = floating(puck, puckPos, puckHome, { omega: 22, zeta: 0.85 });
    this.anim.start(anim);

    // Remember where the puck was dropped so "float free" leaves it there.
    let was = false;
    effect(() => {
      const d = dragging.value;
      if (!d && was) puckFree.value = puckPos.peek();
      was = d;
    });

    s(
      label(view.top.down(20), "drag the knob to pick the behaviour, then drag the puck", {
        size: 14,
        bold: true,
      }),
      label(
        view.bottom.up(14),
        "the spec is a cell · closest selects the mode and snaps the puck · swap it live, no rewiring",
        { size: 10, fill: "var(--text-muted)" },
      ),
    );
  }
}
