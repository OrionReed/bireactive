import { Cell, type Init, SKIP, type Writable } from "../cell";
import type { TraitDict } from "../traits";
import type { Bool } from "./bool";

type V = boolean | "mixed";

const equals = (a: V, b: V) => a === b;

/** Kleene negation: `true` / `false` swap, `"mixed"` is fixed. */
export const not = (a: V): V => (a === "mixed" ? "mixed" : !a);

/** Kleene AND: a known `false` dominates; otherwise mixed unless both
 *  are known and true. */
export const and = (a: V, b: V): V => {
  if (a === false || b === false) return false;
  if (a === true && b === true) return true;
  return "mixed";
};

/** Kleene OR: a known `true` dominates; otherwise mixed unless both
 *  are known and false. */
export const or = (a: V, b: V): V => {
  if (a === true || b === true) return true;
  if (a === false && b === false) return false;
  return "mixed";
};

export class Tri extends Cell<V> {
  static traits = { equals } satisfies TraitDict<V>;
  declare readonly _t: typeof Tri.traits;

  constructor(v: V = "mixed") {
    super(v, { equals });
  }

  /** Kleene negation. */
  not(): this {
    return this.lens(not, not);
  }

  /** AND-aggregate over writable `Bool`/`Tri` children: `true` if all are true,
   *  `false` if all false, else `"mixed"`. A `true`/`false` write broadcasts to
   *  every child (recursing into nested aggregates); `"mixed"` is a no-op. */
  static allOf(parents: readonly (Bool | Tri)[]): Writable<Tri> {
    return Tri.lens(
      parents as never,
      (vs: readonly V[]) => {
        let anyT = false;
        let anyF = false;
        for (const v of vs) {
          if (v === "mixed") return "mixed";
          if (v) anyT = true;
          else anyF = true;
          if (anyT && anyF) return "mixed";
        }
        return anyT;
      },
      (target, _vs) => {
        if (target === "mixed") return parents.map(() => SKIP) as never;
        return parents.map(() => target) as never;
      },
    );
  }

  /** OR-aggregate over writable `Bool`/`Tri` children: `true` if any is true,
   *  `false` if all false, else `"mixed"`. A `true`/`false` write broadcasts to
   *  every child; `"mixed"` is a no-op. */
  static anyOf(parents: readonly (Bool | Tri)[]): Writable<Tri> {
    return Tri.lens(
      parents as never,
      (vs: readonly V[]) => {
        let anyT = false;
        let anyF = false;
        for (const v of vs) {
          if (v === "mixed") return "mixed";
          if (v) anyT = true;
          else anyF = true;
        }
        if (anyT && !anyF) return true;
        if (!anyT && anyF) return false;
        return "mixed";
      },
      (target, _vs) => {
        if (target === "mixed") return parents.map(() => SKIP) as never;
        return parents.map(() => target) as never;
      },
    );
  }
}

/** Writable `Tri` from a literal (new cell) or existing writable (passed
 *  through). Defaults to `"mixed"`. */
export function tri(v: Init<Tri> = "mixed"): Writable<Tri> {
  if (v instanceof Tri) return v as Writable<Tri>;
  return new Tri(v) as Writable<Tri>;
}
