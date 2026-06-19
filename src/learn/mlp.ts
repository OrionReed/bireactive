// mlp.ts — a tiny dense neural net, written as a stack of parametric lenses.
//
// Backprop is the lens pattern: each layer is a forward map (compute the
// activation) paired with a backward map (pull a gradient back to the input
// and deposit gradients on the parameters). Composing layers composes their
// backward passes in reverse — reverse-mode autodiff *is* lens composition,
// exactly the `pipe` of the schema kit but over differentiable maps. The
// "complement" a layer needs for its backward pass is the cached forward
// activation, stashed on the layer during `forward`.
//
// Deliberately coarse-grained: one layer = one matmul over Float64Arrays, not
// a cell per scalar. The reactive/bidirectional payoff lives in the demos
// (live data, watch-it-learn); this core stays plain and fast so it is cheap
// to run and easy to test offline.

/** Hidden/output nonlinearity. The output layer is `linear`; its squashing
 *  (sigmoid/softmax) is folded into the loss for numerically-stable grads. */
export type Activation = "tanh" | "relu" | "sigmoid" | "linear";

/** Deterministic PRNG (mulberry32) so init and data are reproducible. */
export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t ^= t + Math.imul(t ^ (t >>> 7), 61 | t);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Standard normal via Box–Muller, driven by a uniform source. */
export function gaussian(r: () => number): number {
  let u = 0;
  let v = 0;
  while (u === 0) u = r();
  while (v === 0) v = r();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

// A dense layer `a = act(W·x + b)`. Weights are row-major `out×in`.
// `gW`/`gb` accumulate gradients across a batch; `mW…vb` are Adam moments;
// `inBuf`/`preBuf` are the complement (cached forward values for `backward`).
interface Layer {
  inDim: number;
  outDim: number;
  act: Activation;
  W: Float64Array;
  b: Float64Array;
  gW: Float64Array;
  gb: Float64Array;
  mW: Float64Array;
  vW: Float64Array;
  mb: Float64Array;
  vb: Float64Array;
  inBuf: Float64Array;
  preBuf: Float64Array;
  outBuf: Float64Array;
}

/** A multilayer perceptron: a `pipe` of dense layers plus an Adam step clock. */
export interface MLP {
  layers: Layer[];
  /** Adam timestep (for bias correction). */
  t: number;
  lr: number;
  beta1: number;
  beta2: number;
  l2: number;
}

/** Build an MLP. `dims` is `[in, h1, …, out]`; hidden layers use `hidden`
 *  activation, the output layer is `linear` (loss folds in the squashing). */
export function mlp(
  dims: readonly number[],
  opts: { seed?: number; hidden?: Activation; lr?: number; l2?: number } = {},
): MLP {
  const hidden = opts.hidden ?? "tanh";
  const r = rng(opts.seed ?? 1);
  const layers: Layer[] = [];
  for (let i = 0; i + 1 < dims.length; i++) {
    const inDim = dims[i]!;
    const outDim = dims[i + 1]!;
    const act: Activation = i + 2 < dims.length ? hidden : "linear";
    // He for relu, Xavier otherwise — keeps early activations well-scaled.
    const scale = act === "relu" ? Math.sqrt(2 / inDim) : Math.sqrt(1 / inDim);
    const W = new Float64Array(outDim * inDim);
    for (let k = 0; k < W.length; k++) W[k] = gaussian(r) * scale;
    layers.push({
      inDim,
      outDim,
      act,
      W,
      b: new Float64Array(outDim),
      gW: new Float64Array(outDim * inDim),
      gb: new Float64Array(outDim),
      mW: new Float64Array(outDim * inDim),
      vW: new Float64Array(outDim * inDim),
      mb: new Float64Array(outDim),
      vb: new Float64Array(outDim),
      inBuf: new Float64Array(inDim),
      preBuf: new Float64Array(outDim),
      outBuf: new Float64Array(outDim),
    });
  }
  return {
    layers,
    t: 0,
    lr: opts.lr ?? 0.02,
    beta1: 0.9,
    beta2: 0.999,
    l2: opts.l2 ?? 0,
  };
}

/** Pointwise activation `a = σ(z)`. */
export function applyAct(act: Activation, z: number): number {
  switch (act) {
    case "tanh":
      return Math.tanh(z);
    case "relu":
      return z > 0 ? z : 0;
    case "sigmoid":
      return 1 / (1 + Math.exp(-z));
    default:
      return z;
  }
}

/** Activation derivative `σ'`, given the *output* `a` (cheap for tanh/sigmoid). */
export function actGrad(act: Activation, a: number): number {
  switch (act) {
    case "tanh":
      return 1 - a * a;
    case "relu":
      return a > 0 ? 1 : 0;
    case "sigmoid":
      return a * (1 - a);
    default:
      return 1;
  }
}

// Forward through one layer (the lens `fwd`): caches input + output as the
// complement, returns the activation buffer (reused — copy if you must keep).
function forwardLayer(L: Layer, x: Float64Array): Float64Array {
  L.inBuf.set(x);
  for (let o = 0; o < L.outDim; o++) {
    let z = L.b[o]!;
    const base = o * L.inDim;
    for (let i = 0; i < L.inDim; i++) z += L.W[base + i]! * x[i]!;
    L.preBuf[o] = z;
    L.outBuf[o] = applyAct(L.act, z);
  }
  return L.outBuf;
}

// Backward through one layer (the lens `bwd`): given dL/da, accumulate the
// parameter gradients and return dL/dx for the previous layer.
function backwardLayer(L: Layer, dOut: Float64Array): Float64Array {
  const dIn = new Float64Array(L.inDim);
  for (let o = 0; o < L.outDim; o++) {
    const dz = dOut[o]! * actGrad(L.act, L.outBuf[o]!);
    L.gb[o] = L.gb[o]! + dz;
    const base = o * L.inDim;
    for (let i = 0; i < L.inDim; i++) {
      L.gW[base + i] = L.gW[base + i]! + dz * L.inBuf[i]!;
      dIn[i] = dIn[i]! + L.W[base + i]! * dz;
    }
  }
  return dIn;
}

/** Forward pass: logits (pre-squash output) for one input vector. */
export function forward(net: MLP, x: Float64Array | number[]): Float64Array {
  let a = x instanceof Float64Array ? x : Float64Array.from(x);
  for (const L of net.layers) a = forwardLayer(L, a);
  return a;
}

/** Softmax of a logit vector (numerically stabilised). */
export function softmax(logits: Float64Array): Float64Array {
  let max = Number.NEGATIVE_INFINITY;
  for (const z of logits) if (z > max) max = z;
  const out = new Float64Array(logits.length);
  let sum = 0;
  for (let i = 0; i < logits.length; i++) {
    const e = Math.exp(logits[i]! - max);
    out[i] = e;
    sum += e;
  }
  for (let i = 0; i < out.length; i++) out[i] = out[i]! / sum;
  return out;
}

/** Class probabilities: sigmoid for a 1-logit (binary) net, else softmax.
 *  A binary net returns `[P(class 1)]`. */
export function predict(net: MLP, x: Float64Array | number[]): Float64Array {
  const logits = forward(net, x);
  if (logits.length === 1) return Float64Array.of(1 / (1 + Math.exp(-logits[0]!)));
  return softmax(logits);
}

/** Argmax class for a multi-logit net, or `prob ≥ 0.5` for a binary net. */
export function classify(net: MLP, x: Float64Array | number[]): number {
  const p = predict(net, x);
  if (p.length === 1) return p[0]! >= 0.5 ? 1 : 0;
  let best = 0;
  for (let i = 1; i < p.length; i++) if (p[i]! > p[best]!) best = i;
  return best;
}

/** A labelled example: input vector + integer class. */
export interface Sample {
  x: Float64Array | number[];
  y: number;
}

// Cross-entropy loss + the gradient on the logits, written into `dLogit`.
// Binary (1 logit): BCE-with-logits, dz = sigmoid(z) − y.
// Multi (K logits): softmax CE, dz = softmax(z) − onehot(y).
function lossAndGrad(logits: Float64Array, y: number, dLogit: Float64Array): number {
  if (logits.length === 1) {
    const z = logits[0]!;
    const p = 1 / (1 + Math.exp(-z));
    dLogit[0] = p - y;
    const eps = 1e-12;
    return -(y * Math.log(p + eps) + (1 - y) * Math.log(1 - p + eps));
  }
  const p = softmax(logits);
  for (let k = 0; k < logits.length; k++) dLogit[k] = p[k]! - (k === y ? 1 : 0);
  return -Math.log(p[y]! + 1e-12);
}

function adamStep(
  net: MLP,
  param: Float64Array,
  g: Float64Array,
  m: Float64Array,
  v: Float64Array,
): void {
  const { lr, beta1, beta2, t } = net;
  const bc1 = 1 - beta1 ** t;
  const bc2 = 1 - beta2 ** t;
  for (let i = 0; i < param.length; i++) {
    const gi = g[i]!;
    const mi = (m[i] = beta1 * m[i]! + (1 - beta1) * gi);
    const vi = (v[i] = beta2 * v[i]! + (1 - beta2) * gi * gi);
    param[i] = param[i]! - (lr * (mi / bc1)) / (Math.sqrt(vi / bc2) + 1e-8);
  }
}

/** One full-batch gradient step over `batch`. Returns the mean loss before
 *  the update. This is the dynamical step on the weights — call it from a
 *  clock to train. */
export function trainStep(net: MLP, batch: readonly Sample[]): number {
  for (const L of net.layers) {
    L.gW.fill(0);
    L.gb.fill(0);
  }
  const outDim = net.layers[net.layers.length - 1]!.outDim;
  const dLogit = new Float64Array(outDim);
  let total = 0;
  for (const s of batch) {
    const logits = forward(net, s.x);
    total += lossAndGrad(logits, s.y, dLogit);
    let g: Float64Array = dLogit;
    for (let li = net.layers.length - 1; li >= 0; li--) g = backwardLayer(net.layers[li]!, g);
  }
  const inv = 1 / Math.max(1, batch.length);
  net.t += 1;
  for (const L of net.layers) {
    for (let i = 0; i < L.gW.length; i++) L.gW[i] = L.gW[i]! * inv + net.l2 * L.W[i]!;
    for (let i = 0; i < L.gb.length; i++) L.gb[i] = L.gb[i]! * inv;
    adamStep(net, L.W, L.gW, L.mW, L.vW);
    adamStep(net, L.b, L.gb, L.mb, L.vb);
  }
  return total * inv;
}

/** Mean cross-entropy over a dataset (no update) — for monitoring/tests. */
export function meanLoss(net: MLP, data: readonly Sample[]): number {
  const outDim = net.layers[net.layers.length - 1]!.outDim;
  const dLogit = new Float64Array(outDim);
  let total = 0;
  for (const s of data) total += lossAndGrad(forward(net, s.x), s.y, dLogit);
  return total / Math.max(1, data.length);
}

/** Fraction of `data` classified correctly. */
export function accuracy(net: MLP, data: readonly Sample[]): number {
  let ok = 0;
  for (const s of data) if (classify(net, s.x) === s.y) ok++;
  return ok / Math.max(1, data.length);
}

/** Flattened parameter buffers `[W0, b0, W1, b1, …]` (live views). */
export function parameters(net: MLP): Float64Array[] {
  const out: Float64Array[] = [];
  for (const L of net.layers) {
    out.push(L.W);
    out.push(L.b);
  }
  return out;
}

/** Mean-loss gradients over `batch` with no update and no weight decay,
 *  aligned with `parameters(net)`. For gradient checking / inspection. */
export function gradients(net: MLP, batch: readonly Sample[]): Float64Array[] {
  for (const L of net.layers) {
    L.gW.fill(0);
    L.gb.fill(0);
  }
  const outDim = net.layers[net.layers.length - 1]!.outDim;
  const dLogit = new Float64Array(outDim);
  for (const s of batch) {
    lossAndGrad(forward(net, s.x), s.y, dLogit);
    let g: Float64Array = dLogit;
    for (let li = net.layers.length - 1; li >= 0; li--) g = backwardLayer(net.layers[li]!, g);
  }
  const inv = 1 / Math.max(1, batch.length);
  const out: Float64Array[] = [];
  for (const L of net.layers) {
    out.push(L.gW.map(v => v * inv));
    out.push(L.gb.map(v => v * inv));
  }
  return out;
}

/** Input-space gradient of a chosen logit, by one backward pass with a unit
 *  seed. Drives the "dream" view (ascend pixels toward a class) and saliency.
 *  Leaves parameter-gradient accumulators dirty; not for use mid-train-step. */
export function inputGradient(net: MLP, x: Float64Array | number[], cls = 0): Float64Array {
  forward(net, x);
  const outDim = net.layers[net.layers.length - 1]!.outDim;
  const seed = new Float64Array(outDim);
  seed[Math.min(cls, outDim - 1)] = 1;
  let g: Float64Array = seed;
  for (let li = net.layers.length - 1; li >= 0; li--) g = backwardLayer(net.layers[li]!, g);
  return g;
}
