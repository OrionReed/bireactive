// Spatial composition primitives.

import {
  Box,
  boxExpand,
  derive,
  type Read,
  reader,
  transformBox,
  type Val,
} from "@bireactive/core";
import type { Shape } from "./shape";

export interface ArrangeOpts {
  /** Spacing between adjacent bounding boxes. Default 0. */
  gap?: number;
  /** Cross-axis align vs the first shape: 0 top/left, 0.5 center,
   *  1 bottom/right. Default 0. */
  align?: number;
}

/** Lay out `shapes` in a row/column. First stays put; the rest bind
 *  their `translate` reactively to sit `gap` past the previous.
 *  Reflows on size or anchor change. */
export function arrange(
  shapes: readonly Shape[],
  axis: "row" | "column",
  opts: ArrangeOpts = {},
): void {
  const gap = opts.gap ?? 0;
  const cross = opts.align ?? 0;
  if (shapes.length < 2) return;
  const anchor = shapes[0];
  for (let i = 1; i < shapes.length; i++) {
    const prev = shapes[i - 1];
    const cur = shapes[i];
    cur.effect(() => {
      // prev/anchor in the parent frame so upstream transforms
      // cascade; cur stays local since we're writing its own translate.
      const pBox = transformBox(prev.localFrame.value, prev.box.value);
      const aBox = transformBox(anchor.localFrame.value, anchor.box.value);
      const cb = cur.box.value;
      if (axis === "row") {
        const targetX = pBox.x + pBox.w + gap;
        const targetY = aBox.y + cross * aBox.h - cross * cb.h;
        cur.translate.value = {
          x: targetX - cb.x,
          y: targetY - cb.y,
        };
      } else {
        const targetY = pBox.y + pBox.h + gap;
        const targetX = aBox.x + cross * aBox.w - cross * cb.w;
        cur.translate.value = {
          x: targetX - cb.x,
          y: targetY - cb.y,
        };
      }
    });
  }
}

/** Inflate a Box on each side by `by`. */
export function expand(b: Box, by: Val<number>): Box {
  const byFn = reader(by);
  return Box.derive(() => boxExpand(b.value, byFn()));
}

/** Split a Box along an axis into N reactive sub-Boxes.
 *
 *   split(b, "x", 3)              — 3 equal columns
 *   split(b, "x", [3, 2, 2])      — weighted 3:2:2
 *   split(b, "x", 3, { gap: 4 })  — 4px between
 */
export function split(
  source: Box,
  axis: "x" | "y",
  parts: number | number[],
  opts: { gap?: Val<number> } = {},
): Box[] {
  const ratios = typeof parts === "number" ? new Array(parts).fill(1) : parts;
  const total = ratios.reduce((a, b) => a + b, 0);
  const cumBefore = ratios.map((_, i) => ratios.slice(0, i).reduce((a, b) => a + b, 0));
  const gapFn = reader(opts.gap ?? 0);
  return ratios.map((r, i) =>
    Box.derive(() => {
      const b = source.value;
      const gap = gapFn();
      const gapTotal = gap * (ratios.length - 1);
      if (axis === "x") {
        const free = b.w - gapTotal;
        const offset = (cumBefore[i] / total) * free + gap * i;
        return { x: b.x + offset, y: b.y, w: (r / total) * free, h: b.h };
      }
      const free = b.h - gapTotal;
      const offset = (cumBefore[i] / total) * free + gap * i;
      return { x: b.x, y: b.y + offset, w: b.w, h: (r / total) * free };
    }),
  );
}

/** Two-axis split into a `rows × cols` grid (sugar over `split`).
 *  Returns `[row][col]`. */
export function grid(
  source: Box,
  rows: number,
  cols: number,
  opts: { gap?: Val<number> } = {},
): Box[][] {
  return split(source, "y", rows, opts).map(row => split(row, "x", cols, opts));
}

export interface TreeStackBox {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface TreeStackOpts<Id> {
  /** Top-level node ids, in order (read inside a derive; cell reads track). */
  roots: () => readonly Id[];
  /** A container's children, in order (read inside a derive). */
  kids: (id: Id) => readonly Id[];
  /** Containers stack their `kids`; non-containers are sized by `leaf`. */
  container: (id: Id) => boolean;
  /** Intrinsic size of a non-container node. */
  leaf: (id: Id) => { w: number; h: number };
  /** Top-left of a root node. */
  origin: (id: Id) => { x: number; y: number };
  /** Space reserved above a container's children (a title bar). Default 0. */
  header?: number;
  /** Inset around a container's children. Default 0. */
  pad?: number;
  /** Space between adjacent children. Default 0. */
  gap?: number;
  /** Minimum container width. Default 0. */
  minWidth?: number;
  /** Height of an empty container. Default `header + 2·pad`. */
  emptyHeight?: number;
}

export interface TreeStack<Id> {
  /** Reactive placement of every reachable node. */
  readonly boxes: Read<Map<Id, TreeStackBox>>;
  /** A node's box as a reactive `Box` (zero box when absent). */
  box(id: Id): Box;
}

/** Intrinsic ("hug-contents") layout of a tree as nested vertical stacks:
 *  each container's size is the bottom-up sum of its children, each child is
 *  placed top-down from its container. Unlike `row`/`col` (which fit items
 *  into a fixed container), the containers grow to fit. Pure function of the
 *  inputs, so feeding it a *previewed* tree yields a previewed layout. */
export function treeStack<Id>(opts: TreeStackOpts<Id>): TreeStack<Id> {
  const header = opts.header ?? 0;
  const pad = opts.pad ?? 0;
  const gap = opts.gap ?? 0;
  const minW = opts.minWidth ?? 0;
  const emptyH = opts.emptyHeight ?? header + 2 * pad;

  const measure = (id: Id): { w: number; h: number } => {
    if (!opts.container(id)) return opts.leaf(id);
    const ks = opts.kids(id);
    if (ks.length === 0) return { w: minW, h: emptyH };
    let maxw = 0;
    let h = header + pad;
    for (const c of ks) {
      const m = measure(c);
      maxw = Math.max(maxw, m.w);
      h += m.h + gap;
    }
    return { w: Math.max(minW, maxw + 2 * pad), h: h + pad - gap };
  };
  const place = (id: Id, x: number, y: number, out: Map<Id, TreeStackBox>): void => {
    const m = measure(id);
    out.set(id, { x, y, w: m.w, h: m.h });
    if (opts.container(id)) {
      let cy = y + header + pad;
      for (const c of opts.kids(id)) {
        place(c, x + pad, cy, out);
        cy += measure(c).h + gap;
      }
    }
  };

  const boxes = derive(() => {
    const out = new Map<Id, TreeStackBox>();
    for (const r of opts.roots()) {
      const o = opts.origin(r);
      place(r, o.x, o.y, out);
    }
    return out;
  });

  const cache = new Map<Id, Box>();
  return {
    boxes,
    box(id: Id): Box {
      let b = cache.get(id);
      if (!b) {
        b = Box.derive(() => boxes.value.get(id) ?? { x: 0, y: 0, w: 0, h: 0 });
        cache.set(id, b);
      }
      return b;
    },
  };
}
