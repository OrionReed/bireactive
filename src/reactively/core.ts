// core.ts — reactively's push-pull engine (milomg/reactively), refactored for
// the bireactive experiment. Same algorithm and semantics as `vendor.ts`; the
// changes are mechanical and local:
//
//   1. Bitflag node state. The old `state: 0|1|2` + `effect: boolean` pair is
//      packed into one `flags` int. The 2-bit cache state lives in the low bits
//      (so the `state < newState` escalation compare still works on `flags &
//      STATE`), with EFFECT / DISPOSED as higher bits. One field instead of
//      two → smaller, more monomorphic nodes.
//
//   2. Explicit stacks instead of recursion. `updateIfNecessary` (walk up
//      sources) and `markStale` (walk down observers) were mutually/​self
//      recursive — O(depth) call frames with a stack-overflow ceiling on deep
//      graphs. They now drive module-level scratch stacks. The update walk is
//      re-entrant-safe via a saved base pointer (a computation's `fn()`
//      re-enters through `get()`), and slots are cleared on pop so the scratch
//      arrays never pin dead nodes (GC tests).
//
//      Measured tradeoff (kairo suite, see _bench/table.ts): this is a clear
//      win on deep chains (deepPropagation ~1.8x→~1.5x of alien) and removes
//      the recursion ceiling, but adds a small constant per-call overhead that
//      shows on shallow, high-frequency-write graphs — roughly a wash on the
//      geomean. Upstream reactively is already only ~1.15x alien, so these are
//      robustness/scaling changes more than a headline speedup.
//
//   3. `untrack` + effect `dispose`/`onCleanup` teardown, so the engine clears
//      the reactive-framework-test-suite (upstream reactively has no effect
//      disposal). These are additive; the hot read/write/propagate paths are
//      untouched.

let CurrentReaction: Reactive<any> | undefined = undefined;
let CurrentGets: Reactive<any>[] | null = null;
let CurrentGetsIndex = 0;

const EffectQueue: Reactive<any>[] = [];
let stabilizeFn: ((node: Reactive<any>) => void) | undefined = undefined;
let stabilizationQueued = false;

// ── Node flags ──────────────────────────────────────────────────────
// Low 2 bits: cache state (Clean < Check < Dirty, ordered so escalation is a
// `<` compare). Higher bits: orthogonal node properties.
export const CacheClean = 0;
export const CacheCheck = 1;
export const CacheDirty = 2;
const STATE = 3; // mask for the cache-state bits
const EFFECT = 4; // node is an effect (queued + run by stabilize)
const DISPOSED = 8; // node torn down; ignored by propagation + stabilize

export type CacheState = typeof CacheClean | typeof CacheCheck | typeof CacheDirty;
type CacheNonClean = typeof CacheCheck | typeof CacheDirty;

// Shared scratch stacks for the iterative traversals (see header note 2).
const checkNodes: Reactive<any>[] = [];
let checkTop = 0;
const staleNodes: Reactive<any>[] = [];
let staleTop = 0;

export function logDirty(_enable?: boolean): void {}

export interface ReactivelyParams {
  equals?: (a: any, b: any) => boolean;
  effect?: boolean;
  label?: string;
}

/** Construct a reactive node (source if given a value, computation if given a fn). */
export function reactive<T>(fnOrValue: T | (() => T), params?: ReactivelyParams): Reactive<T> {
  const node = new Reactive(fnOrValue, params?.effect, params?.label);
  if (params?.equals) node.equals = params.equals;
  return node;
}

function defaultEquality(a: any, b: any) {
  return a === b;
}

export class Reactive<T> {
  private _value: T;
  private fn?: () => T;
  private observers: Reactive<any>[] | null = null;
  private sources: Reactive<any>[] | null = null;

  private flags: number;
  private label?: string;
  cleanups: ((oldValue: T) => void)[] = [];
  equals = defaultEquality;

  constructor(fnOrValue: (() => T) | T, effect?: boolean, label?: string) {
    if (typeof fnOrValue === "function") {
      this.fn = fnOrValue as () => T;
      this._value = undefined as any;
      this.flags = CacheDirty | (effect ? EFFECT : 0);
      if (effect) {
        EffectQueue.push(this);
        stabilizeFn?.(this);
      }
    } else {
      this.fn = undefined;
      this._value = fnOrValue;
      this.flags = CacheClean;
    }
    if (label) this.label = label;
  }

  get value(): T {
    return this.get();
  }
  set value(v: T) {
    this.set(v);
  }

  get(): T {
    if (CurrentReaction) {
      if (
        !CurrentGets &&
        CurrentReaction.sources &&
        CurrentReaction.sources[CurrentGetsIndex] === this
      ) {
        CurrentGetsIndex++;
      } else {
        if (!CurrentGets) CurrentGets = [this];
        else CurrentGets.push(this);
      }
    }
    if (this.fn) this.updateIfNecessary();
    return this._value;
  }

  set(fnOrValue: T | (() => T)): void {
    if (typeof fnOrValue === "function") {
      const fn = fnOrValue as () => T;
      if (fn !== this.fn) this.markStale(CacheDirty);
      this.fn = fn;
    } else {
      if (this.fn) {
        this.removeParentObservers(0);
        this.sources = null;
        this.fn = undefined;
      }
      const value = fnOrValue as T;
      if (!this.equals(this._value, value)) {
        if (this.observers) {
          for (let i = 0; i < this.observers.length; i++) {
            this.observers[i].markStale(CacheDirty);
          }
        }
        this._value = value;
      }
    }
  }

  /** Escalate this node's staleness and propagate `Check` to clean descendants.
   *  Iterative (was recursive): `this` takes `state`; the BFS over observers
   *  only descends into still-`Clean` nodes (the propagation cut). */
  private markStale(state: CacheNonClean): void {
    if ((this.flags & STATE) >= state) return;

    if ((this.flags & STATE) === CacheClean && this.flags & EFFECT && !(this.flags & DISPOSED)) {
      EffectQueue.push(this);
      stabilizeFn?.(this);
    }
    this.flags = (this.flags & ~STATE) | state;

    const obs = this.observers;
    if (obs === null) return;

    const stack = staleNodes;
    const base = staleTop;
    for (let i = 0; i < obs.length; i++) stack[staleTop++] = obs[i];

    while (staleTop > base) {
      const node = stack[--staleTop];
      stack[staleTop] = undefined as any; // release ref (keeps array capacity)
      if ((node.flags & STATE) === CacheClean) {
        if (node.flags & EFFECT && !(node.flags & DISPOSED)) {
          EffectQueue.push(node);
          stabilizeFn?.(node);
        }
        node.flags |= CacheCheck;
        const childObs = node.observers;
        if (childObs !== null) {
          for (let i = 0; i < childObs.length; i++) stack[staleTop++] = childObs[i];
        }
      }
    }
  }

  /** run the computation fn, updating the cached value */
  private update(): void {
    const oldValue = this._value;

    const prevReaction = CurrentReaction;
    const prevGets = CurrentGets;
    const prevIndex = CurrentGetsIndex;

    CurrentReaction = this;
    CurrentGets = null as any;
    CurrentGetsIndex = 0;

    try {
      if (this.cleanups.length) {
        this.cleanups.forEach(c => c(this._value));
        this.cleanups = [];
      }
      this._value = this.fn!();

      if (CurrentGets) {
        this.removeParentObservers(CurrentGetsIndex);
        if (this.sources && CurrentGetsIndex > 0) {
          this.sources.length = CurrentGetsIndex + CurrentGets.length;
          for (let i = 0; i < CurrentGets.length; i++) {
            this.sources[CurrentGetsIndex + i] = CurrentGets[i];
          }
        } else {
          this.sources = CurrentGets;
        }

        for (let i = CurrentGetsIndex; i < this.sources.length; i++) {
          const source = this.sources[i];
          if (!source.observers) source.observers = [this];
          else source.observers.push(this);
        }
      } else if (this.sources && CurrentGetsIndex < this.sources.length) {
        this.removeParentObservers(CurrentGetsIndex);
        this.sources.length = CurrentGetsIndex;
      }
    } finally {
      CurrentGets = prevGets;
      CurrentReaction = prevReaction;
      CurrentGetsIndex = prevIndex;
    }

    // diamond: if we changed, mark direct observers dirty (their deeper
    // descendants are already Check from the markStale pass).
    if (!this.equals(oldValue, this._value) && this.observers) {
      for (let i = 0; i < this.observers.length; i++) {
        const observer = this.observers[i];
        observer.flags = (observer.flags & ~STATE) | CacheDirty;
      }
    }

    this.flags &= ~STATE;
  }

  /** update() if dirty, or a parent turns out to be dirty. Iterative: walks up
   *  the source DAG with an explicit stack instead of recursion.
   *
   *  No resume-index is tracked: a processed source ends up Clean, so on the
   *  next visit to a frame we just rescan its sources and skip the Clean ones —
   *  the first still-non-clean source is the next to process. For the typical
   *  small / chain-shaped source lists this is cheaper than carrying a parallel
   *  index stack, and it keeps the hot path allocation-free. */
  private updateIfNecessary(): void {
    const s = this.flags & STATE;
    if (s === CacheClean) return;
    if (s === CacheDirty) {
      this.update();
      this.flags &= ~STATE;
      return;
    }

    // s === CacheCheck: resolve whether any source actually changed.
    const nodes = checkNodes;
    const base = checkTop;
    nodes[checkTop++] = this;

    while (checkTop > base) {
      const node = nodes[checkTop - 1];
      const ns = node.flags & STATE;

      if (ns === CacheCheck) {
        const srcs = node.sources;
        let pushed = false;
        if (srcs !== null) {
          for (let i = 0; i < srcs.length; i++) {
            const src = srcs[i];
            if ((src.flags & STATE) !== CacheClean) {
              nodes[checkTop++] = src;
              pushed = true;
              break;
            }
          }
        }
        if (pushed) continue;
        // No source needed work and none promoted us to Dirty: we're current.
        node.flags &= ~STATE;
        nodes[--checkTop] = undefined as any;
      } else {
        // Promoted to Dirty by a just-updated source (or already Dirty).
        if (ns === CacheDirty) node.update();
        node.flags &= ~STATE;
        nodes[--checkTop] = undefined as any;
      }
    }
  }

  private removeParentObservers(index: number): void {
    if (!this.sources) return;
    for (let i = index; i < this.sources.length; i++) {
      const source: Reactive<any> = this.sources[i];
      const swap = source.observers!.findIndex(v => v === this);
      source.observers![swap] = source.observers![source.observers!.length - 1];
      source.observers!.pop();
    }
  }

  /** Tear down an effect: run cleanups, unlink from sources, stop reacting. */
  dispose(): void {
    if (this.flags & DISPOSED) return;
    this.flags |= DISPOSED;
    if (this.cleanups.length) {
      const value = this._value;
      const cleanups = this.cleanups;
      this.cleanups = [];
      for (let i = 0; i < cleanups.length; i++) cleanups[i](value);
    }
    this.removeParentObservers(0);
    this.sources = null;
    this.fn = undefined;
    this.flags &= ~STATE;
  }
}

export function onCleanup<T = any>(fn: (oldValue: T) => void): void {
  if (CurrentReaction) CurrentReaction.cleanups.push(fn);
  else console.error("onCleanup must be called from within a @reactive function");
}

/** Read `fn` without subscribing the active computation to anything it touches. */
export function untrack<T>(fn: () => T): T {
  const prevReaction = CurrentReaction;
  const prevGets = CurrentGets;
  const prevIndex = CurrentGetsIndex;
  CurrentReaction = undefined;
  CurrentGets = null;
  CurrentGetsIndex = 0;
  try {
    return fn();
  } finally {
    CurrentReaction = prevReaction;
    CurrentGets = prevGets;
    CurrentGetsIndex = prevIndex;
  }
}

/** run all non-clean effect nodes (disposed ones no-op: their fn is cleared).
 *  The queue is always cleared, even if an effect throws, so one bad effect
 *  can't wedge the scheduler into re-running it forever. */
export function stabilize(): void {
  try {
    for (let i = 0; i < EffectQueue.length; i++) EffectQueue[i].get();
  } finally {
    EffectQueue.length = 0;
  }
}

export function autoStabilize(fn = deferredStabilize): void {
  stabilizeFn = fn;
}

function deferredStabilize(): void {
  if (!stabilizationQueued) {
    stabilizationQueued = true;
    queueMicrotask(() => {
      stabilizationQueued = false;
      stabilize();
    });
  }
}
