// Branching gear tree where speed = drive · Π(±tₚ/t_c), via opposite-sign
// `scale` lenses; invertible, so dragging any gear scrubs the whole tree.

import {
  cell,
  circle,
  Diagram,
  dragRotate,
  drive,
  label,
  type Mount,
  type Num,
  num,
  Shape,
  type Vec,
  vec,
  type Writable,
} from "@bireactive";

const TAU = Math.PI * 2;
const K = 3.5; // r = K · teeth → matched pitch across all gears.

function gearPathD(r: number, teeth: number, toothDepth = 3.5): string {
  const inner = r - toothDepth;
  const outer = r + toothDepth;
  const parts: string[] = [];
  const N = teeth * 2;
  for (let i = 0; i < N; i++) {
    const a = (i * Math.PI) / teeth;
    const rad = i % 2 === 0 ? outer : inner;
    parts.push(
      `${i === 0 ? "M" : "L"} ${(rad * Math.cos(a)).toFixed(2)} ${(rad * Math.sin(a)).toFixed(2)}`,
    );
  }
  return `${parts.join(" ")} Z`;
}

function gear(center: Vec, teeth: number, rotate: Writable<Num>, back = false): Shape {
  const r = K * teeth;
  const sh = new Shape("path", () => ({ x: -r, y: -r, w: 2 * r, h: 2 * r }), {
    translate: center,
    rotate,
  });
  sh.attr("d", gearPathD(r, teeth));
  // Solid → gears occlude each other; back wheels take a slightly off-bg
  // shade so a compound wheel reads as sitting beneath its mate.
  sh.attr(
    "fill",
    back
      ? "color-mix(in srgb, var(--bg-color, #fff) 88%, var(--text-color, #000) 12%)"
      : "var(--bg-color, #fff)",
  );
  sh.attr("stroke", "currentColor");
  sh.attr("stroke-width", "1.25");
  sh.attr("stroke-linejoin", "round");
  return sh;
}

interface GearSpec {
  teeth: number;
  at?: number; // placement angle from parent (degrees, y-down)
  children?: GearSpec[];
  /** Second wheel on the same shaft (shares angle, own teeth + subtree). */
  compound?: { teeth: number; children?: GearSpec[] };
}

export class MdGears extends Diagram {
  protected scene(s: Mount): void {
    const view = this.view(680, 360);

    const tree: GearSpec = {
      teeth: 12,
      children: [
        {
          teeth: 16,
          at: 0,
          compound: {
            teeth: 24,
            children: [
              { teeth: 12, at: -40 },
              { teeth: 12, at: 40 },
            ],
          },
        },
        { teeth: 10, at: 90 },
      ],
    };

    const drive0 = num(0);
    const dragging = cell(false);
    const root = vec(150, 165);

    // Initial phase must interlock teeth at the contact line: with parent
    // crest reference θp0 and contact direction α, the child's start angle is
    // θc0 = (α+π) − π/N_c + (N_p/N_c)(α − θp0).
    interface Inst {
      center: Vec;
      teeth: number;
      angle: Writable<Num>;
      plane: number;
      main: boolean;
    }
    const insts: Inst[] = [];

    const meshKids = (
      angle: Writable<Num>,
      center: Vec,
      drivingTeeth: number,
      startAngle: number,
      kids: GearSpec[],
    ) => {
      for (const child of kids) {
        const alpha = ((child.at ?? 0) * Math.PI) / 180;
        const np = drivingTeeth;
        const nc = child.teeth;
        const dist = K * (np + nc);
        const cc = vec(
          center.x.value + Math.cos(alpha) * dist,
          center.y.value + Math.sin(alpha) * dist,
        );
        const childStart = alpha + Math.PI - Math.PI / nc + (np / nc) * (alpha - startAngle);
        const ratio = -np / nc;
        layout(child, angle.affine(ratio, childStart - ratio * startAngle), cc, childStart);
      }
    };

    const layout = (
      spec: GearSpec,
      angle: Writable<Num>,
      center: Vec,
      startAngle: number,
    ): void => {
      if (spec.compound) {
        insts.push({ center, teeth: spec.compound.teeth, angle, plane: 0, main: false });
      }
      insts.push({ center, teeth: spec.teeth, angle, plane: 1, main: true });
      meshKids(angle, center, spec.teeth, startAngle, spec.children ?? []);
      if (spec.compound) {
        meshKids(angle, center, spec.compound.teeth, startAngle, spec.compound.children ?? []);
      }
    };

    layout(tree, drive0, root, 0);

    for (const inst of insts.filter(i => i.plane === 0)) {
      dragRotate(s(gear(inst.center, inst.teeth, inst.angle, true)), inst.angle, dragging);
    }
    for (const inst of insts.filter(i => i.plane === 1)) {
      const g = s(gear(inst.center, inst.teeth, inst.angle));
      dragRotate(g, inst.angle, dragging);
      s(circle(inst.center, 3, { fill: true }));
    }

    const omega = TAU * 0.12;
    this.anim.start(
      drive(tick => {
        if (dragging.value) return;
        drive0.value = drive0.peek() + omega * tick.dt;
      }),
    );

    s(
      label(
        view.top.down(20),
        "drag any gear — the meshed tree rotates; writes scrub back through the drive",
      ),
      label(
        view.bottom.up(16),
        "child = parent.scale(−tₚ/t_c) · the compound wheel beneath multiplies the ratio (a real product, no telescoping)",
        { size: 10 },
      ),
    );
  }
}
