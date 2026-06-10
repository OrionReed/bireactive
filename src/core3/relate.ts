// relate.ts — cyclic-relationship combinators over knowledge cells.
//
// The engine itself (the relation graph, on-read SCC discovery, and the
// `Component` lattice solver) lives in `cell.ts`, fused into the same pull as
// the acyclic forward/backward engine: you declare relationships directly as
// plain functions over lattice cells via `constrain`, and any subset of cells
// may participate in a cycle — the engine discovers each SCC on read and solves
// it as a unit. This module is just the ergonomic surface: `equal` plus the
// interval contractors (`bound`/`order`/`add`/`total`), `assert`, and the
// re-exported `constrain`/`free`.
//
// Cost isolation: a plain cell has no lattice and joins no relation, so it never
// touches any of this. Only declared cyclic regions pay, each solve bounded to
// its own component.

import { type Cell, constrain, free } from "./cell";

export { constrain, free };

// biome-ignore lint/suspicious/noExplicitAny: heterogeneous relation graph
type AnyCell = Cell<any>;

// ── interval-knowledge helpers (the two-way numeric contractors) ──
const NINF = Number.NEGATIVE_INFINITY;
const PINF = Number.POSITIVE_INFINITY;
interface Iv {
  readonly min: number;
  readonly max: number;
}
const iv = (k: unknown): Iv => k as Iv;

/** Re-assert a knowledge cell's standing value. While the cell is a member this
 *  re-seeds its standing and re-invalidates its region (a source member) or
 *  routes upstream through its lens (a lens member); otherwise it writes the
 *  cell directly. Plain `cell.value = …` does the same — `assert` is just the
 *  explicit spelling. */
export function assert<T>(c: Cell<T>, value: T): void {
  (c as { value: T }).value = value;
}

// ── relation combinators (declared directly, no wrapper) ────────────

/** a = b — each cell's knowledge meets the other's (their common refinement
 *  in the lattice). Knowledge flows both ways; conflicting concretes give a
 *  contradiction (`isBottom`). */
export function equal<T>(a: Cell<T>, b: Cell<T>): () => void {
  const ca = a as Cell<unknown>;
  const cb = b as Cell<unknown>;
  const d1 = constrain([a], [b], (get, emit) => emit(cb, get(ca)));
  const d2 = constrain([b], [a], (get, emit) => emit(ca, get(cb)));
  return () => {
    d1();
    d2();
  };
}

// ── interval contractors (native two-way narrowers) ─────────────────
//
// Each emits a one-sided band, so it NARROWS rather than asserts: it folds
// through the solver's `meet` and inherits termination + order-independence.
// Like every inequality, a contractor only refines a cell that is a BAND (an
// underdetermined/free member, seeded ⊤); a cell pinned to a concrete fact that
// the band excludes is a contradiction, not a narrowing. The cells must carry
// the interval lattice.

/** `x ∈ [lo, hi]` (pins when `hi` is omitted). Self-applying, so a widening
 *  re-seed gets re-narrowed. */
export function bound(x: Cell<number>, lo: number, hi: number = lo): () => void {
  const cx = x as Cell<unknown>;
  return constrain([x], [x], (_get, emit) => emit(cx, { min: lo, max: hi }));
}

/** `a + gap ≤ b`. Narrows `a` from above and `b` from below. */
export function order(a: Cell<number>, b: Cell<number>, gap = 0): () => void {
  const ca = a as Cell<unknown>;
  const cb = b as Cell<unknown>;
  const d1 = constrain([b], [a], (get, emit) =>
    emit(ca, { min: NINF, max: iv(get(cb)).max - gap }),
  );
  const d2 = constrain([a], [b], (get, emit) =>
    emit(cb, { min: iv(get(ca)).min + gap, max: PINF }),
  );
  return () => {
    d1();
    d2();
  };
}

/** `a + b = c`. Three narrowers; any two bound the third. */
export function add(a: Cell<number>, b: Cell<number>, c: Cell<number>): () => void {
  const ca = a as Cell<unknown>;
  const cb = b as Cell<unknown>;
  const cc = c as Cell<unknown>;
  const d1 = constrain([a, b], [c], (get, emit) => {
    const ia = iv(get(ca));
    const ib = iv(get(cb));
    emit(cc, { min: ia.min + ib.min, max: ia.max + ib.max });
  });
  const d2 = constrain([a, c], [b], (get, emit) => {
    const ia = iv(get(ca));
    const ic = iv(get(cc));
    emit(cb, { min: ic.min - ia.max, max: ic.max - ia.min });
  });
  const d3 = constrain([b, c], [a], (get, emit) => {
    const ib = iv(get(cb));
    const ic = iv(get(cc));
    emit(ca, { min: ic.min - ib.max, max: ic.max - ib.min });
  });
  return () => {
    d1();
    d2();
    d3();
  };
}

/** `Σ parts = whole`. N+1 narrowers: whole from the parts, each part from
 *  whole minus the others. Order-independent. */
export function total(parts: readonly Cell<number>[], whole: Cell<number>): () => void {
  if (parts.length === 0) return () => {};
  const cw = whole as Cell<unknown>;
  const cparts = parts as readonly Cell<unknown>[];
  const disposers: (() => void)[] = [];
  disposers.push(
    constrain(parts, [whole], (get, emit) => {
      let min = 0;
      let max = 0;
      for (const p of cparts) {
        const ip = iv(get(p));
        min += ip.min;
        max += ip.max;
      }
      emit(cw, { min, max });
    }),
  );
  for (let i = 0; i < parts.length; i++) {
    const target = cparts[i]!;
    const others = cparts.filter((_, j) => j !== i);
    disposers.push(
      constrain([whole, ...others], [parts[i]!], (get, emit) => {
        let oMin = 0;
        let oMax = 0;
        for (const o of others) {
          const io = iv(get(o));
          oMin += io.min;
          oMax += io.max;
        }
        const iw = iv(get(cw));
        emit(target, { min: iw.min - oMax, max: iw.max - oMin });
      }),
    );
  }
  return () => {
    for (const d of disposers) d();
  };
}
