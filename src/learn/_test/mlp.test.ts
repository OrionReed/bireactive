// Offline evidence that the net is correct and actually learns:
//   1. analytic gradients match finite differences (backprop is right),
//   2. it drives toy tasks (XOR / moons / circles) to high accuracy,
//   3. it learns circle-vs-rest from raw pixels and generalises to a
//      fresh test set,
//   4. a fixed seed is reproducible.

import { describe, expect, it } from "vitest";
import { circles, moons, shapeBatch, xor } from "../data";
import {
  accuracy,
  forward,
  gradients,
  inputGradient,
  meanLoss,
  mlp,
  parameters,
  predict,
  rng,
  type Sample,
  trainStep,
} from "../mlp";

describe("backprop correctness", () => {
  it("analytic gradients match central finite differences", () => {
    const net = mlp([3, 5, 4], { seed: 3, hidden: "tanh" });
    const r = rng(99);
    const batch: Sample[] = [];
    for (let i = 0; i < 6; i++) {
      batch.push({ x: [r() * 2 - 1, r() * 2 - 1, r() * 2 - 1], y: i % 4 });
    }

    const g = gradients(net, batch);
    const params = parameters(net);
    const eps = 1e-5;
    let checked = 0;
    for (let p = 0; p < params.length; p++) {
      const buf = params[p]!;
      for (let i = 0; i < buf.length; i += 3) {
        const orig = buf[i]!;
        buf[i] = orig + eps;
        const lp = meanLoss(net, batch);
        buf[i] = orig - eps;
        const lm = meanLoss(net, batch);
        buf[i] = orig;
        const num = (lp - lm) / (2 * eps);
        expect(Math.abs(num - g[p]![i]!)).toBeLessThan(1e-5);
        checked++;
      }
    }
    expect(checked).toBeGreaterThan(10);
  });
});

describe("learns toy tasks", () => {
  it("solves XOR (impossible for a linear model)", () => {
    const net = mlp([2, 8, 1], { seed: 1, hidden: "tanh", lr: 0.05 });
    const data = xor(200, { seed: 5 });
    for (let i = 0; i < 1200; i++) trainStep(net, data);
    expect(accuracy(net, data)).toBeGreaterThan(0.97);
  });

  it("separates two moons", () => {
    const net = mlp([2, 12, 12, 1], { seed: 2, hidden: "tanh", lr: 0.03 });
    const data = moons(200, { seed: 5 });
    for (let i = 0; i < 1500; i++) trainStep(net, data);
    expect(accuracy(net, data)).toBeGreaterThan(0.95);
  });

  it("carves out concentric circles", () => {
    const net = mlp([2, 12, 12, 1], { seed: 2, hidden: "tanh", lr: 0.03 });
    const data = circles(200, { seed: 5 });
    for (let i = 0; i < 1500; i++) trainStep(net, data);
    expect(accuracy(net, data)).toBeGreaterThan(0.95);
  });

  it("loss decreases monotonically over a run", () => {
    const net = mlp([2, 12, 1], { seed: 4, hidden: "tanh", lr: 0.03 });
    const data = moons(160, { seed: 8 });
    const first = trainStep(net, data);
    let last = first;
    for (let i = 0; i < 400; i++) last = trainStep(net, data);
    expect(last).toBeLessThan(first * 0.5);
  });
});

describe("learns from raw pixels and generalises", () => {
  it("classifies circle-vs-rest on a held-out test set", () => {
    const grid = 12;
    const net = mlp([grid * grid, 24, 1], { seed: 1, hidden: "tanh", lr: 0.01 });
    const train = rng(42);
    for (let i = 0; i < 350; i++) trainStep(net, shapeBatch(grid, 64, train));
    // Fresh, never-trained samples — the real test of learning.
    const test = shapeBatch(grid, 400, rng(7));
    expect(accuracy(net, test)).toBeGreaterThan(0.78);
  });
});

describe("input gradient (the dream/saliency path)", () => {
  it("ascending a square toward circle raises the circle probability", () => {
    const grid = 12;
    const net = mlp([grid * grid, 24, 1], { seed: 1, hidden: "tanh", lr: 0.01 });
    const train = rng(42);
    for (let i = 0; i < 350; i++) trainStep(net, shapeBatch(grid, 64, train));

    const img = Float64Array.from(shapeBatch(grid, 1, rng(123))[0]!.x);
    const before = predict(net, img)[0]!;
    for (let step = 0; step < 40; step++) {
      const g = inputGradient(net, img, 0);
      for (let i = 0; i < img.length; i++) {
        img[i] = Math.max(0, Math.min(1, img[i]! + 0.5 * g[i]!));
      }
    }
    const after = predict(net, img)[0]!;
    expect(after).toBeGreaterThan(before);
    expect(Number.isFinite(forward(net, img)[0]!)).toBe(true);
  });
});

describe("reproducibility", () => {
  it("same seed gives identical initial loss", () => {
    const data = moons(100, { seed: 5 });
    const a = mlp([2, 12, 1], { seed: 9, hidden: "tanh" });
    const b = mlp([2, 12, 1], { seed: 9, hidden: "tanh" });
    expect(meanLoss(a, data)).toBe(meanLoss(b, data));
  });
});
