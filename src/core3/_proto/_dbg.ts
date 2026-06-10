// Repro of the effect-churn fuzz to find the first failing seed + op trace.
import { effect, Flags, settle } from "../index";
import { equal } from "../relate";
import { mulberry32 } from "../_test/_scc-util";

const F = ["b0", "b1", "b2", "b3"] as const;
const fl = (m: number) => new Flags([...F], m);
const andAll = (xs: number[]): number => xs.reduce((a, b) => a & b, -1);

class UF {
  p: number[];
  constructor(n: number) {
    this.p = Array.from({ length: n }, (_, i) => i);
  }
  find(x: number): number {
    while (this.p[x] !== x) x = this.p[x] = this.p[this.p[x]!]!;
    return x;
  }
  union(a: number, b: number): void {
    this.p[this.find(a)] = this.find(b);
  }
}

for (let seed = 1; seed <= 150; seed++) {
  const rnd = mulberry32(seed * 2246822519 + 13);
  const V = 5;
  const bases: number[] = [];
  const cells: Array<{ value: number }> = [];
  for (let i = 0; i < V; i++) {
    const m = Math.floor(rnd() * 16);
    bases.push(m);
    cells.push(fl(m) as unknown as { value: number });
  }
  const seen: number[] = new Array(V);
  const stops = cells.map((c, i) => effect(() => (seen[i] = c.value)));

  const disp = new Map<string, () => void>();
  const edges: Array<[number, number]> = [];
  const oracleValue = (i: number): number => {
    const uf = new UF(V);
    for (const [x, y] of edges) uf.union(x, y);
    const members: number[] = [];
    for (let k = 0; k < V; k++) if (uf.find(k) === uf.find(i)) members.push(k);
    return members.length === 1 ? bases[i]! : andAll(members.map(k => bases[k]!));
  };

  const trace: string[] = [];
  for (let op = 0; op < 14; op++) {
    const i = Math.floor(rnd() * V);
    const j = Math.floor(rnd() * V);
    if (i !== j) {
      const key = i < j ? `${i},${j}` : `${j},${i}`;
      const existing = disp.get(key);
      if (existing === undefined) {
        disp.set(key, equal(cells[i] as never, cells[j] as never));
        edges.push([i, j]);
        trace.push(`+${key}`);
      } else {
        existing();
        disp.delete(key);
        const at = edges.findIndex(([x, y]) => (x === i && y === j) || (x === j && y === i));
        if (at >= 0) edges.splice(at, 1);
        trace.push(`-${key}`);
      }
    }
    settle();
    for (let k = 0; k < V; k++) {
      if (seen[k] !== oracleValue(k)) {
        console.log(`SEED ${seed} op=${op} cell=${k} seen=${seen[k]} want=${oracleValue(k)}`);
        console.log(`  bases=${JSON.stringify(bases)}`);
        console.log(`  trace=${trace.join(" ")}`);
        console.log(`  edges=${JSON.stringify(edges)}`);
        for (const s of stops) s();
        process.exit(0);
      }
    }
  }
  for (const s of stops) s();
}
console.log("ALL PASS");
