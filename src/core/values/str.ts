// str.ts — a reactive string as a lean, composable lens primitive.
//
// `Str` carries only the general-purpose string operations whose round-trip
// is intrinsic to strings: structural slices and splits, plus the two
// involutions. Word- and case-aware projections (case folding, dedup, …)
// are NOT methods here — they're free lenses in `lenses/text.ts`, composed
// onto a `Str` (`caseFold(s)`), so `Str` stays small and the lossy,
// complement-heavy machinery lives outside the core type.
//
//   reverse — involution on the plain endo `.lens(fwd, bwd)`; no complement.
//   trim    — leading/trailing whitespace, restored on write (complement).
//   slice   — a windowed view; writes splice back into the live source.
//   split   — string ⇄ `Arr<string>`; segments are positional lenses into
//             the source, separators recovered live, structure editable.

import { Cell, type Init, type Writable } from "../cell";
import type { TraitDict } from "../traits";
import { Arr } from "./arr";

type V = string;

export const equals = (a: V, b: V) => a === b;

/** Reverse a string by Unicode code points. */
export const reverseStr = (s: V): V => [...s].reverse().join("");

interface TrimComplement {
  lead: string;
  trail: string;
}

const escapeRegExp = (s: V): V => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Resolve a (possibly negative / out-of-range) index against `len`,
 *  JS `slice`-style: negatives count from the end, then clamp to [0, len]. */
const resolveIndex = (i: number, len: number): number =>
  i < 0 ? Math.max(len + i, 0) : Math.min(i, len);

/** Split `s` on `sep`, keeping the matched separators so the split
 *  round-trips: `parts[0] + seps[0] + parts[1] + … + parts[n-1]`, with
 *  `seps.length === parts.length - 1`. Zero-width matches are skipped (a
 *  separator must consume at least one character), so `parts` is never
 *  empty. */
function scanSplit(s: V, sep: RegExp): { parts: V[]; seps: V[] } {
  const flags = sep.flags.includes("g") ? sep.flags : `${sep.flags}g`;
  const re = new RegExp(sep.source, flags);
  const parts: V[] = [];
  const seps: V[] = [];
  let last = 0;
  let m: RegExpExecArray | null = re.exec(s);
  while (m !== null) {
    if (m[0].length === 0) {
      re.lastIndex++;
      if (re.lastIndex > s.length) break;
      m = re.exec(s);
      continue;
    }
    parts.push(s.slice(last, m.index));
    seps.push(m[0]);
    last = m.index + m[0].length;
    m = re.exec(s);
  }
  parts.push(s.slice(last));
  return { parts, seps };
}

/** Interleave `parts` with `seps`; a boundary with no recorded separator
 *  (a structurally-added one) uses `joiner`. Inverse of `scanSplit`. */
function joinParts(parts: V[], seps: V[], joiner: V): V {
  if (parts.length === 0) return "";
  let out = parts[0]!;
  for (let i = 1; i < parts.length; i++) out += (seps[i - 1] ?? joiner) + parts[i];
  return out;
}

export class Str extends Cell<V> {
  static traits = { equals } satisfies TraitDict<V>;
  declare readonly _t: typeof Str.traits;

  constructor(v: V = "") {
    super(v, { equals });
  }

  /** Reverse. Involution. */
  reverse(): this {
    return this.lens(reverseStr, reverseStr);
  }

  /** Trim edge whitespace; the complement restores the original padding
   *  on write. Edge whitespace in a write is stripped first (the view's
   *  contract is "no edge whitespace", else the complement grows). */
  trim(): Writable<Str> {
    return Str.lens(this, {
      init: (s: V): TrimComplement => {
        const lead = /^\s*/.exec(s)?.[0] ?? "";
        // Slice lead off first so trail can't overlap it on all-whitespace.
        const remain = s.slice(lead.length);
        const trail = /\s*$/.exec(remain)?.[0] ?? "";
        return { lead, trail };
      },
      fwd: (s: V): V => {
        const lead = /^\s*/.exec(s)?.[0] ?? "";
        const remain = s.slice(lead.length);
        const trail = /\s*$/.exec(remain)?.[0] ?? "";
        return remain.slice(0, remain.length - trail.length);
      },
      bwd: (target: V, _s: V, c: TrimComplement) => ({
        update: c.lead + target.replace(/^\s+/, "").replace(/\s+$/, "") + c.trail,
        complement: c,
      }),
    }) as Writable<Str>;
  }

  /** A windowed view, `s.slice(start, end)` (JS semantics: negatives count
   *  from the end). Writes splice the written text back into `[start, end)`
   *  of the LIVE source, so the source grows or shrinks to fit — there's no
   *  stored complement (the surrounding text is read off the source). */
  slice(start: number, end?: number): Writable<Str> {
    return Str.lens(
      this,
      (s: V) => s.slice(start, end),
      (target: V, s: V) => {
        const len = s.length;
        const a = resolveIndex(start, len);
        const b = end === undefined ? len : resolveIndex(end, len);
        const hi = b < a ? a : b;
        return s.slice(0, a) + target + s.slice(hi);
      },
    ) as Writable<Str>;
  }

  /** Split into an editable `Arr<string>`. Each segment is a *positional*
   *  lens into this source — reading segment `i` re-splits the live source,
   *  writing it splices that piece back — so separators need no complement
   *  (they're recovered from the source on every read/write). Structural
   *  edits (`insert` / `remove` / `move`) re-split, edit the piece list, and
   *  rebuild the source; added boundaries use `joiner` (defaults to the
   *  literal `sep`, or `" "` for a pattern). Identity is by position: the
   *  cell at index `i` always views whatever piece is at `i`.
   *
   *  Words are `split(/\s+/)` then `filter(non-empty)`. */
  split(sep: V | RegExp, joiner?: V): Arr<V> {
    const re = typeof sep === "string" ? new RegExp(escapeRegExp(sep)) : sep;
    const join = joiner ?? (typeof sep === "string" ? sep : " ");
    const source = this as Cell<V>;

    const segCache = new Map<number, Writable<Str>>();
    const indexOfCell = new WeakMap<Cell<V>, number>();
    const seg = (i: number): Writable<Str> => {
      let c = segCache.get(i);
      if (c === undefined) {
        c = Str.lens(
          source,
          (s: V) => scanSplit(s, re).parts[i] ?? "",
          (target: V, s: V) => {
            const { parts, seps } = scanSplit(s, re);
            if (i >= parts.length) return s;
            parts[i] = target;
            return joinParts(parts, seps, join);
          },
        ) as Writable<Str>;
        segCache.set(i, c);
        indexOfCell.set(c, i);
      }
      return c;
    };

    const write = (parts: V[], seps: V[]): void => {
      (source as Writable<Str>).value = joinParts(parts, seps, join);
    };

    return Arr.fromSource<V, V>(source, (s: V) => scanSplit(s, re).parts.map((_, i) => seg(i)), {
      insert: (v, at) => {
        const text = v instanceof Cell ? v.value : v;
        const { parts, seps } = scanSplit(source.peek(), re);
        const idx = at == null || at > parts.length ? parts.length : Math.max(0, at);
        parts.splice(idx, 0, text);
        if (parts.length > 1) seps.splice(Math.min(idx, seps.length), 0, join);
        write(parts, seps);
        return seg(idx);
      },
      remove: e => {
        const idx = indexOfCell.get(e);
        if (idx === undefined) return;
        const { parts, seps } = scanSplit(source.peek(), re);
        if (idx >= parts.length) return;
        parts.splice(idx, 1);
        if (seps.length > 0) seps.splice(Math.min(idx, seps.length - 1), 1);
        write(parts, seps);
      },
      moveBefore: (e, anchor) => {
        const from = indexOfCell.get(e);
        if (from === undefined) return;
        const { parts, seps } = scanSplit(source.peek(), re);
        if (from >= parts.length) return;
        const [moved] = parts.splice(from, 1);
        const ai = anchor == null ? undefined : indexOfCell.get(anchor);
        const at = ai === undefined ? parts.length : ai > from ? ai - 1 : ai;
        parts.splice(at, 0, moved!);
        write(parts, seps);
      },
    });
  }
}

/** Writable `Str`. Strict factory: literal seeds a fresh cell;
 *  existing `Writable<Str>` passes through by identity. RO sources
 *  are rejected at the type level — use `Str.derive(...)` for
 *  reactive RO tracking, or `cell.value` to snapshot. */
export function str(v: Init<Str> = ""): Writable<Str> {
  if (v instanceof Str) return v as Writable<Str>;
  return new Str(v) as Writable<Str>;
}
