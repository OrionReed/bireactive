# `proto-microtask` — bireactive engine prototype (microtask-scheduled effects)

A parallel, isolated copy of the bireactive engine (`src/`) that replaces
**synchronous effect flushing** with **microtask-scheduled effects** — the
direction Solid 2.0 / alien-signals v2 are converging on — and uses that pivot
to delete a large chunk of the engine while keeping lens (bidirectional)
semantics exactly correct.

This folder is a self-contained experiment. It does not touch `src/`. The
goal is to validate the design, then decide whether to merge it back / merge it
with the other in-flight engine stream.

---

## Status

- **891 passing, 36 skipped, 0 failing** across 33 test files.
- `core/cell.ts`: **1501 lines** vs `src/core/cell.ts`'s 1769 (~15% leaner),
  *despite* adding the inverse-memo + microtask machinery.
- Lens laws (PutGet / GetPut / PutPut / lossy / soundness) all hold
  **synchronously**; the full forward correctness suite holds when every source
  write is routed through an identity write-through lens (the "lifted" suite).

## Running it

```bash
# tests (uses the prototype alias + include glob)
npx vitest --config vitest.proto.config.ts run proto-microtask/core/_test

# a single area
npx vitest --config vitest.proto.config.ts run proto-microtask/core/_test/microtask.test.ts

# benches (vite-node, prototype alias)
npx vite-node --config vite.proto.config.ts proto-microtask/core/_test/suite/bench/memo.run.ts
```

Both configs (`vitest.proto.config.ts`, `vite.proto.config.ts`) alias
`@bireactive` → this folder, so the engine's own internal imports
(`@bireactive/core`, …) resolve here, not to `src/`.

---

## The thesis (one idea, three consequences)

**Keystone:** terminal effects defer to a `queueMicrotask`. Everything else
follows.

1. **The value graph stays synchronous.** A write drains the backward queue to a
   fixpoint *before returning*, so `.value` read-back, lens commits, and lens
   laws are all synchronous exactly as before. Only the terminal *effects* (the
   observable side-effects) are deferred.
2. **`batch()` becomes unnecessary** and was deleted. A microtask already
   coalesces multiple synchronous writes into one effect run, suppresses
   net-zero reverts (via `checkDirty` at commit time), and is glitch-free —
   which is everything `batch()` bought.
3. **The backward write path unifies.** With no eager/deferred branching to
   juggle, all backward writes stage their value and drain through one path.

### Scheduling model

| layer | when it runs | API |
|---|---|---|
| value graph (sources, lenses, computeds) | **synchronous**, on write | `.value` get/set |
| effects (terminal sinks) | **microtask**, coalesced | `effect(fn)` |
| escape hatch | **synchronous drain** of pending effects | `settle()` |

`settle()` (exported from `core`) runs `flush()` then `runEffects()`
synchronously. It's the test/bench bridge for code that wants to observe effect
output without awaiting a tick. See `core/_test/microtask.test.ts` for the
*real* async path (via `await`) vs. the `settle()` equivalence.

---

## What changed vs `src/core`

**Removed**
- `batch()` — subsumed by microtask coalescing (deleted, not aliased).
- `network()` / `_NetworkNode` / `activeNetwork` — the reactive sub-DAG concept.
- `MergeNode` / `MergePolicy` / `DIRECT_SLOT` — backward aggregation node.
- the `deferred` parameter + eager/deferred branches throughout the backward
  path, and the `excluding` param on `propagate` (only `network()` used it).

**Added**
- **(A) inverse-memo.** A 1-slot memo on `BwdSpec` keyed on
  `(target, parentRead)` for source-reading 1→1 lenses. On a hit the `put`
  body is skipped entirely — ~300× on stable-target back-writes, free on
  changing-target ones. See `BwdSpec` + `propagateBwd` in `core/cell.ts`.
- **microtask plumbing** — `scheduleEffects()` / `runEffects()` / `settle()`,
  and a `try/finally` in `runEffects` so a throwing effect drops the skipped
  effects transactionally (doesn't get resumed by the next unrelated write).

Backward short-circuiting (the reason a clamped/quantized write that doesn't
move the projected value does NOT snap upstream observers) is preserved: lossy
lenses absorb at the value level in `put`, and `propagateBwd` has a per-level
`settled` no-op stop.

---

## Layout

```
proto-microtask/
  core/
    cell.ts            ← the engine (sources, lenses, computeds, effects, settle)
    index.ts           ← public surface
    lenses/ values/    ← lens library + value types (Num, Vec, Bool, Str, Box…)
    lifecycle.ts tree.ts derived-geometry.ts traits.ts linalg.ts
    _test/
      *.test.ts        ← native bireactive tests (lens laws, footguns, glitch-free…)
      microtask.test.ts← the REAL async scheduling path (await, not settle)
      suite/
        adapters/      ← framework-agnostic Reactive interface + bireactive impl
        conformance/   ← RFTS forward + lifted + batch + reconcile conformance
        laws/          ← lens-law generators (lossy, minimality, confluence…)
        harness/ bench/← counters, graph generators, perf workloads
    _proto/            ← SEPARATE, UNRELATED sub-experiments (push-pull "pp",
                         backward-pull "bp", reconcile). Carried along in the
                         copy; not part of the microtask work. Ignore for merge.
  animation/ tree.ts   ← minimal dependency closure the engine needs
  _test/{setup,_util}.ts
```

## Test strategy (what proves correctness)

- **Forward conformance** — the whole `reactive-framework-test-suite` (RFTS)
  against the engine's forward path (alien-signals verbatim).
- **Lifted conformance** — the *same* RFTS suite, but every source write enters
  through an identity write-through lens. Passing bit-identically to the direct
  run is the mechanical proof that the backward path is sound and that async
  effects + no-`batch` didn't break forward semantics.
- **Lens laws** — PutGet / GetPut / PutPut / lossy / bwd-soundness /
  cyclic-correctness, generated over random inputs.
- **`microtask.test.ts`** — coalescing, net-zero suppression, glitch-freedom,
  `settle()` ≡ tick, termination of self-writing effects, and a stateful lens
  under coalescing — all through the real `queueMicrotask` path.

The RFTS adapter bridges async effects → the suite's synchronous-effect
assumption by draining via `settle()` at transaction boundaries (after a
top-level write; once at the end of the outermost adapter-level `batch`), with a
re-entrancy guard so writes *inside* an effect body don't each force a nested
drain (preserving glitch-free implicit batching of inner writes). See
`core/_test/suite/adapters/bireactive.ts`.

## Known, intentional divergences

- RFTS `#209` / `#210` (cascading disposal of nested effects) are skipped:
  this engine uses **independent effect scopes** owned by the call site's
  disposer (as in alien-signals v2, Solid 2.0, Vue's `effectScope`, the TC39
  proposal), not auto-parent cleanup. The 36 skips are these two plus the RFTS
  `behavioral` (non-assertive) cluster.

---

## For the other engine stream (merge notes)

Things to compare / reconcile when merging streams:

- **Scheduling boundary.** This stream draws the sync/async line at *effects*
  only. Where does yours draw it? If both keep the value graph synchronous, the
  lens layer should port cleanly.
- **Public async API is unfinished.** We only expose synchronous `settle()`.
  There's no `await`-able flush / `onSettled` / async-effect support yet — that
  surface is an open design question and the natural place the two streams
  should agree before either commits a public API.
- **`network` / `merge` removal.** Both removed here and (per the other WIP)
  in the `core2`/lattice effort — coordinate so we don't double-delete or
  diverge on the replacement for N→M aggregation.
- **Inverse-memo** is engine-local and independent; easy to lift or drop.

Deferred (not done here): merge-back into `src/`, a perf bench table
(sync `src/core` vs this), and the async public API.
