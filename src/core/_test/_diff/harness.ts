// Differential-fuzz harness for the backward-engine rewrite.
//
// We do NOT trust the existing law suite as the green-light for this rewrite.
// Instead we diff the live engine against a frozen verbatim copy of the
// pre-rewrite engine (`cell-frozen.ts`) on randomly generated bidirectional
// graphs + random read/write/effect sequences, asserting both produce
// identical OBSERVABLES (read values, source values, effect fire counts).
//
// Differential testing needs no correctness spec — only agreement. Where the
// graph is invertible-affine we additionally assert PutGet directly (read-back
// == target), an independent ground truth that trusts neither engine and so
// adjudicates any live-vs-frozen disagreement.

// Each engine module exposes the same surface; type it loosely to avoid
// cross-module identity friction (each module has its own `SKIP` symbol etc).
// biome-ignore lint/suspicious/noExplicitAny: cross-module engine surface
export type Engine = any;

/** Pure, engine-agnostic graph recipe (node `i` may only reference `< i`). */
export type NodeSpec =
  | { kind: "source"; init: number }
  | { kind: "lens1"; parent: number; k: number; b: number; readsSource: boolean }
  | { kind: "derive1"; parent: number; k: number; b: number }
  | { kind: "lensN"; parents: number[]; b: number }
  | { kind: "merge"; parent: number }
  // Multi-out that writes only its first parent (SKIPs the rest): exercises the
  // SKIP / short-tuple path. `fwd = sum`, `bwd = [t - Σothers, SKIP...]`.
  | { kind: "skipN"; parents: number[] }
  // Minimal complement-carrying (stateful) lens — identity through the stateful
  // path, to fuzz the single-source stateful build + `writeBack`'s stateful branch.
  | { kind: "stateful1"; parent: number }
  // Complement-DEPENDENT stateful lens: `view = s + offset`, where a write splits
  // the delta (half to the source, half stashed into the offset) so the VIEW
  // genuinely depends on the complement, and an external source change forgets the
  // offset (the engine runs `step` only on an outside move). This is the node that
  // makes provenance observable to the diff — `stateful1`'s view ignores its complement.
  | { kind: "stateMemo"; parent: number };

export type Op = { kind: "write"; node: number; val: number } | { kind: "read"; node: number };

export interface Recipe {
  nodes: NodeSpec[];
  /** Indices that carry an effect (reads the node, counts fires). */
  effects: number[];
  ops: Op[];
}

export interface Built {
  // biome-ignore lint/suspicious/noExplicitAny: opaque cell handles
  cells: any[];
  fires: number[];
  read(i: number): number;
  write(i: number, v: number): void;
  settle(): void;
}

/** A node is writable iff it is a source or a (non-derive) lens. */
export function writable(n: NodeSpec): boolean {
  return n.kind !== "derive1";
}

/** Materialize a recipe against one engine module. */
export function build(rx: Engine, r: Recipe): Built {
  const { cell, lens, derive, effect, settle, SKIP } = rx;
  // biome-ignore lint/suspicious/noExplicitAny: opaque cell handles
  const cells: any[] = [];
  for (const n of r.nodes) {
    switch (n.kind) {
      case "source":
        cells.push(cell(n.init));
        break;
      case "lens1": {
        const p = cells[n.parent];
        const { k, b } = n;
        const view = n.readsSource
          ? lens(
              p,
              (x: number) => k * x + b,
              (t: number, _s: number) => (t - b) / k,
            )
          : lens(
              p,
              (x: number) => k * x + b,
              (t: number) => (t - b) / k,
            );
        cells.push(view);
        break;
      }
      case "derive1": {
        const p = cells[n.parent];
        const { k, b } = n;
        cells.push(derive(p, (x: number) => k * x + b));
        break;
      }
      case "lensN": {
        const ps = n.parents.map(i => cells[i]);
        const cnt = ps.length;
        const { b } = n;
        cells.push(
          lens(
            ps,
            (vals: number[]) => vals.reduce((a: number, x: number) => a + x, 0) + b,
            (t: number, vals: number[]) => {
              const cur = vals.reduce((a: number, x: number) => a + x, 0) + b;
              const d = (t - cur) / cnt;
              return vals.map((x: number) => x + d);
            },
          ),
        );
        break;
      }
      case "merge": {
        cells.push(cells[n.parent].merge());
        break;
      }
      case "skipN": {
        const ps = n.parents.map(i => cells[i]);
        cells.push(
          lens(
            ps,
            (vals: number[]) => vals.reduce((a: number, x: number) => a + x, 0),
            // readsSource (2-arg): write target into parent 0, SKIP the rest.
            (t: number, vals: number[]) => [
              t - (vals.reduce((a: number, x: number) => a + x, 0) - vals[0]!),
              ...vals.slice(1).map(() => SKIP),
            ],
          ),
        );
        break;
      }
      case "stateful1": {
        const p = cells[n.parent];
        cells.push(
          // No `step`: exercises the default (`init`) refresh, run by the engine
          // only on an outside source move. `fwd` ignores the complement.
          lens(p, {
            init: (s: number) => ({ last: s }),
            fwd: (s: number) => s,
            bwd: (t: number) => ({ update: t, complement: { last: t } }),
          }),
        );
        break;
      }
      case "stateMemo": {
        const p = cells[n.parent];
        cells.push(
          // view = s + off. Write splits the delta: source moves half, off keeps
          // half (PutGet: (s + d/2) + (off + d/2) = s + off + d = t). An outside
          // source change runs `step` (explicit here), forgetting the offset, so the
          // VIEW depends on both the complement AND the engine's provenance verdict.
          lens(p, {
            init: (_s: number) => ({ off: 0 }),
            step: (_s: number, _c: { off: number }) => ({ off: 0 }),
            fwd: (s: number, c: { off: number }) => s + c.off,
            bwd: (t: number, s: number, c: { off: number }) => {
              const d = t - (s + c.off);
              return { update: s + d / 2, complement: { off: c.off + d / 2 } };
            },
          }),
        );
        break;
      }
    }
  }
  const fires = r.effects.map(() => 0);
  r.effects.forEach((idx, ei) => {
    effect(() => {
      void cells[idx].value;
      fires[ei]++;
    });
  });
  // Settle the initial effect fire so it isn't counted in the trace baseline.
  settle();
  for (let i = 0; i < fires.length; i++) fires[i] = 0;
  void SKIP;
  return {
    cells,
    fires,
    read: (i: number) => cells[i].value as number,
    write: (i: number, v: number) => {
      cells[i].value = v;
    },
    settle: () => settle(),
  };
}

export interface Trace {
  reads: number[];
  final: number[];
  fires: number[];
  threw: boolean;
}

/** Run a recipe's op sequence against an engine, recording observables. */
export function run(rx: Engine, r: Recipe): Trace {
  const reads: number[] = [];
  let threw = false;
  let g: Built;
  try {
    g = build(rx, r);
  } catch {
    return { reads: [], final: [], fires: [], threw: true };
  }
  for (const op of r.ops) {
    try {
      if (op.kind === "read") {
        reads.push(round(g.read(op.node)));
      } else {
        g.write(op.node, op.val);
        g.settle();
      }
    } catch {
      // A caught illegal op (e.g. write-through a computed) leaves
      // implementation-defined state; stop so only pre-throw behavior is
      // compared. Both engines detect the same illegal op at the same point.
      threw = true;
      break;
    }
  }
  if (threw) return { reads, final: [], fires: [...g.fires], threw };
  const final = g.cells.map((_, i) => {
    try {
      return round(g.read(i));
    } catch {
      threw = true;
      return Number.NaN;
    }
  });
  try {
    g.settle();
  } catch {
    threw = true;
  }
  return { reads, final, fires: [...g.fires], threw };
}

/** Round to tame float drift; both engines run identical arithmetic so this is
 *  belt-and-suspenders against accumulation order, not a correctness fudge. */
export function round(x: number): number {
  if (!Number.isFinite(x)) return x;
  return Math.round(x * 1e6) / 1e6;
}

export function tracesEqual(a: Trace, b: Trace): boolean {
  if (a.threw !== b.threw) return false;
  return vecEq(a.reads, b.reads) && vecEq(a.final, b.final) && vecEq(a.fires, b.fires);
}

function vecEq(a: number[], b: number[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (Number.isNaN(a[i]!) && Number.isNaN(b[i]!)) continue;
    if (a[i] !== b[i]) return false;
  }
  return true;
}
