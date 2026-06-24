import { Cell, type Writable } from "../cell";
import type { TraitDict } from "../traits";
import { Bool } from "./bool";

const equals = (a: number, b: number) => a === b;

export class Flags<K extends string> extends Cell<number> {
  static traits = { equals } satisfies TraitDict<number>;
  declare readonly _t: typeof Flags.traits;

  #bits = new Map<K, Writable<Bool>>();

  constructor(
    readonly names: readonly K[],
    v = 0,
  ) {
    super(v, { equals });
  }

  /** Cached writable bit lens for `name`. */
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
