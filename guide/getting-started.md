---
title: Getting Started
---

# Getting Started

## Install

```sh
npm install bireactive
```

## Cells, derivations, effects

A {@link cell} is a writable reactive value. {@link derive} builds a read-only
value from others; {@link effect} runs a side effect whenever what it reads
changes. Dependencies are tracked automatically — just read a value to subscribe
to it.

```ts
import { cell, derive, effect } from "bireactive";

const celsius = cell(20);
const fahrenheit = derive(() => (celsius.value * 9) / 5 + 32);

effect(() => console.log(`${celsius.value}°C = ${fahrenheit.value}°F`));
// logs: 20°C = 68°F

celsius.value = 100; // logs: 100°C = 212°F
```

Writing a `derive`d value is an error — it has no inverse:

```ts
fahrenheit.value = 32; // ✗ throws: cannot write to a computed
```

## The bidirectional step: lenses

A {@link lens} is a derivation with an inverse, so the derived end is writable
and the change flows back to the source. A two-argument backward function may
read the current source; a one-argument one reconstructs it from the view alone.

```ts
import { cell } from "bireactive";

const celsius = cell(20);
const fahrenheit = celsius.lens(
  c => (c * 9) / 5 + 32,
  f => ((f - 32) * 5) / 9,
);

fahrenheit.value = 212;
celsius.value; // 100
```

This is the core idea. Where two-way data binding wires up ad-hoc setters,
a lens is a single composable object whose forward and backward directions stay
in sync by construction.

## Typed values

Values also come as small classes — {@link Num}, {@link Vec}, {@link Box},
{@link Color}, and more — whose fields and operators are themselves lenses, so
you can read and write deep into them.

```ts
import { vec, mean } from "bireactive";

const a = vec(0, 0);
const b = vec(10, 0);

const mid = mean([a, b]); // writable midpoint
mid.value = { x: 5, y: 10 }; // drag the midpoint up…
a.value; // { x: 0, y: 10 } — both ends move to keep it the midpoint

// Fields are lenses too:
a.x.value = 3; // writes straight through to `a`
```

## Reacting to changes

Use {@link effect} to push values somewhere — the DOM, a canvas, the console.
The effect re-runs only when something it read actually changes.

```ts
import { cell, effect } from "bireactive";

const label = cell("hello");
const el = document.querySelector("#out")!;

effect(() => {
  el.textContent = label.value;
});

label.value = "world"; // the element updates
```

For richer output, see the **Rendering** group ({@link Diagram} and the DOM
helpers) and the live [demo gallery](https://orionreed.github.io/bireactive/).

## Where next

- [Overview](overview.md) — a map of every capability.
- Browse this reference by domain: **Reactivity**, **Values**, **Lenses**,
  **Animation**, **Shapes**, **Rendering**.
- [Demo gallery](https://orionreed.github.io/bireactive/) — interactive examples.
