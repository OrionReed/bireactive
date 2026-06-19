// Offline evidence that the *lens-routed* net is correct and learns:
//   1. a single backward write (`logits.value = cotangent`) lands the true
//      loss gradient on every weight cell — i.e. the engine's backward pass
//      really is reverse-mode backprop (checked against finite differences),
//   2. driving it by backward writes alone learns toy tasks and raw pixels,
//   3. the frozen-weight backward (the "dream") inverts the net: it raises the
//      target probability while leaving the weights untouched.

import { describe, expect, it } from "vitest";
import { moons, shapeBatch, xor } from "../data";
import {
  accuracyOf,
  inputGradient,
  type LensNet,
  lensNet,
  meanLossOf,
  probsOf,
  trainEpoch,
  trainExample,
} from "../lens-net";
import { rng, type Sample } from "../mlp";

// Snapshot every weight buffer (detached copies).
function snapshot(net: LensNet): { W: Float64Array; b: Float64Array }[] {
  return net.layers.map(L => {
    const p = L.params.peek();
    return { W: p.W.slice(), b: p.b.slice() };
  });
}

describe("training is a backward write", () => {
  it("one backward write applies the true loss gradient to every layer", () => {
    const net = lensNet([3, 5, 4], { seed: 3, hidden: "tanh", lr: 0.1 });
    const one: Sample[] = [{ x: [0.5, -0.3, 0.8], y: 2 }];

    // Finite-difference the single-example loss at the current weights, by
    // perturbing the live weight buffers in place (logitsOf reads them).
    const eps = 1e-5;
    const fd = net.layers.map(L => {
      const p = L.params.peek();
      const gW = new Float64Array(p.W.length);
      for (let k = 0; k < p.W.length; k += 3) {
        const orig = p.W[k]!;
        p.W[k] = orig + eps;
        const lp = meanLossOf(net, one);
        p.W[k] = orig - eps;
        const lm = meanLossOf(net, one);
        p.W[k] = orig;
        gW[k] = (lp - lm) / (2 * eps);
      }
      return gW;
    });

    const before = snapshot(net);
    trainExample(net, one[0]!.x, one[0]!.y);
    const after = snapshot(net);

    // SGD: after = before − lr·grad, so the engine's gradient is recoverable.
    const lr = net.cfg.lr;
    let checked = 0;
    let moved = 0;
    for (let li = 0; li < net.layers.length; li++) {
      const W0 = before[li]!.W;
      const W1 = after[li]!.W;
      for (let k = 0; k < W0.length; k += 3) {
        const recovered = (W0[k]! - W1[k]!) / lr;
        expect(Math.abs(recovered - fd[li]![k]!)).toBeLessThan(1e-5);
        if (Math.abs(recovered) > 1e-6) moved++;
        checked++;
      }
    }
    expect(checked).toBeGreaterThan(10);
    expect(moved).toBeGreaterThan(0); // the gradient reached every layer, not just the last
  });

  it("learns XOR by backward writes alone", () => {
    const net = lensNet([2, 8, 8, 1], { seed: 2, hidden: "tanh", lr: 0.1 });
    const data = xor(200, { seed: 5 });
    const r = rng(7);
    const first = meanLossOf(net, data);
    for (let e = 0; e < 250; e++) trainEpoch(net, data, r);
    expect(accuracyOf(net, data)).toBeGreaterThan(0.95);
    expect(meanLossOf(net, data)).toBeLessThan(first * 0.5);
  }, 20000);

  it("separates two moons by backward writes alone", () => {
    const net = lensNet([2, 12, 12, 1], { seed: 2, hidden: "tanh", lr: 0.08 });
    const data = moons(200, { seed: 5 });
    const r = rng(11);
    for (let e = 0; e < 250; e++) trainEpoch(net, data, r);
    expect(accuracyOf(net, data)).toBeGreaterThan(0.95);
  }, 20000);

  it("learns circle-vs-rest from raw pixels and generalises", () => {
    const grid = 12;
    const net = lensNet([grid * grid, 24, 1], { seed: 1, hidden: "tanh", lr: 0.05 });
    const r = rng(42);
    for (let e = 0; e < 500; e++) trainEpoch(net, shapeBatch(grid, 64, r), r);
    const test = shapeBatch(grid, 400, rng(7));
    expect(accuracyOf(net, test)).toBeGreaterThan(0.78);
  }, 30000);
});

describe("inversion is the same lens, weights frozen", () => {
  it("ascending the input toward circle raises P(circle) and leaves weights fixed", () => {
    const grid = 12;
    const net = lensNet([grid * grid, 24, 1], { seed: 1, hidden: "tanh", lr: 0.05 });
    const r = rng(42);
    for (let e = 0; e < 200; e++) trainEpoch(net, shapeBatch(grid, 64, r), r);

    const img = Float64Array.from(shapeBatch(grid, 1, rng(123))[0]!.x);
    const before = probsOf(net, img)[0]!;
    const wBefore = snapshot(net);

    for (let s = 0; s < 40; s++) {
      const g = inputGradient(net, img, 0);
      for (let i = 0; i < img.length; i++) img[i] = Math.max(0, Math.min(1, img[i]! + 0.5 * g[i]!));
    }

    const after = probsOf(net, img)[0]!;
    expect(after).toBeGreaterThan(before);

    // Frozen mode must not have touched the weights.
    const wAfter = snapshot(net);
    for (let li = 0; li < net.layers.length; li++) {
      for (let k = 0; k < wBefore[li]!.W.length; k++) {
        expect(wAfter[li]!.W[k]).toBe(wBefore[li]!.W[k]);
      }
    }
  }, 20000);
});
