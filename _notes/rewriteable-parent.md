# Rewriteable backward parent (deferred)

A short design note on making a lens's *backward target set* dynamic.
Companion to the lens-as-cell work (`md-lens-algebra`). The capability is
**deliberately deferred** — this records why, what it would unlock, and
the smallest change that buys it, so a later prototype starts warm.

## The asymmetry

The engine's two directions are tracked differently (`core/cell.ts`
header, "Core asymmetry"):

- **Forward deps are implicit.** A lens getter reads `.value` under
  `activeSub`, so the forward graph re-tracks on every recompute. Reading
  a lens-valued cell inside a getter already reconfigures the forward
  edge with no special support.
- **Backward targets are explicit and fixed.** `_bwd.parent` is set once
  at construction (`buildLens1` / `buildLensN`) and read as a plain field
  in `propagateBwd` / `propagateSplit`. The backward graph is static.

So "a lens is a cell" splits into three tiers by how much of the lens is
allowed to vary:

1. **Reactive parameters** — the frame's *coefficients* are cells read in
   the closures (`clamp(lo, hi)`, unit `scaled`, `affine`). Parent set
   fixed. Works today, used everywhere.
2. **Reactive structure over a fixed parent** — the *transform function*
   is a cell; `put` dispatches on its current value. Parent set still
   fixed. Works today — this is what `md-lens-algebra` exercises
   (`through(src, frameCell)`; forward auto-tracks the frame, backward
   inverts `frame.peek()`).
3. **Reactive parent structure** — a write must land in a *different
   source* depending on a selector (a `switch` / `flatMap` / router; the
   writable side of a sum type). Forward already follows whichever branch
   it reads; backward dead-ends because `_bwd.parent` is frozen. **This is
   the deferred tier.**

## What tier 3 unlocks

- **Bidirectional `switch` / routing.** Writes to a view route to the
  live branch; flipping the selector re-points the backward edge. The
  discrete dual of `crossfade` (which blends) — write-back follows the
  active branch instead of splitting by weight.
- **Prism as a first-class optic.** A Prism over a sum type *is* this
  router: `match(tag, { left: …, right: … })` is exactly "resolve the
  backward parent from the current tag". Tier 3 and Prism are one piece
  of work, not two. (Today `md-route-params` fakes the partial/refuse
  case by hand; a real Prism would carry the unmatched branch in the
  complement.)
- **Dynamic graph shape generally** — a lens whose source identity is
  data-dependent (pick-an-element, choose-an-input).

## The smallest change

Let `_bwd.parent` optionally be a *thunk* resolved at write time, instead
of a pinned field. In `propagateBwd`:

```ts
// today:        const parent = cb.parent;
// proposed:     const parent =
//   typeof cb.parent === "function" ? cb.parent() : cb.parent;
```

Mirror it in `propagateSplit` (the multi-parent case). The thunk reads
the selector via `peek()` so resolution stays untracked, matching how the
forward side already re-resolves under `activeSub`. `BwdSpec.parent`
widens from `Cell | Cell[]` to `Cell | Cell[] | (() => Cell | Cell[])`.

## Open questions (for the prototype, not now)

- **No-op stop & equality.** `propagateBwd`'s concrete no-op check reads
  `settled(parent)`; with a dynamic parent the "previous" parent may
  differ from the "current" one. Does the stop condition stay sound, or
  does switching branches need an explicit invalidation?
- **Subscription churn.** Forward auto-tracking already adds/drops the
  selector dep. The backward side has no subscription (it's resolved on
  demand), so there's nothing to unsubscribe — but a branch that's
  written while *not* selected should be a no-op, not a silent write to
  the wrong source. Define the off-branch write semantics.
- **Complement ownership across a switch.** A stateful lens whose parent
  set changes: does the complement reset on switch, or persist per
  branch? Per-branch complements imply a map keyed by selector value.
- **Fusion / introspection.** `transitiveDeps` and any backward-graph
  walker assume a static parent; they'd need to peek the thunk (or treat
  a dynamic-parent lens as an opaque boundary).

## Why defer

Tiers 1–2 already cover the compelling lens-as-cell demos (reconfigurable
pipelines, lens-valued blends) with **zero engine change** — they ride the
existing forward auto-tracking and a `peek()` in `put`. Tier 3's value is
real but concentrated in routing / Prism, which deserve their own design
pass (the open questions above are load-bearing). The change itself is
tiny; the semantics around it are not. Land the optic taxonomy (Iso /
Lens / Prism / Traversal) and the switch semantics together, rather than
bolting a dynamic parent onto an untyped lens.
