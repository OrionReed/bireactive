// fuzz.ts — validate the Design-B spine against a from-scratch Kleene solver.
//   run: npx vite-node src/core3/_proto/fix/fuzz.ts
//
// Random monotone networks over a finite subset lattice (bits = possibilities;
// join = intersection = "more information"; bottom = all bits = "anything").
// Every generated rule is monotone in this order, so a unique least fixpoint
// exists; the engine's lazy pull must reproduce it exactly, regardless of read
// order (confluence + glitch-freedom), be idempotent, and stay lazy.

import { type Cell, type Lattice, Net, type Rule } from "./engine";

const BITS = 6;
const FULL = (1 << BITS) - 1; // bottom: "could be any of the 6 possibilities"

const subset: Lattice<number> = {
  bottom: FULL,
  join: (a, b) => a & b, // intersection ⇒ more information
  eq: (a, b) => a === b,
  // finite ⇒ no widening needed (join already forces a finite ascending chain)
};

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t ^= t + Math.imul(t ^ (t >>> 7), 61 | t);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

interface Spec {
  n: number;
  facts: number[];
  /** rules[target] = list of (reads, mask): contributes (⋂ get(reads)) & mask. */
  rules: Array<Array<{ reads: number[]; mask: number }>>;
}

function genSpec(rnd: () => number): Spec {
  const n = 3 + Math.floor(rnd() * 10);
  const facts = Array.from({ length: n }, () => (rnd() < 0.4 ? Math.floor(rnd() * (FULL + 1)) : FULL));
  const rules: Spec["rules"] = Array.from({ length: n }, () => []);
  const m = Math.floor(rnd() * (n * 2)); // up to ~2 rules/cell ⇒ plenty of cycles
  for (let i = 0; i < m; i++) {
    const target = Math.floor(rnd() * n);
    const k = 1 + (rnd() < 0.5 ? 0 : 1);
    const reads = Array.from({ length: k }, () => Math.floor(rnd() * n));
    const mask = rnd() < 0.5 ? FULL : Math.floor(rnd() * (FULL + 1));
    rules[target]!.push({ reads, mask });
  }
  return { n, facts, rules };
}

/** From-scratch reference: global least fixpoint by chaotic iteration to
 *  stability over ALL cells (Gauss-Seidel; finite ⇒ terminates). */
function naive(spec: Spec): number[] {
  const v = spec.facts.map(() => FULL);
  for (;;) {
    let changed = false;
    for (let c = 0; c < spec.n; c++) {
      let nv = spec.facts[c]!;
      for (const { reads, mask } of spec.rules[c]!) {
        let r = FULL;
        for (const d of reads) r &= v[d]!;
        nv &= r & mask;
      }
      if (nv !== v[c]!) {
        v[c] = nv;
        changed = true;
      }
    }
    if (!changed) return v;
  }
}

function build(spec: Spec): { net: Net<number>; cells: Cell<number>[] } {
  const net = new Net(subset);
  const cells = spec.facts.map(f => net.cell(f));
  spec.rules.forEach((rs, c) => {
    for (const { reads, mask } of rs) {
      const rule: Rule<number> = get => {
        let r = FULL;
        for (const d of reads) r &= get(cells[d]!);
        return r & mask;
      };
      net.rule(cells[c]!, rule);
    }
  });
  return { net, cells };
}

/** Cells reachable (downstream deps) from `start`, for the laziness check. */
function cone(spec: Spec, start: number): Set<number> {
  const seen = new Set<number>([start]);
  const stack = [start];
  while (stack.length) {
    const c = stack.pop()!;
    for (const { reads } of spec.rules[c]!) {
      for (const d of reads) if (!seen.has(d)) {
        seen.add(d);
        stack.push(d);
      }
    }
  }
  return seen;
}

let failures = 0;
const SEEDS = 4000;
for (let seed = 1; seed <= SEEDS && failures < 5; seed++) {
  const rnd = mulberry32(seed);
  const spec = genSpec(rnd);
  const want = naive(spec);

  // (1) confluence + glitch-free: read in a random order, every value exact.
  {
    const { net, cells } = build(spec);
    const order = [...cells.keys()].sort(() => rnd() - 0.5);
    for (const i of order) {
      const got = net.read(cells[i]!);
      if (got !== want[i]) {
        console.log(`FAIL seed=${seed} confluence cell=${i} got=${got} want=${want[i]}`);
        console.log(JSON.stringify(spec));
        failures++;
        break;
      }
    }
  }

  // (2) idempotence: second read identical, and a re-read after settle stable.
  {
    const { net, cells } = build(spec);
    for (let i = 0; i < spec.n; i++) net.read(cells[i]!);
    for (let i = 0; i < spec.n; i++) {
      if (net.read(cells[i]!) !== want[i]) {
        console.log(`FAIL seed=${seed} idempotence cell=${i}`);
        failures++;
        break;
      }
    }
  }

  // (3) laziness: reading ONE cell must not finalize cells outside its cone.
  {
    const { net, cells } = build(spec);
    const start = Math.floor(rnd() * spec.n);
    net.read(cells[start]!);
    const reachable = cone(spec, start);
    for (let i = 0; i < spec.n; i++) {
      if (!reachable.has(i) && cells[i]!.validEpoch === net.epoch) {
        console.log(`FAIL seed=${seed} laziness: cell ${i} finalized but not in cone of ${start}`);
        failures++;
        break;
      }
    }
  }

  // (4) incrementality of CORRECTNESS: change a fact, re-read = new fixpoint.
  {
    const { net, cells } = build(spec);
    for (let i = 0; i < spec.n; i++) net.read(cells[i]!);
    const t = Math.floor(rnd() * spec.n);
    const nf = Math.floor(rnd() * (FULL + 1));
    const spec2: Spec = { ...spec, facts: spec.facts.slice() };
    spec2.facts[t] = nf;
    const want2 = naive(spec2);
    net.set(cells[t]!, nf);
    const order = [...cells.keys()].sort(() => rnd() - 0.5);
    for (const i of order) {
      if (net.read(cells[i]!) !== want2[i]) {
        console.log(`FAIL seed=${seed} after-edit cell=${i} got=${net.read(cells[i]!)} want=${want2[i]}`);
        console.log(`  origFacts=${JSON.stringify(spec.facts)} t=${t} nf=${nf} order=${order.join("")}`);
        console.log(JSON.stringify(spec2));
        failures++;
        break;
      }
    }
  }
}

console.log(failures === 0 ? `ALL PASS (${SEEDS} seeds × 4 properties)` : `${failures} FAILURES`);
