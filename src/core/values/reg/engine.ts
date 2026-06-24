// Matching is over UTF-16 code units (JS regex without the `/u` flag): `.` is
// one code unit, an astral char is two. Keeps the whole stack in one index space.

const UNIT_MAX = 0xffff;

/** A set of UTF-16 code units as sorted, merged, inclusive ranges. Negation is
 *  resolved at construction, so a set is always a positive union of ranges. */
export class CharSet {
  private constructor(readonly ranges: ReadonlyArray<readonly [number, number]>) {}

  /** Build from arbitrary (possibly overlapping/unsorted) ranges. */
  static of(ranges: ReadonlyArray<readonly [number, number]>): CharSet {
    return new CharSet(normalize(ranges));
  }

  static char(cp: number): CharSet {
    return new CharSet([[cp, cp]]);
  }

  static range(lo: number, hi: number): CharSet {
    return new CharSet(lo <= hi ? [[lo, hi]] : [[hi, lo]]);
  }

  /** The full code-unit alphabet. */
  static full(): CharSet {
    return new CharSet([[0, UNIT_MAX]]);
  }

  static empty(): CharSet {
    return new CharSet([]);
  }

  has(cp: number): boolean {
    for (const [lo, hi] of this.ranges) {
      if (cp < lo) return false;
      if (cp <= hi) return true;
    }
    return false;
  }

  isEmpty(): boolean {
    return this.ranges.length === 0;
  }

  union(other: CharSet): CharSet {
    return CharSet.of([...this.ranges, ...other.ranges]);
  }

  /** Do the two sets share any code unit? (Both are sorted/normalized.) */
  overlaps(other: CharSet): boolean {
    let i = 0;
    let j = 0;
    while (i < this.ranges.length && j < other.ranges.length) {
      const a = this.ranges[i]!;
      const b = other.ranges[j]!;
      if (a[1] < b[0]) i++;
      else if (b[1] < a[0]) j++;
      else return true;
    }
    return false;
  }

  /** Complement against the full code-unit alphabet. */
  complement(): CharSet {
    const out: Array<[number, number]> = [];
    let at = 0;
    for (const [lo, hi] of this.ranges) {
      if (lo > at) out.push([at, lo - 1]);
      at = hi + 1;
    }
    if (at <= UNIT_MAX) out.push([at, UNIT_MAX]);
    return new CharSet(out);
  }

  /** Case-fold (ASCII + via `toUpperCase`/`toLowerCase`) for the `i` flag.
   *  Conservative: adds the upper/lower variant of every unit in range. */
  ignoreCase(): CharSet {
    const extra: Array<[number, number]> = [];
    for (const [lo, hi] of this.ranges) {
      for (let cp = lo; cp <= hi; cp++) {
        const ch = String.fromCharCode(cp);
        const u = ch.toUpperCase();
        const l = ch.toLowerCase();
        if (u.length === 1 && u !== ch) extra.push([u.charCodeAt(0), u.charCodeAt(0)]);
        if (l.length === 1 && l !== ch) extra.push([l.charCodeAt(0), l.charCodeAt(0)]);
        if (hi - lo > 4096) break; // don't fold gigantic ranges char-by-char
      }
    }
    return extra.length === 0 ? this : this.union(CharSet.of(extra));
  }
}

function normalize(
  ranges: ReadonlyArray<readonly [number, number]>,
): ReadonlyArray<readonly [number, number]> {
  const sorted = ranges
    .filter(([lo, hi]) => lo <= hi)
    .map(([lo, hi]) => [Math.max(0, lo), Math.min(UNIT_MAX, hi)] as [number, number])
    .sort((a, b) => a[0] - b[0]);
  const out: Array<[number, number]> = [];
  for (const [lo, hi] of sorted) {
    const last = out[out.length - 1];
    if (last !== undefined && lo <= last[1] + 1) {
      if (hi > last[1]) last[1] = hi;
    } else {
      out.push([lo, hi]);
    }
  }
  return out;
}

// ── regular-expression AST ───────────────────────────────────────────

/** A regular expression over code units. `emp` = ∅ (matches nothing), `eps` =
 *  ε (matches the empty string). Built only through the smart constructors
 *  below so that derivatives stay simplified. */
export type Re =
  | { readonly k: "emp" }
  | { readonly k: "eps" }
  | { readonly k: "chr"; readonly set: CharSet }
  | { readonly k: "seq"; readonly a: Re; readonly b: Re }
  | { readonly k: "alt"; readonly a: Re; readonly b: Re }
  | { readonly k: "star"; readonly r: Re };

export const EMP: Re = { k: "emp" };
export const EPS: Re = { k: "eps" };

export function chr(set: CharSet): Re {
  return set.isEmpty() ? EMP : { k: "chr", set };
}

/** Concatenation, simplified: `∅·_ = _·∅ = ∅`, `ε·b = b`, `a·ε = a`. */
export function seq(a: Re, b: Re): Re {
  if (a.k === "emp" || b.k === "emp") return EMP;
  if (a.k === "eps") return b;
  if (b.k === "eps") return a;
  return { k: "seq", a, b };
}

/** Union, normalized modulo ACI: flatten nested alts and drop duplicate
 *  branches, preserving first-occurrence order. The derivative-state set is
 *  finite only modulo ACI, so this keeps `der` bounded. Order is preserved (not
 *  sorted) to keep greedy/backtracking semantics. */
export function alt(a: Re, b: Re): Re {
  if (a.k === "emp") return b;
  if (b.k === "emp") return a;
  const branches: Re[] = [];
  const seen = new Set<string>();
  const add = (r: Re): void => {
    if (r.k === "alt") {
      add(r.a);
      add(r.b);
      return;
    }
    if (r.k === "emp") return;
    const key = reKey(r);
    if (!seen.has(key)) {
      seen.add(key);
      branches.push(r);
    }
  };
  add(a);
  add(b);
  if (branches.length === 1) return branches[0]!;
  let out = branches[branches.length - 1]!;
  for (let i = branches.length - 2; i >= 0; i--) out = { k: "alt", a: branches[i]!, b: out };
  return out;
}

/** Kleene star, simplified: `∅* = ε* = ε`, `(r*)* = r*`. */
export function star(r: Re): Re {
  if (r.k === "emp" || r.k === "eps") return EPS;
  if (r.k === "star") return r;
  return { k: "star", r };
}

/** N-ary concatenation (right-nested). */
export function seqAll(parts: readonly Re[]): Re {
  let out: Re = EPS;
  for (let i = parts.length - 1; i >= 0; i--) out = seq(parts[i]!, out);
  return out;
}

/** N-ary union. */
export function altAll(branches: readonly Re[]): Re {
  let out: Re = EMP;
  for (let i = branches.length - 1; i >= 0; i--) out = alt(branches[i]!, out);
  return out;
}

/** Bounded repetition `r{lo,hi}` (hi `undefined` = unbounded). */
export function repeat(r: Re, lo: number, hi: number | undefined): Re {
  const req: Re[] = [];
  for (let i = 0; i < lo; i++) req.push(r);
  if (hi === undefined) return seq(seqAll(req), star(r));
  let opt: Re = EPS;
  for (let i = lo; i < hi; i++) opt = alt(EPS, seq(r, opt));
  return seq(seqAll(req), opt);
}

/** A canonical structural key, used both for ACI dedup in `alt` and for
 *  derivative-state dedup during language enumeration. */
export function reKey(r: Re): string {
  switch (r.k) {
    case "emp":
      return "0";
    case "eps":
      return "1";
    case "chr":
      return `c${r.set.ranges.map(([a, b]) => `${a}-${b}`).join(",")}`;
    case "seq":
      return `.(${reKey(r.a)})(${reKey(r.b)})`;
    case "alt":
      return `|(${reKey(r.a)})(${reKey(r.b)})`;
    case "star":
      return `*(${reKey(r.r)})`;
  }
}

// ── derivative ─────────────────────────────────────────────────────────

/** Does `r` match the empty string? */
export function nullable(r: Re): boolean {
  switch (r.k) {
    case "emp":
    case "chr":
      return false;
    case "eps":
    case "star":
      return true;
    case "seq":
      return nullable(r.a) && nullable(r.b);
    case "alt":
      return nullable(r.a) || nullable(r.b);
  }
}

/** Brzozowski derivative of `r` with respect to code unit `cp`. */
export function der(r: Re, cp: number): Re {
  switch (r.k) {
    case "emp":
    case "eps":
      return EMP;
    case "chr":
      return r.set.has(cp) ? EPS : EMP;
    case "seq": {
      const d = seq(der(r.a, cp), r.b);
      return nullable(r.a) ? alt(d, der(r.b, cp)) : d;
    }
    case "alt":
      return alt(der(r.a, cp), der(r.b, cp));
    case "star":
      return seq(der(r.r, cp), r);
  }
}

// ── recognition services ───────────────────────────────────────────────

/** Does `r` match exactly `s[from..to)`? */
export function accepts(r: Re, s: string, from = 0, to = s.length): boolean {
  let cur = r;
  for (let i = from; i < to; i++) {
    cur = der(cur, s.charCodeAt(i));
    if (cur.k === "emp") return false;
  }
  return nullable(cur);
}

/** Every prefix length `k ≥ 0` such that `r` matches `s[pos..pos+k)`, ascending.
 *  This is the backtracking lexer primitive: a leaf can accept several lengths
 *  (`\d+` over "123" accepts 1, 2, 3) and the value parser tries them
 *  greedily (longest first) with proper fallback. */
export function matchLengths(r: Re, s: string, pos: number): number[] {
  const out: number[] = [];
  let cur = r;
  if (nullable(cur)) out.push(0);
  for (let i = pos; i < s.length; i++) {
    cur = der(cur, s.charCodeAt(i));
    if (cur.k === "emp") break;
    if (nullable(cur)) out.push(i - pos + 1);
  }
  return out;
}

// ── determinism analysis (first / followLast) ───────────────────────────
// `firstSet` is the begin-set, `followLast` the continue-after-a-complete-match
// set. A grammar is deterministic when, at every split, the left's continue-set
// is disjoint from the right's begin-set.

/** Characters that can begin a word in `L(r)`. */
export function firstSet(r: Re): CharSet {
  switch (r.k) {
    case "emp":
    case "eps":
      return CharSet.empty();
    case "chr":
      return r.set;
    case "seq":
      return nullable(r.a) ? firstSet(r.a).union(firstSet(r.b)) : firstSet(r.a);
    case "alt":
      return firstSet(r.a).union(firstSet(r.b));
    case "star":
      return firstSet(r.r);
  }
}

/** Characters that can extend an already-complete match of `r` (the union of
 *  the first-sets of every reachable accepting derivative state). Finite and
 *  terminating because the derivative-state set is finite modulo ACI. */
export function followLast(r: Re): CharSet {
  const reps = [...alphabetOf(r)];
  let acc = CharSet.empty();
  const seen = new Set<string>();
  const stack: Re[] = [r];
  while (stack.length > 0) {
    const st = stack.pop()!;
    const key = reKey(st);
    if (seen.has(key)) continue;
    seen.add(key);
    if (nullable(st)) acc = acc.union(firstSet(st));
    for (const c of reps) {
      const d = der(st, c);
      if (d.k !== "emp") stack.push(d);
    }
  }
  return acc;
}

// ── language enumeration (for the ambiguity oracle) ─────────────────────

/** Representative code units that exercise every char-set boundary in `r`
 *  (each range's low/high endpoint). Enough to drive structural exploration
 *  without iterating the whole alphabet. */
export function alphabetOf(r: Re, out: Set<number> = new Set()): Set<number> {
  switch (r.k) {
    case "emp":
    case "eps":
      return out;
    case "chr":
      for (const [lo, hi] of r.set.ranges) {
        out.add(lo);
        if (hi !== lo) out.add(hi);
      }
      return out;
    case "seq":
    case "alt":
      alphabetOf(r.a, out);
      alphabetOf(r.b, out);
      return out;
    case "star":
      return alphabetOf(r.r, out);
  }
}

/** Enumerate strings in `L(r)` over `alphabet`, shortest-first, up to `maxLen`
 *  and `cap` results. Used by the ambiguity oracle to find minimal
 *  counterexamples; bounded so it always terminates. */
export function* language(
  r: Re,
  alphabet: readonly number[],
  maxLen: number,
  cap: number,
): Generator<string> {
  let count = 0;
  const queue: Array<[string, Re]> = [["", r]];
  const seen = new Set<string>([`0:${reKey(r)}`]);
  let head = 0;
  while (head < queue.length) {
    const [s, cur] = queue[head++]!;
    if (nullable(cur)) {
      yield s;
      if (++count >= cap) return;
    }
    if (s.length >= maxLen) continue;
    for (const c of alphabet) {
      const d = der(cur, c);
      if (d.k === "emp") continue;
      const key = `${s.length + 1}:${reKey(d)}`;
      if (seen.has(key)) continue;
      seen.add(key);
      queue.push([s + String.fromCharCode(c), d]);
    }
    if (queue.length > 50000) return; // hard cap on exploration
  }
}
