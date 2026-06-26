---
title: Bireactive — Talk
description: A talk about bidirectional reactive programming.
---

# (Bidirectional) Reactive Programming

<md-bireactive></md-bireactive>

Orion Reed

---

## Animation

<md-centering></md-centering>

---

| Yield             | Means                                       |
| ----------------- | ------------------------------------------- |
| yield             | wait one frame, resume with dt              |
| yield 0.5         | sleep half a second                         |
| yield gen         | spawn a child, wait for it                  |
| yield [a, b]      | spawn N in parallel, wait for all           |
| yield (wake) => … | suspend on a callback-shaped source         |
| yield detach(g)   | spawn at root; outlives the yielding parent |
| yield cut(v)      | from inside a group: settle group with v    |

---

## Anchors

<md-anchors></md-anchors>

---

## Interpolation

<md-lerps></md-lerps>

<md-morph></md-morph>

---

## Reactive TeX

<md-tex-demo></md-tex-demo>

Markers tie prose to the diagram: <md-marker sym="osc:gamma">damping</md-marker>, <md-marker sym="osc:A">amplitude</md-marker>, <md-marker sym="osc:omega">frequency</md-marker>.

<md-oscillator></md-oscillator>

---

## Reactivity

```ts
const dots = [vec(0, 0)];
for (let i = 0; i < n; i++)
  dots.push(Vec.derive(() => dots[i].value.rotate(0.6, p).scale(0.85, p)));
```

<md-forward-reactive></md-forward-reactive>

---

## Independent cells

```ts
const dots = [vec(0, 0)];
for (let i = 0; i < n; i++)
  dots.push(vec(dots[i].value.rotate(0.6, p).scale(0.85, p)));
```

<md-independent-cells></md-independent-cells>

---

## Bidirectionality

```ts
const dots = [vec(0, 0)];
for (let i = 0; i < n; i++)
  dots.push(dots[i].rotate(0.6, p).scale(0.85, p));
```

<md-invertible></md-invertible>

---

## One scalar, every body

<md-solar-system></md-solar-system>

---

## Colour

<md-color-hsv></md-color-hsv>

---

## Units

<md-units></md-units>

---

## Coordinate spaces

<md-coordinate-spaces></md-coordinate-spaces>

---

## Gears & pulleys

<md-gears></md-gears>

<md-pulley></md-pulley>

---

<md-triangle></md-triangle>

<md-loop></md-loop>

---

## N parents

<md-best-fit></md-best-fit>

---

## Cross-domain traits

<md-traits-cross-domain></md-traits-cross-domain>

---

## Blending

<md-twisted></md-twisted>

---

## Across types

<md-bool-bridges></md-bool-bridges>

---

## Allen relations

<md-allen></md-allen>

---

## Text

<md-madlibs></md-madlibs>

---

## One source, many formats

<md-syntax-lens></md-syntax-lens>

---

## Schema evolution

<md-schema-evolution></md-schema-evolution>

---

## Collaboration

<md-scene-canvas></md-scene-canvas>

<md-scene-inspector></md-scene-inspector>

<md-scene-table></md-scene-table>

---

## Large & costly data

<md-canvas-graph></md-canvas-graph>

---

## Reaction–diffusion

<md-reaction-diffusion></md-reaction-diffusion>

---

## Learning

<md-classify-points></md-classify-points>

---

## …on raw pixels

<md-classify-pixels></md-classify-pixels>

---

## Cycles & constraints

<md-flex></md-flex>

---

## Sudoku

<md-prop-sudoku></md-prop-sudoku>

---

## Graph layout

<md-sugiyama></md-sugiyama>

---

## Physics

<md-figure8></md-figure8>

---

## Cloth

<md-cloth></md-cloth>

---

## Stacking

<md-rigid-stack></md-rigid-stack>

---

# Thank you

[github.com/OrionReed/bireactive](https://github.com/OrionReed/bireactive)

[npmjs.com/package/bireactive](https://www.npmjs.com/package/bireactive)

[orionreed.com](https://orionreed.com)
