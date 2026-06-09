// Property/fuzz: the pull-driven relation engine vs an INDEPENDENT global
// naive-Kleene oracle, generalised past the existing `equal`-only intersection
// oracle (see relate-fuzz.test.ts) along three axes:
//
//   • multiple lattices in one run — `Range` (componentwise (lo,hi) interval
//     meet — field-wise unification) AND `Flags` (bit-AND meet), with each
//     connected same-class subgraph free to form a cyclic SCC;
//   • directed `narrow` rules (`b := b ⊓ a`) alongside symmetric `equal`,
//     so components are real propagator folds, not just intersections;
//   • the engine's per-SCC, topologically-pulled solve is checked against a
//     single global fixpoint computed over ALL rules at once — agreement
//     validates that SCC decomposition + pull ordering = the global least
//     fixpoint.
//
// The oracle re-implements interval/bit meet locally (NOT importing the value
// classes' lattices) so a bug in `Range.lattice`/`Flags.lattice` surfaces as a
// mismatch rather than being masked by shared code.
//
// Rules are restricted to pure meet folds (`equal`/`narrow`): values only ever
// narrow within the finite span of the bases, so every run is guaranteed to
// converge fast — no divergence, no wave cap in play. (Offset folds like
// `geGap`, which can diverge in a positive cycle, get their own bounded
// acyclic test in relate-fuzz.ts.)
//
// Properties checked per generated scenario:
//   1. engine value == global oracle value, for every cell;
//   2. confluence — the oracle reaches the same fixpoint with rule order
//      reversed (meet is order-independent);
//   3. idempotence — a second settle() changes nothing;
//   4. relax-to-base — disposing every rule returns each cell to its base.

import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { Flags, range, settle } from "../index";
import { assert, constrain, equal } from "../relate";

const BITS = ["b0", "b1", "b2", "b3"] as const;

type Cls = "range" | "flags";
type RV = { lo: number; hi: number };

// Independent lattice math — duplicated on purpose (see header).
// Coordinate-pair Range knowledge: an interval per endpoint.
type RK = { loMin: number; loMax: number; hiMin: number; hiMax: number };
const seedRK = (v: RV): RK => ({ loMin: v.lo, loMax: v.lo, hiMin: v.hi, hiMax: v.hi });
const meetRK = (a: RK, b: RK): RK => ({
  loMin: Math.max(a.loMin, b.loMin),
  loMax: Math.min(a.loMax, b.loMax),
  hiMin: Math.max(a.hiMin, b.hiMin),
  hiMax: Math.min(a.hiMax, b.hiMax),
});
const eqRK = (a: RK, b: RK): boolean =>
  a.loMin === b.loMin && a.loMax === b.loMax && a.hiMin === b.hiMin && a.hiMax === b.hiMax;
const conc1 = (min: number, max: number, fb: number): number =>
  min > max ? fb : min === max ? min : Math.max(min, Math.min(max, fb));
const concRK = (k: RK, base: RV): RV => ({
  lo: conc1(k.loMin, k.loMax, base.lo),
  hi: conc1(k.hiMin, k.hiMax, base.hi),
});

interface Scenario {
  readonly classes: readonly Cls[];
  readonly rangeBases: readonly { lo: number; w: number }[];
  readonly flagBases: readonly number[];
  readonly rules: readonly { i: number; j: number; kind: "equal" | "narrow" }[];
}

const arbScenario: fc.Arbitrary<Scenario> = fc.record({
  classes: fc.array(fc.constantFrom<Cls>("range", "flags"), { minLength: 2, maxLength: 6 }),
  // Fixed length 6 so any cell index (0..5, post-mod) has a base.
  rangeBases: fc.array(
    fc.record({ lo: fc.integer({ min: 0, max: 20 }), w: fc.integer({ min: 0, max: 20 }) }),
    {
      minLength: 6,
      maxLength: 6,
    },
  ),
  flagBases: fc.array(fc.integer({ min: 0, max: 15 }), { minLength: 6, maxLength: 6 }),
  rules: fc.array(
    fc.record({
      i: fc.integer({ min: 0, max: 5 }),
      j: fc.integer({ min: 0, max: 5 }),
      kind: fc.constantFrom<"equal" | "narrow">("equal", "narrow"),
    }),
    { maxLength: 8 },
  ),
});

type Value = RV | number;

const baseOf = (s: Scenario, i: number): Value =>
  s.classes[i] === "range"
    ? { lo: s.rangeBases[i]!.lo, hi: s.rangeBases[i]!.lo + s.rangeBases[i]!.w }
    : s.flagBases[i]!;

/** Keep only well-typed, non-self rules between same-class cells (mod n). */
function normalize(s: Scenario): { i: number; j: number; kind: "equal" | "narrow" }[] {
  const n = s.classes.length;
  const out: { i: number; j: number; kind: "equal" | "narrow" }[] = [];
  for (const r of s.rules) {
    const i = r.i % n;
    const j = r.j % n;
    if (i === j || s.classes[i] !== s.classes[j]) continue;
    out.push({ i, j, kind: r.kind });
  }
  return out;
}

/** Directed dataflow edges: `to := to ⊓ from`. `equal` is two edges. */
function toEdges(rules: ReturnType<typeof normalize>): { from: number; to: number }[] {
  const edges: { from: number; to: number }[] = [];
  for (const r of rules) {
    edges.push({ from: r.i, to: r.j });
    if (r.kind === "equal") edges.push({ from: r.j, to: r.i });
  }
  return edges;
}

/** Global naive Kleene over all edges from the given live bases until
 *  quiescence, then concretize each Range field (a conflicting endpoint keeps
 *  its base) — the oracle. Pure monotone meet: a `narrow`/`equal` edge folds
 *  `to := to ⊓ from` to the greatest lower bound. Associative/commutative/
 *  idempotent, so the fixpoint is order-independent (confluence is a checked
 *  property). A contradiction collapses to ⊥ and `concRK` then falls back to the
 *  base endpoint (§7c). */
function kleene(
  classes: readonly Cls[],
  bases: readonly Value[],
  edges: { from: number; to: number }[],
): Value[] {
  const work: (RK | number)[] = bases.map(v => (typeof v === "number" ? v : seedRK(v)));
  let moved = true;
  let waves = 0;
  while (moved && waves < 10_000) {
    waves++;
    moved = false;
    for (const { from, to } of edges) {
      if (classes[to] === "range") {
        const next = meetRK(work[to] as RK, work[from] as RK);
        if (!eqRK(next, work[to] as RK)) {
          work[to] = next;
          moved = true;
        }
      } else {
        const next = (work[to] as number) & (work[from] as number);
        if (next !== work[to]) {
          work[to] = next;
          moved = true;
        }
      }
    }
  }
  return classes.map((cls, i) =>
    cls === "range" ? concRK(work[i] as RK, bases[i] as RV) : (work[i] as number),
  );
}

// biome-ignore lint/suspicious/noExplicitAny: heterogeneous relation graph
type AnyCell = any;

function makeCells(s: Scenario): AnyCell[] {
  const cells: AnyCell[] = [];
  for (let i = 0; i < s.classes.length; i++) {
    if (s.classes[i] === "range") {
      const b = baseOf(s, i) as RV;
      cells.push(range(b.lo, b.hi));
    } else {
      cells.push(new Flags([...BITS], baseOf(s, i) as number));
    }
  }
  return cells;
}

const applyRule = (
  cells: AnyCell[],
  r: { i: number; j: number; kind: "equal" | "narrow" },
): (() => void) =>
  r.kind === "equal"
    ? equal(cells[r.i], cells[r.j])
    : constrain([cells[r.i]], [cells[r.j]], (get, emit) => emit(cells[r.j], get(cells[r.i])));

function buildEngine(s: Scenario, rules: ReturnType<typeof normalize>) {
  const cells = makeCells(s);
  const disposers = rules.map(r => applyRule(cells, r));
  return { cells, disposers };
}

const read = (s: Scenario, c: AnyCell, i: number): Value =>
  s.classes[i] === "range" ? { lo: c.value.lo, hi: c.value.hi } : (c.value as number);

describe("relate vs global Kleene oracle (range + flags, equal + narrow)", () => {
  it("engine == oracle; confluent; idempotent; relaxes to base", () => {
    fc.assert(
      fc.property(arbScenario, s => {
        const rules = normalize(s);
        const edges = toEdges(rules);
        const { cells, disposers } = buildEngine(s, rules);

        const bases = s.classes.map((_, i) => baseOf(s, i));

        // 1. engine == global oracle
        const want = kleene(s.classes, bases, edges);
        const got = cells.map((c, i) => read(s, c, i));
        for (let i = 0; i < cells.length; i++) {
          if (s.classes[i] === "range") expect(got[i]).toEqual(want[i]);
          else expect(got[i]).toBe(want[i]);
        }

        // 2. confluence — reversed rule order, same oracle fixpoint
        const rev = kleene(s.classes, bases, [...edges].reverse());
        expect(rev).toEqual(want);

        // 3. idempotence — a second settle moves nothing
        settle();
        for (let i = 0; i < cells.length; i++) {
          if (s.classes[i] === "range") expect(read(s, cells[i], i)).toEqual(got[i]);
          else expect(read(s, cells[i], i)).toBe(got[i]);
        }

        // 4. relax-to-base — dropping every rule returns each cell to its base
        for (const d of disposers) d();
        for (let i = 0; i < cells.length; i++) {
          if (s.classes[i] === "range") expect(read(s, cells[i], i)).toEqual(baseOf(s, i));
          else expect(read(s, cells[i], i)).toBe(baseOf(s, i));
        }
      }),
      { numRuns: 400 },
    );
  });
});

// Reactive across solves: interleave rule toggles with base RE-ASSERTS
// (including widening — the anti-monotone-across-ticks case the model relies
// on). After every edit the engine must re-solve to the oracle computed from
// the CURRENT live bases and the CURRENT active rule set.
const arbOps = fc.array(
  fc.record({
    op: fc.constantFrom<"toggle" | "reassert">("toggle", "reassert"),
    a: fc.integer({ min: 0, max: 7 }),
    lo: fc.integer({ min: 0, max: 20 }),
    w: fc.integer({ min: 0, max: 20 }),
    mask: fc.integer({ min: 0, max: 15 }),
  }),
  { maxLength: 14 },
);

describe("relate reactive churn vs oracle (toggles + base re-asserts)", () => {
  it("re-solves to the oracle after every rule toggle and base re-assert", () => {
    fc.assert(
      fc.property(arbScenario, arbOps, (s, ops) => {
        const n = s.classes.length;
        const rules = normalize(s);
        const cells = makeCells(s);
        const liveBases: Value[] = s.classes.map((_, i) => baseOf(s, i));
        const active = new Map<number, () => void>();
        const history: string[] = [];

        const checkAll = () => {
          const edges = toEdges([...active.keys()].map(k => rules[k]!));
          const want = kleene(s.classes, liveBases, edges);
          for (let i = 0; i < n; i++) {
            const got = read(s, cells[i], i);
            const ok =
              s.classes[i] === "range"
                ? JSON.stringify(got) === JSON.stringify(want[i])
                : got === want[i];
            if (!ok) {
              throw new Error(
                `MISMATCH i=${i} cls=${s.classes[i]}\n got=${JSON.stringify(got)} want=${JSON.stringify(want[i])}\n classes=${JSON.stringify(s.classes)}\n rules=${JSON.stringify(rules)}\n active=${JSON.stringify([...active.keys()])}\n liveBases=${JSON.stringify(liveBases)}\n history=${JSON.stringify(history)}`,
              );
            }
          }
        };

        for (const o of ops) {
          if (o.op === "toggle" && rules.length > 0) {
            const idx = o.a % rules.length;
            const d = active.get(idx);
            if (d !== undefined) {
              d();
              active.delete(idx);
              history.push(`toggleOFF ${idx}`);
            } else {
              active.set(idx, applyRule(cells, rules[idx]!));
              history.push(`toggleON ${idx}`);
            }
          } else if (o.op === "reassert") {
            const i = o.a % n;
            const nv: Value = s.classes[i] === "range" ? { lo: o.lo, hi: o.lo + o.w } : o.mask;
            assert(cells[i], nv);
            liveBases[i] = nv;
            history.push(`reassert ${i}=${JSON.stringify(nv)}`);
          }
          settle();
          checkAll();
        }

        for (const d of active.values()) d();
      }),
      { numRuns: 250 },
    );
  });
});
