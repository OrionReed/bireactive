// flags.ts — named bit-flags over a packed integer.
//
// A `number` bitmask whose bits are named at construction. `flag(name)` is a
// `Writable<Bool>` mask lens onto one bit — set/clear round-trips through the
// packed value, so the integer and its named booleans are one source seen
// two ways. Sparse-trait (`equals` only): bits are discrete, so there's no
// linear/pack/factor surface. Bit `i` carries value `2^i`, so a flag list
// ordered low→high makes the packed int equal the conventional mask (e.g.
// chmod octal). Two front-ends: variadic names, or an object of defaults.
//
// `flag()` is the collision-free accessor (a single generic method, names
// checked as a union) rather than dynamic `.name` members — no risk of a
// flag named "value"/"flag" shadowing the class. Since each flag is a
// writable Bool, `Tri.allOf([f.flag(a), f.flag(b)])` gives all/none/mixed
// group toggles for free.

import { Cell, type Lattice, type Writable } from "../cell";
import type { TraitDict } from "../traits";
import { Bool } from "./bool";

const equals = (a: number, b: number) => a === b;

export class Flags<K extends string> extends Cell<number> {
  static traits = { equals } satisfies TraitDict<number>;
  declare readonly _t: typeof Flags.traits;

  /** Bit-intersection lattice — a packed mask read as a candidate SET of
   *  bits. `meet` is bitwise AND (narrow the allowed bits), `top` is the
   *  all-ones mask (every bit still possible; `-1 & m = m`), `isBottom` is
   *  the empty mask. The relate layer uses it when a `Flags` joins a cyclic
   *  relation — e.g. boolean/finite-domain constraint propagation. */
  static lattice: Lattice<number> = {
    top: -1,
    meet: (a, b) => a & b,
    equals: (a, b) => a === b,
    isBottom: a => a === 0,
  };

  #bits = new Map<K, Writable<Bool>>();

  constructor(
    readonly names: readonly K[],
    v = 0,
  ) {
    super(v, { equals });
  }

  /** Bit lens for `name`; set/clear round-trips through the packed mask.
   *  Cached per name so repeated calls return the same lens. */
  flag<F extends K>(name: F): Writable<Bool> {
    let lens = this.#bits.get(name);
    if (lens === undefined) {
      const i = this.names.indexOf(name);
      if (i < 0) throw new Error(`Flags: unknown flag "${String(name)}"`);
      lens = Bool.lens(
        this as Flags<K>,
        v => ((v >> i) & 1) === 1,
        (on, cur) => (on ? cur | (1 << i) : cur & ~(1 << i)),
      ) as Writable<Bool>;
      this.#bits.set(name, lens);
    }
    return lens;
  }
}

/** Writable `Flags` from variadic bit names (bit `i` = the i-th name), or
 *  from an object of name→default (keys are the bits in insertion order). */
export function flags<const N extends readonly string[]>(...names: N): Writable<Flags<N[number]>>;
export function flags<const R extends Record<string, boolean>>(
  defaults: R,
): Writable<Flags<keyof R & string>>;
export function flags(arg: string | Record<string, boolean>, ...rest: string[]): unknown {
  if (typeof arg === "string") return new Flags([arg, ...rest]) as unknown;
  const names = Object.keys(arg);
  let v = 0;
  for (let i = 0; i < names.length; i++) if (arg[names[i]!]) v |= 1 << i;
  return new Flags(names, v) as unknown;
}
