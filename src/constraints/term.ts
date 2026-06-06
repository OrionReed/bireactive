// term.ts — abstract Term: one augmented-Lagrangian constraint over
// cells, with residual `C(x)`, Jacobian `J = ∂C/∂x`, dual `λ`, penalty.
// Cells are integer ids into the solver's SOA buffers.
//
// AVBD inner loop, per term:
//   - initialize() once per prepare(); `false` drops the term.
//   - computeConstraint(alpha) writes `C`; hard constraints stabilise
//     as `C(x) = C*(x) − α·C*(x⁻)`.
//   - computeDerivatives(cellIdx) writes the Jacobian column and
//     geometric-stiffness Hessian column-norms. `cellIdx` indexes
//     `term.cells`, not the integer cell id.

import type { Solver } from "./solver";

export const PENALTY_MIN = 1.0;
export const PENALTY_MAX = 1e9;

/** Hard symmetric cap on the per-row multiplier `λ`. Without it the
 *  dual update grows unboundedly while a constraint stays infeasible
 *  (e.g. a joint dragged outside its workspace), blowing positions to
 *  infinity. Capping at `1e9` saturates instead of exploding;
 *  symmetric so equalities stay reachable from either side. */
export const LAMBDA_MAX = 1e9;

export abstract class Term {
  readonly solver: Solver;
  /** Bound cell ids in subclass order; `cells[ci]` is cell-index ci. */
  readonly cells: readonly number[];
  /** Per-cell-index offset into `solver.positions`; cached (offsets are
   *  append-only). */
  readonly cellOffsets: readonly number[];
  readonly cellDims: readonly number[];
  readonly rows: number;

  /** Current constraint values; filled by `computeConstraint`. */
  readonly C: Float64Array;
  /** Constraint values at start of step (hard-constraint stabilisation). */
  readonly C0: Float64Array;
  /** Per-row stiffness; `Infinity` = hard (augmented-Lagrangian path). */
  readonly stiffness: Float64Array;
  /** Per-row lower bound on λ (default `-Infinity`); one-sided
   *  constraints and friction-cone clamps. */
  readonly lambdaMin: Float64Array;
  readonly lambdaMax: Float64Array;
  /** Fracture threshold: `|λ| > fracture` disables the term. */
  readonly fracture: Float64Array;
  /** Current penalty (warm-started, ramped via β). */
  readonly penalty: Float64Array;
  /** Lagrange multiplier for hard constraints (soft uses 0). */
  readonly lambda: Float64Array;
  /** Removal flag, honoured at the next `prepare()`. Set by
   *  `dispose()` or by fracture in `_dualPass`. */
  disabled = false;

  /** Per-cell-index Jacobian; `J[ci]` is `rows × dim` row-major. */
  readonly J: Float64Array[];
  /** Per-cell-index Hessian column norms; same shape as `J[ci]`. */
  readonly HCols: Float64Array[];

  constructor(solver: Solver, cells: readonly number[], rows: number) {
    this.solver = solver;
    this.cells = cells;
    this.cellOffsets = cells.map(id => solver.offsets[id]!);
    this.cellDims = cells.map(id => solver.dims[id]!);
    this.rows = rows;
    this.C = new Float64Array(rows);
    this.C0 = new Float64Array(rows);
    this.stiffness = new Float64Array(rows).fill(Number.POSITIVE_INFINITY);
    this.lambdaMin = new Float64Array(rows).fill(Number.NEGATIVE_INFINITY);
    this.lambdaMax = new Float64Array(rows).fill(Number.POSITIVE_INFINITY);
    this.fracture = new Float64Array(rows).fill(Number.POSITIVE_INFINITY);
    this.penalty = new Float64Array(rows).fill(PENALTY_MIN);
    this.lambda = new Float64Array(rows);
    this.J = this.cellDims.map(d => new Float64Array(rows * d));
    this.HCols = this.cellDims.map(d => new Float64Array(rows * d));
    for (let ci = 0; ci < cells.length; ci++) {
      solver._connectTerm(this, cells[ci]!, ci);
    }
  }

  abstract initialize(): boolean;
  abstract computeConstraint(alpha: number): void;
  abstract computeDerivatives(cellIdx: number): void;

  /** Mark for removal; takes effect on the next solver pass. */
  dispose(): void {
    this.disabled = true;
  }

  /** True iff row is hard (`stiffness === Infinity`). */
  isHard(row: number): boolean {
    return this.stiffness[row]! === Number.POSITIVE_INFINITY;
  }
}
