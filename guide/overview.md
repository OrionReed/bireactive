---
title: Overview
---

# What is bireactive?

Bireactive is a signals-style reactive system where **edges run both ways**. An
ordinary reactive value is read-only downstream: you write a source, and
everything derived from it recomputes. Here a derived value can also be
*written* — the engine runs the derivation backward to update its sources.

```ts
import { cell } from "bireactive";

const celsius = cell(20);
const fahrenheit = celsius.lens(
  c => (c * 9) / 5 + 32, // forward
  f => ((f - 32) * 5) / 9, // backward
);

fahrenheit.value; // 68
fahrenheit.value = 212; // write the derived end…
celsius.value; // 100 — …and the source updates to match
```

New here? Start with the [Getting Started](getting-started.md) guide. The live
[demo gallery](https://orionreed.github.io/bireactive/) shows these ideas in
motion.

## What can it do?

The library is organized into a handful of domains, each a group in this API
reference:

### Reactivity

The reactive core: writable {@link cell}s, read-only {@link derive}d values,
side-effecting {@link effect}s, and the bidirectional {@link lens}.
{@link Cell.merge} folds many writers into one source; {@link network} builds constraint-style
sub-graphs; {@link store} gives a deep, lens-backed proxy over nested state; and
{@link batch} groups writes.

### Values

Typed value cells with field lenses and domain operators, so `point.x` or
`color.lightness` is itself a writable cell. Includes {@link Num}, {@link Vec},
{@link Box}, {@link Color}, {@link Str}, {@link Bool}, {@link Range},
{@link Matrix}, {@link Transform}, {@link Pose}, {@link Tri}, {@link Field},
{@link Flags}, {@link Arr}, {@link Reg}, {@link Canvas}, and {@link Audio}.

You do not need to use value classes, but they are a convenient way to create value types with well-known methods and cross-type lenses that reads left-to-right.

### Lenses

Free-function lenses that compose values into writable derived views: the
midpoint {@link mean} of points, a {@link mix} or {@link crossfade}, geometric
relations, point-cloud fits, and numerical solvers.

### Animation

Time-based motion: {@link spring} physics, {@link tween} interpolation, and
generator-driven animators.

### Shapes

Drawable geometric primitives for building diagrams and visualizations.

### Rendering

Getting values onto the screen: SVG {@link Diagram}s, DOM attribute binding,
syntax-highlighted {@link code}, and animatable {@link tex} math typesetting.

### Utilities

Assorted helpers, including tree walking and assertions.