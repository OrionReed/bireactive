// Planets & suns — drag a planet onto any orbit, around any sun. Built by
// composing primitives, not as a bespoke widget:
//   • orbit position   = center + r·(cos θ, sin θ)   (a polar lens)
//   • orbit motion      = a `drive` animator ticking θ
//   • which orbit       = `closest` over each ring's projection of the pointer
//   • preview + settle  = the planet springs to where it would land (the
//                         pointer projected onto the chosen orbit), so the
//                         body itself shows the drop — no ring highlight needed.
// Releasing reassigns the planet's orbit (and sun) and resumes the motion
// from the drop angle.

import {
  cell,
  circle,
  closest,
  Diagram,
  drag,
  drive,
  effect,
  label,
  type Mount,
  spring,
  Vec,
  vec,
} from "@bireactive";

const SUNS = [
  { x: 196, y: 222, fill: "#f5a623" },
  { x: 470, y: 222, fill: "#e25c5c" },
];
// (sun index, radius) for every orbit, flattened.
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

export class MdPlanets extends Diagram {
  protected scene(s: Mount): void {
    const view = this.view(640, 430);

    const draggingPlanet = cell<number | null>(null);
    const planets = PLANETS.map((p, i) => ({
      id: i,
      orbit: cell(p.orbit),
      angle: cell((i / PLANETS.length) * Math.PI * 2),
      speed: p.speed,
      fill: p.fill,
      pos: vec(0, 0),
      // The raw pointer while this planet is held (drives the projection).
      raw: vec(0, 0),
    }));

    // The dragged planet's raw pointer.
    const pointer = Vec.derive(() => {
      const d = draggingPlanet.value;
      return d === null ? { x: -1e4, y: -1e4 } : planets[d]!.raw.value;
    });
    // Each orbit's candidate position is the pointer projected onto its ring;
    // `closest` then picks the nearest orbit across both suns.
    const projections = ORBITS.map(o =>
      Vec.derive(() => {
        const c = SUNS[o.sun]!;
        const p = pointer.value;
        const dx = p.x - c.x;
        const dy = p.y - c.y;
        const d = Math.hypot(dx, dy) || 1;
        return { x: c.x + (dx / d) * o.r, y: c.y + (dy / d) * o.r };
      }),
    );
    const { index: targetOrbit } = closest(pointer, projections, { sticky: 16 });
    // Where a release would put the planet: the chosen ring's projection.
    const projectedDrop = Vec.derive(() => projections[targetOrbit.value]!.value);

    // Orbit rings — plain; the dragged body itself shows the target.
    ORBITS.forEach(o => {
      const c = SUNS[o.sun]!;
      s(circle(vec(c.x, c.y), o.r, { fill: "none", stroke: "#8886", strokeWidth: 1.25 }));
    });

    // Suns.
    SUNS.forEach(sun => s(circle(vec(sun.x, sun.y), 20, { fill: sun.fill })));

    // Planets: each springs toward its orbit position — or, while held,
    // toward where it would land. So the body previews the drop and a release
    // just stops steering it.
    for (const p of planets) {
      const home = Vec.derive(() => {
        const o = ORBITS[p.orbit.value]!;
        const c = SUNS[o.sun]!;
        const a = p.angle.value;
        return { x: c.x + o.r * Math.cos(a), y: c.y + o.r * Math.sin(a) };
      });
      p.pos.value = home.peek();

      const dragging = cell(false);
      const target = Vec.derive(() =>
        draggingPlanet.value === p.id ? projectedDrop.value : home.value,
      );

      const dot = s(
        circle(p.pos, 11, { fill: p.fill, stroke: "var(--bg-color, #fff)", strokeWidth: 2 }),
      );
      dot.el.style.cursor = "grab";
      dot.on("pointerdown", () => {
        p.raw.value = p.pos.peek();
      });
      drag(dot, p.raw, dragging);
      this.anim.start(spring(p.pos, target, { omega: 28, zeta: 0.9, precision: 0 }));

      let was = false;
      effect(() => {
        const now = dragging.value;
        if (now && !was) {
          draggingPlanet.value = p.id;
          dot.el.parentElement?.appendChild(dot.el);
        } else if (!now && was) {
          // Commit: adopt the chosen orbit and resume from the drop angle.
          const k = targetOrbit.peek();
          const o = ORBITS[k]!;
          const c = SUNS[o.sun]!;
          const pos = p.pos.peek();
          p.orbit.value = k;
          p.angle.value = Math.atan2(pos.y - c.y, pos.x - c.x);
          draggingPlanet.value = null;
        }
        was = now;
      });
    }

    // Orbit motion: one animator advances every (un-held) planet's angle.
    this.anim.start(
      drive(tick => {
        for (const p of planets) {
          if (draggingPlanet.peek() === p.id) continue;
          p.angle.value = p.angle.peek() + p.speed * tick.dt;
        }
      }),
    );

    s(
      label(view.top.down(20), "drag a planet to any orbit — around either sun", {
        size: 14,
        bold: true,
      }),
      label(
        view.bottom.up(14),
        "orbit = polar position · closest picks the ring · the body springs to the projected drop · one drive ticks the angles",
        { size: 10, fill: "var(--text-muted)" },
      ),
    );
  }
}
