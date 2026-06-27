---
title: Bireactive — Talk
description: A talk about bidirectional reactive programming.
---

# (Bidirectional) Reactive Programming

<md-bireactive></md-bireactive>

Orion Reed

---

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

<md-anchors></md-anchors>

---

<md-lerps></md-lerps>

<md-morph></md-morph>

---


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

## Reactivity


```ts
const dots = [vec(0, 0)];
for (let i = 0; i < n; i++)
  dots.push(vec(dots[i].value.rotate(0.6, p).scale(0.85, p)));
```

<md-independent-cells></md-independent-cells>

---

## Reactivity

```ts
const dots = [vec(0, 0)];
for (let i = 0; i < n; i++)
  dots.push(dots[i].rotate(0.6, p).scale(0.85, p));
```

<md-invertible></md-invertible>

---

<md-solar-system></md-solar-system>

---


<md-color-hsv></md-color-hsv>

---


<md-units></md-units>

---


<md-coordinate-spaces></md-coordinate-spaces>

---

<md-gears></md-gears>

<md-pulley></md-pulley>

---

<md-triangle></md-triangle>

<md-loop></md-loop>

---

## Many parents

<md-best-fit></md-best-fit>

---

<md-traits-cross-domain></md-traits-cross-domain>

---

<md-twisted></md-twisted>

---

## Lenses across types

<md-bool-bridges></md-bool-bridges>

---

<md-allen></md-allen>

---

## String lenses

<md-madlibs></md-madlibs>

---

<md-syntax-lens></md-syntax-lens>

---

## Schema lenses

<md-schema-evolution></md-schema-evolution>

---

<md-scene-canvas></md-scene-canvas>

<md-scene-inspector></md-scene-inspector>

<md-scene-table></md-scene-table>

---

## Lenses (on the GPU)

<md-canvas-graph></md-canvas-graph>

---

<md-reaction-diffusion></md-reaction-diffusion>

---

## Machine learning

<md-classify-points></md-classify-points>

---

<md-classify-pixels></md-classify-pixels>

---

## Cycles (propagator networks)

<md-flex></md-flex>

---


<md-prop-sudoku></md-prop-sudoku>

---


<md-sugiyama></md-sugiyama>

---

## Physics (numerical constraints)

<md-figure8></md-figure8>

---

<md-cloth></md-cloth>

---

<md-rigid-stack></md-rigid-stack>

---

# Thank you :)

[github.com/OrionReed/bireactive](https://github.com/OrionReed/bireactive)

[npmjs.com/package/bireactive](https://www.npmjs.com/package/bireactive)

[orionreed.com](https://orionreed.com)
