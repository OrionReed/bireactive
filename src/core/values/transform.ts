import { type Easing, type Tween, tween } from "../../animation";
import { Cell, fieldLens, type Inner, reader, readNow, type Val, type Writable } from "../cell";
import type { Linear, TraitDict } from "../traits";
import { Num } from "./num";
import {
  Vec,
  add as vAdd,
  equals as vEquals,
  lerp as vLerp,
  metric as vMetric,
  scale as vScale,
  sub as vSub,
} from "./vec";

type V = {
  translate: Inner<Vec>;
  scale: Inner<Vec>;
  origin: Inner<Vec>;
  rotate: number;
  opacity: number;
};

export const DEFAULT: V = {
  translate: { x: 0, y: 0 },
  scale: { x: 1, y: 1 },
  origin: { x: 0, y: 0 },
  rotate: 0,
  opacity: 1,
};

export const add = (a: V, b: V): V => ({
  translate: vAdd(a.translate, b.translate),
  scale: vAdd(a.scale, b.scale),
  origin: vAdd(a.origin, b.origin),
  rotate: a.rotate + b.rotate,
  opacity: a.opacity + b.opacity,
});
export const sub = (a: V, b: V): V => ({
  translate: vSub(a.translate, b.translate),
  scale: vSub(a.scale, b.scale),
  origin: vSub(a.origin, b.origin),
  rotate: a.rotate - b.rotate,
  opacity: a.opacity - b.opacity,
});
export const scale = (a: V, k: number): V => ({
  translate: vScale(a.translate, k),
  scale: vScale(a.scale, k),
  origin: vScale(a.origin, k),
  rotate: a.rotate * k,
  opacity: a.opacity * k,
});
export const lerp = (a: V, b: V, t: number): V => ({
  translate: vLerp(a.translate, b.translate, t),
  scale: vLerp(a.scale, b.scale, t),
  origin: vLerp(a.origin, b.origin, t),
  rotate: a.rotate + (b.rotate - a.rotate) * t,
  opacity: a.opacity + (b.opacity - a.opacity) * t,
});
export const equals = (a: V, b: V) =>
  a === b ||
  (vEquals(a.translate, b.translate) &&
    vEquals(a.scale, b.scale) &&
    vEquals(a.origin, b.origin) &&
    a.rotate === b.rotate &&
    a.opacity === b.opacity);
export const metric = (a: V, b: V) =>
  vMetric(a.translate, b.translate) +
  vMetric(a.scale, b.scale) +
  vMetric(a.origin, b.origin) +
  Math.abs(a.rotate - b.rotate) +
  Math.abs(a.opacity - b.opacity);

const linearImpl: Linear<V> = { add, sub, scale };

export class Transform extends Cell<V> {
  static traits = { linear: linearImpl, lerp, metric, equals } satisfies TraitDict<V>;
  declare readonly _t: typeof Transform.traits;

  constructor(v: V = DEFAULT) {
    super(v, { equals });
  }

  add(b: Val<V>): this {
    const bf = reader(b);
    return this.lens(
      v => add(v, bf()),
      n => sub(n, bf()),
    );
  }
  sub(b: Val<V>): this {
    const bf = reader(b);
    return this.lens(
      v => sub(v, bf()),
      n => add(n, bf()),
    );
  }
  lerp(b: Val<V>, t: Val<number>): Transform {
    return Transform.derive(() => lerp(this.value, readNow(b), readNow(t)));
  }

  get translate() {
    return fieldLens(this, "translate", Vec);
  }
  get scale() {
    return fieldLens(this, "scale", Vec);
  }
  get origin() {
    return fieldLens(this, "origin", Vec);
  }
  get rotate() {
    return fieldLens(this, "rotate", Num);
  }
  get opacity() {
    return fieldLens(this, "opacity", Num);
  }

  /** Tween-builder. */
  to(this: Writable<Transform>, target: V, dur: Val<number>, ease?: Easing): Tween<V> {
    return tween(this, target, dur, ease);
  }
}

export type TransformInit = { [K in keyof V]?: V[K] };

/** Writable `Transform` from literal fields. For reactive sources use
 *  `Transform.lens` or field writes. */
export function transform(init?: TransformInit): Writable<Transform> {
  const tr = new Transform() as Writable<Transform>;
  if (init) {
    if (init.translate !== undefined) tr.translate.value = init.translate;
    if (init.scale !== undefined) tr.scale.value = init.scale;
    if (init.origin !== undefined) tr.origin.value = init.origin;
    if (init.rotate !== undefined) tr.rotate.value = init.rotate;
    if (init.opacity !== undefined) tr.opacity.value = init.opacity;
  }
  return tr;
}
