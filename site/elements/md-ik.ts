// Position-based IK arm via FABRIK living inside a plain `Vec.lens([joints],
// fwd, bwd)`: the bwd runs the two-pass solver, so `spring(tip, cursor(...))`
// is the whole driver. No Jacobian, so no rank-deficient regimes.

import {
  circle,
  cursor,
  Diagram,
  line,
  type Mount,
  spring,
  Vec,
  vec,
  type Writable,
} from "@bireactive";

const N = 5;
const L = 56;
const MAX_ITERS = 16;
const TOL = 0.25; // pixels

type V = { x: number; y: number };

export class MdIk extends Diagram {
  protected scene(s: Mount): void {
    const view = this.view(640, 360);
    const root = vec(view.left.right(80).value.x, view.center.value.y);

    // Joints as positions, initialised along a slight diagonal so the
    // start state isn't pathological (any non-collinear start is fine).
    const joints: Writable<Vec>[] = [];
    for (let i = 0; i < N; i++) {
      joints.push(
        vec(
          root.value.x + (i + 1) * L * Math.cos(0.05 * (i + 1)),
          root.value.y + (i + 1) * L * Math.sin(0.05 * (i + 1)),
        ),
      );
    }

    const tip = Vec.lens(
      joints as readonly Writable<Vec>[],
      (vals: readonly V[]) => vals[N - 1]!,
      (target: V, vals: readonly V[]) => {
        // Walk on a scratch array including the root at index 0.
        const js = new Array<V>(N + 1);
        const R = root.value;
        js[0] = R;
        for (let i = 0; i < N; i++) js[i + 1] = vals[i]!;

        for (let iter = 0; iter < MAX_ITERS; iter++) {
          if (Math.hypot(js[N]!.x - target.x, js[N]!.y - target.y) < TOL) break;

          // Forward pass: tip → target, walk back maintaining lengths.
          js[N] = { x: target.x, y: target.y };
          for (let i = N - 1; i >= 1; i--) {
            const next = js[i + 1]!;
            const cur = js[i]!;
            const dx = cur.x - next.x;
            const dy = cur.y - next.y;
            const d = Math.hypot(dx, dy) || 1;
            const k = L / d;
            js[i] = { x: next.x + dx * k, y: next.y + dy * k };
          }

          // Backward pass: root → ..., walk forward maintaining lengths.
          js[0] = R;
          for (let i = 1; i <= N; i++) {
            const prev = js[i - 1]!;
            const cur = js[i]!;
            const dx = cur.x - prev.x;
            const dy = cur.y - prev.y;
            const d = Math.hypot(dx, dy) || 1;
            const k = L / d;
            js[i] = { x: prev.x + dx * k, y: prev.y + dy * k };
          }
        }

        // Return updates for each joint cell (skip the fixed root).
        const out = new Array<V>(N);
        for (let i = 0; i < N; i++) out[i] = js[i + 1]!;
        return out;
      },
    );

    for (let i = 0; i < N; i++) {
      const prev = i === 0 ? root : joints[i - 1]!;
      s(line(prev, joints[i]!, { thin: false }));
      if (i < N - 1) {
        s(circle(joints[i]!, 4, { fill: "var(--bg-color, white)", thin: true }));
      }
    }
    s(circle(root, 6, { fill: true }));
    s(circle(joints[N - 1]!, 6, { fill: "#5b8def" }));

    // Seed at the tip so the first spring frame isn't a jolt to (0, 0);
    // `precision: 0` keeps the spring live so it tracks a moving target.
    const target = cursor(s.root, joints[N - 1]!.peek());
    this.anim.start(spring(tip, target, { omega: 6, zeta: 0.35, precision: 0 }));
  }
}
