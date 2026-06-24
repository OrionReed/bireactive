import { Cell, type Optic, type Read, type Writable } from "../cell";
import { optic } from "../optic";
import { Arr } from "./arr";
import { concatAmbiguity, intersects } from "./reg/ambiguity";
import {
  accepts,
  alphabetOf,
  altAll,
  CharSet,
  chr,
  EPS,
  language,
  type Re,
  nullable as reNullable,
  seq as reSeq,
  star as reStar,
  seqAll,
} from "./reg/engine";
import { compileProgram, type Program, parseValue, recognize } from "./reg/nfa";
import { compileRegex, RegError } from "./reg/regex";
import type {
  AnyBound,
  Bound,
  Classify,
  CoBound,
  DigitBound,
  FirstChar,
  LastChar,
  LetterBound,
  LitBound,
  NoneBound,
  Overlaps,
  Union,
  WordBound,
} from "./reg/types";
import { Str } from "./str";
import { type Codec, numCodec } from "./template";

// ── runtime value tree ─────────────────────────────────────────────────
// `match` yields a `RegVal` mirroring the AST; `print` consumes it. Runtime
// shapes: leaf→string|T, `seq`→array of visible (non-`lit`) children,
// `alt`→{branch, val}, `opt`→inner|null, `star`→{items, seps}.

/** A parsed star: its elements plus the literal separators between them
 *  (`seps.length === items.length - 1`), kept so `print` round-trips. */
export interface StarVal<V = RegVal> {
  readonly items: readonly V[];
  readonly seps: readonly string[];
}

/** A parsed alternation: which branch matched, and that branch's value. */
export interface AltVal<V = RegVal> {
  readonly branch: number;
  readonly val: V;
}

/** The abstract value of a `Reg`. Wide by nature — `match`'s static type
 *  refines it; `bind` gives typed per-capture handles for editing. */
export type RegVal = string | number | boolean | null | readonly RegVal[] | StarVal | AltVal;

// ── AST ──────────────────────────────────────────────────────────────

/** @internal — the grammar AST (also consumed by `reg/nfa.ts`). */
export type Node = LitNode | CopyNode | OfNode | SeqNode | AltNode | OptNode | StarNode;

/** @internal */
export interface LitNode {
  readonly kind: "lit";
  readonly text: string;
}
/** @internal */
export interface CopyNode {
  readonly kind: "copy";
  readonly re: RegExp;
  readonly engine: Re;
  readonly name?: string;
}
/** @internal */
export interface OfNode {
  readonly kind: "of";
  readonly re: RegExp;
  readonly engine: Re;
  readonly codec: Codec<unknown>;
  readonly name?: string;
}
/** @internal */
export interface SeqNode {
  readonly kind: "seq";
  readonly parts: readonly Node[];
}
/** @internal */
export interface AltNode {
  readonly kind: "alt";
  readonly branches: readonly Node[];
}
/** @internal */
export interface OptNode {
  readonly kind: "opt";
  readonly part: Node;
}
/** @internal */
export interface StarNode {
  readonly kind: "star";
  readonly part: Node;
  readonly sep?: Node;
  readonly joiner: string;
  /** Minimum element count for an *unseparated* star (0 = Kleene, 1 = plus).
   *  Separated stars are always ≥1 (split semantics). */
  readonly min: 0 | 1;
  /** Resourceful alignment: derive a stable identity from an element's string.
   *  Element handles then follow that identity across reorders. */
  readonly key?: (item: string) => string;
  readonly name?: string;
}

const isSilent = (n: Node): boolean => n.kind === "lit";

/** Source span `[start, end)` of a named capture, recovered by `spans`. */
export type Span = readonly [start: number, end: number];

// ── memoized structural views (toRe / program) ───────────────────────

const reMemo = new WeakMap<Node, Re>();
const progMemo = new WeakMap<Node, Program>();

/** The compiled Thompson program for a node (built once, then cached). */
function progOf(n: Node): Program {
  let p = progMemo.get(n);
  if (p === undefined) {
    p = compileProgram(n);
    progMemo.set(n, p);
  }
  return p;
}

function reOf(n: Node): Re {
  let r = reMemo.get(n);
  if (r === undefined) {
    r = toRe(n);
    reMemo.set(n, r);
  }
  return r;
}

// ── parse (get): linear PikeVM, whole-string ──────────────────────────

/** Parse `s` fully; `null` if it doesn't match. */
function parseNode(n: Node, s: string, spans?: Map<string, Span>): RegVal | null {
  const r = parseValue(n, progOf(n), s, spans);
  return r === null ? null : r.val;
}

/** Whole-string match of a leaf's language — for validating a scalar write. */
function fullLeafMatch(leaf: CopyNode | OfNode, s: string): boolean {
  return accepts(leaf.engine, s);
}

/** Does `n` parse all of `s`? General write-validation. */
function fullNodeMatch(n: Node, s: string): boolean {
  return recognize(progOf(n), s);
}

// ── print (put) ──────────────────────────────────────────────────────

function printNode(n: Node, val: RegVal): string {
  switch (n.kind) {
    case "lit":
      return n.text;
    case "copy":
      return String(val ?? "");
    case "of":
      return n.codec.format(val);
    case "seq": {
      const vals = (val as readonly RegVal[]) ?? [];
      let out = "";
      let vi = 0;
      for (const part of n.parts) {
        if (isSilent(part)) out += printNode(part, null);
        else out += printNode(part, vals[vi++] ?? defaultVal(part));
      }
      return out;
    }
    case "alt": {
      const a = (val as AltVal) ?? { branch: 0, val: defaultVal(n.branches[0]!) };
      const branch = n.branches[a.branch] ?? n.branches[0]!;
      return printNode(branch, a.val);
    }
    case "opt":
      if (val === null || val === undefined) return "";
      return printNode(n.part, isSilent(n.part) ? null : val);
    case "star": {
      const sv = (val as StarVal) ?? { items: [], seps: [] };
      let out = "";
      for (let k = 0; k < sv.items.length; k++) {
        if (k > 0) out += sv.seps[k - 1] ?? n.joiner;
        out += printNode(n.part, sv.items[k]!);
      }
      return out;
    }
  }
}

// ── totalization + nullability ───────────────────────────────────────

function defaultVal(n: Node): RegVal {
  switch (n.kind) {
    case "lit":
      return null;
    case "copy":
      return "";
    case "of":
      return (n.codec.parse("") ?? n.codec.parse("0") ?? null) as RegVal;
    case "seq":
      return n.parts.filter(p => !isSilent(p)).map(defaultVal);
    case "alt":
      return { branch: 0, val: defaultVal(n.branches[0]!) };
    case "opt":
      return null;
    case "star":
      return { items: [], seps: [] };
  }
}

function nullable(n: Node): boolean {
  switch (n.kind) {
    case "lit":
      return n.text === "";
    case "copy":
    case "of":
      return reNullable(n.engine);
    case "seq":
      return n.parts.every(nullable);
    case "alt":
      return n.branches.some(nullable);
    case "opt":
      return true;
    case "star":
      return n.sep === undefined && n.min === 0 ? true : nullable(n.part);
  }
}

// ── unambiguity checks (thrown at construction) ──────────────────────
// Each combinator validates only its own new seams (children are already valid),
// deciding on the derivative automaton (see `reg/ambiguity.ts`). Each error
// names a concrete witness string that would parse two ways.

const quote = (s: string): string => (s === "" ? '""' : JSON.stringify(s));

function checkSeq(parts: readonly Node[]): void {
  for (let i = 0; i < parts.length - 1; i++) {
    const a = reOf(parts[i]!);
    const b = seqAll(parts.slice(i + 1).map(reOf));
    const w = concatAmbiguity(a, b);
    if (w !== null) {
      throw new RegError(
        `Reg.seq: the boundary after part ${i} is ambiguous — ${quote(w)} splits two ways. Insert a lit() delimiter or use disjoint character classes.`,
      );
    }
  }
}

function checkAlt(branches: readonly Node[]): void {
  for (let i = 0; i < branches.length; i++) {
    for (let j = i + 1; j < branches.length; j++) {
      const w = intersects(reOf(branches[i]!), reOf(branches[j]!));
      if (w !== null) {
        throw new RegError(
          `Reg.alt: branches ${i} and ${j} both match ${quote(w)} — make the branches' languages disjoint.`,
        );
      }
    }
  }
}

function checkOpt(part: Node): void {
  if (nullable(part)) {
    throw new RegError("Reg.opt: the element is itself nullable — present-vs-absent is ambiguous.");
  }
}

function checkStar(part: Node, sep: Node | undefined): void {
  const e = reOf(part);
  if (sep === undefined) {
    if (nullable(part)) {
      throw new RegError(
        'Reg.star/plus: a nullable element with no separator iterates ambiguously — add a separator (e.g. star(lit(","))).',
      );
    }
    const w = concatAmbiguity(e, reStar(e)); // element · element* unambiguous?
    if (w !== null) {
      throw new RegError(
        `Reg.star/plus: element boundaries are not self-delimiting — ${quote(w)} iterates two ways. Add a separator.`,
      );
    }
    return;
  }
  if (nullable(sep)) {
    throw new RegError("Reg.star/plus: a nullable separator cannot pin element boundaries.");
  }
  // Pattern is `E (S E)*`; check each seam: S·E, the (S·E) repetition, and the
  // leading E · (S E)*.
  const s = reOf(sep);
  const se = reSeq(s, e);
  const tail = reStar(se);
  const w =
    concatAmbiguity(s, e) ?? concatAmbiguity(se, tail) ?? concatAmbiguity(e, reSeq(s, tail));
  if (w !== null) {
    throw new RegError(
      `Reg.star/plus: element and separator boundaries overlap — ${quote(w)} parses two ways.`,
    );
  }
}

// ── grammar → capture-free automaton (recognition) ────────────────────

function toRe(n: Node): Re {
  switch (n.kind) {
    case "lit": {
      const parts: Re[] = [];
      for (let i = 0; i < n.text.length; i++) parts.push(chr(CharSet.char(n.text.charCodeAt(i))));
      return seqAll(parts);
    }
    case "copy":
    case "of":
      return n.engine;
    case "seq":
      return seqAll(n.parts.map(toRe));
    case "alt":
      return altAll(n.branches.map(toRe));
    case "opt":
      return altAll([EPS, toRe(n.part)]);
    case "star": {
      const P = toRe(n.part);
      const S = n.sep !== undefined ? toRe(n.sep) : EPS;
      return altAll([EPS, reSeq(P, reStar(reSeq(S, P)))]);
    }
  }
}

/** The separator string to emit when inserting into a star: the literal text
 *  for a `lit`, otherwise the *shortest* string in the separator's language.
 *  A separator whose language is empty has no insertable member, so the star
 *  is rejected at construction rather than silently writing off-language text. */
function joinerFor(sep: Node | undefined): string {
  if (sep === undefined) return "";
  if (sep.kind === "lit") return sep.text;
  const re = reOf(sep);
  for (const w of language(re, [...alphabetOf(re)], 1024, 1)) return w;
  throw new RegError(
    "Reg.star/plus: the separator matches no string, so nothing can be inserted between elements.",
  );
}

// ── named-capture path resolution ────────────────────────────────────

/** A step into the value tree: a `seq` tuple index, or an `alt` branch (active
 *  only when that branch matched — an inactive branch reads "" and ignores
 *  writes). `opt` is transparent (its value *is* the inner value). */
type Step = { readonly seq: number } | { readonly alt: number };

interface Capture {
  node: CopyNode | OfNode | StarNode;
  path: Step[];
}

function collectCaptures(n: Node, path: Step[], acc: Map<string, Capture>): void {
  switch (n.kind) {
    case "copy":
    case "of":
    case "star":
      if (n.name !== undefined) acc.set(n.name, { node: n, path: path.slice() });
      return;
    case "seq": {
      let vi = 0;
      for (const part of n.parts) {
        if (isSilent(part)) continue;
        collectCaptures(part, [...path, { seq: vi }], acc);
        vi++;
      }
      return;
    }
    case "opt":
      collectCaptures(n.part, path, acc);
      return;
    case "alt": {
      for (let b = 0; b < n.branches.length; b++) {
        collectCaptures(n.branches[b]!, [...path, { alt: b }], acc);
      }
      return;
    }
    case "lit":
      return;
  }
}

/** Structural value equality, for the print-validate (PutGet) write check. */
function regEqual(a: RegVal, b: RegVal): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

const isAltVal = (v: RegVal): v is AltVal => v !== null && typeof v === "object" && "branch" in v;

function getAt(val: RegVal, path: readonly Step[]): RegVal {
  let v: RegVal = val;
  for (const step of path) {
    if ("seq" in step) v = (v as readonly RegVal[])?.[step.seq] ?? null;
    else if (isAltVal(v) && v.branch === step.alt) v = v.val;
    else return null; // inactive alt branch
  }
  return v;
}

function setAt(val: RegVal, path: readonly Step[], next: RegVal): RegVal {
  if (path.length === 0) return next;
  const [head, ...rest] = path;
  if ("seq" in head!) {
    const arr = ((val as readonly RegVal[]) ?? []).slice();
    arr[head.seq] = setAt(arr[head.seq] ?? null, rest, next);
    return arr;
  }
  // alt step: descend only into the active branch; otherwise the write is a no-op.
  if (isAltVal(val) && val.branch === head.alt) {
    return { branch: val.branch, val: setAt(val.val, rest, next) };
  }
  return val;
}

// ── type-level plumbing ───────────────────────────────────────────────

declare const SILENT: unique symbol;
/** The value of a `lit`: dropped from `seq` tuples. */
export type Silent = { readonly [SILENT]: true };

// `any` slots keep the phantom class assignable to the constraint regardless
// of `Reg`'s invariance in its value parameter.
// biome-ignore lint/suspicious/noExplicitAny: see above
type AnyReg = Reg<any, any, any, any>;
// biome-ignore lint/suspicious/noExplicitAny: extractor projections
type ValOf<R> = R extends Reg<infer V, any, any, any> ? V : never;
// biome-ignore lint/suspicious/noExplicitAny: extractor projections
type NullOf<R> = R extends Reg<any, infer N, any, any> ? N : never;
// biome-ignore lint/suspicious/noExplicitAny: extractor projections
type FirstOf<R> = R extends Reg<any, any, infer F, any> ? F : never;
// biome-ignore lint/suspicious/noExplicitAny: extractor projections
type LastOf<R> = R extends Reg<any, any, any, infer L> ? L : never;

type And<A extends boolean, B extends boolean> = A extends true ? B : false;
type Or<A extends boolean, B extends boolean> = A extends true ? true : B;

/** A value as it contributes to a `seq` tuple: `lit` drops out; a nested seq
 *  tuple splices in; everything else is one slot. */
type AsTuple<V> = [V] extends [Silent] ? [] : V extends readonly unknown[] ? V : [V];

/** The value of an optional: inner value when present, `null` when absent; a
 *  silent inner (no value) records presence as `true`. */
type OptVal<V> = ([V] extends [Silent] ? true : V) | null;

/** Boundary of `until(c)`: a single-char delimiter excludes exactly one class
 *  (`CoBound`); a multi-char delimiter excludes several at runtime but the
 *  single-atom type algebra can't name that, so it degrades to `AnyBound`
 *  (sound: defers the adjacency check to construction time). */
type UntilBound<C extends string> = C extends `${infer _H}${infer R}`
  ? R extends ""
    ? CoBound<Classify<C>>
    : AnyBound
  : AnyBound;

/** The brand a bad adjacency degrades the argument list to, so the call site
 *  fails with this message. */
type AdjErr = {
  readonly __ambiguous: "adjacent parts overlap — insert a lit() delimiter or use disjoint character classes";
};

// ── public types ──────────────────────────────────────────────────────

/** Options for `bind` / `view`. */
export interface BindOpts {
  strict?: boolean;
}

/** A bound named handle: a `string` capture is a `Writable<Str>`; a `star`
 *  capture is an editable `Arr<string>`. */
export type Handle = Writable<Str> | Arr<string>;

/** Schema tag for the typed `bind` overload: `"str"` → scalar, `"arr"` → star. */
export type HandleKind = "str" | "arr";

/** The concrete handle type for a schema tag. */
export type HandleOf<K extends HandleKind> = K extends "arr" ? Arr<string> : Writable<Str>;

// ── the Reg class ────────────────────────────────────────────────────

/** An immutable bidirectional string-lens description. Build with the typed
 *  leaf builders and combinators, then `bind`/`view` onto a `Cell<string>`.
 *
 *  The four type parameters are phantom: `V` is the parsed value, `N` whether
 *  it accepts "", and `F`/`L` the character classes its match can begin/end
 *  with. `F`/`L`/`N` drive the compile-time ambiguity checks; they have no
 *  runtime presence. */
export class Reg<
  V = RegVal,
  N extends boolean = boolean,
  F extends Bound = AnyBound,
  L extends Bound = AnyBound,
> {
  /** @internal */
  readonly root: Node;

  #lastParse: { s: string; v: RegVal | null } | null = null;

  /** @internal — use the static builders. */
  constructor(root: Node) {
    this.root = root;
  }

  // ── leaf builders ─────────────────────────────────────────────────

  /** A fixed delimiter: matched and printed, never surfaced as a value. */
  static lit<T extends string>(
    text: T,
  ): Reg<Silent, T extends "" ? true : false, LitBound<FirstChar<T>>, LitBound<LastChar<T>>> {
    return new Reg({ kind: "lit", text }) as never;
  }

  /** Text up to (but not including) the delimiter `c` — i.e. `[^c]*`. Nullable
   *  (an empty field is allowed); the natural companion of `star(lit(c))`. */
  static until<C extends string>(c: C): Reg<string, true, UntilBound<C>, UntilBound<C>> {
    const escaped = c.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return new Reg({
      kind: "copy",
      re: new RegExp(`[^${escaped}]*`),
      engine: compileRegex(new RegExp(`[^${escaped}]*`)),
    }) as never;
  }

  /** One or more digits, `\d+`, as a string. */
  static digits(): Reg<string, false, DigitBound, DigitBound> {
    return new Reg({ kind: "copy", re: /\d+/, engine: compileRegex(/\d+/) }) as never;
  }

  /** One or more digits, decoded as a `number` (a quotient lens — leading
   *  zeros are not preserved). */
  static int(): Reg<number, false, DigitBound, DigitBound> {
    return new Reg({
      kind: "of",
      re: /\d+/,
      engine: compileRegex(/\d+/),
      codec: numCodec(true) as Codec<unknown>,
    }) as never;
  }

  /** One or more ASCII letters, `[A-Za-z]+`. */
  static letters(): Reg<string, false, LetterBound, LetterBound> {
    return new Reg({ kind: "copy", re: /[A-Za-z]+/, engine: compileRegex(/[A-Za-z]+/) }) as never;
  }

  /** One or more word characters, `\w+` (letters, digits, underscore). */
  static word(): Reg<string, false, WordBound, WordBound> {
    return new Reg({ kind: "copy", re: /\w+/, engine: compileRegex(/\w+/) }) as never;
  }

  /** The escape hatch: capture the text matched by an arbitrary regular `re`.
   *  Non-regular constructs (anchors, lookaround, backreferences) throw. The
   *  boundary is opaque to the type system (`AnyBound`), so adjacency can't be
   *  checked at compile time — the construction-time check still applies. */
  static copy(re: RegExp): Reg<string, boolean, AnyBound, AnyBound> {
    return new Reg({ kind: "copy", re, engine: compileRegex(re) }) as never;
  }

  /** Typed escape hatch: `re` recognizes, `codec` decodes/encodes. */
  static of<T>(re: RegExp, codec: Codec<T>): Reg<T, boolean, AnyBound, AnyBound> {
    return new Reg({
      kind: "of",
      re,
      engine: compileRegex(re),
      codec: codec as Codec<unknown>,
    }) as never;
  }

  // ── combinators ───────────────────────────────────────────────────

  /** Unambiguous concatenation; every boundary is checked here and throws on
   *  ambiguity. (For compile-time adjacency checking, prefer the fluent
   *  `a.then(b).then(c)`, which validates each link.) */
  static seq<T extends readonly AnyReg[]>(
    ...parts: T
  ): Reg<SeqVal<T>, SeqNull<T>, SeqFirst<T>, SeqLast<T>> {
    const flat = flattenSeq(parts as readonly AnyReg[]);
    checkSeq(flat);
    return new Reg({ kind: "seq", parts: flat }) as never;
  }

  /** Ordered union; branches must be first-disjoint (checked). */
  static alt<T extends readonly AnyReg[]>(
    ...branches: T
  ): Reg<AltOf<T>, AltNull<T>, AltFirst<T>, AltLast<T>> {
    const bs = branches.map(b => (b as unknown as Reg).root);
    checkAlt(bs);
    return new Reg({ kind: "alt", branches: bs }) as never;
  }

  /** Optional (`part` or nothing). `part` must be non-nullable. The value is
   *  the inner value when present and `null` when absent; an optional with no
   *  value of its own (e.g. `lit(...).optional()`) records presence as `true`. */
  static opt<V2, F2 extends Bound, L2 extends Bound>(
    part: Reg<V2, false, F2, L2>,
  ): Reg<OptVal<V2>, true, F2, L2> {
    checkOpt((part as unknown as Reg).root);
    return new Reg({ kind: "opt", part: (part as unknown as Reg).root }) as never;
  }

  /** `seq(this, ...next)`. A provably-overlapping boundary between `this` and
   *  the next part is a *type* error — so `a.then(b).then(c)` statically checks
   *  every link. Interior boundaries of a multi-arg call, and the `copy`/`of`
   *  escapes, are checked at construction (throws). */
  then<T extends readonly AnyReg[]>(
    this: Reg<V, N, F, L>,
    ...next: T extends readonly [infer H extends AnyReg, ...AnyReg[]]
      ? Overlaps<L, FirstOf<H>> extends true
        ? readonly AdjErr[]
        : T
      : T
  ): Reg<
    SeqVal<[Reg<V, N, F, L>, ...T]>,
    SeqNull<[Reg<V, N, F, L>, ...T]>,
    SeqFirst<[Reg<V, N, F, L>, ...T]>,
    SeqLast<[Reg<V, N, F, L>, ...T]>
  > {
    const flat = flattenSeq([this as unknown as AnyReg, ...(next as unknown as AnyReg[])]);
    checkSeq(flat);
    return new Reg({ kind: "seq", parts: flat }) as never;
  }

  /** `alt(this, other)`. */
  or<V2, N2 extends boolean, F2 extends Bound, L2 extends Bound>(
    this: Reg<V, N, F, L>,
    other: Reg<V2, N2, F2, L2>,
  ): Reg<AltVal<V> | AltValB<V2>, Or<N, N2>, Union<F, F2>, Union<L, L2>> {
    return Reg.alt(this as unknown as AnyReg, other as unknown as AnyReg) as never;
  }

  /** `opt(this)`. Only available when `this` is non-nullable. */
  optional(this: Reg<V, false, F, L>): Reg<OptVal<V>, true, F, L> {
    return Reg.opt(this as Reg<V, false, F, L>) as never;
  }

  /** Iterate zero-or-more, optionally separated by `sep`; binds to an `Arr`.
   *  A separated star is a *split* (≥1 piece, like `Str.split`). Pass
   *  `opts.key` for resourceful alignment across reorders. */
  star<
    Vs = never,
    Ns extends boolean = boolean,
    Fs extends Bound = Bound,
    Ls extends Bound = Bound,
  >(
    this: Reg<V, N, F, L>,
    sep?: Reg<Vs, Ns, Fs, Ls>,
    opts: { key?: (item: string) => string } = {},
  ): Reg<StarVal<V>, true, F, L> {
    const part = (this as unknown as Reg).root;
    const sepNode = sep === undefined ? undefined : (sep as unknown as Reg).root;
    checkStar(part, sepNode);
    return new Reg({
      kind: "star",
      part,
      sep: sepNode,
      joiner: joinerFor(sepNode),
      min: 0,
      key: opts.key,
    }) as never;
  }

  /** Iterate one-or-more (forbids the empty list when unseparated). */
  plus<
    Vs = never,
    Ns extends boolean = boolean,
    Fs extends Bound = Bound,
    Ls extends Bound = Bound,
  >(
    this: Reg<V, N, F, L>,
    sep?: Reg<Vs, Ns, Fs, Ls>,
    opts: { key?: (item: string) => string } = {},
  ): Reg<StarVal<V>, N, F, L> {
    const part = (this as unknown as Reg).root;
    const sepNode = sep === undefined ? undefined : (sep as unknown as Reg).root;
    checkStar(part, sepNode);
    return new Reg({
      kind: "star",
      part,
      sep: sepNode,
      joiner: joinerFor(sepNode),
      min: 1,
      key: opts.key,
    }) as never;
  }

  /** Name this capture so `bind` exposes it as a handle (`copy`/`of`/`star`). */
  as(name: string): Reg<V, N, F, L> {
    const r = this.root;
    if (r.kind !== "copy" && r.kind !== "of" && r.kind !== "star") {
      throw new RegError(`Reg.as: can only name copy/of/star, got "${r.kind}"`);
    }
    return new Reg({ ...r, name }) as never;
  }

  /** Attach a codec to a `copy` leaf, turning it into a typed `of` capture. */
  map<T>(codec: Codec<T>): Reg<T, N, F, L> {
    const r = this.root;
    if (r.kind !== "copy") throw new RegError(`Reg.map: only on a copy leaf, got "${r.kind}"`);
    return new Reg({
      kind: "of",
      re: r.re,
      engine: r.engine,
      codec: codec as Codec<unknown>,
      name: r.name,
    }) as never;
  }

  // ── pure parser / printer ────────────────────────────────────────

  /** Parse `s` fully (must consume to the end); `null` if it doesn't match.
   *  Single-pass and linear. */
  match(s: string): V | null {
    if (this.#lastParse !== null && this.#lastParse.s === s) return this.#lastParse.v as V | null;
    const v = parseNode(this.root, s);
    this.#lastParse = { s, v };
    return v as V | null;
  }

  /** Reflective print: render a value back to source text. */
  print(v: V): string {
    return printNode(this.root, v as RegVal);
  }

  /** Does `s` fully match? Linear. */
  test(s: string): boolean {
    return recognize(progOf(this.root), s);
  }

  /** Source spans of each named capture, keyed by name — the `get`/`put`
   *  correspondence made visible. Empty if `s` doesn't fully match. */
  spans(s: string): Record<string, Span> {
    const m = new Map<string, Span>();
    const r = parseValue(this.root, progOf(this.root), s, m);
    return r !== null ? Object.fromEntries(m) : {};
  }

  // ── reactive binding ─────────────────────────────────────────────

  /** This grammar as a first-class, composable `Optic<string, V>`: `get`
   *  parses (falling back to the default value off-language), `put` reprints
   *  and round-trip-guards (an off-language source or a non-round-tripping
   *  value leaves the source untouched). Drops straight into `compose(...)`
   *  and `cell.through(...)`, so it chains with `atKey`/`iso` and string
   *  lenses like `caseFold`. */
  optic(): Optic<string, V> {
    const def = defaultVal(this.root);
    return optic<string, V>(
      (s: string) => (this.match(s) ?? def) as V,
      (v: V, s: string) => {
        if (this.match(s) === null) return s; // source off-language: don't clobber
        const next = this.print(v);
        return this.match(next) === null ? s : next; // print must round-trip
      },
    );
  }

  /** The whole abstract value as a writable lens over `source`. */
  view(source: Cell<string>): Writable<Cell<V>> {
    return source.through(this.optic());
  }

  /** Bind named captures (`.as`) to editable handles over `source`: a string
   *  capture → `Writable<Str>`, a `star` capture → `Arr<string>`.
   *
   *  Pass `opts.schema` (`{ name: "str" | "arr" }`) for known keys and
   *  per-handle types without casts. */
  bind<S extends Record<string, HandleKind>>(
    source: Cell<string>,
    opts: { schema: S },
  ): { [K in keyof S]: HandleOf<S[K]> };
  bind(source: Cell<string>, opts?: BindOpts): Record<string, Handle>;
  bind(
    source: Cell<string>,
    opts: BindOpts & { schema?: Record<string, HandleKind> } = {},
  ): Record<string, Handle> {
    const captures = new Map<string, Capture>();
    collectCaptures(this.root, [], captures);
    if (opts.schema !== undefined) {
      for (const [name, kind] of Object.entries(opts.schema)) {
        const cap = captures.get(name);
        if (cap === undefined)
          throw new RegError(`Reg.bind: schema names "${name}", which isn't a capture`);
        const isArr = cap.node.kind === "star";
        if ((kind === "arr") !== isArr) {
          throw new RegError(
            `Reg.bind: schema says "${name}" is "${kind}" but it's a ${isArr ? "star" : "scalar"} capture`,
          );
        }
      }
    }
    const def = defaultVal(this.root);
    const out: Record<string, Handle> = {};
    for (const [name, cap] of captures) {
      out[name] =
        cap.node.kind === "star"
          ? this.#starHandle(source, cap, def)
          : this.#scalarHandle(source, cap, def);
    }
    return out;
  }

  // ── internals ────────────────────────────────────────────────────

  #scalarHandle(source: Cell<string>, cap: Capture, def: RegVal): Writable<Str> {
    const leaf = cap.node as CopyNode | OfNode;
    const path = cap.path;
    return Str.lens(
      source as Cell<string>,
      (s: string) => {
        const v = getAt((this.match(s) as RegVal) ?? def, path);
        return leaf.kind === "of" ? leaf.codec.format(v) : String(v ?? "");
      },
      (target: string, s: string) => {
        if (!fullLeafMatch(leaf, target)) return s;
        const decoded: RegVal = leaf.kind === "of" ? (leaf.codec.parse(target) as RegVal) : target;
        if (decoded === undefined) return s;
        const base = this.match(s) as RegVal | null;
        if (base === null) return s;
        const next = this.print(setAt(base, path, decoded) as V);
        const back = this.match(next) as RegVal | null;
        if (back === null || !regEqual(getAt(back, path), decoded)) return s;
        return next;
      },
    ) as Writable<Str>;
  }

  #starHandle(source: Cell<string>, cap: Capture, def: RegVal): Arr<string> {
    const starNode = cap.node as StarNode;
    if (starNode.part.kind !== "copy" && starNode.part.kind !== "of") {
      throw new RegError(
        `Reg.bind: named star "${starNode.name}" needs a copy/of element for an Arr handle (got "${starNode.part.kind}") — use view() for structured elements`,
      );
    }
    const path = cap.path;
    const self = this;
    const readStar = (s: string): StarVal =>
      (getAt((self.match(s) as RegVal) ?? def, path) as StarVal) ?? { items: [], seps: [] };
    const writeStar = (s: string, sv: StarVal): string => {
      const base = self.match(s) as RegVal | null;
      if (base === null) return s;
      const next = self.print(setAt(base, path, sv) as V);
      return self.match(next) === null ? s : next;
    };

    const keyFn = starNode.key;
    const slotIdsOf = (items: readonly RegVal[]): string[] => {
      if (keyFn === undefined) return items.map((_, i) => String(i));
      const occ = new Map<string, number>();
      return items.map(it => {
        const k = keyFn(String(it ?? ""));
        const n = occ.get(k) ?? 0;
        occ.set(k, n + 1);
        return `${k}#${n}`;
      });
    };
    const indexOfId = (items: readonly RegVal[], id: string): number =>
      keyFn === undefined
        ? Number(id) < items.length
          ? Number(id)
          : -1
        : slotIdsOf(items).indexOf(id);

    const segCache = new Map<string, Writable<Str>>();
    const idOfCell = new WeakMap<Cell<string>, string>();
    const seg = (id: string): Writable<Str> => {
      let c = segCache.get(id);
      if (c === undefined) {
        c = Str.lens(
          source as Cell<string>,
          (s: string) => {
            const sv = readStar(s);
            const idx = indexOfId(sv.items, id);
            return idx < 0 ? "" : String(sv.items[idx] ?? "");
          },
          (target: string, s: string) => {
            const sv = readStar(s);
            const idx = indexOfId(sv.items, id);
            if (idx < 0) return s;
            if (!fullNodeMatch(starNode.part, target)) return s;
            const items = sv.items.slice();
            items[idx] = target;
            return writeStar(s, { items, seps: sv.seps });
          },
        ) as Writable<Str>;
        segCache.set(id, c);
        idOfCell.set(c as unknown as Cell<string>, id);
      }
      return c;
    };

    const write = (sv: StarVal): void => {
      (source as Writable<Cell<string>>).value = writeStar(source.peek(), sv);
    };

    return Arr.fromSource<string, string>(
      source as Read<string>,
      (s: string) => {
        const items = readStar(s).items;
        return slotIdsOf(items).map(seg) as readonly Cell<string>[];
      },
      {
        insert: (v, at) => {
          const text = v instanceof Cell ? (v.value as string) : (v as string);
          const sv = readStar(source.peek());
          const items = sv.items.slice();
          const seps = sv.seps.slice();
          const idx = at == null || at > items.length ? items.length : Math.max(0, at);
          items.splice(idx, 0, text);
          if (items.length > 1) seps.splice(Math.min(idx, seps.length), 0, starNode.joiner);
          write({ items, seps });
          return seg(slotIdsOf(items)[idx]!) as unknown as Cell<string>;
        },
        remove: e => {
          const sv = readStar(source.peek());
          const id = idOfCell.get(e as unknown as Cell<string>);
          const idx = id === undefined ? -1 : indexOfId(sv.items, id);
          if (idx < 0) return;
          const items = sv.items.slice();
          const seps = sv.seps.slice();
          items.splice(idx, 1);
          if (seps.length > 0) seps.splice(Math.min(idx, seps.length - 1), 1);
          write({ items, seps });
        },
        moveBefore: (e, anchor) => {
          const sv = readStar(source.peek());
          const fromId = idOfCell.get(e as unknown as Cell<string>);
          const from = fromId === undefined ? -1 : indexOfId(sv.items, fromId);
          if (from < 0) return;
          const items = sv.items.slice();
          const [moved] = items.splice(from, 1);
          const anchorId =
            anchor == null ? undefined : idOfCell.get(anchor as unknown as Cell<string>);
          const ai = anchorId === undefined ? -1 : indexOfId(sv.items, anchorId);
          const at = ai < 0 ? items.length : ai > from ? ai - 1 : ai;
          items.splice(at, 0, moved!);
          write({ items, seps: sv.seps });
        },
      },
    );
  }
}

/** Flatten nested seqs so `a.then(b).then(c)` and `seq(a,b,c)` agree (a flat
 *  tuple of visible values), and adjacency checks see real neighbours. */
function flattenSeq(parts: readonly AnyReg[]): Node[] {
  const flat: Node[] = [];
  for (const p of parts) {
    const r = (p as unknown as Reg).root;
    if (r.kind === "seq") flat.push(...r.parts);
    else flat.push(r);
  }
  return flat;
}

// ── seq / alt type folds ──────────────────────────────────────────────

type SeqVal<T extends readonly AnyReg[]> = T extends readonly [
  infer H extends AnyReg,
  ...infer R extends readonly AnyReg[],
]
  ? [...AsTuple<ValOf<H>>, ...SeqVal<R>]
  : [];

type SeqNull<T extends readonly AnyReg[]> = T extends readonly [
  infer H extends AnyReg,
  ...infer R extends readonly AnyReg[],
]
  ? And<NullOf<H>, SeqNull<R>>
  : true;

type SeqFirst<T extends readonly AnyReg[]> = T extends readonly [
  infer H extends AnyReg,
  ...infer R extends readonly AnyReg[],
]
  ? NullOf<H> extends true
    ? Union<FirstOf<H>, SeqFirst<R>>
    : FirstOf<H>
  : NoneBound;

type SeqLast<T extends readonly AnyReg[]> = T extends readonly [
  ...infer R extends readonly AnyReg[],
  infer Last extends AnyReg,
]
  ? NullOf<Last> extends true
    ? Union<LastOf<Last>, SeqLast<R>>
    : LastOf<Last>
  : NoneBound;

type AltOf<T extends readonly AnyReg[]> = T extends readonly [
  infer H extends AnyReg,
  ...infer R extends readonly AnyReg[],
]
  ? R extends readonly []
    ? AltVal<ValOf<H>>
    : AltVal<ValOf<H>> | AltShift<AltOf<R>>
  : never;
// Re-tag the branch indices of the tail union by +1.
type AltShift<U> = U extends AltVal<infer W> ? AltValB<W> : never;
/** `AltVal` whose branch is ≥1 (used to widen `or`/`alt` unions structurally;
 *  the runtime tag is the real index). */
export type AltValB<V> = { readonly branch: number; readonly val: V };

type AltNull<T extends readonly AnyReg[]> = T extends readonly [
  infer H extends AnyReg,
  ...infer R extends readonly AnyReg[],
]
  ? Or<NullOf<H>, AltNull<R>>
  : false;

type AltFirst<T extends readonly AnyReg[]> = T extends readonly [
  infer H extends AnyReg,
  ...infer R extends readonly AnyReg[],
]
  ? Union<FirstOf<H>, AltFirst<R>>
  : NoneBound;

type AltLast<T extends readonly AnyReg[]> = T extends readonly [
  infer H extends AnyReg,
  ...infer R extends readonly AnyReg[],
]
  ? Union<LastOf<H>, AltLast<R>>
  : NoneBound;
