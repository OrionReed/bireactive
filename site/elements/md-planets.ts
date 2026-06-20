// Planets & suns — drag a planet onto any orbit, around any sun. Mixed discrete
// (which ring) and continuous (where on it), as a composition:
//   • each orbit is a `d.vary` track — place = project the pointer onto the ring
//     (angle = atan2), so the body lands where you point;
//   • `d.closest` over the tracks picks the nearest ring across both suns;
//   • no `withFloating`, so the held body springs to the projected drop — it
//     previews the landing itself, no ring highlight needed.
// Releasing commits the chosen orbit + angle; one `drive` ticks every other
// planet's angle onward.

import {
  cell,
  circle,
  Diagram,
  d,
  dragModel,
  drive,
  label,
  type Mount,
  raise,
  spring,
  Vec,
  vec,
} from "@bireactive";

type P = { orbit: number; angle: number };

const SUNS = [
  { x: 196, y: 222, fill: "#f5a623" },
  { x: 470, y: 222, fill: "#e25c5c" },
];
const ORBITS = [
  { sun: 0, r: 52 },
  { sun: 0, r: 88 },
  { sun: 0, r: 124 },
  { sun: 1, r: 56 },
  { sun: 1, r: 96 },
];
const PLANETS = [
  { orbit: 0, speed: 0.9, fill: "#5b8def" },
  { orbit: 2, speed: -0.5, fill: "#3bb273" },
  { orbit: 3, speed: 0.8, fill: "#9b5de5" },
  { orbit: 4, speed: -0.45, fill: "#00b8a9" },
];

const posOf = (o: number, angle: number) => {
  const orb = ORBITS[o]!;
  const c = SUNS[orb.sun]!;
  return { x: c.x + orb.r * Math.cos(angle), y: c.y + orb.r * Math.sin(angle) };
};

export class MdPlanets extends Diagram {
  protected scene(s: Mount): void {
    const view = this.view(640, 430);

    const model = cell<P[]>(
      PLANETS.map((p, i) => ({ orbit: p.orbit, angle: (i / PLANETS.length) * Math.PI * 2 })),
    );

    // Dragging planet `id`: each orbit is a `vary` track that projects the
    // pointer onto its ring; `closest` picks the nearest across both suns.
    const dm = dragModel<P[], number>(model, (id, pointer) =>
      d.closest(
        ORBITS.map((orb, oi) =>
          d.vary<P[]>(
            pointer,
            p => {
              // Read `model` live (not peek): the other planets keep orbiting,
              // so the drop must reflect their current angles, or committing a
              // stale snapshot on release snaps them backward.
              const base = model.value;
              const c = SUNS[orb.sun]!;
              const angle = Math.atan2(p.y - c.y, p.x - c.x);
              return base.map((st, k) => (k === id ? { orbit: oi, angle } : st));
            },
            m => posOf(oi, m[id]!.angle),
          ),
        ),
      ),
    );

    ORBITS.forEach(orb => {
      const c = SUNS[orb.sun]!;
      s(circle(vec(c.x, c.y), orb.r, { fill: "none", stroke: "#8886", strokeWidth: 1.25 }));
    });
    SUNS.forEach(sun => s(circle(vec(sun.x, sun.y), 20, { fill: sun.fill })));

    PLANETS.forEach((p, k) => {
      const start = posOf(p.orbit, model.peek()[k]!.angle);
      const pos = vec(start.x, start.y);
      const dot = s(
        circle(pos, 11, { fill: p.fill, stroke: "var(--bg-color, #fff)", strokeWidth: 2 }),
      );
      dot.el.style.cursor = "grab";

      // Held: spring to the projected drop (`dm.at`). Idle: orbit at the
      // drive-ticked angle. Either way it lerps — releasing just stops steering.
      const home = Vec.derive(() => {
        if (dm.active.value === k) return dm.at.value;
        const st = model.value[k]!;
        return posOf(st.orbit, st.angle);
      });
      this.anim.start(spring(pos, home, { omega: 28, zeta: 0.9, precision: 0 }));
      dm.grip(
        dot,
        k,
        () => pos.peek(),
        () => raise(dot),
      );
    });

    // One animator advances every un-held planet's angle.
    this.anim.start(
      drive(tick => {
        const act = dm.active.peek();
        model.value = model
          .peek()
          .map((st, k) =>
            k === act ? st : { orbit: st.orbit, angle: st.angle + PLANETS[k]!.speed * tick.dt },
          );
      }),
    );

    s(
      label(view.top.down(20), "drag a planet to any orbit — around either sun", {
        size: 14,
        bold: true,
      }),
      label(
        view.bottom.up(14),
        "each orbit is a d.vary track · d.closest picks the ring · the body springs to the projected drop",
        { size: 10, fill: "var(--text-muted)" },
      ),
    );
  }
}
