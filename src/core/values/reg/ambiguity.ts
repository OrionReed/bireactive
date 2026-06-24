import { alphabetOf, der, nullable, type Re, reKey } from "./engine";

const cp = (c: number): string => String.fromCharCode(c);

/** Representative code units that distinguish every transition in `a` and `b`
 *  (the range endpoints of every char class). Sufficient to realize every
 *  reachable derivative pair. */
function alphaUnion(a: Re, b: Re): number[] {
  const set = alphabetOf(a);
  alphabetOf(b, set);
  return [...set];
}

/** Fold the derivative across a string. */
function applyStr(r: Re, s: string): Re {
  let cur = r;
  for (let i = 0; i < s.length && cur.k !== "emp"; i++) cur = der(cur, s.charCodeAt(i));
  return cur;
}

/** A witness in `L(a) ∩ L(b)` (shortest), or `null` if the languages are
 *  disjoint. Product BFS over derivative pairs. */
export function intersects(a: Re, b: Re): string | null {
  const alpha = alphaUnion(a, b);
  const seen = new Set<string>([`${reKey(a)}|${reKey(b)}`]);
  const queue: Array<{ a: Re; b: Re; w: string }> = [{ a, b, w: "" }];
  for (let head = 0; head < queue.length; head++) {
    const { a: da, b: db, w } = queue[head]!;
    if (nullable(da) && nullable(db)) return w;
    for (const c of alpha) {
      const na = der(da, c);
      if (na.k === "emp") continue;
      const nb = der(db, c);
      if (nb.k === "emp") continue;
      const key = `${reKey(na)}|${reKey(nb)}`;
      if (seen.has(key)) continue;
      seen.add(key);
      queue.push({ a: na, b: nb, w: w + cp(c) });
    }
  }
  return null;
}

/** All reachable derivative states of `r`, each with a shortest word reaching
 *  it (BFS over the derivative automaton). */
function reachableStates(r: Re): Map<string, { re: Re; word: string }> {
  const alpha = [...alphabetOf(r)];
  const out = new Map<string, { re: Re; word: string }>([[reKey(r), { re: r, word: "" }]]);
  const queue: Array<{ re: Re; word: string }> = [{ re: r, word: "" }];
  for (let head = 0; head < queue.length; head++) {
    const { re, word } = queue[head]!;
    for (const c of alpha) {
      const d = der(re, c);
      if (d.k === "emp") continue;
      const k = reKey(d);
      if (out.has(k)) continue;
      const w = word + cp(c);
      out.set(k, { re: d, word: w });
      queue.push({ re: d, word: w });
    }
  }
  return out;
}

const SET_KEY = (states: readonly Re[]): string => states.map(reKey).sort().join(",");

const dedup = (states: readonly Re[]): Re[] => {
  const seen = new Set<string>();
  const out: Re[] = [];
  for (const s of states) {
    const k = reKey(s);
    if (!seen.has(k)) {
      seen.add(k);
      out.push(s);
    }
  }
  return out;
};

// A generous bound: if the product search explodes past this, refuse to certify
// (sound — we reject rather than risk admitting an ambiguous grammar).
const MAX_STATES = 200000;

/** A witness string that `a · b` factors two distinct ways, or `null` if the
 *  concatenation is unambiguous. Ambiguous iff some nonempty bridge `t` can
 *  both extend a word of `L(a)` and be absorbed into `L(b)`. */
export function concatAmbiguity(a: Re, b: Re): string | null {
  const statesA = reachableStates(a);
  const accepting: Array<{ re: Re; word: string }> = [];
  for (const st of statesA.values()) if (nullable(st.re)) accepting.push(st);
  if (accepting.length === 0) return null; // L(a) = ∅: nothing to split

  const alpha = alphaUnion(a, b);
  // Search for a nonempty bridge `t`: state = (set of A-derivatives reached
  // from A's accepting states by `t`, der(b, t)).
  const start = dedup(accepting.map(s => s.re));
  const seen = new Set<string>([`${SET_KEY(start)}|${reKey(b)}`]);
  const queue: Array<{ sa: Re[]; db: Re; t: string }> = [{ sa: start, db: b, t: "" }];
  for (let head = 0; head < queue.length; head++) {
    if (seen.size > MAX_STATES) throw new Error("reg: grammar too complex to verify");
    const { sa, db, t } = queue[head]!;
    if (t.length > 0 && sa.some(nullable)) {
      const v = intersects(db, b); // v ∈ L(b) with t·v ∈ L(b)
      if (v !== null) return witnessFor(accepting, t, v);
    }
    for (const c of alpha) {
      const db2 = der(db, c);
      if (db2.k === "emp") continue; // t·… can no longer be a prefix of L(b)
      const sa2 = dedup(sa.map(s => der(s, c)).filter(s => s.k !== "emp"));
      if (sa2.length === 0) continue; // no accepting continuation on the left
      const key = `${SET_KEY(sa2)}|${reKey(db2)}`;
      if (seen.has(key)) continue;
      seen.add(key);
      queue.push({ sa: sa2, db: db2, t: t + cp(c) });
    }
  }
  return null;
}

/** Assemble the full doubly-parsing string `u·t·v`: pick an accepting `u ∈ L(a)`
 *  (shortest known) with `u·t ∈ L(a)`; falls back to `t·v` if none is found. */
function witnessFor(
  accepting: ReadonlyArray<{ re: Re; word: string }>,
  t: string,
  v: string,
): string {
  for (const s of accepting) if (nullable(applyStr(s.re, t))) return s.word + t + v;
  return t + v;
}
