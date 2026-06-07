// Network-as-a-value, the part you CAN'T get another way: composition.
// Three fingers share a hub; each is its own constraint cluster (rigid
// bars + soft bend), and `exposeVec` turns each fingertip into a plain
// `Writable<Vec>`. Then `procrustes(tips)` lays an EXACT closed-form
// similarity lens (move / spin / size) on top of those three solvers.
// One gizmo write splits — through the closed form — into a per-finger
// target, and each cluster relaxes independently to meet it. You can't
// fold this into one flat network without dissolving the exact aggregate
// into more soft constraints, and you can't get it by "driving a cell":
// spin and size are emergent — no single cell holds them.

import {
  circle,
  Diagram,
  handle,
  label,
  line,
  type Mount,
  Num,
  polar,
  procrustes,
  type Vec,
  vec,
  type Writable,
} from "@bireactive";
import { bend, constraints, distance, exposeVec, pin } from "@bireactive/constraints";

const SEG = 4; // links per finger
const L = 50; // bar length → reach 200
const ACCENT = "#5b8def";
const GIZMO = "#e0663c";
const GHOST = "rgba(127,127,127,0.45)";

type V = { x: number; y: number };
type Finger = { base: Writable<Vec>; joints: Writable<Vec>[]; tip: Writable<Vec> };

/** Declare one finger as its own cluster; return base, joints, exposed tip.
 *  Seeded as a bowed arc that already ends at `rest`, so the chain is never
 *  collinear with its target (a straight chain pulled along its own axis
 *  can't choose a fold direction — a singularity the solver won't escape). */
function finger(base: Writable<Vec>, rest: V, bow: number): Finger {
  const b = base.peek();
  const dx = rest.x - b.x;
  const dy = rest.y - b.y;
  const len = Math.hypot(dx, dy) || 1;
  const px = (-dy / len) * bow; // unit perpendicular × bow direction
  const py = (dx / len) * bow;
  const slack = Math.sqrt(Math.max(0, (SEG * L) ** 2 - len ** 2)) / 2;
  const joints: Writable<Vec>[] = [];
  for (let i = 0; i < SEG; i++) {
    const t = (i + 1) / SEG;
    const off = slack * Math.sin(Math.PI * t); // 0 at base and tip, bow in the middle
    joints.push(vec(b.x + dx * t + px * off, b.y + dy * t + py * off));
  }
  const c = constraints({ iterations: 40 });
  c.add(pin(base), distance(base, joints[0]!, L));
  for (let i = 1; i < SEG; i++) c.add(distance(joints[i - 1]!, joints[i]!, L));
  // A whisper of bend keeps the chain from kinking; kept tiny (and the
  // soft pull stiff) so the tip lands ON target. A hard undershoot would
  // make `procrustes` read a shrinking scale, compounding into a collapse.
  for (let i = 0; i < SEG - 1; i++) {
    c.add(bend(i === 0 ? base : joints[i - 1]!, joints[i]!, joints[i + 1]!, 2));
  }
  return {
    base,
    joints,
    tip: exposeVec(c, joints, joints[SEG - 1]!, { iters: 20, stiffness: 1e7 }),
  };
}

export class MdNetworkLens extends Diagram {
  protected scene(s: Mount): void {
    const view = this.view(720, 420);
    const hubY = 372;

    // Rest triangle (inside reach), with headroom to spin and scale. Each
    // finger is seeded bowing outward toward its corner.
    const rest = [
      { x: 302, y: 268 },
      { x: 363, y: 192 },
      { x: 418, y: 268 },
    ];
    const fingers = [
      finger(vec(338, hubY), rest[0]!, 48),
      finger(vec(360, hubY), rest[1]!, -40),
      finger(vec(382, hubY), rest[2]!, -48),
    ];
    const tips = fingers.map(f => f.tip);

    // Settle the bars to exact length while keeping the bow.
    tips.forEach((t, i) => {
      t.value = rest[i]!;
    });

    // The whole claw, oriented as one similarity frame. Closed-form, exact.
    const { centroid, rotation, scale } = procrustes(tips);

    // Fingers, drawn straight off the bound cells the solver writes back.
    for (const f of fingers) {
      s(line(f.base, f.joints[0]!, { thin: false }));
      for (let i = 1; i < SEG; i++) s(line(f.joints[i - 1]!, f.joints[i]!, { thin: false }));
      for (let i = 0; i < SEG - 1; i++) {
        s(circle(f.joints[i]!, 3.5, { fill: "var(--bg-color, white)", thin: true }));
      }
    }
    // The constellation the gizmo transforms.
    for (let i = 0; i < tips.length; i++) {
      s(line(tips[i]!, tips[(i + 1) % tips.length]!, { thin: true, dashed: true, stroke: GHOST }));
    }
    for (const f of fingers) s(circle(f.base, 5, { fill: true }));
    for (const t of tips) s(circle(t, 6, { fill: ACCENT }));

    // The gizmo: one move handle, one spin knob, one size knob — three
    // closed-form views of the same three solvers.
    const R = 92;
    const spinAt = polar(centroid, R, rotation, "circular");
    const sizeAt = polar(centroid, scale, Num.pin(0), "radial");
    s(circle(centroid, R, { thin: true, stroke: GHOST }));
    s(line(centroid, spinAt, { thin: true, stroke: GHOST }));

    s(handle(centroid, { r: 8, fill: GIZMO }));
    s(handle(spinAt, { r: 7, fill: GIZMO }));
    s(handle(sizeAt, { r: 7, fill: GIZMO }));
    s(
      label(centroid.down(20), "move", { size: 9, opacity: 0.7 }),
      label(spinAt.down(15), "spin", { size: 9, opacity: 0.7 }),
      label(sizeAt.down(15), "size", { size: 9, opacity: 0.7 }),
    );

    s(
      label(
        view.top.down(18),
        "one gizmo, three solvers — move / spin / size an exact similarity lens over independent clusters",
      ),
      label(
        view.bottom.up(14),
        "procrustes(tips) ⇌ 3 × exposeVec(cluster) · each write splits, through the closed form, into a per-finger target",
        { size: 10 },
      ),
    );
  }
}
