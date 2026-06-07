// A clock is a polar chain off one scalar — the solar system in a form
// everyone owns. Each hand angle is `time.affine(τ/period, -π/2)`, each
// tip a `circular` polar point, so dragging any hand scrubs `time` and
// the rest follow (turning the minute hand drags the hour hand 1/12 as
// far, exactly like the gears in a real movement). A second timezone is
// one more affine — `time.affine(1, offset)` — a whole linked face for
// free. The digital read-out is the same scalar, formatted.

import {
  cell,
  circle,
  Diagram,
  derive,
  drag,
  drive,
  label,
  line,
  type Mount,
  type Num,
  num,
  polar,
  vec,
  type Writable,
} from "@bireactive";

const TAU = Math.PI * 2;
const R = 96; // face radius
const HOUR = "#5b8def";
const MIN = "#5b8def";
const SEC = "#e25c5c";

const pad = (n: number) => String(n).padStart(2, "0");

/** Seconds-since-midnight → `HH:MM:SS` (24h, wrapped to a day). */
function clockText(sec: number): string {
  const s = ((sec % 86400) + 86400) % 86400;
  return `${pad(Math.floor(s / 3600))}:${pad(Math.floor(s / 60) % 60)}:${pad(Math.floor(s) % 60)}`;
}

export class MdClock extends Diagram {
  protected scene(s: Mount): void {
    const view = this.view(560, 300);

    // The one source of truth: seconds since local midnight.
    const time = num(10 * 3600 + 8 * 60 + 26);
    const dragging = cell(false); // true while any hand is grabbed

    // A second timezone is a single affine edge onto the same instant.
    const tokyo = time.affine(1, 9 * 3600);

    this.#face(s, 156, 138, time, dragging, "local");
    this.#face(s, 404, 138, tokyo, dragging, "Tokyo · +9h");

    // Tick forward in real time, but hold while a hand is being dragged.
    this.anim.start(
      drive(t => {
        if (!dragging.peek()) time.value = time.peek() + t.dt;
      }),
    );

    s(
      label(
        view.top.down(18),
        "drag any hand — every hand, both faces, and both read-outs stay in sync",
      ),
      label(
        view.bottom.up(14),
        "one `time: Num` · hand angle = time.affine(τ/period, −π/2) · Tokyo = time.affine(1, 9h)",
        { size: 10 },
      ),
    );
  }

  /** One analog face reading `t` (seconds), with a digital read-out. */
  #face(
    s: Mount,
    cx: number,
    cy: number,
    t: Writable<Num>,
    dragging: ReturnType<typeof cell<boolean>>,
    name: string,
  ): void {
    const center = vec(cx, cy);
    const at = (r: number, a: number) => vec(cx + r * Math.cos(a), cy + r * Math.sin(a));

    // Bezel and tick marks (12 hours, longer at the quarters).
    s(circle(center, R, { fill: "none", thin: true }));
    for (let i = 0; i < 12; i++) {
      const a = -Math.PI / 2 + (i * TAU) / 12;
      s(line(at(R - (i % 3 === 0 ? 13 : 7), a), at(R - 2, a), { thin: true, opacity: 0.55 }));
      s(label(at(R - 26, a), String(i === 0 ? 12 : i), { size: 12, fill: "#9b9b9b" }));
    }

    // Each hand: angle is an affine view of `t`; the tip is a circular
    // polar point, so a drag writes only the angle, back through to `t`.
    const hand = (period: number, len: number, color: string, width: number, grab: number) => {
      const angle = t.affine(TAU / period, -Math.PI / 2);
      const tip = polar(center, len, angle, "circular");
      s(line(center, tip, { stroke: color, strokeWidth: width, cap: "round" }));
      drag(s(circle(tip, grab, { fill: color })), tip, dragging);
    };
    hand(43200, R * 0.5, HOUR, 5, 7); // hour
    hand(3600, R * 0.74, MIN, 3, 6); // minute
    hand(60, R * 0.88, SEC, 1.5, 4); // second
    s(circle(center, 4, { fill: SEC }));

    // The same scalar, read as text.
    s(
      label(
        vec(cx, cy + R + 22),
        derive(() => clockText(t.value)),
        { size: 20, bold: true },
      ),
      label(vec(cx, cy + R + 42), name, { size: 11, fill: "#9b9b9b" }),
    );
  }
}
