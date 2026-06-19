// lens-net.ts — the MLP of `mlp.ts`, but wired as an actual lens DAG so that
// *training is a backward write*.
//
// Each dense layer is a multi-parent stateful lens over `[paramsCell, inputCell]`:
//   fwd  computes the activation `act(W·x + b)`,
//   bwd  receives the cotangent dL/da, deposits an SGD step on the weight cell,
//        and passes dL/dx up to the previous layer.
// Composing the layers composes their backward passes in reverse, so writing
// the output cotangent to the `logits` cell makes the engine run reverse-mode
// backprop down the whole chain and land an update on every weight source.
// There is no optimizer object and no training loop inside the net: the
// statement `logits.value = cotangent` *is* one gradient step.
//
// The very same lens, run with the weights frozen (`cfg.frozen`), inverts
// instead of fits — the cotangent still flows to the input, so the input cell
// receives dL/dx. That is the gradient the "dream" ascends to paint a class
// prototype: inference-time inversion is just the backward leg with the
// parameters held fixed.
//
// `mlp.ts` stays the flat, fast reference (and the offline ground truth); this
// is the reactive realization the demos drive.

import { type Cell, cell, lens, SKIP, type Skip, type Writable } from "../core";
import { type Activation, actGrad, applyAct, gaussian, rng, type Sample, softmax } from "./mlp";

/** Dense-layer parameters: row-major `out×in` weights + `out` biases. */
export interface LayerParams {
  W: Float64Array;
  b: Float64Array;
}

/** Training knobs read live by every layer's backward map. */
export interface LensNetCfg {
  /** SGD learning rate for the weight step. */
  lr: number;
  /** Freeze the weights: their backward update is `SKIP`ped and only the input
   *  cotangent flows — the inversion ("dream") leg. */
  frozen: boolean;
}

/** One dense layer as a lens: `out = act(W·in + b)`, `params` its weight source. */
export interface LensLayer {
  inDim: number;
  outDim: number;
  act: Activation;
  params: Writable<Cell<LayerParams>>;
  out: Writable<Cell<Float64Array>>;
}

/** A net wired as a lens DAG `input → layer → … → logits`. Train by writing the
 *  output cotangent to `logits`; the engine backpropagates to the sources. */
export interface LensNet {
  input: Writable<Cell<Float64Array>>;
  layers: LensLayer[];
  logits: Writable<Cell<Float64Array>>;
  cfg: LensNetCfg;
  dims: readonly number[];
}

const toF64 = (x: ArrayLike<number>): Float64Array =>
  x instanceof Float64Array ? x : Float64Array.from(x);

// Forward of one dense layer (the lens `fwd`).
function denseForward(
  p: LayerParams,
  inDim: number,
  outDim: number,
  act: Activation,
  x: ArrayLike<number>,
): Float64Array {
  const y = new Float64Array(outDim);
  for (let o = 0; o < outDim; o++) {
    let z = p.b[o]!;
    const base = o * inDim;
    for (let i = 0; i < inDim; i++) z += p.W[base + i]! * x[i]!;
    y[o] = applyAct(act, z);
  }
  return y;
}

// Backward of one dense layer (the lens `bwd` math): given dL/da, return the
// input cotangent dL/dx and the parameter gradients gW/gb. Shared by the
// engine-routed training step and the frozen inversion pass so they can't drift.
function denseBackward(
  p: LayerParams,
  inDim: number,
  outDim: number,
  act: Activation,
  x: ArrayLike<number>,
  dOut: ArrayLike<number>,
): { dIn: Float64Array; gW: Float64Array; gb: Float64Array } {
  const dIn = new Float64Array(inDim);
  const gW = new Float64Array(outDim * inDim);
  const gb = new Float64Array(outDim);
  for (let o = 0; o < outDim; o++) {
    let z = p.b[o]!;
    const base = o * inDim;
    for (let i = 0; i < inDim; i++) z += p.W[base + i]! * x[i]!;
    const dz = dOut[o]! * actGrad(act, applyAct(act, z));
    gb[o] = dz;
    for (let i = 0; i < inDim; i++) {
      gW[base + i] = dz * x[i]!;
      dIn[i] = dIn[i]! + p.W[base + i]! * dz;
    }
  }
  return { dIn, gW, gb };
}

// Build one dense layer-lens over its weight source and input cell. Forward is
// the activation; backward steps the weights (unless frozen) and always returns
// dL/dx for the input parent — for a hidden layer that propagates the gradient
// up the chain; for the first layer it lands on the input cell (where the
// inversion pass reads it).
function denseLens(
  params: Writable<Cell<LayerParams>>,
  input: Cell<Float64Array>,
  inDim: number,
  outDim: number,
  act: Activation,
  cfg: LensNetCfg,
): Writable<Cell<Float64Array>> {
  const parents: readonly [Writable<Cell<LayerParams>>, Cell<Float64Array>] = [params, input];
  return lens(parents, {
    init: (): null => null,
    step: (_s: readonly [LayerParams, Float64Array], c: null): null => c,
    fwd: (s: readonly [LayerParams, Float64Array]): Float64Array =>
      denseForward(s[0], inDim, outDim, act, s[1]),
    bwd: (cot: Float64Array, s: readonly [LayerParams, Float64Array], c: null) => {
      const { dIn, gW, gb } = denseBackward(s[0], inDim, outDim, act, s[1], cot);
      let pUpd: LayerParams | Skip;
      if (cfg.frozen) {
        pUpd = SKIP;
      } else {
        const W = new Float64Array(s[0].W);
        const b = new Float64Array(s[0].b);
        const lr = cfg.lr;
        for (let k = 0; k < W.length; k++) W[k] = W[k]! - lr * gW[k]!;
        for (let o = 0; o < b.length; o++) b[o] = b[o]! - lr * gb[o]!;
        pUpd = { W, b };
      }
      return { updates: [pUpd, dIn] as [LayerParams | Skip, Float64Array], complement: c };
    },
  }) as Writable<Cell<Float64Array>>;
}

/** Build a net as a lens DAG. `dims` is `[in, h1, …, out]`; hidden layers use
 *  `hidden` activation, the output is `linear` (the squash folds into the loss). */
export function lensNet(
  dims: readonly number[],
  opts: { seed?: number; hidden?: Activation; lr?: number } = {},
): LensNet {
  const hidden = opts.hidden ?? "tanh";
  const r = rng(opts.seed ?? 1);
  const cfg: LensNetCfg = { lr: opts.lr ?? 0.05, frozen: false };
  const input = cell<Float64Array>(new Float64Array(dims[0]!));
  const layers: LensLayer[] = [];
  let x: Writable<Cell<Float64Array>> = input;
  for (let i = 0; i + 1 < dims.length; i++) {
    const inDim = dims[i]!;
    const outDim = dims[i + 1]!;
    const act: Activation = i + 2 < dims.length ? hidden : "linear";
    const scale = act === "relu" ? Math.sqrt(2 / inDim) : Math.sqrt(1 / inDim);
    const W = new Float64Array(outDim * inDim);
    for (let k = 0; k < W.length; k++) W[k] = gaussian(r) * scale;
    const params = cell<LayerParams>({ W, b: new Float64Array(outDim) });
    const out = denseLens(params, x, inDim, outDim, act, cfg);
    layers.push({ inDim, outDim, act, params, out });
    x = out;
  }
  return { input, layers, logits: x, cfg, dims };
}

/** Logits for `x`, reading the current weight cells (no training, untracked).
 *  Applies any pending backward write first, so it always sees fresh weights. */
export function logitsOf(net: LensNet, x: ArrayLike<number>): Float64Array {
  let a: ArrayLike<number> = toF64(x);
  for (const L of net.layers) a = denseForward(L.params.peek(), L.inDim, L.outDim, L.act, a);
  return a as Float64Array;
}

/** Class probabilities: sigmoid for a 1-logit (binary) net, else softmax. */
export function probsOf(net: LensNet, x: ArrayLike<number>): Float64Array {
  const z = logitsOf(net, x);
  return z.length === 1 ? Float64Array.of(1 / (1 + Math.exp(-z[0]!))) : softmax(z);
}

/** Argmax class for a multi-logit net, or `P ≥ 0.5` for a binary net. */
export function classifyOf(net: LensNet, x: ArrayLike<number>): number {
  const p = probsOf(net, x);
  if (p.length === 1) return p[0]! >= 0.5 ? 1 : 0;
  let best = 0;
  for (let i = 1; i < p.length; i++) if (p[i]! > p[best]!) best = i;
  return best;
}

/** Fraction of `data` classified correctly. */
export function accuracyOf(net: LensNet, data: readonly Sample[]): number {
  let ok = 0;
  for (const s of data) if (classifyOf(net, s.x) === s.y) ok++;
  return ok / Math.max(1, data.length);
}

// Cross-entropy loss + the cotangent dL/dlogits (the seed of the backward
// pass). Binary: BCE-with-logits, dz = σ(z) − y. Multi: softmax CE, dz = p − e_y.
function lossCotangent(z: Float64Array, y: number): { loss: number; cot: Float64Array } {
  if (z.length === 1) {
    const p = 1 / (1 + Math.exp(-z[0]!));
    const eps = 1e-12;
    return {
      loss: -(y * Math.log(p + eps) + (1 - y) * Math.log(1 - p + eps)),
      cot: Float64Array.of(p - y),
    };
  }
  const p = softmax(z);
  const cot = new Float64Array(z.length);
  for (let k = 0; k < z.length; k++) cot[k] = p[k]! - (k === y ? 1 : 0);
  return { loss: -Math.log(p[y]! + 1e-12), cot };
}

/** Mean cross-entropy over a dataset (no update) — for monitoring/tests. */
export function meanLossOf(net: LensNet, data: readonly Sample[]): number {
  let total = 0;
  for (const s of data) total += lossCotangent(logitsOf(net, s.x), s.y).loss;
  return total / Math.max(1, data.length);
}

/** Train one example with a single backward write: pin the input, read the
 *  prediction (the forward pull), then write the output cotangent to `logits`.
 *  The engine backpropagates and lands an SGD step on every weight cell. The
 *  step is forced before returning (while the input still holds this example),
 *  so callers may move on immediately. Returns the loss before the step. */
export function trainExample(net: LensNet, x: ArrayLike<number>, y: number): number {
  net.cfg.frozen = false;
  net.input.value = toF64(x);
  const { loss, cot } = lossCotangent(net.logits.value, y);
  net.logits.value = cot;
  void net.logits.peek(); // force the backward now, while input === this example
  return loss;
}

// Fisher–Yates over [0, n) using the provided uniform source.
function shuffled(n: number, r: () => number): number[] {
  const a = Array.from({ length: n }, (_, i) => i);
  for (let i = n - 1; i > 0; i--) {
    const j = Math.floor(r() * (i + 1));
    const t = a[i]!;
    a[i] = a[j]!;
    a[j] = t;
  }
  return a;
}

/** Train one shuffled pass — one backward write per example (online SGD).
 *  Returns the mean loss over the epoch. */
export function trainEpoch(net: LensNet, data: readonly Sample[], r: () => number): number {
  if (data.length === 0) return 0;
  let total = 0;
  for (const idx of shuffled(data.length, r)) {
    const s = data[idx]!;
    total += trainExample(net, s.x, s.y);
  }
  return total / data.length;
}

/** Input-space gradient toward raising logit `cls`, by one frozen-weight
 *  backward write: with the weights held fixed the cotangent flows past them to
 *  the input cell, which then holds dL/dInput. Drives the "dream" / saliency. */
export function inputGradient(net: LensNet, x: ArrayLike<number>, cls = 0): Float64Array {
  net.cfg.frozen = true;
  net.input.value = toF64(x);
  const z = net.logits.value; // forward
  const seed = new Float64Array(z.length);
  seed[Math.min(cls, z.length - 1)] = 1;
  net.logits.value = seed;
  void net.logits.peek(); // force the backward; the gradient lands on `input`
  const g = net.input.peek();
  net.cfg.frozen = false;
  return g;
}
