// stacked-stateful.test.ts — the make-or-break spike from
// `_notes/seq-value-class.md §8`: two *separate* complement-carrying
// stateful lenses (filter, then sort) stacked as distinct cells, with a
// write to the FINAL view round-tripping to the source through both
// complements in order. If this passes, the permutation/interleaving
// demos (reorderable lists, twisted trees) are tractable; if it forces
// monolithing, the leverage evaporates. It passes.

import { describe, expect, it } from "vitest";
import { type Cell, cell, lens, type Writable } from "../../cell";

/** filter: forward drops elements failing `pred`; the complement records
 *  the kept source positions so a write to the filtered view splices the
 *  edited values back in place, conserving the dropped ones (interleaving). */
function filterLens(
  src: Writable<Cell<number[]>>,
  pred: (x: number) => boolean,
): Writable<Cell<number[]>> {
  type C = { keep: number[] };
  const keptPositions = (arr: readonly number[]): number[] => {
    const out: number[] = [];
    for (let i = 0; i < arr.length; i++) if (pred(arr[i]!)) out.push(i);
    return out;
  };
  return lens<number[], number[], C>(src, {
    init: s => ({ keep: keptPositions(s) }),
    step: s => ({ keep: keptPositions(s) }),
    fwd: s => s.filter(pred),
    bwd: (view, s, c) => {
      const next = s.slice();
      for (let j = 0; j < c.keep.length; j++) next[c.keep[j]!] = view[j]!;
      return { update: next, complement: c };
    },
  });
}

/** sort: forward sorts a copy; the complement is the permutation π with
 *  `view[i] = src[π[i]]`, so a write to the sorted view scatters back to
 *  the original positions (edit a sorted row, the source row updates). */
function sortLens(
  src: Writable<Cell<number[]>>,
  cmp: (a: number, b: number) => number,
): Writable<Cell<number[]>> {
  type C = { perm: number[] };
  const permutation = (arr: readonly number[]): number[] =>
    arr.map((_, i) => i).sort((i, j) => cmp(arr[i]!, arr[j]!));
  return lens<number[], number[], C>(src, {
    init: s => ({ perm: permutation(s) }),
    step: s => ({ perm: permutation(s) }),
    fwd: (s, c) => c.perm.map(i => s[i]!),
    bwd: (view, s, c) => {
      const next = s.slice();
      for (let i = 0; i < c.perm.length; i++) next[c.perm[i]!] = view[i]!;
      return { update: next, complement: c };
    },
  });
}

describe("stacked stateful lenses — filter ∘ sort round-trip (the spike)", () => {
  it("forward composes: filter(<8) then ascending sort", () => {
    const source = cell<number[]>([5, 3, 8, 1, 9, 2]);
    const filtered = filterLens(source, x => x < 8);
    const sorted = sortLens(filtered, (a, b) => a - b);
    expect(filtered.value).toEqual([5, 3, 1, 2]);
    expect(sorted.value).toEqual([1, 2, 3, 5]);
  });

  it("GetPut: writing the view back unchanged leaves the source intact", () => {
    const source = cell<number[]>([5, 3, 8, 1, 9, 2]);
    const filtered = filterLens(source, x => x < 8);
    const sorted = sortLens(filtered, (a, b) => a - b);
    sorted.value = sorted.value.slice(); // structurally equal, fresh identity
    expect(source.value).toEqual([5, 3, 8, 1, 9, 2]);
  });

  it("editing the final view inverts through BOTH complements in order", () => {
    const source = cell<number[]>([5, 3, 8, 1, 9, 2]);
    const filtered = filterLens(source, x => x < 8);
    const sorted = sortLens(filtered, (a, b) => a - b);

    // sorted is [1,2,3,5]; the 1 lives at source index 3. Edit it to 4.
    const edit = sorted.value.slice();
    edit[0] = 4;
    sorted.value = edit;

    // The edit must land on exactly the source element that produced it,
    // through sort's permutation and filter's interleaving, dropped
    // elements (8 at idx 2, 9 at idx 4) conserved.
    expect(source.value).toEqual([5, 3, 8, 4, 9, 2]);
    // And the views recompute consistently afterwards.
    expect(filtered.value).toEqual([5, 3, 4, 2]);
    expect(sorted.value).toEqual([2, 3, 4, 5]);
  });

  it("a reorder written at the sorted view rewrites source positions", () => {
    const source = cell<number[]>([30, 10, 20]);
    const sorted = sortLens(source, (a, b) => a - b); // [10,20,30], π=[1,2,0]
    // Reverse the sorted view: [30,20,10]. Each slot scatters home.
    sorted.value = [30, 20, 10];
    // view[0]=30→src[1], view[1]=20→src[2], view[2]=10→src[0]
    expect(source.value).toEqual([10, 30, 20]);
  });
});
