import { Cell, type Init, reader, type Val, type Writable } from "../cell";
import type { TraitDict } from "../traits";
import { Num } from "./num";

/** Clip header; the graph compares `epoch`. One `pcm` buffer per channel. */
export interface AudioClip {
  readonly pcm: readonly Float32Array[];
  readonly sampleRate: number;
  readonly epoch: number;
}

type V = AudioClip;

let EPOCH = 0;
/** Stamp buffers with a fresh epoch — the only way to mint a `Clip` value. */
export const stamp = (pcm: readonly Float32Array[], sampleRate: number): V => ({
  pcm,
  sampleRate,
  epoch: ++EPOCH,
});

export const equals = (a: V, b: V): boolean => a.epoch === b.epoch;

const peak = (v: V): number => {
  let m = 0;
  for (const ch of v.pcm) {
    for (let i = 0; i < ch.length; i++) {
      const a = ch[i]! < 0 ? -ch[i]! : ch[i]!;
      if (a > m) m = a;
    }
  }
  return m;
};

const rmsOf = (v: V): number => {
  let sum = 0;
  let n = 0;
  for (const ch of v.pcm) {
    for (let i = 0; i < ch.length; i++) sum += ch[i]! * ch[i]!;
    n += ch.length;
  }
  return n === 0 ? 0 : Math.sqrt(sum / n);
};

const scaled = (v: V, k: number): V =>
  stamp(
    v.pcm.map(ch => {
      const o = new Float32Array(ch.length);
      for (let i = 0; i < ch.length; i++) o[i] = ch[i]! * k;
      return o;
    }),
    v.sampleRate,
  );

export class Audio extends Cell<V> {
  static traits = { equals } satisfies TraitDict<V>;
  declare readonly _t: typeof Audio.traits;

  constructor(v: V = { pcm: [], sampleRate: 44100, epoch: 0 }) {
    super(v, { equals });
  }

  /** Time-reverse every channel. */
  reverse(): this {
    const run = (v: V) =>
      stamp(
        v.pcm.map(ch => {
          const o = new Float32Array(ch.length);
          for (let i = 0; i < ch.length; i++) o[i] = ch[ch.length - 1 - i]!;
          return o;
        }),
        v.sampleRate,
      );
    return this.lens(run, run);
  }

  /** Scalar gain. Invertible while k ≠ 0. */
  gain(k: Val<number>): this {
    const kf = reader(k);
    return this.lens(
      v => scaled(v, kf()),
      n => scaled(n, 1 / kf()),
    );
  }

  /** Peak-normalize to `target` (default 1). The complement stores the original
   *  peak so a write-back restores it. */
  normalize(target: Val<number> = 1): Writable<Audio> {
    const tf = reader(target);
    const self: Audio = this;
    return Audio.lens(self, {
      init: s => peak(s),
      fwd: s => {
        const p = peak(s);
        return p === 0 ? s : scaled(s, tf() / p);
      },
      bwd: (view, _src, c) => {
        const t = tf();
        return { update: t === 0 ? view : scaled(view, c / t), complement: c };
      },
    }) as Writable<Audio>;
  }

  /** RMS loudness as a writable `Num`; writing rescales the clip to hit it. */
  rms(): Writable<Num> {
    const self: Audio = this;
    return Num.lens(
      self,
      v => rmsOf(v),
      (target, v) => {
        const cur = rmsOf(v);
        return cur === 0 ? v : scaled(v, target / cur);
      },
    ) as Writable<Num>;
  }
}

/** Writable `Audio` from a `Clip` (new cell) or existing writable (passed
 *  through). */
export function audio(v: Init<Audio>): Writable<Audio> {
  if (v instanceof Audio) return v as Writable<Audio>;
  return new Audio(v) as Writable<Audio>;
}
