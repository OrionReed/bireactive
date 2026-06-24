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


## A brief tour of lenses
Lenses are a way to express bi-directional relationships. Many lenses are easy to write, some are more complex. This section hopes to provide a brief overview of the simplest to most complex lenses.

### Isomorphic lenses
Isomorphic lenses are the simplest kind of lens, where for every value of the source, there is a unique value of the target and vice versa. For example `a+10 = b ⇌ b-10 = a` can be viewed as a lens:

$$a \begin{array}{c} \xrightarrow{\;a+10\;} \\[-1.6ex] \xleftarrow[\;b-10\;]{} \end{array} b$$


```ts
let p = a;
for (let i = 0; i < N; i++) p = p.rotate(θ, pivot).scale(k, pivot);
```

<md-invertible></md-invertible>

Each field is a lens onto one SI-base cell, `si.lens(u.fromBase, u.toBase)`.

```ts
const km     = meter.scaled(1000);                       // prefix
const knot   = nmi.div(hour);                            // compound
const litre  = meter.pow(3).scaled(0.001);               // m³ → L
const newton = kilogram.times(meter).div(second.pow(2)); // kg·m·s⁻²
const joule  = newton.times(meter);                      // energy
const watt   = joule.div(second);                        // power
```

<md-units></md-units>

Coordinate spaces via a `world.lens(fwd, bwd)`: euclidean, oblique, polar, log-polar, toroidal.

<md-coordinate-spaces></md-coordinate-spaces>

### Lossy lenses

`clamp`, `quantize`, and `snap` discard information idempotently, so the backward direction just projects again:

```ts
const t  = num(0.5);
const tC = t.clamp(lo, hi); // lo, hi can be cells too
const tQ = tC.quantize(0.1);
```

<md-clamp-quantize></md-clamp-quantize>

```ts
const angle = time.affine(τ / period, offset);
const pos   = polar(sun, dist, angle); // drag any body to scrub time
```

<md-solar-system></md-solar-system>



RGB ⇌ HSV, bidirectionally:

<md-color-hsv></md-color-hsv>

<md-gears></md-gears>


Exact bijections — reflections, rotations, scales, affine maps, polar/cartesian, unit conversions — have closed-form inverses.


```ts
const a = num(130);
const b = a.affine(-1, L₁);
const c = b.affine(-1, L₂);
```

<md-pulley></md-pulley>


<md-function></md-function>

<md-mirror></md-mirror>

<md-conformal-disc></md-conformal-disc>


### Cross-type lenses

An edge's two ends needn't share a type. With a boolean target, forward is a predicate (`v > t`, `box.contains(p)`, `a ≈ b`) and backward nudges the source to satisfy it:

<md-bool-bridges></md-bool-bridges>


`(Range, Range) ⇌ AllenRelation` reads two intervals as one of Allen's thirteen relations; setting a relation reshapes the second interval:

<md-allen></md-allen>

same idea but with a `(Box, Box) ⇌ RCC-8` relation.

<md-rcc8></md-rcc8>

### 1-1, N-1, and M-N lenses

A residual edge loses information but keeps the lost part in the source. A centroid reads as the average of its points; writing it moves them all evenly.

A whole figure can be a small DAG of these. Only the three vertices are roots; the edge-midpoints and the centroid are each a `mean` lens, and the medial triangle is just lines between the midpoints. It feels n-ary — grab any point and the rest reorganise — but every backward step is one average:

<md-triangle></md-triangle>


<md-handles></md-handles>

A backward function is a closure and can read other cells. The midpoint reads each handle's `dragging`, so a held endpoint stays pinned while the free end absorbs the difference.

<md-multitouch></md-multitouch>


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

`meanSpread(inputs) ⇌ {mean, spread}` any linear type with a metric — vectors, colours, poses:

<md-traits-cross-domain></md-traits-cross-domain>

A Sankey with a cycle: flow fans out from a hub through three branches into a collector, part of it recirculates around the bottom, and the rest leaves as output. Conservation (in = out) holds at every node, so the whole picture is pinned by four free numbers — the three branch flows and the recirculation — and every other width derives from them. Those widths are lenses: drag a branch to set its flow, drag the hub or collector to scale all of it at once, drag the return band to set how much recirculates (the input takes up the slack). Conservation stops being a constraint to solve and becomes the coordinate system:

<md-sankey></md-sankey>

### "Symmetric" lenses

// lenses that need complement state

## Collections & Hierarchical Values

We can express interactive todo lists as a tree of Tri values (a `true | false | "mixed"` value). Clicking a checkbox propagates upward to update the parent and ancestor nodes, and downward to update the children.

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


An array cell, `arr(items)`, has writeable lens views (`filter` / `sortBy` / `groupBy`) allowing you to do things like:.

```ts
const visible = tasks.filter(is(c => c.value.done, false));
const board   = visible.groupBy(c => c.value.status, { order: COLUMNS });
```


The predicate that derives the view, `is(c => c.value.done, false)`, runs forward (test) and backward (assert). A drop is `board.move(card, column, i)`: its backward pass writes the group field, splices the base order and asserts the filter.

<md-kanban></md-kanban>


<md-containment-forest></md-containment-forest>


## Text


A `Template` is a multi-parent lens over typed slot cells — `lit₀ slot₀ lit₁ … litₙ` — rendering forward and parsing back. Each slot carries a `string ⇄ T` codec.

<md-madlibs></md-madlibs>


<md-route-params></md-route-params>


Strings can't recover dropped detail from the result alone, so a lossy projection carries a private _complement_ state. Editing any pane updates the source; the detail each projection dropped is recovered via the complement.

<md-string-pipeline></md-string-pipeline>

`Str` has `trim` / `reverse` / `slice` / `split`. Where `split(/\s+/)` returns an `Arr` of positional segment lenses, so editing a word, or adding/removing/reordering one, rewrites the source string.

`Reg` lifts that idea into a small bidirectional regex-lens algebra — `copy` / `lit` / `seq` / `alt` / `opt` / `star`, each combinator a lens. Leaves compile to a real regular automaton (Brzozowski derivatives), and the whole grammar compiles to a tagged Thompson program run as a PikeVM, so any *unambiguous* grammar parses in **linear time, no backtracking** — common-prefix alternations (`INFO|INes`) and longest-match splits (`copy(/\d\d/).then(digits())`) included. Genuine ambiguity is rejected at *construction* with a concrete witness string that would parse two ways (`copy(/\d+/).then(copy(/\d+/))` names `"00"`), and the most common overlaps are caught one step earlier, in the TypeScript types. A write whose source is off-language is rejected instead of clobbering the rest. `bind` exposes every named capture — including captures *inside* an `alt` branch — as an editable handle (a `copy` becomes a `Writable<Str>`, a `star` an `Arr`); the backward pass reflectively reprints the source, preserving everything the view never named. And `reg.optic()` exposes a grammar as a first-class `Optic<string, V>`, so it drops straight into `compose(...)` and `cell.through(...)` and chains with the rest of the lens algebra. Because a `star`'s element cells are themselves lenses, grammars compose too: an outer line-splitter over an inner cell-splitter turns one string into a grid editable in *both* dimensions — add, remove, reorder rows and cells — with every edit reprinted into the single source.

<md-reg-table></md-reg-table>

And `spans` reports where each named capture sits in the source, so the parse can be drawn directly onto the string: the coloured decomposition below is the `get` direction made visible, while the field controls — including an enum `select` for the level — drive `put`. Break the shape and the lens simply stops writing.

<md-reg-log></md-reg-log>

Composition pays off twice. Compose a grammar's word cells with `caseFold` and you get the textbook case-preserving find/replace for free — the grammar locates the words, `caseFold` carries each occurrence's own case (UPPER / lower / Title), and neither lens knows about the other:

<md-reg-rename></md-reg-rename>

And because `reg.optic()` is just an `Optic`, one backing string can be edited through several grammars at once. Each pane below is `source.through(canonical, format(other))` — the same key/value list rendered as a URL query, as `key: value` lines, and as a compact form, all kept in sync:

<md-reg-formats></md-reg-formats>

What makes all of this safe is the two-sided guarantee underneath. A lens is only a function if its grammar is unambiguous, so the parser accepts the full unambiguous regular class in linear time — and anything genuinely ambiguous is refused at *construction*, with a concrete witness string. The playground makes both halves visible: pick a grammar a single-pass parser can't handle (a common-prefix alternation, an optional longest-match tail, fixed-width fields with no delimiters), watch the coloured parse re-derive as you type, then see four tempting-but-ambiguous grammars get rejected — each naming the exact input that would parse two ways.

<md-reg-playground></md-reg-playground>

Here is a (slightly broken) attempt to reactively edit multiple syntaxes of JSON, YAML, TOML, and EDN.

The parsers are error-tolerant, so a broken pane stops writing the hub but keeps absorbing the other panes' edits around its error spans.



<md-syntax-lens></md-syntax-lens>

### A document you can run backwards

A Soulver-style calculator-as-document.

<md-soulver></md-soulver>

## Schema Evolution

A schema migration is a `pipe` of small, individually-trivial lenses — `renameField`, `addField`, `nestFields`, `splitField`, a value-level `mapField` — and because each step carries a private *complement* holding whatever it dropped, the whole composition round-trips even where individual steps are lossy. Were this a stateless lossy migration, it would need to fabricate the discarded detail on the way back in a way that breaks composition.

```ts
const toV2 = pipe(
  renameField("text", "title"),
  mapField("done", widenToTriState), // boolean ⇄ "todo"|"doing"|"done"
  addField("owner", "Ada Lovelace"), // a field older schemas can't represent
);
```


<md-schema-evolution></md-schema-evolution>


## Bi-reactivity over large or costly data

While the reactive graph usually propagates concrete values, if we want to work with large or costly data, we can instead propagate "handles" through the graph. A `Canvas` value carries an RGBA float texture while the reactivity graph compares a monotonic `epoch` in the handle. 

<md-canvas-graph></md-canvas-graph>



A `Field<T>` is similar to the `Canvas` value but with a generic `T` instead of pixels. `Field<Vec>` runs Gray–Scott reaction–diffusion: `field.evolve(kernel)` steps the PDE, `field.colormap(V)` is a `Field → Canvas` render lens, and `field.regionMean(box)` is a plain `num` cell:

<md-reaction-diffusion></md-reaction-diffusion>


## Numerical Approximations

When the inverse has no closed form, the backward direction runs a solver to approximate it — still a single pass from the outside. An N-link arm is a `Vec.lens` running inverse kinematics on each write:

<md-ik></md-ik>



<md-loop></md-loop>

## Cycle Handling & Fixpoint Convergence

Some relationships have no source end at all — a four-bar linkage or cloth simulation are not meaningfully expressible as lenses. We can still express these systems in a reactive graph by marking or discovering cyclic regions (strongly connected components) and solving them iteratively and writing back to the graph as a single batch() operation.

### Propagator Networks

A propagator declares which cells it reads and writes and narrows the writes via `merge` (lattice meet). Because meet only narrows, termination is guaranteed by the structure of the lattice.

Estimate one quantity from several independent measurements.

```ts
const est = intervalCell();
solve(...sensors.map(m => propagator([m], [est], () => merge(est, m.value))));
```

<md-partial></md-partial>

This approach works nicely for layout combinators too.

```ts
solve(
  col(container, [{ box: toolbar, min: 44, max: 44 }, body], { gap: 10, padding: 10 }),
  row(body, panes, { gap: 10, align: "stretch" }),
);
```

<md-flex></md-flex>

Here is a 9×9 sudoku with 27 `allDifferent` relations to narrow to a solution (or a contradiction).

<md-prop-sudoku></md-prop-sudoku>

Or an analagous approach to type inference.

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

The interval lattice also works for structured graph layout: `order(layer(u), layer(v), 1)` for each edge `u → v`, and the solver narrows each layer to its longest reaching path.

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

### Numerical Constraints / Physics Simulation

Here is an implementation of Augmented Vertex Block Descent with a handful of small constraints (`distance`, `angle`, `onCircle`, `generic`, …) that can do n-iteration approximation of complex relationships.


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

A poor man's Sketchpad:

<md-sketchpad-live></md-sketchpad-live>



`physics({ gravity })` bakes a time-stepper into the pipeline advanced manually with `step(dt)`.

<md-cloth></md-cloth>


We can simulate basic physics with `gap`, `inside`, and `gravity` constraints/forces.

<md-particles></md-particles>

Or a full physics simulation.

<md-rigid-stack></md-rigid-stack>


<md-rigid-rope></md-rigid-rope>

The same setup on a 1D submanifold fixes each circle to `(R·sin t, R·sin 2t / 2)` by a `generic` constraint. Near the origin both branches are admissible and the solver can flip:

<md-figure8></md-figure8>

Nothing here is geometry-specific. Three numbers and one `generic` solve `a² + b² = c²`:

<md-equation></md-equation>

## Learning

Backpropagation *is* the lens pattern, taken literally. Each layer is a lens over its weight cell: the forward map computes the activation `act(W·x + b)`; the backward map takes the cotangent `dL/da`, deposits a gradient step on the weight cell, and passes `dL/dx` up to the previous layer. Stack the layers and you have a lens DAG `input → layer → … → logits` — and composing layers composes their backward passes in reverse, which is exactly reverse-mode autodiff: the `pipe` of the schema kit, over differentiable maps.

So there is no optimiser object and no hand-written training loop inside the net. **One gradient step is a single backward write:**

```ts
const net = lensNet([2, 16, 16, 1]); // input cell → layer lenses → logits cell
net.input.value = x;                 // forward: read the prediction
net.logits.value = prediction - y;   // backward: the engine backprops onto every weight cell
```

Writing the output cotangent to `logits` makes the engine run backprop down the whole chain and land an SGD update on each weight source — training is just bireactivity pointed at the parameters. (Finite-difference checks in the test-suite confirm the engine's backward write equals the true gradient on every layer.)

A 2D classifier you can watch learn. The background is the predicted class probability over the whole plane, so the decision boundary *forms* as it trains; ringed points are held-out test data, so generalisation is visible (green = correct). Drag, add, or flip points and re-train to watch it adapt.

<md-classify-points></md-classify-points>

The same net, wider, on raw pixels. Draw a shape and the bar is the live P(circle); the training data is an endless stream of procedurally-generated shapes, so the label is whatever the generator drew. **dream** is the *same lens run with the weights frozen*: the cotangent flows past the fixed weights to the input cell, so gradient-ascending the pixels paints the prototype the net associates with "circle". Fitting and inverting are one backward map.

<md-classify-pixels></md-classify-pixels>

## Animation

Before the bireactive experiments took off, this started as a tiny generator-based animation runtime — which I was very excited about, and still am. The idea is all based around _generators_. Generators yield control up; the runtime passes `dt` back down as the resume value:

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

The runtime calls `.next(dt)` and generators compose by calling each other — sequencing, parallelism, and time scope:

<md-transitions></md-transitions>

A generator can pull `dt` and forward a changed version — slow motion, reverse, pause, jitter:

```ts
function* halfSpeed<R>(gen: Animator<R>): Animator<R> {
  let r = gen.next(0);
  while (!r.done) r = gen.next((yield) * 0.5);
  return r.value;
}
```

To wait without a fixed duration, a generator yields `(wake) => dispose`; the runtime parks it until `wake(value)`:

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

Sequencing is `yield*` and parallelism is `yield [a, b, c]`. Cancellation is cooperative through `.until(stop)` or hard via `gen.return()`; `finally` runs either way:

<md-cancel></md-cancel>

`cut(v)` is Prolog's cut: a child returning it settles its group with `v` and cancels its siblings. `race`, `firstN`, `firstMatching`, `anySuccess`, and `allSettled` are each one closure over it:

```ts
function* race(...kids) {
  return yield kids.map(k => commit(k));
}
```

<md-rand></md-rand>

Every value signal has `.to(target, dur, ease?)`, a chainable tween that is also an animator:

```ts
yield* x.to(100, 0.5, easeInOut);
yield* x.from(0).to(100, 0.5).to(0, 0.5).until(stop);
```

`spring`, `toward`, and `attract` pull toward a reactive target; `wave` covers closed-form motion and `driven` is the escape hatch:

<md-behaviors></md-behaviors>

Others park until a signal acts: `when(sig)` for truthy, `untilChange(sig)` for the next change. `play(p)` lifts any playable thing (number, array, generator, suspend function, signal) into one surface:

```ts
spring(w, rest).until(dragging);
play([lane0, lane1, lane2]).until(stop);
play(0.5).then(fadeIn(shape, 0.3));
loop(() => fadeInOut(c)).until(done);
```

<md-circuit></md-circuit>

A row of cards, each width behind a `clamp(MIN_W, ∞)` edge so a handle can't drag it below the minimum:

<md-layout-demo></md-layout-demo>

Rigid group choreography: a centroid, mean rotation, and mean scale animated in parallel:

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

The debugger lays the trace — a gantt of factory invocations — beside `α(t)` coloured by author, with the claim strips on the same axis. A buggy `nudge` overshoots `α = 1`:

<md-debugger></md-debugger>

`.to` dispatches on traits: `tween`, `spring`, `toward`, and `attract` read `linear`, `lerp`, and `metric` from each class's `static traits`:

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

`polygon.to(target, dur)` then works on the same machinery; adding `linear` and `metric` brings `spring`, `toward`, and `attract` along:

<md-morph></md-morph>

`tex` renders MathML through Temml; `part()` markers become addressable child shapes with their own transform, opacity, and colour:

```ts
const eq = tex`E = ${part("M")} c^2`;
yield* eq.parts.M.translate.to({ x: 0, y: -20 }, 0.4);
```

<md-tex-demo></md-tex-demo>

<md-tex-live></md-tex-live>

Markers cross diagrams: `marker.register("id")` and `<md-marker sym="id">` share one `marker.active` cell, a derived OR over every binding. `yield* play(marker.active)` parks a generator until any rendering activates it. Three markers tie this text to the diagram — <md-marker sym="osc:gamma">damping</md-marker>, <md-marker sym="osc:A">amplitude</md-marker>, <md-marker sym="osc:omega">frequency</md-marker>:

<md-oscillator></md-oscillator>

`code` is `tex`'s sibling — a reactive source in a text wrapper. `c.morphTo(src, dur)` diffs lines then tokens, wraps the changed ranges, and interpolates their size:

<md-code></md-code>


The `(wake) => dispose` shape carries to native primitives: `untilAnimation(a)` wakes on a WAAPI finish, `untilInView(el)` on intersection, `scrollProgress()` is a lazy scroll signal. `native(el, keyframes, opts)` wraps `Element.animate` as a composable animator:

<md-waapi-demo></md-waapi-demo>

None of it is SVG-specific. The same pipeline drives a `<canvas>` with a per-frame loop:

<md-canvas-field></md-canvas-field>

A spring over a transform, with phantom poses trailing behind it:

<md-trails></md-trails>

A geometric construction on a timeline — axis, ticks, labels, bounding box, centroid:

<md-centering></md-centering>

The runtime's test suite runs in the browser on a fresh `Anim` driven by `step(dt)`:

<md-runtime-tests></md-runtime-tests>

## Misc ~~~~~~~~~~~~~~~~~

Loose demos that may not survive the final cut.

An optical bench: a beam from a draggable lamp bounces through a heterogeneous arrangement of flat mirrors and a concave elliptical mirror. The light path is one reactive `derive` that walks the ray surface-to-surface, reflecting off the nearest hit each step, so dragging the lamp, a mirror, or the ellipse's foci re-traces every downstream bounce at once. The controls are lenses too — each mirror's midpoint is a `mean` (drag it, both ends follow) and the ellipse's semi-major axis is a `Vec.lens` that projects the drag onto the major axis.

<md-optical-bench></md-optical-bench>

A clock: each hand an affine view of `time`, each tip a polar point:

```ts
const angle = time.affine(τ / period, -π / 2);
const tip   = polar(center, len, angle); // drag a tip to scrub time
const tokyo = time.affine(1, 9 * 3600);   // a second timezone
```

<md-clock></md-clock>

`merge` — many writers fold into one source through a fold over all contributions. An idempotent meet, a last-writer join, tri-state bus resolution, a sum:

```ts
const bus = source.merge(vals => vals.reduce(combine, "Z"));
```

<md-merge></md-merge>

`Array<Num> ⇌ Array<BinCount>` keeps counts, drops positions; transport moves the fewest samples across the nearest boundary:

<md-histogram></md-histogram>

A lens is itself a value, so it can live in a cell. `through(src, frame)` tracks the frame forward and inverts whatever it holds backward:

<md-lens-algebra></md-lens-algebra>

A fractal tree.

<md-fractal-tree></md-fractal-tree>

A constraint cluster oriented by `exposeVec` into a `Writable<Vec>`; `procrustes(tips)` lays a move/spin/size frame over three finger tips:

<md-network-lens></md-network-lens>

Constraints as loci — `onCircle(P, center, r)`, `collinear(P, A, B)`. Two incidences, two equal bars, a symmetry, and a right angle:

<md-incidence></md-incidence>

A slider-crank: two distances and a `collinear` over six cells, four pinned:

<md-slider-crank></md-slider-crank>

Force-directed layout: soft edge springs plus pairwise `gap` constraints:

<md-graph></md-graph>

Real Kepler orbits, still invertible: the forward path solves `M = E − e·sin E` numerically, the backward is closed-form:

<md-kepler-system></md-kepler-system>

A confocal family of ellipses: two foci and a derived shape; `ellipse(center, a, b, rotation?)` takes a reactive value on every parameter:

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

Any writable point can host a handle, including a derived one. Anchor points track a shape as it animates:

<md-anchors></md-anchors>

Units form a vector space under multiplication: `times`/`div` add and subtract dimension vectors and `pow` scales them; two quantities convert exactly when their vectors match:

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


A waveform and its spectrum:

<md-fourier></md-fourier>


<md-bireactive-eq></md-bireactive-eq>



`mix(weights, branches)` reads as a weighted sum and writes back split by weight. `select` and `crossfade` are the same lens with control on the weight simplex:

<md-select></md-select>


<md-skeletal-rig></md-skeletal-rig>

<md-propagation></md-propagation>


## Dragging

Inspired by [Dragology](https://joshuahhh.com/dragology/) and its `d` DSL. These demos explore whether the same algebra can be re-expressed using reactive lenses:

```ts
d.fixed(pointer, state, locate); // a reachable model
d.vary(pointer, place, locate); // a continuous family — place is the backward lens
d.closest([...]); // pick the smallest residual          d.between(pointer, [...], mix); // blend the hull
d.whenFar(near, far, r); // switch on distance            d.withFloating(pointer, b); // float the handle
```

`order.indexOf(tile)` is a *writable* `Num` lens
over it (read = the index, write = a reorder.

```ts
const idx = order.indexOf(tile);          // Writable<Num> — read the index, write a reorder
const pos = Vec.lens(idx, place, locate); // one layout map: forward renders, backward locates
```

<md-reorder></md-reorder>

`d.between` is the continuous sibling of `d.closest`. A node's three presets are just its own corners, so dragging *any* node steers the one morph.

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

Drag a planet to any orbit, around either sun: each orbit is a `vary` track (project the pointer onto the ring), `closest` picks across both suns.

```ts
d.closest(ORBITS.map((o, i) =>
  d.vary(pointer, p => placeOnOrbit(i, p), m => posOf(i, m)))); // discrete × continuous
```

<md-planets></md-planets>

```ts
d.withFloating(pointer, d.vary(pointer, place)); // preview = the previewed tree, drop = commit it
```

<md-nested></md-nested>

The puck's behaviour is itself three `d` specs selected by a knob, so the same lil bits of algebra can apply reflexively.

```ts
const by = [d.closest(grid), d.vary(free), d.vary(ring)];
const spec = select(mode, by); // closest snaps, vary frees — no rewiring
```

<md-spec></md-spec>


## Collaborative Documents

We can create an adapter to [Automerge](https://automerge.org/) CRDT documents, making automerge docs into writable cells or a deep `store`. 

Below there are 3 UIs with different schemas. It is not too hard to make multiple UIs for the same document, but because lenses compose, we can chain and stack lensed views together arbitrarily. So here we have views **A ▸ B ▸ C** where each is a collection of lenses over the previous ones:

- **canvas** — a spatial view of the doc (A): drag a shape to write its `x/y`.
- **inspector** — one card per shape, each bound to `shapeLens(doc, id)` (B), with raw `x/y/w/h/hue/sat/lum` controls composed on top of it.
- **spreadsheet** — a view *of the inspector*: the same shape lens, but reprojected through a different basis — centre, area, aspect ratio, hex (C).

```ts
const shape  = doc.through(byId(id));         // A ▸ B   the inspector's per-shape lens
const area   = shape.through(areaOptic);      // B ▸ C   edit it and w·h scale, aspect held
const hex    = shape.through(hexOptic);        // B ▸ C   the HSL triple as one #rrggbb
```

So editing `area` in the spreadsheet scales the box on the canvas; nudging a slider in the inspector moves the centre in the sheet. Edit in any view and the whole chain runs both ways — across tabs too. Copy the scene's id (shown under the canvas) into a second tab to collaborate.

<md-scene-canvas></md-scene-canvas>

<md-scene-inspector></md-scene-inspector>

<md-scene-table></md-scene-table>