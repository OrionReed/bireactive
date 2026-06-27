// Gravity-driven cloth: a grid of point masses with edge springs (stretch)
// and 3-point bends (fold). `postStabilize` runs drift-tolerant iters then a
// final α=0 iter to zero the frame-end residual.

import { Diagram, handle, line, type Mount, type Vec, vec, type Writable } from "@bireactive";
import { animate, bend, physics, pin, Strength, spring } from "@bireactive/constraints";

type WVec = Writable<Vec>;

const W = 14;
const H = 10;
const SP = 26;

export class MdCloth extends Diagram {
  protected scene(s: Mount): void {
    const view = this.view(560, 380);
    const cx = view.center.value.x;
    const top = view.top.value.y + 28;

    const grid: WVec[][] = [];
    for (let j = 0; j < H; j++) {
      const row: WVec[] = [];
      for (let i = 0; i < W; i++) {
        row.push(vec(cx - ((W - 1) * SP) / 2 + i * SP, top + j * SP));
      }
      grid.push(row);
    }

    // Post-stabilize + warm-start absorb energy through drift, so damping can
    // stay light (0.997) — the cloth feels alive instead of underwater.
    const cluster = physics({
      iterations: 12,
      postStabilize: true,
      gravity: [0, 90],
      damping: 0.997,
    });

    for (let j = 0; j < H; j++) {
      for (let i = 1; i < W; i++)
        cluster.add(spring(grid[j]![i - 1]!, grid[j]![i]!, SP, Strength.MEDIUM));
    }
    for (let i = 0; i < W; i++) {
      for (let j = 1; j < H; j++)
        cluster.add(spring(grid[j - 1]![i]!, grid[j]![i]!, SP, Strength.MEDIUM));
    }

    // 3-point bends resist folding — the missing piece for cloth-like drape.
    for (let j = 0; j < H; j++) {
      for (let i = 2; i < W; i++)
        cluster.add(bend(grid[j]![i - 2]!, grid[j]![i - 1]!, grid[j]![i]!, 0.5));
    }
    for (let i = 0; i < W; i++) {
      for (let j = 2; j < H; j++)
        cluster.add(bend(grid[j - 2]![i]!, grid[j - 1]![i]!, grid[j]![i]!, 0.5));
    }

    cluster.add(pin(grid[0]![0]!), pin(grid[0]![W - 1]!));

    for (let j = 0; j < H; j++) {
      for (let i = 1; i < W; i++)
        s(line(grid[j]![i - 1]!, grid[j]![i]!, { thin: true, opacity: 0.55 }));
    }
    for (let i = 0; i < W; i++) {
      for (let j = 1; j < H; j++)
        s(line(grid[j - 1]![i]!, grid[j]![i]!, { thin: true, opacity: 0.55 }));
    }

    const handles: ReadonlyArray<[WVec, ReturnType<typeof handle>]> = grid
      .flat()
      .map(sig => [sig, s(handle(sig, { r: 3 }))] as const);
    for (const [sig, h] of handles) {
      cluster.addWhile(h.dragging, pin(sig));
    }

    this.anim.start(animate(cluster));
  }
}
