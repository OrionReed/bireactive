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
import {
  type Cell,
  cell,
  derive,
  effect,
  type Inner,
  type Read,
  Vec,
  vec,
  type Writable,
} from "@bireactive/core";
import type { Drag } from "./drag-spec";
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

// ── drag lifecycle ──────────────────────────────────────────────────
// The `was`-flag edge and z-raise every demo hand-rolls, factored out, plus a
// model-driven driver that ties a `Drag<M>` spec (drag-spec.ts) to the
// grab→preview→commit lifecycle — the spec is built once per grab (like
// Dragology's `dragologyOnDrag`), so candidate states are enumerated then.

/** Run `grab`/`drop` on the rising/falling edge of `active`. */
export function onGesture(
  active: Read<boolean>,
  edges: { grab?: () => void; drop?: () => void },
): () => void {
  let was = false;
  return effect(() => {
    const now = active.value;
    if (now && !was) edges.grab?.();
    else if (!now && was) edges.drop?.();
    was = now;
  });
}

/** Re-append shapes to raise them above siblings (z-order). */
export function raise(...shapes: readonly AnyShape[]): void {
  for (const s of shapes) s.el.parentElement?.appendChild(s.el);
}

export interface DragModel<M, Id> {
  /** Which element is being dragged (null when idle). */
  active: Cell<Id | null>;
  /** The free pointer for the active drag (bound by `grip`). */
  pointer: Writable<Vec>;
  /** Previewed model while dragging, else the committed model. */
  preview: Read<M>;
  /** Where the dragged handle sits this frame (float the dragged element here). */
  at: Vec;
  /** Wire a handle: seed + claim on press, commit `drop` on release. */
  grip(handle: AnyShape, id: Id, seed: () => Inner<Vec>, onGrab?: () => void): () => void;
}

/** Bind a committed `model` cell to a `Drag<M>` spec built at grab time. Owns
 *  the transient drag state (which element, the free pointer, the live preview)
 *  and commits the spec's drop on release — the demo only renders `preview`/`at`. */
export function dragModel<M, Id>(
  model: Writable<Cell<M>>,
  spec: (id: Id, pointer: Read<Inner<Vec>>) => Drag<M>,
): DragModel<M, Id> {
  const active = cell<Id | null>(null);
  const pointer = vec(0, 0);
  const live = cell<Drag<M> | null>(null);
  const preview = derive(() => {
    const s = live.value;
    return s ? s.preview.value : model.value;
  });
  const at = Vec.derive(() => {
    const s = live.value;
    return s ? s.at.value : pointer.value;
  });
  const grip = (
    handle: AnyShape,
    id: Id,
    seed: () => Inner<Vec>,
    onGrab?: () => void,
  ): (() => void) => {
    const dragging = cell(false);
    const offDown = handle.on("pointerdown", () => {
      pointer.value = seed();
      active.value = id;
      live.value = spec(id, pointer);
      onGrab?.();
    });
    const offDrag = drag(handle, pointer, dragging);
    const offEdge = onGesture(dragging, {
      drop: () => {
        const s = live.peek();
        if (s) model.value = s.drop.peek();
        active.value = null;
        live.value = null;
      },
    });
    return () => {
      offDown();
      offDrag();
      offEdge();
    };
  };
  return { active, pointer, preview, at, grip };
}
