// Rope-length conservation composed across two pulleys.
//
// Total rope = aDrop + tangent_length(B → P1).  Because B sits at the
// midpoint, tangent_length(B → P1) = tangent_length(B → P2) exactly, so
// cDrop mirrors aDrop.  Sliding a pulley changes the diagonal and moves B.

import {
  circle,
  Diagram,
  drag,
  label,
  line,
  type Mount,
  num,
  rect,
  Vec,
  vec,
  type Writable,
} from "@bireactive";

const W = 560;
const H = 380;
const PY = 110; // pulley axle height
const GY = PY - 32; // girder height
const R = 26; // pulley radius

// Initial drops — ROPE is inferred so the scene opens in exactly this state.
const A0 = 130;
const B0 = 120;
const H0 = 100; // = (P2x₀ − P1x₀) / 2  =  (380 − 180) / 2
const ROPE = A0 + Math.sqrt(H0 * H0 + B0 * B0 - R * R);

const M = 44; // min drop below the axle

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

/** Upper bound on aDrop (= cDrop) for half-separation h, keeping B ≥ M below axle. */
const aMax = (h: number) => ROPE - Math.sqrt(Math.max(0, M * M + h * h - R * R));

/** Upper bound on bDrop for half-separation h, keeping A ≥ M below axle. */
const bMax = (h: number) => Math.sqrt(Math.max(0, (ROPE - M) * (ROPE - M) - h * h + R * R));

/** Tangent point from external point E to circle (C, R) — the upper one,
 *  so the rope reads as wrapping over the top of the wheel. */
function tangent(
  e: { x: number; y: number },
  c: { x: number; y: number },
): { x: number; y: number } {
  const dx = e.x - c.x;
  const dy = e.y - c.y;
  const d = Math.hypot(dx, dy) || 1;
  const phi = Math.atan2(dy, dx);
  const beta = Math.acos(clamp(R / d, -1, 1));
  const p = (a: number) => ({ x: c.x + R * Math.cos(a), y: c.y + R * Math.sin(a) });
  const a = p(phi + beta);
  const b = p(phi - beta);
  return a.y < b.y ? a : b;
}

export class MdPulley extends Diagram {
  protected scene(s: Mount): void {
    const view = this.view(W, H);

    const p1 = vec(180, PY);
    const p2 = vec(380, PY);
    // Pulleys slide horizontally on the girder (y pinned, kept apart).
    const p1h = Vec.lens(
      [p1, p2] as const,
      ([a]) => a,
      (t, [, b]) => [{ x: clamp(t.x, 40 + R + 10, b.x - 120), y: PY }],
    );
    const p2h = Vec.lens(
      [p2, p1] as const,
      ([a]) => a,
      (t, [, b]) => [{ x: clamp(t.x, b.x + 120, W - 40 - R - 10), y: PY }],
    );

    // Single source of truth: aDrop (= cDrop by symmetry).
    // bDrop is derived from the real diagonal rope length:
    //   ROPE = aDrop + sqrt(h² + bDrop² − R²)  →  bDrop = sqrt((ROPE−a)² + R² − h²)
    const aDrop = num(A0);

    const aPos = Vec.lens(
      [aDrop, p1, p2] as const,
      ([d, P1]) => ({ x: P1.x - R, y: PY + d }),
      (t, [, P1, P2]) => {
        const h = (P2.x - P1.x) / 2;
        return [clamp(t.y - PY, M, aMax(h))];
      },
    );
    const cPos = Vec.lens(
      [aDrop, p1, p2] as const,
      ([a, , P2]) => ({ x: P2.x + R, y: PY + a }),
      (t, [, P1, P2]) => {
        const h = (P2.x - P1.x) / 2;
        return [clamp(t.y - PY, M, aMax(h))];
      },
    );
    const bPos = Vec.lens(
      [aDrop, p1, p2] as const,
      ([a, P1, P2]) => {
        const h = (P2.x - P1.x) / 2;
        const drop = Math.sqrt(Math.max(M * M, (ROPE - a) * (ROPE - a) + R * R - h * h));
        return { x: (P1.x + P2.x) / 2, y: PY + drop };
      },
      (t, [, P1, P2]) => {
        const h = (P2.x - P1.x) / 2;
        const bd = clamp(t.y - PY, M, bMax(h));
        const tanLen = Math.sqrt(Math.max(0, h * h + bd * bd - R * R));
        return [clamp(ROPE - tanLen, M, aMax(h))];
      },
    );

    s(line(vec(40, GY), vec(W - 40, GY), { strokeWidth: 3 }));
    s(
      line(
        Vec.derive(() => ({ x: p1.x.value, y: GY })),
        p1,
        { thin: true },
      ),
    );
    s(
      line(
        Vec.derive(() => ({ x: p2.x.value, y: GY })),
        p2,
        { thin: true },
      ),
    );

    // Ropes: A and C straight down; B held by a rope tangent to each wheel.
    s(
      line(
        Vec.derive(() => ({ x: p1.x.value - R, y: PY })),
        aPos,
        { thin: true },
      ),
    );
    s(
      line(
        Vec.derive(() => ({ x: p2.x.value + R, y: PY })),
        cPos,
        { thin: true },
      ),
    );
    s(
      line(
        bPos,
        Vec.derive(() => tangent(bPos.value, p1.value)),
        { thin: true },
      ),
    );
    s(
      line(
        bPos,
        Vec.derive(() => tangent(bPos.value, p2.value)),
        { thin: true },
      ),
    );

    for (const [p, ph] of [
      [p1, p1h],
      [p2, p2h],
    ] as const) {
      const wheel = s(circle(p, R, { thin: true }));
      drag(wheel, ph);
      wheel.el.style.cursor = "ew-resize";
      wheel.el.style.pointerEvents = "all"; // grab the whole disc, not just the rim
      const hub = s(circle(p, 2.5, { fill: true }));
      hub.el.style.pointerEvents = "none";
    }

    const weight = (pos: Writable<Vec>, fill: string, name: string) => {
      const r = s(rect(pos, 40, 28, { fill, corner: 3 }));
      drag(r, pos);
      r.el.style.cursor = "ns-resize";
      s(label(pos, name, { size: 12, fill: "#fff", bold: true }));
    };
    weight(aPos, "#5b8def", "A");
    weight(bPos, "#e2a33c", "B");
    weight(cPos, "#e25c5c", "C");

    s(
      label(view.top.down(20), "drag a weight — or slide a pulley along the girder"),
      label(
        view.bottom.up(16),
        "ROPE = aDrop + √(h² + bDrop² − R²)  ·  cDrop = aDrop  ·  slide pulleys to see B respond",
        { size: 10 },
      ),
    );
  }
}
