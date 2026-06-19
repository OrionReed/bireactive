// flex.ts — flexbox as interval propagation.
//
// A flex line is two phases, both grounded in the interval lattice:
//
//   1. FEASIBILITY (narrowing). Given the container's content size and
//      each item's [min, max], the `total` relation narrows every item
//      to the band it could occupy: `wᵢ ∈ content − Σ(others)`. If any
//      band comes back empty the line can't fit — that's a real lattice
//      contradiction, reported, not a silent overflow.
//
//   2. RESOLUTION (point pick). Within the feasible bands, grow/shrink
//      weights distribute the slack to a single size per item. This is
//      the one place a *preference* (not a constraint) enters, so it's
//      kept out of the narrowing.
//
// The line operates on plain `Box` cells — zero ceremony, nothing is
// coloured. Nesting composes through the ordinary reactive graph: a
// child container is just an item of its parent, so resizing the root
// re-runs each line top-down. `row`/`col` are the only public surface;
// everything else is the two phases above.

import {
  type Box,
  isCell,
  type Num as NumClass,
  type Read,
  readNow,
  type Writable,
} from "@bireactive/core";
import { interval } from "./lattice";
import { type Propagator, propagator } from "./solver";

type Num = NumClass;
const asW = (n: Num): Writable<Num> => n as unknown as Writable<Num>;
type ValOrSig = number | Read<number>;

function readDeps(...vs: ValOrSig[]): Num[] {
  return vs.filter(isCell) as Num[];
}

const clamp = (v: number, lo: number, hi: number): number => Math.min(Math.max(v, lo), hi);

/** A flex child. A bare `Box` takes defaults (grow 1, shrink 1, no
 *  bounds); tag it to set per-item flex. `basis` seeds the size the
 *  distribution grows/shrinks from (defaults to the box's current main
 *  size). */
export type Item =
  | Box
  | {
      box: Box;
      grow?: number;
      shrink?: number;
      min?: number;
      max?: number;
      basis?: number;
    };

interface Spec {
  box: Box;
  grow: number;
  shrink: number;
  min: number;
  max: number;
  basis?: number;
}

function specs(items: readonly Item[]): Spec[] {
  return items.map(it =>
    "box" in it
      ? {
          box: it.box,
          grow: it.grow ?? 1,
          shrink: it.shrink ?? 1,
          min: it.min ?? 0,
          max: it.max ?? Number.POSITIVE_INFINITY,
          basis: it.basis,
        }
      : { box: it, grow: 1, shrink: 1, min: 0, max: Number.POSITIVE_INFINITY },
  );
}

export interface FlexOpts {
  /** Space between adjacent items. Default 0. */
  gap?: ValOrSig;
  /** Padding inside the container on every side. Default 0. */
  padding?: ValOrSig;
  /** Cross-axis placement. Default "stretch". */
  align?: "start" | "center" | "end" | "stretch";
  /** Set to `true` on the frame(s) where the content can't fit (Σmin >
   *  content). Drives "this layout is impossible" UI. */
  report?: Writable<NumClass> | ((infeasible: boolean) => void);
}

/** Horizontal flex line over plain `Box` cells. */
export function row(c: Box, items: readonly Item[], opts: FlexOpts = {}): Propagator {
  return line(c, items, opts, "x");
}

/** Vertical flex line over plain `Box` cells. */
export function col(c: Box, items: readonly Item[], opts: FlexOpts = {}): Propagator {
  return line(c, items, opts, "y");
}

function line(c: Box, rawItems: readonly Item[], opts: FlexOpts, main: "x" | "y"): Propagator {
  const items = specs(rawItems);
  const horizontal = main === "x";
  const mainPos = (b: Box) => asW(horizontal ? b.x : b.y);
  const mainSize = (b: Box) => asW(horizontal ? b.w : b.h);
  const crossPos = (b: Box) => asW(horizontal ? b.y : b.x);
  const crossSize = (b: Box) => asW(horizontal ? b.h : b.w);
  const align = opts.align ?? "stretch";

  const reads: Num[] = [
    mainPos(c),
    mainSize(c),
    crossPos(c),
    crossSize(c),
    ...items.map(it => crossSize(it.box)),
    ...readDeps(opts.gap ?? 0, opts.padding ?? 0),
  ];
  const writes: Writable<Num>[] = [];
  for (const it of items) {
    writes.push(mainPos(it.box), mainSize(it.box), crossPos(it.box));
    if (align === "stretch") writes.push(crossSize(it.box));
  }
  if (typeof opts.report !== "function" && opts.report) writes.push(opts.report);

  return propagator(reads, writes, () => {
    const gap = readNow(opts.gap ?? 0);
    const pad = readNow(opts.padding ?? 0);
    const n = items.length;
    if (n === 0) return;

    const content = mainSize(c).value - 2 * pad - (n - 1) * gap;
    const mins = items.map(it => it.min);
    const maxs = items.map(it => it.max);
    const sumMin = mins.reduce((a, b) => a + b, 0);
    const sumMax = maxs.reduce((a, b) => a + b, 0);

    // Phase 1 — feasibility. Per-item band from the `total` relation:
    //   wᵢ ∈ [content − Σmax(others), content − Σmin(others)] ∩ [minᵢ, maxᵢ].
    const bands = items.map((_, i) => {
      const lo = content - (sumMax - maxs[i]!);
      const hi = content - (sumMin - mins[i]!);
      return interval.meet([Math.max(lo, mins[i]!), Math.min(hi, maxs[i]!)], [mins[i]!, maxs[i]!]);
    });
    const infeasible = content < sumMin - 1e-9 || bands.some(interval.isBottom);
    report(opts, infeasible);

    // Phase 2 — resolution. Distribute slack from the basis sizes,
    // weighted by grow (free > 0) / shrink (free < 0), clamped into the
    // feasible band each pass and redistributed.
    const base = items.map((it, i) =>
      clamp(it.basis ?? mainSize(it.box).value, mins[i]!, maxs[i]!),
    );
    const sizes = distribute(base, items, mins, maxs, content);

    let cursor = mainPos(c).value + pad;
    for (let i = 0; i < n; i++) {
      mainPos(items[i]!.box).value = cursor;
      mainSize(items[i]!.box).value = sizes[i]!;
      cursor += sizes[i]! + gap;
    }

    const cBase = crossPos(c).value + pad;
    const cAvail = crossSize(c).value - 2 * pad;
    for (const it of items) {
      const itSize = crossSize(it.box).value;
      switch (align) {
        case "start":
          crossPos(it.box).value = cBase;
          break;
        case "center":
          crossPos(it.box).value = cBase + (cAvail - itSize) / 2;
          break;
        case "end":
          crossPos(it.box).value = cBase + cAvail - itSize;
          break;
        case "stretch":
          crossPos(it.box).value = cBase;
          crossSize(it.box).value = cAvail;
          break;
      }
    }
  });
}

/** CSS-flex slack distribution, clamped into [min, max] with overflow
 *  redistributed across still-eligible items. */
function distribute(
  base: number[],
  items: readonly Spec[],
  mins: readonly number[],
  maxs: readonly number[],
  content: number,
): number[] {
  const n = base.length;
  const sizes = base.slice();
  const free = content - base.reduce((a, b) => a + b, 0);

  if (free > 1e-9) {
    let remaining = free;
    const eligible = new Set<number>();
    for (let i = 0; i < n; i++) if (items[i]!.grow > 0 && sizes[i]! < maxs[i]!) eligible.add(i);
    while (remaining > 1e-9 && eligible.size > 0) {
      let weight = 0;
      for (const i of eligible) weight += items[i]!.grow;
      if (weight === 0) break;
      let absorbed = 0;
      for (const i of [...eligible]) {
        const next = Math.min(sizes[i]! + (remaining * items[i]!.grow) / weight, maxs[i]!);
        absorbed += next - sizes[i]!;
        sizes[i] = next;
        if (next >= maxs[i]!) eligible.delete(i);
      }
      if (absorbed < 1e-9) break;
      remaining -= absorbed;
    }
  } else if (free < -1e-9) {
    let remaining = -free;
    const eligible = new Set<number>();
    for (let i = 0; i < n; i++) if (items[i]!.shrink > 0 && sizes[i]! > mins[i]!) eligible.add(i);
    while (remaining > 1e-9 && eligible.size > 0) {
      let weight = 0;
      for (const i of eligible) weight += items[i]!.shrink;
      if (weight === 0) break;
      let absorbed = 0;
      for (const i of [...eligible]) {
        const next = Math.max(sizes[i]! - (remaining * items[i]!.shrink) / weight, mins[i]!);
        absorbed += sizes[i]! - next;
        sizes[i] = next;
        if (next <= mins[i]!) eligible.delete(i);
      }
      if (absorbed < 1e-9) break;
      remaining -= absorbed;
    }
  }
  return sizes;
}

function report(opts: FlexOpts, infeasible: boolean): void {
  if (typeof opts.report === "function") opts.report(infeasible);
  else if (opts.report) asW(opts.report as NumClass).value = infeasible ? 1 : 0;
}
