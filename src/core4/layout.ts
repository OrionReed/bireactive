// layout.ts — rigid layout combinators, the vezwork "layout with propagation"
// port. Each box is four scalar cells (top-left + size); combinators install
// bidirectional propagators between them. Because every edge is bidirectional
// and equality-gated, you can drag ANY participating box and the rest follow
// rigidly — the relaxation settles in one pass for a consistent arrangement.
//
// These are intentionally the *fixed* structural relations (adjacency,
// alignment). They demonstrate the spine; a full combinator library (flex,
// grids, centring) layers on the same `propagator` primitive.

import { type Cell, cell, type Derive, derive, propagator } from "./engine";

export interface Box {
  x: Cell<number>;
  y: Cell<number>;
  w: Cell<number>;
  h: Cell<number>;
}

export function box(x = 0, y = 0, w = 0, h = 0): Box {
  return { x: cell(x), y: cell(y), w: cell(w), h: cell(h) };
}

/** Keep two scalar cells in agreement under a fixed offset: `hi = lo + k`.
 *  Bidirectional and equality-gated, so dragging either end moves the other. */
function offset(lo: Cell<number>, hi: Cell<number>, k: () => number): void {
  propagator([lo as Cell<unknown>], () => hi.set(lo.peek() + k()));
  propagator([hi as Cell<unknown>], () => lo.set(hi.peek() - k()));
}

/** Place `b` immediately to the right of `a` with `gap`, tops aligned.
 *  Drag a → b follows; drag b → a follows. */
export function beside(a: Box, b: Box, gap = 0): void {
  // Horizontal adjacency: b.x = a.x + a.w + gap (offset depends on a.w too).
  propagator([a.x as Cell<unknown>, a.w as Cell<unknown>], () =>
    b.x.set(a.x.peek() + a.w.peek() + gap),
  );
  propagator([b.x as Cell<unknown>, a.w as Cell<unknown>], () =>
    a.x.set(b.x.peek() - a.w.peek() - gap),
  );
  // Vertical alignment: tops equal.
  offset(a.y, b.y, () => 0);
}

/** Stack `b` immediately below `a` with `gap`, left edges aligned.
 *  Drag a → b follows; drag b → a follows. */
export function above(a: Box, b: Box, gap = 0): void {
  propagator([a.y as Cell<unknown>, a.h as Cell<unknown>], () =>
    b.y.set(a.y.peek() + a.h.peek() + gap),
  );
  propagator([b.y as Cell<unknown>, a.h as Cell<unknown>], () =>
    a.y.set(b.y.peek() - a.h.peek() - gap),
  );
  offset(a.x, b.x, () => 0);
}

/** Read-only enclosing box of `boxes` (for rendering / measurement). */
export function bounds(...boxes: Box[]): {
  x: Derive<number>;
  y: Derive<number>;
  w: Derive<number>;
  h: Derive<number>;
} {
  const minX = derive(() => Math.min(...boxes.map(b => b.x.get())));
  const minY = derive(() => Math.min(...boxes.map(b => b.y.get())));
  const maxX = derive(() => Math.max(...boxes.map(b => b.x.get() + b.w.get())));
  const maxY = derive(() => Math.max(...boxes.map(b => b.y.get() + b.h.get())));
  return {
    x: minX,
    y: minY,
    w: derive(() => maxX.get() - minX.get()),
    h: derive(() => maxY.get() - minY.get()),
  };
}
