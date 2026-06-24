# bi-reactive

[NPM](https://www.npmjs.com/package/bireactive) · [GitHub](https://github.com/OrionReed/bireactive) · [Demos](https://orionreed.github.io/bireactive/) · [API](https://orionreed.github.io/bireactive/api/)

A signals-like bidirectional reactive programming system where edges can go both ways. Forward and backward propagation are handled by the engine, with the same set of caveats as regular reactive programming.

## Install

```sh
npm install bireactive
```

Runtime dependencies [`temml`](https://temml.org) (for `tex`), [`Automerge`](https://automerge.org) and
[`prism-esm`](https://github.com/orionhealthotago/prism-esm) (for `code`) are
installed automatically. These will be split into separate packages later so the
core stays dependency-free.

## Sketch

```ts
import { cell } from "bireactive";

// A derived value with an inverse — the edge runs both ways.
const celsius = cell(20);
const fahrenheit = celsius.lens(
  c => (c * 9) / 5 + 32, // forward
  f => ((f - 32) * 5) / 9, // backward
);

fahrenheit.value; // 68
fahrenheit.value = 212; // write the derived end…
celsius.value; // 100 — …and the source updates to match
```

Values also come as small classes (`Num`, `Vec`, `Box`, `Color`, ...) with field
lenses and bidirectional operators.

```ts
import { vec, box, mean } from "bireactive";

// Free-function lens: the mean (midpoint) of two points, writable.
const a = vec(0, 0);
const b = vec(10, 0);
const mid = mean([a, b]);
mid.value = { x: 5, y: 10 }; // drag it up…
a.value; // { x: 0, y: 10 } — both ends translate to keep it the midpoint

// Chaining value-class operators builds a multi-step writable view.
const p = vec(10, 20);
const view = p.scale(2).right(5); // ×2, then shift +5 in x
view.value; // { x: 25, y: 40 }
view.value = { x: 5, y: 0 }; // write the end of the chain…
p.value; // { x: 0, y: 0 } — inverted back through right, then scale

// Cross-type lens: a Box/Vec relation projected to Bool, still writable.
const region = box(0, 0, 100, 100); // x, y, w, h
const q = vec(150, 50); // outside the box
const inside = region.contains(q); // Bool view of "q ∈ region"
inside.value; // false
inside.value = true; // assert membership…
q.value; // { x: 100, y: 50 } — q snaps to the nearest in-box point
```

## Develop

```sh
npm run dev        # serve the landing page at :5555
npm run site       # build the static site into dist-web/
npm run build      # compile the library into dist/
npm test           # run the test suite
```

## Status

`0.x` — APIs are still moving frequently. The package is a single bundle today; sub-packages will be split out once the surface settles.

## License

MIT
