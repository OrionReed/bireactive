import { Cell, type Init, reader, type Val, type Writable } from "../cell";
import type { Linear, TraitDict } from "../traits";

type V = boolean;

export const not = (a: V): V => !a;
export const and = (a: V, b: V): V => a && b;
export const or = (a: V, b: V): V => a || b;
export const xor = (a: V, b: V): V => a !== b;
export const equals = (a: V, b: V) => a === b;

// F₂-linear: xor is both add and sub; scale collapses by parity.
const linearImpl: Linear<V> = {
  add: xor,
  sub: xor,
  scale: (a, k) => (Math.round(k) % 2 !== 0 ? a : false),
};

export class Bool extends Cell<V> {
  static traits = { linear: linearImpl, equals } satisfies TraitDict<V>;
  declare readonly _t: typeof Bool.traits;

  constructor(v: V = false) {
    super(v, { equals });
  }

  /** Logical negation. */
  not(): this {
    return this.lens(not, not);
  }

  /** True when exactly one side is true (XOR); its own inverse. */
  xor(b: Val<V>): this {
    const bf = reader(b);
    return this.lens(
      v => v !== bf(),
      n => n !== bf(),
    );
  }

  /** True when both sides are true. Read-only — a write can't be split
   *  between the two inputs. */
  and(b: Val<V>): Bool {
    const bf = reader(b);
    return Bool.derive(() => this.value && bf());
  }
  /** True when either side is true. */
  or(b: Val<V>): Bool {
    const bf = reader(b);
    return Bool.derive(() => this.value || bf());
  }
  /** True unless `this` is true and `b` is false (`this → b`). */
  implies(b: Val<V>): Bool {
    const bf = reader(b);
    return Bool.derive(() => !this.value || bf());
  }
  /** True when both sides match (XNOR). */
  eq(b: Val<V>): Bool {
    const bf = reader(b);
    return Bool.derive(() => this.value === bf());
  }
  /** True unless both sides are true (NAND). */
  nand(b: Val<V>): Bool {
    const bf = reader(b);
    return Bool.derive(() => !(this.value && bf()));
  }
  /** True when both sides are false (NOR). */
  nor(b: Val<V>): Bool {
    const bf = reader(b);
    return Bool.derive(() => !(this.value || bf()));
  }
}

/** Writable `Bool` from a literal (new cell) or existing writable (passed
 *  through). For read-only sources use `Bool.derive`. */
export function bool(v: Init<Bool> = false): Writable<Bool> {
  if (v instanceof Bool) return v as Writable<Bool>;
  return new Bool(v) as Writable<Bool>;
}
