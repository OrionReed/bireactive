// Constraint solver (AVBD) integration perf.

import "../_test/setup";
import {
  body,
  constraints,
  distance,
  gap,
  joint,
  pin,
  Strength,
  spring,
  world,
} from "@bireactive/constraints";
import { type Vec, vec, type Writable } from "@bireactive/core";
import { bench, group, run } from "mitata";

type WVec = Writable<Vec>;

group("rigid bodies (per frame)", () => {
  bench("rigid rope: 18 links + 18 joints, iter=14 postStab", () => {
    const w = world({ gravity: [0, 1500], iterations: 14, postStabilize: true });
    const N = 18;
    const LW = 18;
    const LH = 6;
    const anchor = w.add(body({ size: { w: 8, h: 8 }, density: 0 }, { x: 0, y: 0 }));
    let prev = anchor;
    for (let i = 0; i < N; i++) {
      const cx = LW / 2 + i * LW;
      const link = w.add(body({ size: { w: LW - 1, h: LH }, density: 1 }, { x: cx, y: 0 }));
      w.add(
        joint(prev, link, i === 0 ? { x: 0, y: 0 } : { x: LW / 2, y: 0 }, { x: -LW / 2, y: 0 }),
      );
      prev = link;
    }
    for (let f = 0; f < 60; f++) w.step(1 / 60);
  });

  bench("rigid pyramid: 10 boxes, iter=14 postStab", () => {
    const w = world({ gravity: [0, 1500], iterations: 14, postStabilize: true, damping: 0.995 });
    w.add(body({ size: { w: 800, h: 16 }, density: 0, friction: 0.7 }, { x: 0, y: 200 }));
    const SIZE = 44;
    for (let row = 0; row < 4; row++) {
      const cols = 4 - row;
      for (let col = 0; col < cols; col++) {
        const x = -((cols - 1) * SIZE) / 2 + col * SIZE;
        const y = 200 - 8 - SIZE / 2 - row * (SIZE + 1);
        w.add(
          body(
            { size: { w: SIZE - 2, h: SIZE - 2 }, density: 1, friction: 0.5 },
            { x, y, theta: 0 },
          ),
        );
      }
    }
    for (let f = 0; f < 60; f++) w.step(1 / 60);
  });
});

group("position solver (per drag)", () => {
  {
    const W = 14;
    const H = 10;
    const SP = 26;
    const grid: WVec[][] = [];
    for (let j = 0; j < H; j++) {
      const row: WVec[] = [];
      for (let i = 0; i < W; i++) row.push(vec(i * SP, j * SP));
      grid.push(row);
    }
    const c = constraints({ iterations: 16 });
    for (let j = 0; j < H; j++)
      for (let i = 1; i < W; i++)
        c.add(spring(grid[j]![i - 1]!, grid[j]![i]!, SP, Strength.STRONG));
    for (let i = 0; i < W; i++)
      for (let j = 1; j < H; j++)
        c.add(spring(grid[j - 1]![i]!, grid[j]![i]!, SP, Strength.STRONG));
    c.add(pin(grid[0]![0]!));
    c.add(pin(grid[0]![W - 1]!));
    c.add(pin(grid[H - 1]![W - 1]!));
    let dy = 1;
    bench("cloth 14×10 spring(STRONG) iter=16", () => {
      dy += 0.05;
      grid[H - 1]![W - 1]!.value = { x: (W - 1) * SP, y: (H - 1) * SP + dy };
    });
  }

  {
    const N = 16;
    const REST = 60;
    const MIN_GAP = 30;
    const STIFFNESS = 200;
    const TAU = Math.PI * 2;
    const nodes: WVec[] = [];
    for (let i = 0; i < N; i++) {
      const a = (i / N) * TAU;
      nodes.push(vec(Math.cos(a) * 100, Math.sin(a) * 100));
    }
    const edges: [number, number][] = [
      [0, 1],
      [0, 2],
      [0, 3],
      [1, 4],
      [1, 5],
      [2, 6],
      [2, 7],
      [3, 8],
      [3, 9],
      [4, 10],
      [5, 10],
      [6, 11],
      [7, 11],
      [8, 12],
      [9, 12],
      [10, 13],
      [11, 13],
      [12, 13],
      [13, 14],
      [14, 15],
      [4, 6],
      [5, 7],
      [8, 9],
    ];
    const c = constraints({ iterations: 12 });
    for (const [a, b] of edges) c.add(spring(nodes[a]!, nodes[b]!, REST, STIFFNESS));
    for (let i = 0; i < N; i++)
      for (let j = i + 1; j < N; j++) c.add(gap(nodes[i]!, nodes[j]!, MIN_GAP));
    c.add(pin(nodes[0]!));
    c.add(pin(nodes[1]!));
    let t = 0;
    bench("graph N=16 E=23 all-pairs gap iter=12", () => {
      t += 0.1;
      nodes[1]!.value = { x: 30 + 50 * Math.cos(t), y: 50 * Math.sin(t) };
    });
  }

  {
    const N = 256;
    const cells: WVec[] = [];
    for (let i = 0; i < N; i++) cells.push(vec(i, 0));
    const c = constraints({ iterations: 5 });
    for (let i = 1; i < N; i++) c.add(distance(cells[i - 1]!, cells[i]!, 1));
    c.add(pin(cells[0]!));
    c.add(pin(cells[N - 1]!));
    let dy = 1;
    bench("chain N=256 iter=5", () => {
      dy += 0.01;
      cells[N - 1]!.value = { x: N - 5, y: dy };
    });
  }

  {
    const W = 32;
    const H = 32;
    const cells: WVec[][] = [];
    for (let j = 0; j < H; j++) {
      const row: WVec[] = [];
      for (let i = 0; i < W; i++) row.push(vec(i, j));
      cells.push(row);
    }
    const c = constraints({ iterations: 5 });
    for (let j = 0; j < H; j++)
      for (let i = 1; i < W; i++) c.add(distance(cells[j]![i - 1]!, cells[j]![i]!, 1));
    for (let i = 0; i < W; i++)
      for (let j = 1; j < H; j++) c.add(distance(cells[j - 1]![i]!, cells[j]![i]!, 1));
    c.add(pin(cells[0]![0]!));
    c.add(pin(cells[0]![W - 1]!));
    let dy = 0.5;
    bench("lattice 32×32 iter=5", () => {
      dy += 0.05;
      cells[H - 1]![W - 1]!.value = { x: W - 0.5, y: H - 1 + dy };
    });
  }
});

await run({ format: "mitata" });
