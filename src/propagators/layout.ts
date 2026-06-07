// layout.ts — rigid Box-relational combinators.
//
// The bidirectional, whole-box anchoring relations (edge-to-edge,
// centring, insets, grids). Flex lives in `flex.ts`; these are the
// fixed structural pieces you compose around it. Reactive opts (`gap`,
// `padding`, …) accept a number or a Num signal.

import {
  type Box,
  isCell,
  type Num as NumClass,
  type Read,
  readNow,
  type Writable,
} from "@bireactive/core";
import { type Propagator, propagator } from "./solver";

type Num = NumClass;
const asW = (n: Num): Writable<NumClass> => n as unknown as Writable<NumClass>;
type ValOrSig = number | Read<number>;

function readDeps(...vs: ValOrSig[]): Num[] {
  return vs.filter(isCell) as Num[];
}

export interface GridOpts {
  /** Cells per row. */
  cols: number;
  /** Gap between cells (both axes). Use `gapX` / `gapY` to differ. */
  gap?: ValOrSig;
  gapX?: ValOrSig;
  gapY?: ValOrSig;
  padding?: ValOrSig;
}

/** Regular grid: items placed in a `cols`-wide grid. Cells equal-size,
 *  computed from container minus padding and gaps. */
export function grid(c: Box, items: readonly Box[], opts: GridOpts): Propagator {
  const cols = opts.cols;
  const reads: Num[] = [
    c.x,
    c.y,
    c.w,
    c.h,
    ...readDeps(opts.gap ?? 0, opts.gapX ?? 0, opts.gapY ?? 0, opts.padding ?? 0),
  ];
  const writes: Writable<NumClass>[] = [];
  for (const it of items) writes.push(asW(it.x), asW(it.y), asW(it.w), asW(it.h));
  return propagator(reads, writes, () => {
    const pad = readNow(opts.padding ?? 0);
    const gap = readNow(opts.gap ?? 0);
    const gx = readNow(opts.gapX ?? gap);
    const gy = readNow(opts.gapY ?? gap);
    const rows = Math.ceil(items.length / cols);
    const cellW = (c.w.value - 2 * pad - (cols - 1) * gx) / cols;
    const cellH = (c.h.value - 2 * pad - (rows - 1) * gy) / rows;
    for (let i = 0; i < items.length; i++) {
      const row = Math.floor(i / cols);
      const col = i % cols;
      const it = items[i]!;
      asW(it.x).value = c.x.value + pad + col * (cellW + gx);
      asW(it.y).value = c.y.value + pad + row * (cellH + gy);
      asW(it.w).value = cellW;
      asW(it.h).value = cellH;
    }
  });
}

/** `inner` fills `outer` minus padding on all sides. Drag outer →
 *  inner follows. Default padding is 0 (inner == outer). */
export function inset(outer: Box, inner: Box, opts: { padding?: ValOrSig } = {}): Propagator {
  const reads: Num[] = [outer.x, outer.y, outer.w, outer.h, ...readDeps(opts.padding ?? 0)];
  const writes: Writable<NumClass>[] = [asW(inner.x), asW(inner.y), asW(inner.w), asW(inner.h)];
  return propagator(reads, writes, () => {
    const pad = readNow(opts.padding ?? 0);
    asW(inner.x).value = outer.x.value + pad;
    asW(inner.y).value = outer.y.value + pad;
    asW(inner.w).value = outer.w.value - 2 * pad;
    asW(inner.h).value = outer.h.value - 2 * pad;
  });
}

export type Side = "left" | "right" | "top" | "bottom";

/** Anchor `b`'s `bSide` to `a`'s `aSide` with optional gap.
 *
 *    attach(panel, sidebar, "right", "left", { gap: 8 })
 *      // sidebar.left = panel.right + 8
 *
 *  Bidirectional: drag a → b follows; drag b → a follows. */
export function attach(
  a: Box,
  b: Box,
  aSide: Side,
  bSide: Side,
  opts: { gap?: ValOrSig } = {},
): Propagator[] {
  const gapDeps = readDeps(opts.gap ?? 0);
  const gap = (): number => readNow(opts.gap ?? 0);

  const sideValue = (box: Box, side: Side): number => {
    switch (side) {
      case "left":
        return box.x.value;
      case "right":
        return box.x.value + box.w.value;
      case "top":
        return box.y.value;
      case "bottom":
        return box.y.value + box.h.value;
    }
  };
  const writeSide = (box: Box, side: Side, v: number): void => {
    switch (side) {
      case "left":
        asW(box.x).value = v;
        break;
      case "right":
        asW(box.x).value = v - box.w.value;
        break;
      case "top":
        asW(box.y).value = v;
        break;
      case "bottom":
        asW(box.y).value = v - box.h.value;
        break;
    }
  };

  return [
    propagator([a.x, a.y, a.w, a.h, b.w, b.h, ...gapDeps], [asW(b.x), asW(b.y)], () =>
      writeSide(b, bSide, sideValue(a, aSide) + gap()),
    ),
    propagator([b.x, b.y, b.w, b.h, a.w, a.h, ...gapDeps], [asW(a.x), asW(a.y)], () =>
      writeSide(a, aSide, sideValue(b, bSide) - gap()),
    ),
  ];
}

/** Center `inner` inside `outer`. `inner.w/h` are preserved.
 *  Bidirectional: drag outer → inner re-centers; drag inner → outer
 *  shifts to keep inner centered. */
export function centerInside(outer: Box, inner: Box): Propagator[] {
  return [
    propagator(
      [outer.x, outer.y, outer.w, outer.h, inner.w, inner.h],
      [asW(inner.x), asW(inner.y)],
      () => {
        asW(inner.x).value = outer.x.value + (outer.w.value - inner.w.value) / 2;
        asW(inner.y).value = outer.y.value + (outer.h.value - inner.h.value) / 2;
      },
    ),
    propagator([inner.x, inner.y], [asW(outer.x), asW(outer.y)], () => {
      const targetX = inner.x.value - (outer.w.value - inner.w.value) / 2;
      const targetY = inner.y.value - (outer.h.value - inner.h.value) / 2;
      if (Math.abs(targetX - outer.x.value) > 1e-9) asW(outer.x).value = targetX;
      if (Math.abs(targetY - outer.y.value) > 1e-9) asW(outer.y).value = targetY;
    }),
  ];
}

/** Pin one edge of a box to a fixed coordinate. The OPPOSITE edge
 *  stays put; size adjusts. */
export function pinEdge(b: Box, side: Side, target: ValOrSig): Propagator {
  const targetDeps = readDeps(target);
  const t = () => readNow(target);
  return propagator(
    [b.x, b.y, b.w, b.h, ...targetDeps],
    [asW(b.x), asW(b.y), asW(b.w), asW(b.h)],
    () => {
      const tv = t();
      switch (side) {
        case "left": {
          const right = b.x.value + b.w.value;
          asW(b.x).value = tv;
          asW(b.w).value = right - tv;
          break;
        }
        case "right":
          asW(b.w).value = tv - b.x.value;
          break;
        case "top": {
          const bot = b.y.value + b.h.value;
          asW(b.y).value = tv;
          asW(b.h).value = bot - tv;
          break;
        }
        case "bottom":
          asW(b.h).value = tv - b.y.value;
          break;
      }
    },
  );
}

/** Lock a box's width or height to a fixed value (or signal). */
export function lockSize(b: Box, axis: "w" | "h", target: ValOrSig): Propagator {
  const deps = readDeps(target);
  const cell = axis === "w" ? asW(b.w) : asW(b.h);
  return propagator([cell, ...deps], [cell], () => {
    const v = readNow(target);
    if (cell.value !== v) cell.value = v;
  });
}

/** One-way mirror: `follower` tracks `leader` exactly. */
export function follow(leader: Box, follower: Box): Propagator {
  return propagator(
    [leader.x, leader.y, leader.w, leader.h],
    [asW(follower.x), asW(follower.y), asW(follower.w), asW(follower.h)],
    () => {
      asW(follower.x).value = leader.x.value;
      asW(follower.y).value = leader.y.value;
      asW(follower.w).value = leader.w.value;
      asW(follower.h).value = leader.h.value;
    },
  );
}
