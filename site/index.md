---
title: Bireactive Programming
description: A bi-directional reactive programming library.
---

# Bidirectional Reactive Programming

<md-bireactive></md-bireactive>

## Introduction

> NOTE: This page is a work in progress.

### Reactive systems
Ordinary reactive systems (often called "signals") flows one way: write an input, everything derived updates. Reactive systems assure ~4 properties:

1. **Minimality** — only the affected nodes recompute.
2. **Consistency** — a read is never stale; it always returns the latest value.
3. **Glitch-freedom** — a write that fans out to N sources and reconverges never shows intermediate/inconsistent state; downstream derived values and side-effects fire exactly once.
4. **Natural acyclicality** — by requiring dependencies be defined before use, it is _unnatural_ to create cycles in normal use.

Dependencies are implicit, so one need only read a value to subscribe to it.

```ts
const c = cell(20);
const f = derive(() => c.value * 9/5 + 32);
const fDouble = derive(() => f.value * 2); // fDouble subscribes to f by reading it.

// side-effect fires exactly once when values change.
effect(() => console.log(`${c.value}°C = ${f.value}°F = 2×${fDouble.value}`));

c.value = 100; // → 100°C = 212°F
f.value = 32;  // Error: cannot write to a derived value.
```

### Lenses vs two-way binding

// two-way binding stuff, see notes doc
// lens stuff and how they might address the problems with two-way binding


### Bireactivity

*Bi-directional reactivity* extends the lazy propagation model of signals to allow *backward* propagation, allowing us to write to a derived value.
```ts
const c = cell(20);
const f = c.lens(c => c * 9/5 + 32, f => (f - 32) * 5/9);
effect(() => console.log(`${c.value}°C = ${f.value}°F`));
// 20°C = 68°F

c.value = 100; // → 100°C = 212°F
f.value = 32;  // → 0°C = 32°F
```

Bireactive systems maintain many of the same properties as forward-only reactivity. *Propagation* is still acyclic despite the addition of backward edges, so cycles are as hard to create as they were before. Consistency and glitch-freedom are maintained by the same mechanisms as forward-only reactivity.

$$a \begin{array}{c} \xrightarrow{\;a+10\;} \\[-1.6ex] \xleftarrow[\;b-10\;]{} \end{array} b$$

<md-invertible></md-invertible>


<md-solar-system></md-solar-system>

<md-color-hsv></md-color-hsv>

`clamp`, `quantize`, and `snap` discard information idempotently, so the backward direction projects again.

```ts
const t  = num(0.5);
const tC = t.clamp(lo, hi); // lo, hi can be cells too
const tQ = tC.quantize(0.1);
```

<md-clamp-quantize></md-clamp-quantize>

## Unit conversions

Each field is a lens onto one SI-base cell: `si.lens(u.fromBase, u.toBase)`. Units form a vector space under multiplication: `times` and `div` add and subtract dimension vectors, `pow` scales them; two quantities convert when their vectors match.

```ts
const km     = meter.scaled(1000);                       // prefix
const knot   = nmi.div(hour);                            // compound
const litre  = meter.pow(3).scaled(0.001);               // m³ → L
const newton = kilogram.times(meter).div(second.pow(2)); // kg·m·s⁻²
const joule  = newton.times(meter);                      // energy
const watt   = joule.div(second);                        // power
```

<md-units></md-units>

## Geometry

Coordinate spaces through `world.lens(fwd, bwd)`: euclidean, oblique, polar, log-polar, toroidal.

<md-coordinate-spaces></md-coordinate-spaces>

Reflections, rotations, scales, and affine maps have closed-form inverses.

<md-mirror></md-mirror>

<md-function></md-function>

<md-conformal-disc></md-conformal-disc>

A pulley as two `affine(-1, L)` lenses.

```ts
const a = num(130);
const b = a.affine(-1, L₁);
const c = b.affine(-1, L₂);
```

<md-pulley></md-pulley>

Meshed gears: turn any one and the rest follow.

<md-gears></md-gears>

Drag a vertex; the edge-midpoints and centroid follow. Each derived point is a `mean` lens, so every backward step is one average.

<md-triangle></md-triangle>

<md-handles></md-handles>

The midpoint reads each handle's `dragging`, so a held endpoint stays pinned while the free end absorbs the difference.

<md-multitouch></md-multitouch>

```ts
const { center, size } = bbox(points);
```

<md-bbox-handles></md-bbox-handles>

A best-fit line and circle sharing one centroid.

```ts
const { point, direction } = bestFitLine(points);
const { center, radius }   = bestFitCircle(points);
```

<md-best-fit></md-best-fit>

`meanSpread(inputs) ⇌ {mean, spread}` for any linear type with a metric: vectors, colours, poses.

<md-traits-cross-domain></md-traits-cross-domain>

A pose tree: `world = compose(parent.world, local)`, and a drag inverts through `decompose`.

<md-skeletal-rig></md-skeletal-rig>

A Sankey diagram where conservation (in = out) holds at every node. Four free numbers fix every width; each width is a lens, so dragging one re-solves the rest.

<md-sankey></md-sankey>

## Lenses across types

The two ends of a lens needn't share a type. With a boolean target, forward is a predicate (`v > t`, `box.contains(p)`, `a ≈ b`) and backward nudges the source to satisfy it.

<md-bool-bridges></md-bool-bridges>

`(Range, Range) ⇌ AllenRelation` reads two intervals as one of Allen's thirteen relations; setting the relation reshapes the second interval.

<md-allen></md-allen>

`(Box, Box) ⇌ RCC-8`, the same idea in two dimensions.

<md-rcc8></md-rcc8>

## Collections

A todo tree of `Tri` values (`true | false | "mixed"`). A click propagates up to ancestors and down to children.

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

A `Flags` value is one integer with named bits; `flag(name)` is a `Bool` lens over a single bit.

<md-flags></md-flags>

<md-budget-tree></md-budget-tree>

An array cell `arr(items)` has writable lens views (`filter` / `sortBy` / `groupBy`).

```ts
const visible = tasks.filter(is(c => c.value.done, false));
const board   = visible.groupBy(c => c.value.status, { order: COLUMNS });
```

`is(c => c.value.done, false)` runs forward (test) and backward (assert). `board.move(card, column, i)` writes the group field, splices the base order, and asserts the filter.

<md-kanban></md-kanban>

<md-containment-forest></md-containment-forest>

## Text

A `Template` is a multi-parent lens over typed slot cells (`lit₀ slot₀ lit₁ … litₙ`), rendering forward and parsing back. Each slot carries a `string ⇄ T` codec.

<md-madlibs></md-madlibs>

<md-route-params></md-route-params>

Each projection is lossy, so it keeps what it drops in a complement. Edit any pane and the source updates; the others re-derive.

<md-string-pipeline></md-string-pipeline>

`Str` has `trim` / `reverse` / `slice` / `split`; `split(/\s+/)` returns an `Arr` of segment lenses, so editing, adding, or reordering a word rewrites the source.

`Reg` is a bidirectional regex-lens algebra: `copy` / `lit` / `seq` / `alt` / `opt` / `star`, each combinator a lens. Leaves compile to a Brzozowski automaton and the grammar to a tagged Thompson program run as a PikeVM, so an unambiguous grammar parses in linear time without backtracking. Ambiguity is rejected at construction with a witness string that parses two ways (`copy(/\d+/).then(copy(/\d+/))` names `"00"`). A write whose source is off-language is rejected instead of clobbering the rest. `bind` exposes each named capture as an editable handle (`copy` → `Writable<Str>`, `star` → `Arr`); the backward pass reprints the source, preserving anything the view never named. `reg.optic()` exposes a grammar as an `Optic<string, V>` for `cell.lens(...)`. A `star`'s element cells are lenses, so grammars nest: a line-splitter over a cell-splitter makes a grid editable in both dimensions.

<md-reg-table></md-reg-table>

`spans` reports where each capture sits in the source, so the parse can be drawn onto the string. Below, the coloured decomposition is `get`; the field controls drive `put`. Break the shape and the lens stops writing.

<md-reg-log></md-reg-log>

Compose a grammar's word cells with `caseFold` for case-preserving find/replace: the grammar locates words, `caseFold` carries each occurrence's case (UPPER / lower / Title).

<md-reg-rename></md-reg-rename>

Because `reg.optic()` is an `Optic`, one string can be edited through several grammars at once. Each pane is `source.lens(canonical, format(other))` — the same key/value list as a URL query, as `key: value` lines, and as a compact form.

<md-reg-formats></md-reg-formats>

The playground: pick a grammar a single-pass parser can't handle, watch the parse re-derive as you type, and see ambiguous grammars rejected with the input that would parse two ways.

<md-reg-playground></md-reg-playground>

Editing JSON, YAML, TOML, and EDN through one hub. The parsers are error-tolerant, so a broken pane stops writing the hub but keeps absorbing the other panes' edits.

<md-syntax-lens></md-syntax-lens>

## Schema evolution

A migration is a `pipe` of small lenses (`renameField`, `addField`, `nestFields`, `splitField`, `mapField`). Each step keeps what it drops in a complement, so the whole composition round-trips even where individual steps are lossy.

```ts
const toV2 = pipe(
  renameField("text", "title"),
  mapField("done", widenToTriState), // boolean ⇄ "todo"|"doing"|"done"
  addField("owner", "Ada Lovelace"), // a field older schemas can't represent
);
```

<md-schema-evolution></md-schema-evolution>

## Large & costly data

To work with large or costly data, the graph propagates handles instead of values. A `Canvas` carries an RGBA float texture; the graph compares a monotonic `epoch` on the handle.

<md-canvas-graph></md-canvas-graph>

A `Field<T>` is the same idea with a generic `T`. `Field<Vec>` runs Gray–Scott reaction–diffusion: `field.evolve(kernel)` steps the PDE, `field.colormap(V)` is a `Field → Canvas` lens, and `field.regionMean(box)` is a `num` cell.

<md-reaction-diffusion></md-reaction-diffusion>

## Approximate inverses

When the inverse has no closed form, the backward pass runs a solver, still one pass from the outside. An N-link arm is a `Vec.lens` running inverse kinematics on each write.

<md-ik></md-ik>

## Learning

Each layer is a lens over its weight cell. Forward computes `act(W·x + b)`. Backward takes `dL/da`, writes a gradient step to the weight cell, and returns `dL/dx`. Composing layers composes the backward passes in reverse, which is reverse-mode autodiff. There is no optimiser object and no training loop; one gradient step is a single backward write.

```ts
const net = lensNet([2, 16, 16, 1]); // input cell → layer lenses → logits cell
net.input.value = x;                 // forward: read the prediction
net.logits.value = prediction - y;   // backward: the engine backprops onto every weight cell
```

Finite-difference checks in the test suite confirm the backward write equals the true gradient on every layer.

A 2D classifier. The background is the predicted class probability over the plane, so the decision boundary forms as it trains. Ringed points are held-out test data (green = correct). Drag, add, or flip points and re-train.

<md-classify-points></md-classify-points>

The same net, wider, on raw pixels. Draw a shape; the bar is the live P(circle). Training data is a stream of generated shapes, so the label is whatever the generator drew. `dream` runs the same lens with weights frozen: the cotangent flows past the fixed weights to the input cell, so gradient-ascending the pixels paints the prototype for "circle".

<md-classify-pixels></md-classify-pixels>


## Animation

The animation runtime is built on generators. A generator yields control up; the runtime passes `dt` back down as the resume value.

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

The runtime calls `.next(dt)`; generators compose by calling each other for sequencing, parallelism, and time scope.

<md-transitions></md-transitions>

A generator can pull `dt` and forward a changed value: slow motion, reverse, pause, jitter.

```ts
function* halfSpeed<R>(gen: Animator<R>): Animator<R> {
  let r = gen.next(0);
  while (!r.done) r = gen.next((yield) * 0.5);
  return r.value;
}
```

To wait without a fixed duration, a generator yields `(wake) => dispose`; the runtime parks it until `wake(value)`.

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

Sequencing is `yield*`, parallelism is `yield [a, b, c]`. Cancellation is cooperative through `.until(stop)` or hard via `gen.return()`; `finally` runs either way.

<md-cancel></md-cancel>

`cut(v)` is Prolog's cut: a child returning it settles its group with `v` and cancels its siblings. `race`, `firstN`, `firstMatching`, `anySuccess`, and `allSettled` are each one closure over it.

```ts
function* race(...kids) {
  return yield kids.map(k => commit(k));
}
```

<md-rand></md-rand>

Every value signal has `.to(target, dur, ease?)`, a chainable tween that is also an animator.

```ts
yield* x.to(100, 0.5, easeInOut);
yield* x.from(0).to(100, 0.5).to(0, 0.5).until(stop);
```

`spring`, `toward`, and `attract` pull toward a reactive target; `wave` is closed-form motion and `driven` is the escape hatch.

<md-behaviors></md-behaviors>

`when(sig)` parks until truthy, `untilChange(sig)` until the next change. `play(p)` lifts a number, array, generator, suspend function, or signal into one surface.

```ts
spring(w, rest).until(dragging);
play([lane0, lane1, lane2]).until(stop);
play(0.5).then(fadeIn(shape, 0.3));
loop(() => fadeInOut(c)).until(done);
```

<md-circuit></md-circuit>

A row of cards, each width behind a `clamp(MIN_W, ∞)` edge so a handle can't drag it below the minimum.

<md-layout-demo></md-layout-demo>

A centroid, mean rotation, and mean scale animated in parallel.

<md-choreography></md-choreography>

A timeline is a clock with clips over `(at, dur)` ranges, each exposing a normalized `t`. `yield* tl` runs the clock to the total duration.

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

A `claim` is a labeled boolean over a predicate, composing with `.and` / `.or` / `.not` / `.during` / `.before` because it is itself a cell.

```ts
const fadeIn = scope("fadeIn", function* (s, dur) { /* ... */ });

const bounded  = claim(c.opacity).stays.in([0, 1]).during(fadeIn);
const reaches1 = claim(c.opacity).becomes.equal(1).during(fadeIn);

loop(() => fadeIn(c, 0.3));
```

The debugger lays the trace (a gantt of factory invocations) beside `α(t)` coloured by author, with the claim strips on the same axis. A buggy `nudge` overshoots `α = 1`.

<md-debugger></md-debugger>

`.to` dispatches on traits: `tween`, `spring`, `toward`, and `attract` read `linear`, `lerp`, and `metric` from each class's `static traits`.

<md-lerps></md-lerps>

A new value type is one class with a trait dict.

```ts
class Polygon extends Cell<PolygonValue> {
  static traits = {
    lerp: lerpPolygon,
    equals: equalsPolygon,
  };
  to(target, dur, ease?) { return tween(this, target, dur, ease); }
}
```

`polygon.to(target, dur)` then works on the same machinery; adding `linear` and `metric` brings `spring`, `toward`, and `attract` along.

<md-morph></md-morph>

A centroid is an ordinary cell, so two animations can share one position, the motion their per-frame mean.

```ts
const c = centroid(a, b, c, d);
yield* c.to({ x: 200, y: 100 }, 1);
```

<md-mix></md-mix>

`tex` renders MathML through Temml; `part()` markers become addressable child shapes with their own transform, opacity, and colour.

```ts
const eq = tex`E = ${part("M")} c^2`;
yield* eq.parts.M.translate.to({ x: 0, y: -20 }, 0.4);
```

<md-tex-demo></md-tex-demo>

<md-tex-live></md-tex-live>

`marker.register("id")` and `<md-marker sym="id">` share one `marker.active` cell, a derived OR over every binding. `yield* play(marker.active)` parks until any rendering activates it. Three markers tie this text to the diagram: <md-marker sym="osc:gamma">damping</md-marker>, <md-marker sym="osc:A">amplitude</md-marker>, <md-marker sym="osc:omega">frequency</md-marker>.

<md-oscillator></md-oscillator>

`code` is `tex`'s sibling, a reactive source in a text wrapper. `c.morphTo(src, dur)` diffs lines then tokens, wraps the changed ranges, and interpolates their size.

<md-code></md-code>

The `(wake) => dispose` shape carries to native primitives: `untilAnimation(a)` wakes on a WAAPI finish, `untilInView(el)` on intersection, `scrollProgress()` is a lazy scroll signal. `native(el, keyframes, opts)` wraps `Element.animate` as an animator.

<md-waapi-demo></md-waapi-demo>

The same pipeline drives a `<canvas>` with a per-frame loop.

<md-canvas-field></md-canvas-field>

A spring over a transform, with phantom poses trailing behind.

<md-trails></md-trails>

Anchor points track a shape as it animates.

<md-anchors></md-anchors>

A geometric construction on a timeline: axis, ticks, labels, bounding box, centroid.

<md-centering></md-centering>

The runtime's test suite, run in the browser on a fresh `Anim` driven by `step(dt)`.

<md-runtime-tests></md-runtime-tests>

## Dragging

Inspired by [Dragology](https://joshuahhh.com/dragology/) and its `d` DSL, re-expressed with reactive lenses.

```ts
d.fixed(pointer, state, locate); // a reachable model
d.vary(pointer, place, locate); // a continuous family — place is the backward lens
d.closest([...]); // pick the smallest residual          d.between(pointer, [...], mix); // blend the hull
d.whenFar(near, far, r); // switch on distance            d.withFloating(pointer, b); // float the handle
```

`order.indexOf(tile)` is a writable `Num` lens (read = the index, write = a reorder).

```ts
const idx = order.indexOf(tile);          // Writable<Num> — read the index, write a reorder
const pos = Vec.lens(idx, place, locate); // one layout map: forward renders, backward locates
```

<md-reorder></md-reorder>

`d.between` is the continuous sibling of `d.closest`. A node's three presets are its own corners, so dragging any node steers the morph.

```ts
const corners = anchors.map((a, i) => d.fixed(pointer, basis[i], () => a));
d.between(pointer, corners, mix); // weights → every node is the weighted blend
```

<md-twisted></md-twisted>

```ts
const pos = mix(tent(playhead), keyframes); // continuous morph
const snap = nearestIndex(playhead, ticks); // discrete settle
```

<md-algebra></md-algebra>

Drag a planet to any orbit around either sun: each orbit is a `vary` track (project the pointer onto the ring), `closest` picks across both suns.

```ts
d.closest(ORBITS.map((o, i) =>
  d.vary(pointer, p => placeOnOrbit(i, p), m => posOf(i, m)))); // discrete × continuous
```

<md-planets></md-planets>

```ts
d.withFloating(pointer, d.vary(pointer, place)); // preview = the previewed tree, drop = commit it
```

<md-nested></md-nested>

The puck's behaviour is three `d` specs selected by a knob, so the same algebra applies reflexively.

```ts
const by = [d.closest(grid), d.vary(free), d.vary(ring)];
const spec = select(mode, by); // closest snaps, vary frees — no rewiring
```

<md-spec></md-spec>

## Collaborative documents

An adapter to [Automerge](https://automerge.org/) CRDT documents makes a doc into writable cells or a deep `store`. Because lenses compose, multiple UIs over one document chain and stack as views A ▸ B ▸ C, each a set of lenses over the previous:

- canvas — a spatial view (A): drag a shape to write its `x/y`.
- inspector — one card per shape, bound to `shapeLens(doc, id)` (B), with raw `x/y/w/h/hue/sat/lum` controls on top.
- spreadsheet — a view of the inspector (C): the same shape lens reprojected through centre, area, aspect ratio, hex.

```ts
const shape  = doc.lens(byId(id));         // A ▸ B   the inspector's per-shape lens
const area   = shape.lens(areaOptic);      // B ▸ C   edit it and w·h scale, aspect held
const hex    = shape.lens(hexOptic);        // B ▸ C   the HSL triple as one #rrggbb
```

Editing `area` scales the box on the canvas; a slider in the inspector moves the centre in the sheet. Edits run both ways, across tabs too. Copy the scene id (under the canvas) into a second tab to collaborate.

<md-scene-canvas></md-scene-canvas>

<md-scene-inspector></md-scene-inspector>

<md-scene-table></md-scene-table>

## Cycles & constraints

Some relationships have no source end: a four-bar linkage or cloth simulation isn't a lens. These run as cyclic regions (strongly connected components) solved iteratively and written back in one `batch()`.

### Propagator networks

A propagator declares the cells it reads and writes and narrows the writes via `merge` (lattice meet). Meet only narrows, so termination follows from the lattice.

```ts
const est = intervalCell();
solve(...sensors.map(m => propagator([m], [est], () => merge(est, m.value))));
```

<md-partial></md-partial>

Layout combinators.

```ts
solve(
  col(container, [{ box: toolbar, min: 44, max: 44 }, body], { gap: 10, padding: 10 }),
  row(body, panes, { gap: 10, align: "stretch" }),
);
```

<md-flex></md-flex>

A 9×9 sudoku with 27 `allDifferent` relations to narrow to a solution (or a contradiction).

<md-prop-sudoku></md-prop-sudoku>

Type inference by the same approach.

```ts
function unify(a: TypeNode, b: TypeNode) {
  return [
    ...same(a.tag, b.tag), // intersect candidate sets both ways
    ...(a.dom && b.dom ? unify(a.dom, b.dom) : []),
    ...(a.cod && b.cod ? unify(a.cod, b.cod) : []),
  ];
}
```

<md-prop-types></md-prop-types>

Graph layout on the interval lattice: `order(layer(u), layer(v), 1)` per edge, narrowed to each layer's longest path.

```ts
const layer = rank(graph); // longest-path = order() atoms run to a fixpoint
const place = layered(graph, { direction: "TB" }); // + crossings + coordinates
```

<md-sugiyama></md-sugiyama>

```ts
const inner = layered(cluster);          // lay out each subgraph
const meta = layered(clusters, { sizeOf: extentOf }); // then the clusters
```

<md-subgraphs></md-subgraphs>

### Physics & numerical constraints

Augmented Vertex Block Descent with small constraints (`distance`, `angle`, `onCircle`, `generic`, …).

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

<md-sketchpad-live></md-sketchpad-live>

`physics({ gravity })` bakes a time-stepper into the pipeline, advanced with `step(dt)`.

<md-cloth></md-cloth>

`gap`, `inside`, and `gravity` as constraints and forces.

<md-particles></md-particles>

<md-rigid-stack></md-rigid-stack>

<md-rigid-rope></md-rigid-rope>

A four-bar linkage solved by a vector-loop Newton step each frame, seeded from the last.

<md-loop></md-loop>

Each circle is fixed to `(R·sin t, R·sin 2t / 2)` by a `generic` constraint. Near the origin both branches are admissible and the solver can flip.

<md-figure8></md-figure8>

Three numbers and one `generic` constraint solve `a² + b² = c²`.

<md-equation></md-equation>

Constraints as loci: `onCircle(P, center, r)`, `collinear(P, A, B)`.

<md-incidence></md-incidence>

A slider-crank: two distances and a `collinear` over six cells, four pinned.

<md-slider-crank></md-slider-crank>

Force-directed layout: edge springs plus pairwise `gap` constraints.

<md-graph></md-graph>

A constraint cluster exposed as a `Writable<Vec>` via `exposeVec`; `procrustes(tips)` lays a move/spin/size frame over three fingertips.

<md-network-lens></md-network-lens>


## ~ Scratchboard ~

Mostly rough demos that aren't very good yet and may not survive the final cut.

`Array<Num> ⇌ Array<BinCount>` keeps counts and drops positions; transport moves the fewest samples across the nearest boundary.

<md-histogram></md-histogram>

`merge` folds many writers into one source. An idempotent meet, a last-writer join, tri-state bus resolution, a sum.

```ts
const bus = source.merge(vals => vals.reduce(combine, "Z"));
```

<md-merge></md-merge>

`mix(weights, branches)` reads as a weighted sum and writes back split by weight. `select` and `crossfade` are the same lens with control on the weight simplex.

<md-select></md-select>

A lens is itself a value, so it can live in a cell. `through(src, frame)` tracks the frame forward and inverts whatever it holds backward.

<md-lens-algebra></md-lens-algebra>

Inverse EQ: drag the response curve and `factor` solves the band gains, which an `effect` pushes onto live filters.

<md-bireactive-eq></md-bireactive-eq>

A Soulver-style calculator. Mark a leaf as the unknown, then type or drag any result that depends on it; a 1-D Newton solve back-fills the leaf and rewrites it in place.

<md-soulver></md-soulver>

An optical bench: the beam is one `derive` that reflects off the nearest surface each step. Mirror midpoints are `mean` lenses; the ellipse's semi-major axis is a `Vec.lens`.

<md-optical-bench></md-optical-bench>

A self-similar tree from one rule (branch angle, length ratio). Dragging a node inverts through a multi-output lens that rewrites the rule, so every level updates.

<md-fractal-tree></md-fractal-tree>

A cubic Bézier read as `{start, end, startTangent, endTangent}` instead of raw control points.

<md-bezier-gestalt></md-bezier-gestalt>

<!-- a cubic is four DOF; each spline basis is a change of coordinates over shared coefficients, so handles are a `Vec.lens` via the basis matrix. -->

<!-- <md-curve-bases></md-curve-bases> -->

A confocal family of ellipses: two foci and a derived shape. `ellipse(center, a, b, rotation?)` takes a reactive value on every parameter.

```ts
const aE = derive(() => (r1.value + r2.value) / 2);
const bE = derive(() => Math.sqrt(aE.value ** 2 - cDist.value ** 2));
s(ellipse(center, aE, bE, rot, { stroke: ACCENT }));
```

<md-confocal></md-confocal>

Kepler orbits. The forward path solves `M = E − e·sin E` numerically; the backward is closed-form.

<md-kepler-system></md-kepler-system>

A waveform and its spectrum: `coeffs.lens(iso(synthesize, analyze))`, an invertible change of basis.

<md-fourier></md-fourier>

Each clock hand is an affine view of `time`, each tip a polar point. Drag a hand to scrub time.

```ts
const angle = time.affine(τ / period, -π / 2);
const tip   = polar(center, len, angle); // drag a tip to scrub time
const tokyo = time.affine(1, 9 * 3600);   // a second timezone
```

<md-clock></md-clock>

Units as a vector space: `times` / `div` / `pow` over dimension vectors.

<md-unit-algebra></md-unit-algebra>

Change propagation made visible: a write runs backward to the sources it derives from, then forward over the affected cone.

<md-propagation></md-propagation>
