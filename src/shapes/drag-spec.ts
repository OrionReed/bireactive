// drag-spec.ts — the general drag algebra (Dragology's `d.` DSL), model-driven.
//
// Dragology's closed object isn't "snap"; it's a behavior
//
//     DragBehavior = (pointer) → { preview, dropState, gap }
//
// — the whole previewed MODEL this frame, the model to commit on release, and
// the residual the combinators arbitrate on. Snapping is one primitive of it.
//
// Reactive form: the result is cells already tracking a shared pointer, so
// nothing recomputes per frame by hand. And the deep bit — "drawing knows
// state→drawing, computing knows drawing→state" (a lens) — is FREE here:
// Dragology synthesizes drawing→state by speculative rendering (render every
// candidate, extract positions; quadratic), whereas bireactive already has it
// as the backward lens, so `vary` is a lens write and `preview` is a reactive
// previewed model (springs interpolate it — no view-diffing, no re-render).
//
// Exposed as `d` to mirror the paper. It builds on core's pointer math
// (`hullWeights` for `between`, `nearestIndex`'s sticky selection mirrored in
// `closest`). Renderer contract: render non-dragged elements from `preview`,
// the dragged one at `at`, and commit `drop` on release.

import { derive, hullWeights, type Read } from "@bireactive/core";

type V = { x: number; y: number };
const dist = (a: V, b: V) => Math.hypot(a.x - b.x, a.y - b.y);

/** A drag behavior: Dragology's `DragBehavior`, reactive and parametric in the
 *  MODEL `M` (positions are just `M = Vec`). */
export interface Drag<M> {
  /** Model rendered this frame (non-dragged elements reflow toward this). */
  preview: Read<M>;
  /** Model committed on release. */
  drop: Read<M>;
  /** Where the dragged handle sits this frame (the renderer floats it here). */
  at: Read<V>;
  /** Residual |pointer − achievable|; combinators arbitrate on this. */
  gap: Read<number>;
}

/** `d.fixed`: a single reachable model; `locate` reads where the dragged handle
 *  lands in it (a layout cell, or a pure layout fn). */
function fixed<M>(pointer: Read<V>, state: M, locate: (m: M) => V): Drag<M> {
  const s = derive(() => state);
  const at = derive(() => locate(state));
  return { preview: s, drop: s, at, gap: derive(() => dist(pointer.value, at.value)) };
}

/** `d.vary`: a continuous family; `place` is the BACKWARD map pointer→model (a
 *  lens / `argminVec`, not numerical search), `gap` the residual off the family. */
function vary<M>(pointer: Read<V>, place: (p: V) => M, locate: (m: M) => V): Drag<M> {
  const preview = derive(() => place(pointer.value));
  const at = derive(() => locate(preview.value));
  return { preview, drop: preview, at, gap: derive(() => dist(pointer.value, at.value)) };
}

/** `d.closest`: the behavior with the smallest `gap` (discrete snapping and
 *  continuous tracks both pick with it). */
function closest<M>(bs: readonly Drag<M>[]): Drag<M> {
  const idx = derive(() => {
    let best = 0;
    let bg = Number.POSITIVE_INFINITY;
    for (let i = 0; i < bs.length; i++) {
      const g = bs[i]!.gap.value;
      if (g < bg) {
        bg = g;
        best = i;
      }
    }
    return best;
  });
  return {
    preview: derive(() => bs[idx.value]!.preview.value),
    drop: derive(() => bs[idx.value]!.drop.value),
    at: derive(() => bs[idx.value]!.at.value),
    gap: derive(() => bs[idx.value]!.gap.value),
  };
}

/** `d.between`: free motion in the candidates' convex hull; preview is their
 *  barycentric blend (`mix` any `Lerp`/`Linear` model). Unlike `closest` it does
 *  NOT snap — it rests at the blend, so `drop` is the previewed mix. */
function between<M>(
  pointer: Read<V>,
  bs: readonly Drag<M>[],
  mix: (ms: readonly M[], ws: readonly number[]) => M,
): Drag<M> {
  const ws = derive(() =>
    hullWeights(
      pointer.value,
      bs.map(b => b.at.value),
    ),
  );
  const at = derive(() => {
    const w = ws.value;
    let x = 0;
    let y = 0;
    bs.forEach((b, i) => {
      const a = b.at.value;
      x += w[i]! * a.x;
      y += w[i]! * a.y;
    });
    return { x, y };
  });
  const blend = derive(() =>
    mix(
      bs.map(b => b.preview.value),
      ws.value,
    ),
  );
  return { preview: blend, drop: blend, at, gap: derive(() => dist(pointer.value, at.value)) };
}

/** `d.whenFar`: use `near` unless its gap exceeds `radius`, then `far` (snap
 *  into a port, else float free). */
function whenFar<M>(near: Drag<M>, far: Drag<M>, radius: number): Drag<M> {
  const pickFar = derive(() => near.gap.value > radius);
  const sel = <T>(f: (b: Drag<M>) => Read<T>) => derive(() => f(pickFar.value ? far : near).value);
  return {
    preview: sel(b => b.preview),
    drop: sel(b => b.drop),
    at: sel(b => b.at),
    gap: sel(b => b.gap),
  };
}

/** `d.withFloating`: the dragged handle follows the pointer while the rest
 *  reflow (they already do — `preview` is reactive); just an `at` override. */
function withFloating<M>(pointer: Read<V>, b: Drag<M>): Drag<M> {
  return { preview: b.preview, drop: b.drop, gap: b.gap, at: pointer };
}

/** `d.onDrop`: transform the committed model (create/destroy, snap-to-grid),
 *  the escape hatch beyond repositional drags. */
function onDrop<M>(b: Drag<M>, f: (m: M) => M): Drag<M> {
  return { preview: b.preview, at: b.at, gap: b.gap, drop: derive(() => f(b.drop.value)) };
}

/** The drag-behavior DSL (Dragology's `d.`): primitives `fixed`/`vary`,
 *  combinators `closest`/`between`/`whenFar`, modifiers `withFloating`/`onDrop`.
 *  Build a `Drag<M>` once at grab; the renderer reads `preview`/`at`/`drop`. */
export const d = {
  fixed,
  vary,
  closest,
  between,
  whenFar,
  withFloating,
  onDrop,
} as const;
