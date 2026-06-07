// Self-similar fractal canopy: an infinite tree generated from ONE shared
// rule (branch angle + length ratio), lazily unfolded only while a branch
// stays wider than a pixel threshold. Dragging a single branch node inverts
// through a multi-output lens that rewrites the rule, so every level of the
// (infinite) tree updates at once.

import {
  circle,
  derive,
  Diagram,
  drag,
  forEach,
  type Inner,
  label,
  line,
  type Mount,
  type Num,
  num,
  Vec,
  vec,
  type Writable,
} from "@bireactive";

type Pt = Inner<Vec>;

const W = 640;
const H = 470;
const BASE: Pt = { x: W / 2, y: H - 26 };

// Lazy-unfold cutoff: stop descending a branch once its on-screen length
// drops below MIN_PX, and never exceed the depth / node budgets. These are
// the only thing keeping a genuinely infinite structure finite to draw.
const MIN_PX = 7;
const MAX_DEPTH = 14;
const MAX_NODES = 2400;

// Walk a root→node path (0 = left turn, 1 = right turn) to the node's
// segment endpoints. Pure function of the rule (`tip`, `ang`, `rat`); the
// root segment (empty path) is just BASE→tip.
function segOf(path: readonly number[], tip: Pt, ang: number, rat: number): { from: Pt; to: Pt } {
  if (path.length === 0) return { from: BASE, to: tip };
  let a = Math.atan2(tip.y - BASE.y, tip.x - BASE.x);
  let len = Math.hypot(tip.x - BASE.x, tip.y - BASE.y);
  let p = tip;
  let from = tip;
  let to = tip;
  for (const bit of path) {
    a += bit === 0 ? -ang : ang;
    len *= rat;
    from = p;
    to = { x: p.x + len * Math.cos(a), y: p.y + len * Math.sin(a) };
    p = to;
  }
  return { from, to };
}

const wrapToPi = (x: number) => x - 2 * Math.PI * Math.round(x / (2 * Math.PI));

export class MdFractalTree extends Diagram {
  protected scene(s: Mount): void {
    const view = this.view(W, H);

    // The entire tree is THESE THREE CELLS. `rootTip` aims/sizes the trunk;
    // `angle`/`ratio` are the self-similar branching rule shared by every node.
    const rootTip: Writable<Vec> = vec(W / 2, H * 0.56);
    const angle: Writable<Num> = num(0.46);
    const ratio: Writable<Num> = num(0.62);

    // Lazy unfold: emit every node, level by level, until a level's segment
    // length falls under MIN_PX (or a budget trips). Depends only on the
    // trunk length + ratio, NOT the angle — the visible SET is angle-free.
    const visiblePaths = derive(() => {
      const rat = ratio.value;
      const tip = rootTip.value;
      const l0 = Math.hypot(tip.x - BASE.x, tip.y - BASE.y);
      const paths: number[][] = [];
      let count = 0;
      for (let d = 0; d <= MAX_DEPTH; d++) {
        if (d > 0 && l0 * rat ** d < MIN_PX) break;
        const levelCount = 1 << d;
        if (count + levelCount > MAX_NODES) break;
        for (let i = 0; i < levelCount; i++) {
          const path: number[] = [];
          for (let j = d - 1; j >= 0; j--) path.push((i >> j) & 1);
          paths.push(path);
        }
        count += levelCount;
      }
      return paths;
    });

    // Branch layer. `forEach` materialises one line per visible node (keyed
    // by path) and removes it when the unfold no longer reaches that depth —
    // so DOM node count tracks the lazily-observed slice of the infinite tree.
    forEach(
      s.root,
      visiblePaths,
      (path: number[]) => {
        const depth = path.length;
        const from = Vec.derive(() => segOf(path, rootTip.value, angle.value, ratio.value).from);
        const to = Vec.derive(() => segOf(path, rootTip.value, angle.value, ratio.value).to);
        const shade = Math.min(depth, 9);
        const stroke = `hsl(${28 + shade * 9} 60% ${30 + shade * 4}%)`;
        const sw = Math.max(0.7, 5.5 * 0.62 ** depth);
        return line(from, to, { stroke, strokeWidth: sw, cap: "round" });
      },
      { key: (p: number[]) => (p.length ? p.join("") : "root") },
    );

    s(
      label(
        view.top.down(18),
        "drag the blue trunk tip to aim the whole tree · drag the orange branch node to rewrite the rule",
        { size: 12 },
      ),
    );

    // Trunk-tip handle: a plain writable Vec. Aiming/lengthening the trunk
    // reshapes every descendant (they all hang off it) and re-runs the unfold.
    const tipDot = s(circle(rootTip, 7, { fill: "#5b8def", stroke: "#1f4fb0", thin: true }));
    drag(tipDot, rootTip);

    // Rule handle: a multi-output lens onto the root's FIRST LEFT branch tip.
    // Forward places it from the rule; backward solves the rule that lands it
    // under the cursor — writing `angle` + `ratio` (not this point), so the
    // whole self-similar tree reshapes from one drag. The trunk is left fixed.
    const ruleHandle = Vec.lens(
      [rootTip, angle, ratio] as const,
      (vals: readonly [Pt, number, number]) => {
        const [tip, ang, rat] = vals;
        const a0 = Math.atan2(tip.y - BASE.y, tip.x - BASE.x);
        const l0 = Math.hypot(tip.x - BASE.x, tip.y - BASE.y);
        const a1 = a0 - ang;
        const l1 = l0 * rat;
        return { x: tip.x + l1 * Math.cos(a1), y: tip.y + l1 * Math.sin(a1) };
      },
      (target: Pt, vals) => {
        const [tip] = vals as readonly [Pt, number, number];
        const a0 = Math.atan2(tip.y - BASE.y, tip.x - BASE.x);
        const l0 = Math.hypot(tip.x - BASE.x, tip.y - BASE.y) || 1;
        const vx = target.x - tip.x;
        const vy = target.y - tip.y;
        const newRatio = Math.min(0.95, Math.max(0.05, Math.hypot(vx, vy) / l0));
        const newAngle = Math.min(1.5, Math.max(0.02, Math.abs(wrapToPi(a0 - Math.atan2(vy, vx)))));
        return [undefined, newAngle, newRatio] as never;
      },
    );
    const ruleDot = s(circle(ruleHandle, 6, { fill: "#f5a623", stroke: "#b3760f", thin: true }));
    drag(ruleDot, ruleHandle);

    s(
      label(
        view.bottom.up(30),
        derive(
          () =>
            `${visiblePaths.value.length} branches drawn — an infinite tree, unfolded only while a branch stays wider than ${MIN_PX}px`,
        ),
        { size: 11 },
      ),
    );
    s(
      label(
        view.bottom.up(13),
        "every node shares ONE rule (angle, ratio); the drag's backward lens rewrites it, so all depths update at once",
        { size: 10 },
      ),
    );
  }
}
