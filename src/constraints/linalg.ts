// linalg.ts — constraint-specific dense matrix helpers for AVBD's
// per-cell local Newton system. The SPD solve itself is shared with the
// numerical lenses (`solveSPD` lives in core); this module re-exports it
// and adds the accumulation helpers the solver assembles its LHS with.
//
// Convention: matrices are row-major Float64Array of length n*n.

export { solve2, solve3, solveSPD } from "../core/linalg";

/** Add `α · v · vᵀ` to a square matrix `A` in row-major form.
 *  Used to accumulate Jᵀ J terms in the local Newton system. */
export function addOuterProduct(A: Float64Array, v: Float64Array, alpha: number, n: number): void {
  for (let i = 0; i < n; i++) {
    const vi = v[i]! * alpha;
    for (let j = 0; j < n; j++) {
      A[i * n + j]! += vi * v[j]!;
    }
  }
}

/** Add `α · I` to the diagonal of `A`. */
export function addScaledIdentity(A: Float64Array, alpha: number, n: number): void {
  for (let i = 0; i < n; i++) A[i * n + i]! += alpha;
}

/** Add `α · diag(d)` to the diagonal of `A`. */
export function addDiag(A: Float64Array, d: Float64Array, alpha: number, n: number): void {
  for (let i = 0; i < n; i++) A[i * n + i]! += alpha * d[i]!;
}

export function zeroMatrix(A: Float64Array, n: number): void {
  for (let i = 0; i < n * n; i++) A[i] = 0;
}

export function zeroVector(v: Float64Array, n: number): void {
  for (let i = 0; i < n; i++) v[i] = 0;
}

export function clamp(x: number, lo: number, hi: number): number {
  return x < lo ? lo : x > hi ? hi : x;
}
