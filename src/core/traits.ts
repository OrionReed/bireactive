// Traits — polymorphic interfaces declared on a class via a single
// `static traits = { … }` dictionary. One constraint type `Traits<T, K>` covers
// any combination of required traits via a union of keys (no per-trait alias
// proliferation):
//
//   function spring<T>(sig: Traits<T, "linear" | "metric">, target: Val<T>) …
//   function tween<T>(sig: Traits<T, "lerp">, target: T, dur: Val<number>) …
//
// Two axes: at the type level `Traits<T, K>` requires a phantom `_t` slot typed
// against the class's static traits; at runtime `requireLinear` & siblings walk
// `s.constructor.traits.*`. The engine itself is trait-ignorant — subclasses
// thread equality through `super(v, { equals })`.

export interface Linear<T> {
  add(a: T, b: T): T;
  sub(a: T, b: T): T;
  scale(a: T, k: number): T;
}
export type Lerp<T> = (a: T, b: T, t: number) => T;
export type Metric<T> = (a: T, b: T) => number;
export type Equals<T> = (a: T, b: T) => boolean;

/** Flat-buffer codec: view a typed value as a `dim`-sized slice of a
 *  shared `Float64Array`, read/written by offset to avoid allocations
 *  in hot numerical loops. */
export interface Pack<T> {
  readonly dim: number;
  read(value: T, into: Float64Array, offset: number): void;
  write(from: Float64Array, offset: number): T;
}

/** 2-D group action: rotation + uniform scale about a pivot. Used by
 *  closed-form aggregate lenses ("rotate/scale the cluster about its
 *  centroid"). Per-value-class semantics — Pose rotates position AND
 *  orientation, Vec only position; pivot is always a 2-D `{x, y}`.
 *  Caller passes signed dθ (wraps) and k (k < 0 reflects). */
export interface Pivotal<T> {
  rotateAbout(value: T, pivot: { x: number; y: number }, dθ: number): T;
  scaleAbout(value: T, pivot: { x: number; y: number }, k: number): T;
}

/** Shape of a value class's `static traits` dict. Subclasses fill the
 *  subset they implement; consumers constrain on `Traits<T, …keys>`. */
export interface TraitDict<T> {
  linear?: Linear<T>;
  lerp?: Lerp<T>;
  metric?: Metric<T>;
  equals?: Equals<T>;
  pack?: Pack<T>;
  pivotal?: Pivotal<T>;
}

/** Valid keys of `TraitDict`. The set of declarable traits. */
export type TraitKey = keyof TraitDict<unknown>;

/** "A reactive whose class declares the listed traits." `_t` is a phantom slot
 *  typed against `typeof Cls.traits`; listed keys must resolve to non-null. Pure
 *  constraint — doesn't imply `Cell<T>`; intersect with `Writable<Cell<T>>` /
 *  `Read<T>` for capability. */
export type Traits<T, K extends TraitKey = never> = {
  /** @internal Phantom slot; never accessed at runtime. */
  readonly _t: { [P in K]-?: NonNullable<TraitDict<T>[P]> } & TraitDict<T>;
};

/** Class-level traits dictionary for any Cell subclass. */
const dictOf = <T>(s: object): TraitDict<T> =>
  (s as { constructor?: { traits?: TraitDict<T> } }).constructor?.traits ?? {};

const className = (s: object): string =>
  (s as { constructor?: { name?: string } }).constructor?.name ?? "?";

const missing = (s: object, slot: string): Error =>
  new Error(`require${slot}: ${className(s)} has no traits.${slot.toLowerCase()}`);

export function requireLinear<T>(s: Traits<T, "linear">): Linear<T> {
  const v = dictOf<T>(s).linear;
  if (!v) throw missing(s, "Linear");
  return v;
}
export function requireLerp<T>(s: Traits<T, "lerp">): Lerp<T> {
  const v = dictOf<T>(s).lerp;
  if (!v) throw missing(s, "Lerp");
  return v;
}
export function requireMetric<T>(s: Traits<T, "metric">): Metric<T> {
  const v = dictOf<T>(s).metric;
  if (!v) throw missing(s, "Metric");
  return v;
}
export function requireEquals<T>(s: Traits<T, "equals">): Equals<T> {
  const v = dictOf<T>(s).equals;
  if (!v) throw missing(s, "Equals");
  return v;
}
export function requirePack<T>(s: Traits<T, "pack">): Pack<T> {
  const v = dictOf<T>(s).pack;
  if (!v) throw missing(s, "Pack");
  return v;
}
export function requirePivotal<T>(s: Traits<T, "pivotal">): Pivotal<T> {
  const v = dictOf<T>(s).pivotal;
  if (!v) throw missing(s, "Pivotal");
  return v;
}
