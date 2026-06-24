// ── character-class atoms ─────────────────────────────────────────────
// Disjoint classes plus symbol characters as their own singleton atoms.

export type Digit = "𝖣";
export type Lower = "𝖫";
export type Upper = "𝖴";
export type Space = "𝖶";
export type ClassAtom = Digit | Lower | Upper | Space;
export type Atom = ClassAtom | (string & {});

type Digits = "0" | "1" | "2" | "3" | "4" | "5" | "6" | "7" | "8" | "9";
type Lowers =
  | "a"
  | "b"
  | "c"
  | "d"
  | "e"
  | "f"
  | "g"
  | "h"
  | "i"
  | "j"
  | "k"
  | "l"
  | "m"
  | "n"
  | "o"
  | "p"
  | "q"
  | "r"
  | "s"
  | "t"
  | "u"
  | "v"
  | "w"
  | "x"
  | "y"
  | "z";
type Uppers = Uppercase<Lowers>;
type Spaces = " " | "\t" | "\n" | "\r";

/** Fold one character to its atom (alphanumerics into a class; symbols stay
 *  singletons). */
export type Classify<C extends string> = C extends Digits
  ? Digit
  : C extends Lowers
    ? Lower
    : C extends Uppers
      ? Upper
      : C extends Spaces
        ? Space
        : C;

export type FirstChar<S extends string> = S extends `${infer H}${string}` ? H : never;
export type LastChar<S extends string> = S extends `${infer H}${infer R}`
  ? R extends ""
    ? H
    : LastChar<R>
  : never;

// ── boundary sets ─────────────────────────────────────────────────────

/** A boundary: ∅ (a leaf that only matches ""), ⊤ (unknown — the regex
 *  escape), a finite union of atoms, or a complement (everything but some
 *  atoms — e.g. `until(",")` ends on anything-but-comma). */
export type Bound =
  | { readonly k: "none" }
  | { readonly k: "all" }
  | { readonly k: "set"; readonly a: Atom }
  | { readonly k: "co"; readonly a: Atom };

export type NoneBound = { readonly k: "none" };
export type AnyBound = { readonly k: "all" };
export type SetBound<A extends Atom> = { readonly k: "set"; readonly a: A };
export type CoBound<A extends Atom> = { readonly k: "co"; readonly a: A };

type IsNever<T> = [T] extends [never] ? true : false;

/** Provably disjoint? Returns `false` whenever overlap can't be ruled out, so
 *  acceptance is always sound (the runtime check is the complete authority). */
export type Disjoint<A extends Bound, B extends Bound> = A extends NoneBound
  ? true
  : B extends NoneBound
    ? true
    : A extends AnyBound
      ? false
      : B extends AnyBound
        ? false
        : A extends SetBound<infer SA>
          ? B extends SetBound<infer SB>
            ? IsNever<SA & SB>
            : B extends CoBound<infer CB>
              ? IsNever<Exclude<SA, CB>>
              : false
          : A extends CoBound<infer CA>
            ? B extends SetBound<infer SB>
              ? IsNever<Exclude<SB, CA>>
              : false // co ∩ co is always inhabited
            : false;

/** *Provably* overlapping? The compile-time adjacency guard rejects only when
 *  this is `true`. An unknown boundary (`all`, from the `copy`/`of` escape
 *  hatch) returns `false` — the escape hatch opts out of *compile-time*
 *  checking, never of the complete runtime check. */
export type Overlaps<A extends Bound, B extends Bound> = A extends NoneBound
  ? false
  : B extends NoneBound
    ? false
    : A extends AnyBound
      ? false
      : B extends AnyBound
        ? false
        : A extends SetBound<infer SA>
          ? B extends SetBound<infer SB>
            ? IsNever<SA & SB> extends true
              ? false
              : true
            : B extends CoBound<infer CB>
              ? IsNever<Exclude<SA, CB>> extends true
                ? false
                : true
              : false
          : A extends CoBound<infer CA>
            ? B extends SetBound<infer SB>
              ? IsNever<Exclude<SB, CA>> extends true
                ? false
                : true
              : true // co ∩ co is always inhabited
            : false;

/** Conservative union (may over-approximate to ⊤, which only makes the
 *  downstream disjointness test stricter — never unsound). */
export type Union<A extends Bound, B extends Bound> = A extends NoneBound
  ? B
  : B extends NoneBound
    ? A
    : A extends SetBound<infer SA>
      ? B extends SetBound<infer SB>
        ? SetBound<SA | SB>
        : AnyBound
      : AnyBound;

// ── leaf boundary shapes ──────────────────────────────────────────────

export type DigitBound = SetBound<Digit>;
export type LetterBound = SetBound<Lower | Upper>;
export type WordBound = SetBound<Digit | Lower | Upper | "_">;
export type LitBound<C extends string> = C extends "" ? NoneBound : SetBound<Classify<C>>;
