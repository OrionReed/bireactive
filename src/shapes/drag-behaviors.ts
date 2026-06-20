// drag-behaviors.ts — Dragology-style drag *modifiers* layered over the
// scene graph. The model-driven cores (`closest`, `between`, `whenFar`)
// live in `core/lenses/snap.ts`; these wire them to pointer input and the
// animation clock.
//
// The key idea, and the answer to "drag-and-drop complicates state": the
// floating offset and the spring-settle are TRANSIENT drag state, held in
// the animator, never written to the model. The model only ever sees the
// committed drop.

import { type Animator, type SpringOpts, spring } from "@bireactive/animation";
import { type Cell, cell, type Read, type Vec, vec, type Writable } from "@bireactive/core";
import { drag } from "./interaction";
import type { AnyShape } from "./shape";

export interface FloatingResult {
  /** True between pointerdown and release. Drive ghosting/elevation off this. */
  dragging: Cell<boolean>;
  /** Start this on the diagram's `Anim` (`this.anim.start(anim)`). */
  anim: Animator<void>;
  dispose: () => void;
}

export interface FloatingOpts extends SpringOpts<{ x: number; y: number }> {}

/** Dragology's `withFloating`: while held, `pos` follows the pointer
 *  directly (via the robust `drag` wiring — grab offset, touch, capture);
 *  on release it springs to `home` (the resolved target, e.g. a `closest`
 *  snap position or a layout slot). `pos` is the caller-owned display cell
 *  the shape renders from.
 *
 *      const pos = vec(home.peek());
 *      const dot = s(circle(pos, 10));
 *      const { anim } = floating(dot, pos, home);
 *      this.anim.start(anim);
 *
 *  While dragging, the settle spring is frozen (rate 0) so it never fights
 *  the pointer; on release it re-engages and eases `pos` home. */
export function floating(
  shape: AnyShape,
  pos: Writable<Vec>,
  home: Read<{ x: number; y: number }>,
  opts: FloatingOpts = {},
): FloatingResult {
  const dragging = cell(false);
  const dispose = drag(shape, pos, dragging);
  const anim = spring(pos, home, {
    omega: opts.omega ?? 24,
    zeta: opts.zeta ?? 0.9,
    ...opts,
    // Never completes (re-engages every release) and yields to the pointer
    // while held.
    precision: 0,
    rate: () => (dragging.value ? 0 : (opts.rate?.() ?? 1)),
  });
  return { dragging, anim, dispose };
}

/** Sugar: create the display cell, float the shape, and return both. The
 *  shape must already be bound to the returned `pos`. */
export function floatingAt(
  make: (pos: Writable<Vec>) => AnyShape,
  home: Read<{ x: number; y: number }>,
  opts: FloatingOpts = {},
): { pos: Writable<Vec>; shape: AnyShape } & FloatingResult {
  const p = home.peek();
  const pos = vec(p.x, p.y);
  const shape = make(pos);
  return { pos, shape, ...floating(shape, pos, home, opts) };
}
