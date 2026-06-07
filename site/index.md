---
title: Bireactive Programming
description: A bi-directional reactive programming library.
---

# Bireactive Programming

<md-bireactive></md-bireactive>

Reactive values flow one way: write an input and everything derived from it updates. A *bireactive* system allows edges that go backward — write the derived value (a.k.a a "lens") and the input adjusts to match. We write such an edge `a ⇌ b`, reserving `a → b` for an ordinary one-way derive.

Each edge carries a forward and an inverse, so a change at any node propagates both ways.

The full surface is documented in the [API reference](./api/).

A solar system, every body positioned from one `time`.

<md-solar-system></md-solar-system>

Each body chains polar coordinates off `time`; the chain inverts, so dragging any body scrubs `time` and the rest follow — the moon too, if you can catch it.

A clock is the same chain — each hand an affine view of `time`, each tip a polar point:

```ts
const angle = time.affine(τ / period, -π / 2);
const tip   = polar(center, len, angle); // drag a tip to scrub time
const tokyo = time.affine(1, 9 * 3600);   // a second timezone
```

<md-clock></md-clock>

[^edge]: A write is a single bounded walk up the edge it came down — no global solver, no fixpoint, and the graph stays acyclic. That is what separates it from a constraint system, where relations are bidirectional but global and have to converge to a fixpoint (the subject of a later section).

## Reversible edges

The plainest edges are exact bijections: reflections, rotations, scales, affine maps, polar/cartesian, unit conversions. The inverse is closed-form, so the backward direction involves no search.

Rope-length conservation is one affine edge, chained:

```ts
const a = num(130);
const b = a.affine(-1, L₁);
const c = b.affine(-1, L₂);
```

<md-pulley></md-pulley>

A *similarity* — rotate then scale about a pivot — composed down a chain lays the dots on a logarithmic spiral:

```ts
let p = a;
for (let i = 0; i < N; i++) p = p.rotate(θ, pivot).scale(k, pivot);
```

<md-invertible></md-invertible>

<md-function></md-function>

Reflection across a line is its own inverse:

<md-mirror></md-mirror>

On the Poincaré disc,[^poincare] geodesics are circles meeting the boundary at right angles, and reflection becomes inversion in them. Moving a vertex curves the sides, repositions the sister triangles, and updates the angle sum and area.[^gaussbonnet]

<md-conformal-disc></md-conformal-disc>

Gears branch into a tree, each child meshing through `child = parent.scale(−teethₚ / teeth_c)`. A compound wheel — two gears on one shaft — makes the ratio product real. Turning any gear turns the rest.

<md-gears></md-gears>

Not every edge is a bijection. `clamp`, `quantize`, and `snap` discard information idempotently, so the backward direction just projects again:

```ts
const t  = num(0.5);
const tC = t.clamp(lo, hi); // lo, hi can be cells too
const tQ = tC.quantize(0.1);
```

<md-clamp-quantize></md-clamp-quantize>

Every field is a lens onto one SI-base cell, `si.lens(u.fromBase, u.toBase)`. Units compose:

```ts
const km     = meter.scaled(1000);                       // prefix
const knot   = nmi.div(hour);                            // compound
const litre  = meter.pow(3).scaled(0.001);               // m³ → L
const newton = kilogram.times(meter).div(second.pow(2)); // kg·m·s⁻²
const joule  = newton.times(meter);                      // energy
const watt   = joule.div(second);                        // power
```

<md-units></md-units>

Coordinate spaces, similarly: each is a `world.lens(fwd, bwd)` — euclidean, oblique, polar, log-polar, toroidal.

<md-coordinate-spaces></md-coordinate-spaces>

Or a waveform and its spectrum:

<md-fourier></md-fourier>

A cascade of EQ filters is a forward DSP graph — gains in, sound out. As a lens, drag the response and `factor` solves the band gains in real time onto native Web Audio filters; the curve behind is the live spectrum. Press play, then drag a point:

<md-bireactive-eq></md-bireactive-eq>

## Aggregates

A residual edge also loses information, but the lost part stays in the source for the backward direction to read back. A centroid reads as the average of its points; writing it moves them all, splitting the change evenly.

`handle(point)` wraps a writable point; on a centroid (which is itself just a writeable point), it drags the whole group:

<md-handles></md-handles>

A backward function is a closure, so it can read other cells. Here the midpoint reads each handle's `dragging` cell: hold one endpoint and it stays pinned while the free end absorbs the difference:

<md-multitouch></md-multitouch>

An aggregate needn't collapse to a single value. A bounding box decomposes, so dragging a corner scales the box about its center:

```ts
const { center, size } = bbox(points);
```

<md-bbox-handles></md-bbox-handles>

A best-fit line and circle, sharing one centroid:

```ts
const { point, direction } = bestFitLine(points);
const { center, radius }   = bestFitCircle(points);
```

<md-best-fit></md-best-fit>

`meanSpread(inputs) ⇌ {mean, spread}` is dispatched by trait, so it works for any linear type with a metric — vectors, colours, poses:

<md-traits-cross-domain></md-traits-cross-domain>

A `merge` cell runs the other way: many writers fold into one source through a monoid policy, in any order.

```ts
const bus = source.merge({ identity: "Z", combine });
```

An idempotent meet, a last-writer join, tri-state bus resolution, a sum:

<md-merge></md-merge>

## Crossing types

An edge's two ends needn't share a type. With a boolean target, the forward direction is a predicate (`v > t`, `box.contains(p)`, `a ≈ b`) and the backward direction nudges the source to satisfy it — a read-only readout becomes writable:

<md-bool-bridges></md-bool-bridges>

Six shapes share one `Bool.lens`: two thresholds, two relations (coincidence, box collision), an array aggregate, and a parity check. Writing `inside` moves the point into the region.

With a richer target, `(Range, Range) ⇌ AllenRelation` (classify / realize) reads two intervals as one of Allen's thirteen relations.[^allen] Setting a relation reshapes the second interval to match:

<md-allen></md-allen>

A box is a range on each axis, so `(Box, Box) ⇌ RCC-8`[^rcc8] is two Allen classifications, one per axis:

<md-rcc8></md-rcc8>

A histogram coarsens: `Array<Num> ⇌ Array<BinCount>` (bin / transport) keeps counts, drops positions; transport moves the fewest samples across the nearest boundary:

<md-histogram></md-histogram>

In 2D, a heatmap: `Array<Vec> ⇌ Grid<Count>` (bin / pull). Moving a point re-bins it; selecting a cell pulls the nearest point in:

<md-heatmap></md-heatmap>

`mix(weights, branches)` reads as a weighted sum and writes back split by weight. `select` and `crossfade` are the same lens with the control on the weight simplex — a boolean snaps between branches, a number blends them across position, colour, and size:

<md-select></md-select>

A lens is itself a value, so it can live in a cell — the *transformation* becomes reactive. `through(src, frame)` tracks the frame cell forward and inverts whatever it holds backward, so swapping or blending the lens reconfigures a live pipeline. Stage one swaps an affine frame from a palette; stage two blends one continuously:

<md-lens-algebra></md-lens-algebra>

## Trees

Extending boolean to a sum type gives `Tri` — three-valued logic with an indeterminate state. A checkbox tree with hierarchical mixed state is a few lines:

```ts
const node = (label, children = [], init = false) => ({
  label,
  children,
  checked: children.length ? Tri.allOf(children.map(c => c.checked)) : tri(init),
});

const tree = node("Tasks", [
  node("Work",     [node("Report"), node("Review", [], true), node("Email")]),
  node("Personal", [node("Groceries"), node("Call mom", [], true), node("Laundry")]),
  node("Reading",  [node("Chapter 4", [], true), node("Chapter 5", [], true)]),
]);
```

<md-tri-tree></md-tri-tree>


A `Flags` value is one integer with named bits; `flag(name)` is a `Bool` lens over a single bit. Unix file permissions are nine bit lenses, each row a `Tri` over its triad, with octal, symbolic, and raw-binary as format/parse views of the same cell.

<md-flags></md-flags>

A tree of scalars: moving a boundary adjusts the siblings, the parent total, and the rows downstream:

<md-budget-tree></md-budget-tree>

## Collections

A `coll(items)` holds stable element handles — records of cells — and each view is a *writable* structural lens.

```ts
const visible = tasks.filter(is(c => c.done, false));
const board   = visible.groupBy(c => c.status, { order: COLUMNS, sort: c => c.rank });
```

The forward half is nothing exotic — `filter`/`sortBy`/`groupBy` are plain derivations, expressible on any signal library. What `coll` adds is the *backward* half as part of the same vocabulary: you edit the view, not the source. A drag is one call, and the lens chain writes the fields that make the view true:

```ts
board.move(card, "doing", i); // status := "doing" (the group key),
                              // rank := between(neighbours) (the order field),
                              // and the upstream filter's assert (done := false)
```

So the predicate that *derives* the view also *repairs* it: `is(c => c.done, false)` is one expression used forward (the test) and backward (the assert), and `done` is itself a `Bool` lens over `status`, so ticking it rewrites the column. Swap `c.status` for `c.assignee` or `c.priority` and the identical `move` re-targets the new field. The board, table, and timeline are three lenses over one `coll`, edited independently and kept in lockstep.

<md-kanban></md-kanban>

Each bone holds a local pose; world pose composes down the chain, and a joint handle decomposes a world target back into the local frame. Moving a hand bends one arm; moving the root translates the whole figure:

<md-skeletal-rig></md-skeletal-rig>

The reverse reads a tree *out* of flat geometry: `Array<Box> ⇌ Forest` nests each box in the smallest that contains it. Moving a box carries its subtree; dragging one onto another rescales it to nest inside:

<md-containment-forest></md-containment-forest>

Here is a fractal tree thing.

<md-fractal-tree></md-fractal-tree>

## Text

Everything so far rides numeric types. Strings, arrays, and sets need a different mechanism, since the discarded detail can't be recovered from the result alone: each cell carries a private complement[^lens] threaded through every write, and lens chains compose on top.

One source string, five projections. Editing any pane updates the source; the detail each projection dropped — padding, per-word case, separator runs, duplicate positions — comes back from the complement:

<md-string-pipeline></md-string-pipeline>

Each badge names the lens: `trim` stores the padding, `lowercase` a case mask, `words` the separator runs, `sortedUnique` a map from key to positions and case (so one edit fans out to every occurrence), and `rot13` is the involution case (its own inverse).

A `Template` is a multi-parent lens over typed slot cells — `lit₀ slot₀ lit₁ … litₙ`, rendering forward and parsing back. The pipeline above is string-as-source; a template is slots-as-source, so the same cells drive several renderings. Two share one pool here — edit a control, either line, or either template's *structure*. `{name}` is a string hole, `{#name}` a typed int hole:

<md-madlibs></md-madlibs>

Each slot carries a `string ⇄ T` codec. With one editable pattern, that's routing: `:name`/`#name` holes parse a URL into typed params, and editing the pattern itself reshapes the route:

<md-route-params></md-route-params>

The same complement mechanism scales to rasters, on the GPU. A `Canvas` carries its pixels as an RGBA float texture in one shared WebGL2 context; the reactive graph compares a monotonic `epoch`, so propagation never touches a pixel and nothing crosses the bus but handles. Every lens is a shader pass into a scratch texture, every backward pass its inverse. Below, a source forks five ways: a transform spine (`brightness(k) ⇌ blur(r) ⇌ grayscale ⇌ invert`, where `grayscale` stores per-pixel chroma), a `flipH` forking into dual projections (`grayscale` keeps luma, `chroma` keeps colour), a `downsample` thumbnail, a region branch (`crop ⇌ meanColor`), and a 1-bit `brighterThan`. Paint any canvas, drag the crop box, flip the exposure bit, or pick a mean colour — every edit flows back through the inverses:

<md-canvas-graph></md-canvas-graph>

Several tiers stack here. `downsample` projects to a thumbnail whose complement is the Laplacian residual, so painting the coarse node reconstructs full-resolution detail underneath the edit, keeping coarse structure and fine texture independently editable. Painting the blurred node runs an iterated Richardson–Lucy solve backward, seeded from the current source so untouched regions stay fixed while a stroke back-solves to the sharp pre-image — multiplicative and non-negative, so still PutGet, not exact GetPut: the honest residual of an ill-posed inverse. `meanColor` is a writable `Color` whose RGB field-lenses rigidly shift every pixel, edited through `crop`. And `brighterThan(t)` projects to a `Bool`; flipping that bit auto-exposes, a rigid gain that pushes the mean across the threshold and flows back to the source.

Hit *spring root* and per-pixel position/velocity state — float textures that never leave the card — makes every pixel a damped oscillator chasing a target image; the settle metric is a GPU reduction, so even the "are we done?" check stays off the CPU. The spring drives the root each frame and the whole DAG re-derives until it settles.

## Solvers

When the inverse has no closed form, the backward direction runs a solver — still a single pass from the outside. An N-link arm is a `Vec.lens` whose backward direction runs inverse kinematics on each write:

<md-ik></md-ik>

A constraint cluster is an *unoriented* relation; `exposeVec(c, cells, handle)` orients it, handing back a `Writable<Vec>` whose backward direction relaxes the network. The solver is now a *value*, so the closed-form lens algebra stacks on top. Three fingers share a hub, each its own cluster with its tip exposed; `procrustes(tips)` lays an exact move/spin/size frame over all three. One gizmo write splits into a per-finger target, and each cluster relaxes to meet it — *spin* and *size* emergent, held by no single cell:

<md-network-lens></md-network-lens>

A closed loop parameterizes each bar by angle and solves `Σ rᵢ · u(θᵢ) = 0` from the previous frame's seed, staying continuous as it travels around the cycle:

<md-loop></md-loop>

## Fixpoint networks

Some relationships have no source end at all — a four-bar linkage, a cloth, a sudoku. The lens model bottoms out and the cluster owns the solve. Both flavours share one `network()`: propagators narrow to a fixpoint, constraints settle onto a manifold.

### Propagators

A propagator declares which cells it reads and which it writes, and the network runs them to a fixpoint driven by what's stale. Combinators dispatch on type — `centroid(G, A, B, C)` runs both ways, `mid(A, B, M)` is the two-point form — so a triangle's medians stack from a centroid and three midpoints:

```ts
const p = propagators();
p.add(centroid(G, A, B, C));
p.add(mid(A, B, Mab));
p.add(mid(B, C, Mbc));
p.add(mid(C, A, Mca));
```

<md-prop-geom></md-prop-geom>

But a propagator isn't *required* here. The dependency graph is a fan-in DAG rooted at the three vertices: `G` and each midpoint are pure functions of `A`, `B`, `C` — no cycle, no cell co-owned by two relations. That's exactly the lens-expressible subset, so the same construction drops the network entirely. Each derived point IS a value (`mean`), and its backward direction is the drag policy — centroid and midpoint collapse into the *same* primitive:

```ts
const G = mean([A, B, C]);
const Mab = mean([A, B]);
const Mbc = mean([B, C]);
const Mca = mean([C, A]);
```

<md-lens-geom></md-lens-geom>

Drag the two demos side by side: behaviourally identical. The split is one of role, not capability — the lens *defines* the value ("`G` is the centroid"), the propagator *solves* a relation ("these should satisfy `a+b=c`"). Lenses win whenever the relation is a one-directional derivation: total, ~8× cheaper per drag, never inconsistent. Propagators earn their network the moment you need a *cycle*, a cell *co-owned* by two relations, or a *peer* constraint where both endpoints stay independently draggable (`keepDistance`, `onLine`, the sudoku below) — none of which a single lens can own.

Layout is one large propagator: `hstack(container, items, opts)` reads the container, gap, and widths and writes positions in a single pass:

<md-prop-flex></md-prop-flex>

The same network narrows sets. A 9×9 sudoku is set-narrowing on `Cell<Set<T>>` — the same `network()` with a different value type and merge rule:

<md-prop-sudoku></md-prop-sudoku>

Narrowing on a different lattice is type inference. Each AST node is a cell of candidate types: `+` forces `{Int}`, an application narrows the function to `{Fn}` and unifies its domain with the argument. Unification[^hm] is set intersection lifted to structures:

```ts
function unify(a: TypeNode, b: TypeNode) {
  return [
    propagator([a.tag], [b.tag], () => intersectInto(b.tag, a.tag)),
    propagator([b.tag], [a.tag], () => intersectInto(a.tag, b.tag)),
    ...(a.dom && b.dom ? unify(a.dom, b.dom) : []),
    ...(a.cod && b.cod ? unify(a.cod, b.cod) : []),
  ];
}
```

The demo steps through four expressions one fixpoint wave at a time. The fourth has no consistent typing — `λx. x + 1` forces `x : Int` but is applied to a string — and the contradiction shows up as an empty cell:

<md-prop-types></md-prop-types>

### Constraints

`Constraints` binds cells and runs an Augmented Vertex Block Descent[^avbd] solve per write. The factories (`distance`, `angle`, `onCircle`, `generic`, …) compose, and membership is reactive: `addWhile(flag, rel)` keeps a relation alive only while a cell is truthy.

Four side constraints leave the quad one internal degree of freedom; a fifth diagonal toggles it rigid:

```ts
const braced = cell(true);
const c = constraints({ iterations: 20 });
c.add(
  distance(A, B, 160),
  distance(B, C, 120),
  distance(C, D, 160),
  distance(D, A, 120),
);
c.addWhile(braced, distance(A, C, diag));
```

<md-sketchpad></md-sketchpad>

An editor from the same parts: two reactive collections of points and constraints drive `forEach` blocks that mount and unmount visuals as you build:

<md-sketchpad-live></md-sketchpad-live>

Constraints describe loci as well — `onCircle(P, center, r)`, `collinear(P, A, B)`. This bracket stacks six in one cluster: two incidences, two equal bars, a symmetry, and a right angle:

<md-incidence></md-incidence>

A slider-crank: two distances and a `collinear` over six cells, four pinned, the piston tracking the crank:

<md-slider-crank></md-slider-crank>

`physics({ gravity })` bakes a time-stepper into the pipeline and `step(dt)` advances it each frame. The cloth is a grid of points held by distance constraints with the top corners pinned:

<md-cloth></md-cloth>

`gap(a, b, d)` keeps two points at least `d` apart, enforced only when violated. Soft edge springs plus pairwise gaps make a force-directed layout:

<md-graph></md-graph>

Gaps with `inside(P, …)` and gravity pack circles into a region, shoving each other aside when one is moved:

<md-particles></md-particles>

Proper rigid bodies on the same engine: a 3-DOF `(x, y, θ)` cell with mass `(m, m, I)`, box-box collisions via SAT, and a tangential clamp for Coulomb friction:

<md-rigid-stack></md-rigid-stack>

Joints chain rigid bars — each link a body hinged by a `Joint` whose position rows are hard and angle row free — so they behave like bars rather than beads on a string:

<md-rigid-rope></md-rigid-rope>

The same setup on a 1D submanifold fixes each circle's position to `(R·sin t, R·sin 2t / 2)` by a `generic` constraint. Near the origin both branches are admissible and the solver can flip between them:

<md-figure8></md-figure8>

Nothing here is geometry-specific. Three numbers and one `generic` solve `a² + b² = c²`: move any handle and the other two redistribute:

<md-equation></md-equation>

## Animation

Before the bireactive experiments took off, this started as a tiny generator-based animation runtime — which I was very excited about, and still am. The idea is simple:

Generators yield control up; the runtime passes `dt` back down as the resume value:

```ts
function* fadeOut(opacity, secs) {
  let t = 0;
  while (t < secs) {
    const { dt } = yield;
    t += dt;
    opacity.value = 1 - t / secs;
  }
}
```

The runtime calls `.next(dt)` and the generator writes wherever its values land. Generators compose by calling each other, which is where sequencing, parallelism, and time scope come from:

<md-transitions></md-transitions>

A generator can pull `dt` and forward a changed version of it. Halving it is a few lines, and the same shape covers slow motion, reverse, pause, and jitter:

```ts
function* halfSpeed<R>(gen: Animator<R>): Animator<R> {
  let r = gen.next(0);
  while (!r.done) r = gen.next((yield) * 0.5);
  return r.value;
}
```

To wait on something without a fixed duration, a generator yields `(wake) => dispose`; the runtime parks it until `wake(value)` is called, which can happen straight from a DOM handler:

```ts
const event = yield* untilEvent(button, "click");
const next = yield* untilChange(signal);
```

| Yield             | Means                                       |
| ----------------- | ------------------------------------------- |
| yield             | wait one frame, resume with dt              |
| yield 0.5         | sleep half a second                         |
| yield gen         | spawn a child, wait for it                  |
| yield [a, b]      | spawn N in parallel, wait for all           |
| yield (wake) => … | suspend on a callback-shaped source         |
| yield detach(g)   | spawn at root; outlives the yielding parent |
| yield cut(v)      | from inside a group: settle group with v    |

Sequencing is `yield*` and parallelism is `yield [a, b, c]`. Cancellation is either cooperative through `.until(stop)`, which resolves cleanly mid-step and can run a sequel, or hard, which walks the tree calling `gen.return()`; `finally` runs either way:

<md-cancel></md-cancel>

`cut(v)` is Prolog's cut:[^cut] a child returning it settles its group with `v` and cancels its siblings. `race`, `firstN`, `firstMatching`, `anySuccess`, and `allSettled` are each a single closure over it:

```ts
function* race(...kids) {
  return yield kids.map(k => commit(k));
}
```

<md-rand></md-rand>

Signals meet generators through a few helpers. Every value signal has `.to(target, dur, ease?)`, a chainable tween that is also an animator:

```ts
yield* x.to(100, 0.5, easeInOut);
yield* x.from(0).to(100, 0.5).to(0, 0.5).until(stop);
```

`spring`, `toward`, and `attract` pull toward a reactive target; `wave` covers closed-form motion and `driven` is the escape hatch:

<md-behaviors></md-behaviors>

Others park until a signal acts: `when(sig)` for truthy, `untilChange(sig)` for the next change. `play(p)` lifts any playable thing (a number, array, generator, suspend function, or signal) into one surface:

```ts
spring(w, rest).until(dragging);
play([lane0, lane1, lane2]).until(stop);
play(0.5).then(fadeIn(shape, 0.3));
loop(() => fadeInOut(c)).until(done);
```

<md-circuit></md-circuit>

A row of cards, each width behind a `clamp(MIN_W, ∞)` edge so a handle can't drag it below the minimum:

<md-layout-demo></md-layout-demo>

Rigid group choreography is a centroid, mean rotation, and mean scale animated in parallel:

<md-choreography></md-choreography>

A timeline is a clock with clips over `(at, dur)` ranges, each exposing a normalized `t`. `yield* tl` runs the clock to the total duration:

```ts
const tl = timeline({
  intro: { at: 0, dur: 0.5 },
  hold:  { at: 0.5, dur: 1.0 },
  outro: { at: 1.5, dur: 0.4 },
});
effect(() => (circle.opacity.value = tl.intro.t.value));
yield* tl;
```

<md-multitrack></md-multitrack>

<md-timeline-editor></md-timeline-editor>

A `claim` is a labeled boolean over a predicate — true while it holds — and composes with `.and`/`.or`/`.not`/`.during`/`.before` because it is itself a cell:

```ts
const fadeIn = scope("fadeIn", function* (s, dur) { /* ... */ });

const bounded  = claim(c.opacity).stays.in([0, 1]).during(fadeIn);
const reaches1 = claim(c.opacity).becomes.equal(1).during(fadeIn);

loop(() => fadeIn(c, 0.3));
```

The debugger lays the trace — a gantt of factory invocations — beside `α(t)` coloured by author, with the claim strips on the same axis. A buggy `nudge` overshoots `α = 1`, and stepping through names the offender:

<md-debugger></md-debugger>

`.to` dispatches on traits: `tween`, `spring`, `toward`, and `attract` read `linear`, `lerp`, and `metric` from each class's `static traits`, knowing nothing about `Vec` or `Color`:

<md-lerps></md-lerps>

A new value type is one class with a trait dict:

```ts
class Polygon extends Cell<PolygonValue> {
  static traits = {
    lerp: lerpPolygon,
    equals: equalsPolygon,
  };
  to(target, dur, ease?) { return tween(this, target, dur, ease); }
}
```

and `polygon.to(target, dur)` works on the same machinery; adding `linear` and `metric` brings `spring`, `toward`, and `attract` along too:

<md-morph></md-morph>

`tex` renders MathML through Temml; `part()` markers become addressable child shapes with their own transform, opacity, and colour:

```ts
const eq = tex`E = ${part("M")} c^2`;
yield* eq.parts.M.translate.to({ x: 0, y: -20 }, 0.4);
```

<md-tex-demo></md-tex-demo>

<md-tex-live></md-tex-live>

Markers cross diagrams: `marker.register("id")` and `<md-marker sym="id">` share one `marker.active` cell, a derived OR over every binding. Because it is a `Cell<boolean>`, `yield* play(marker.active)` parks a generator until any rendering activates it. Three markers tie this prose to the diagram — <md-marker sym="osc:gamma">damping</md-marker> lights the decay envelope, <md-marker sym="osc:A">amplitude</md-marker> the bounds, <md-marker sym="osc:omega">frequency</md-marker> the period ticks:

<md-oscillator></md-oscillator>

`code` is `tex`'s sibling — a reactive source in a text wrapper. `c.morphTo(src, dur)` diffs lines then tokens, wraps the changed ranges, and interpolates their size while matched text reflows:

<md-code></md-code>

### Beyond SVG

The `(wake) => dispose` shape carries to native primitives: `untilAnimation(a)` wakes on a WAAPI finish, `untilInView(el)` on intersection, and `scrollProgress()` is a lazy scroll signal. `native(el, keyframes, opts)` wraps `Element.animate` as an animator that composes with `stagger`, `race`, and `try`/`finally`:

<md-waapi-demo></md-waapi-demo>

None of it is SVG-specific. The same pipeline drives a `<canvas>` with a per-frame loop; the shape graph is a convenience on top:

<md-canvas-field></md-canvas-field>

A spring over a transform, with phantom poses trailing behind it:

<md-trails></md-trails>

A geometric construction on a timeline — axis, ticks, labels, bounding box, centroid — from the same primitives:

<md-centering></md-centering>

The runtime's test suite runs in the browser on a fresh `Anim` driven by `step(dt)`:

<md-runtime-tests></md-runtime-tests>

## Misc

Loose demos that may not survive the final cut.

Real Kepler orbits, still invertible: the forward path solves `M = E − e·sin E` numerically, the backward is closed-form. The periapsis speed-up falls out:

<md-kepler-system></md-kepler-system>

A confocal family of ellipses is two foci and a derived shape; `ellipse(center, a, b, rotation?)` takes a reactive value on every parameter:

```ts
const aE = derive(() => (r1.value + r2.value) / 2);
const bE = derive(() => Math.sqrt(aE.value ** 2 - cDist.value ** 2));
s(ellipse(center, aE, bE, rot, { stroke: ACCENT }));
```

<md-confocal></md-confocal>

A centroid is an ordinary cell, so two animations can share one position — the motion is their per-frame mean:

```ts
const c = centroid(a, b, c, d);
yield* c.to({ x: 200, y: 100 }, 1);
```

<md-mix></md-mix>

Any writable point can host a handle, including a derived one. Anchor points on a shape track it as it animates:

<md-anchors></md-anchors>

Units form a vector space under multiplication, so `times`/`div` add and subtract dimension vectors and `pow` scales them; two quantities convert exactly when their vectors match:

```ts
const km     = meter.scaled(1000);                       // prefix
const knot   = nmi.div(hour);                            // compound
const litre  = meter.pow(3).scaled(0.001);               // m³ → L
const newton = kilogram.times(meter).div(second.pow(2)); // kg·m·s⁻²
const joule  = newton.times(meter);                      // energy
const watt   = joule.div(second);                        // power
```

<md-unit-algebra></md-unit-algebra>

A cubic Bézier reads as `{start, end, startTangent, endTangent}`, putting the handles on the curve's shape rather than its raw control points:

<md-bezier-gestalt></md-bezier-gestalt>

<!-- Pushed further, a cubic is four DOF and every spline basis is just a different coordinate system for the same curve, related by a constant matrix. Each net's handles are a `Vec.lens` onto the shared coefficients, so dragging a handle in any basis remaps the others while the curve stays put: -->

<!-- <md-curve-bases></md-curve-bases> -->

[^poincare]: [Poincaré disc model](https://en.wikipedia.org/wiki/Poincar%C3%A9_disk_model).

[^gaussbonnet]: The area is π minus the angle sum, by the [Gauss–Bonnet theorem](https://en.wikipedia.org/wiki/Gauss%E2%80%93Bonnet_theorem).

[^allen]: [Allen's interval algebra](https://en.wikipedia.org/wiki/Allen%27s_interval_algebra) — thirteen ways two intervals can relate on a line.

[^rcc8]: [Region connection calculus](https://en.wikipedia.org/wiki/Region_connection_calculus), the eight base relations between two regions.

[^lens]: A symmetric lens in the [Hofmann–Pierce–Wagner](https://www.cis.upenn.edu/~bcpierce/papers/symmetric-full.pdf) sense; the case-preserving find-and-replace follows Foster and Pierce's work on bidirectional transformations.

[^hm]: [Hindley–Milner](https://en.wikipedia.org/wiki/Hindley%E2%80%93Milner_type_system) type inference, whose unification step is structural set intersection.

[^avbd]: [Augmented Vertex Block Descent](https://graphics.cs.utah.edu/research/projects/avbd/).

[^cut]: [The cut](https://en.wikipedia.org/wiki/Cut_(logic_programming)) in logic programming, which commits to choices made so far and prunes the alternatives.
