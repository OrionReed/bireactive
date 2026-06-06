// Shared test helpers: float/vec approximate equality and a seeded PRNG,
// factored out of the per-suite copies that drifted apart.

/** Float and vec approximate-equality closed over a default tolerance. */
export function approxWithin(tol: number) {
  const near = (a: number, b: number, t = tol): boolean => Math.abs(a - b) < t;
  const vnear = (a: { x: number; y: number }, b: { x: number; y: number }, t = tol): boolean =>
    near(a.x, b.x, t) && near(a.y, b.y, t);
  return { near, vnear };
}

/** Seeded LCG returning [0, 1); reproducible across runs. */
export function lcg(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 0x100000000;
  };
}
