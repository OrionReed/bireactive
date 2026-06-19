// Partial information: one quantity estimated from several independent
// measurements. Each measurement is an interval; the estimate is their
// running intersection (lattice meet). Evidence only sharpens, order
// doesn't matter, and a measurement that disagrees with the rest
// collapses the estimate to a contradiction. None of this is a lens —
// it's many sources narrowing one cell.

import { cell, Diagram, derive, label, line, loop, type Mount, rect, Vec, vec } from "@bireactive";
import {
  type Interval,
  intervalCell,
  isContradiction,
  merge,
  propagator,
  solve,
} from "@bireactive/propagators";

const X0 = 90;
const X1 = 560;
const VMAX = 100;
const xOf = (v: number): number => X0 + (Math.max(0, Math.min(VMAX, v)) / VMAX) * (X1 - X0);

const SENSOR = ["#5b8def", "#e25c5c", "#f5a623", "#9c6bce"];
const OK = "#86b966";
const BAD = "#e25c5c";
const TOP: Interval = [Number.NEGATIVE_INFINITY, Number.POSITIVE_INFINITY];

// Two datasets: one consistent (narrows to a tight band), one whose last
// measurement disagrees (collapses to ⊥).
const CONSISTENT: Interval[] = [
  [20, 80],
  [35, 70],
  [40, 62],
  [44, 58],
];
const CONFLICTING: Interval[] = [
  [20, 80],
  [35, 70],
  [40, 62],
  [70, 92],
];

export class MdPartial extends Diagram {
  protected scene(s: Mount): void {
    const view = this.view(620, 380);
    const rowY = (i: number) => 90 + i * 46;
    const estY = rowY(4) + 24;

    const sensors = Array.from({ length: 4 }, () => intervalCell());
    const est = intervalCell();
    const revealed = cell(0);

    // Fan-in: each sensor narrows the single estimate cell.
    solve(...sensors.map(sc => propagator([sc], [est], () => merge(est, sc.value))));

    // Measurement bands.
    sensors.forEach((sc, i) => {
      const shown = derive(() => revealed.value > i);
      const lo = derive(() => (Number.isFinite(sc.value[0]) ? xOf(sc.value[0]) : X0));
      const hi = derive(() => (Number.isFinite(sc.value[1]) ? xOf(sc.value[1]) : X1));
      s(
        line(vec(X0, rowY(i)), vec(X1, rowY(i)), { thin: true, opacity: 0.15 }),
        rect(
          lo,
          derive(() => rowY(i) - 9),
          derive(() => hi.value - lo.value),
          18,
          {
            fill: SENSOR[i]!,
            opacity: derive(() => (shown.value ? 0.4 : 0)),
            corner: 3,
          },
        ),
        label(vec(X0 - 14, rowY(i)), `m${i + 1}`, { size: 11, fill: SENSOR[i]! }),
      );
    });

    // The estimate = meet of all revealed measurements.
    const eLo = derive(() => (Number.isFinite(est.value[0]) ? xOf(est.value[0]) : X0));
    const eHi = derive(() => (Number.isFinite(est.value[1]) ? xOf(est.value[1]) : X1));
    const bad = derive(() => isContradiction(est));
    s(
      line(vec(X0, estY), vec(X1, estY), { thin: true, opacity: 0.25 }),
      rect(
        eLo,
        estY - 12,
        derive(() => Math.max(0, eHi.value - eLo.value)),
        24,
        {
          fill: derive(() => (bad.value ? BAD : OK)),
          opacity: derive(() => (bad.value ? 0.15 : 0.55)),
          corner: 4,
        },
      ),
      label(vec(X0 - 18, estY), "est", { size: 11, bold: true }),
      label(
        Vec.derive(() => ({ x: bad.value ? (X0 + X1) / 2 : eHi.value + 30, y: estY })),
        derive(() => {
          const [lo, hi] = est.value;
          if (bad.value) return "⊥ contradiction";
          if (!Number.isFinite(lo)) return "unknown";
          return `[${Math.round(lo)}, ${Math.round(hi)}]`;
        }),
        { size: 11, bold: true, fill: derive(() => (bad.value ? BAD : "var(--text)")) },
      ),
    );

    s(
      label(
        view.top.down(20),
        derive(() =>
          bad.value
            ? "m4 disagrees with m1–m3 — the estimate has no consistent value"
            : "each measurement narrows the estimate · meet = intersection",
        ),
        { size: 13, bold: true, fill: derive(() => (bad.value ? BAD : OK)) },
      ),
      label(
        view.bottom.up(16),
        "four sources, one cell — order-independent, monotone, contradiction-aware. A lens has one source.",
        { size: 10 },
      ),
    );

    let cycle = 0;
    this.anim.start(
      loop(function* () {
        const data = cycle % 2 === 0 ? CONSISTENT : CONFLICTING;
        cycle++;
        est.value = TOP;
        for (const sc of sensors) sc.value = TOP;
        revealed.value = 0;
        yield 0.7;
        for (let i = 0; i < data.length; i++) {
          sensors[i]!.value = data[i]!;
          revealed.value = i + 1;
          yield 0.95;
        }
        yield 2.2;
      }),
    );
  }
}
