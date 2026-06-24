// Small dense linear algebra for the numerical backward directions (the
// factor/argmin pseudoinverse `A k = δy` with `A = J W Jᵀ + λI` SPD, and the
// per-cell Newton solves in constraints). Systems are tiny (n ≤ ~12), so
// unrolled solves (n = 2, 3) and in-place LDLᵀ beat anything general-purpose and
// allocate nothing: the matrix is destroyed, the solution written into `b`.
//
// Convention: matrices are row-major, length `n*n`.

/** Dense vector/matrix backing: a typed buffer or a plain array. */
export type Floats = Float64Array | number[];

const TINY = 1e-14;

/** Solve an SPD (or semi-definite) system `A·x = b` in place via LDLᵀ.
 *  `A` is destroyed, the solution is written into `b`. Returns `false`
 *  if too singular to solve safely (callers typically leave state put). */
export function solveSPD(A: Floats, b: Floats, n: number): boolean {
  if (n === 1) {
    const a = A[0]!;
    if (Math.abs(a) < TINY) return false;
    b[0] = b[0]! / a;
    return true;
  }
  if (n === 2) return solve2(A, b);
  if (n === 3) return solve3(A, b);
  return ldltGeneric(A, b, n);
}

/** 2×2 SPD direct solve (uses symmetry: `A[1] === A[2]`). */
export function solve2(A: Floats, b: Floats): boolean {
  const a = A[0]!;
  const c = A[1]!;
  const d = A[3]!;
  const det = a * d - c * c;
  if (Math.abs(det) < TINY) return false;
  const inv = 1 / det;
  const x0 = (d * b[0]! - c * b[1]!) * inv;
  const x1 = (-c * b[0]! + a * b[1]!) * inv;
  b[0] = x0;
  b[1] = x1;
  return true;
}

/** 3×3 SPD direct solve via cofactor expansion. */
export function solve3(A: Floats, b: Floats): boolean {
  const a00 = A[0]!,
    a01 = A[1]!,
    a02 = A[2]!;
  const a10 = A[3]!,
    a11 = A[4]!,
    a12 = A[5]!;
  const a20 = A[6]!,
    a21 = A[7]!,
    a22 = A[8]!;
  const c00 = a11 * a22 - a12 * a21;
  const c01 = -(a10 * a22 - a12 * a20);
  const c02 = a10 * a21 - a11 * a20;
  const det = a00 * c00 + a01 * c01 + a02 * c02;
  if (Math.abs(det) < TINY) return false;
  const c10 = -(a01 * a22 - a02 * a21);
  const c11 = a00 * a22 - a02 * a20;
  const c12 = -(a00 * a21 - a01 * a20);
  const c20 = a01 * a12 - a02 * a11;
  const c21 = -(a00 * a12 - a02 * a10);
  const c22 = a00 * a11 - a01 * a10;
  const inv = 1 / det;
  const b0 = b[0]!,
    b1 = b[1]!,
    b2 = b[2]!;
  b[0] = (c00 * b0 + c10 * b1 + c20 * b2) * inv;
  b[1] = (c01 * b0 + c11 * b1 + c21 * b2) * inv;
  b[2] = (c02 * b0 + c12 * b1 + c22 * b2) * inv;
  return true;
}

/** General LDLᵀ for `n ≥ 4`. In-place: `A` is overwritten with the
 *  factor, `b` with the solution. */
function ldltGeneric(A: Floats, b: Floats, n: number): boolean {
  for (let j = 0; j < n; j++) {
    let djj = A[j * n + j]!;
    for (let k = 0; k < j; k++) {
      const ljk = A[j * n + k]!;
      djj -= ljk * ljk * A[k * n + k]!;
    }
    if (Math.abs(djj) < TINY) return false;
    A[j * n + j] = djj;
    for (let i = j + 1; i < n; i++) {
      let lij = A[i * n + j]!;
      for (let k = 0; k < j; k++) {
        lij -= A[i * n + k]! * A[j * n + k]! * A[k * n + k]!;
      }
      A[i * n + j] = lij / djj;
    }
  }
  // Forward solve L y = b → y in b.
  for (let i = 0; i < n; i++) {
    let yi = b[i]!;
    for (let k = 0; k < i; k++) yi -= A[i * n + k]! * b[k]!;
    b[i] = yi;
  }
  // D solve.
  for (let i = 0; i < n; i++) b[i] = b[i]! / A[i * n + i]!;
  // Backward solve Lᵀ x = y → x in b.
  for (let i = n - 1; i >= 0; i--) {
    let xi = b[i]!;
    for (let k = i + 1; k < n; k++) xi -= A[k * n + i]! * b[k]!;
    b[i] = xi;
  }
  return true;
}
