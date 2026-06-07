// Data plane for the bireactive EQ demo (native WebAudio).

import { type AudioClip as Clip, audioStamp as stamp } from "@bireactive";

/** One peaking band; gain is a reactive control, not stored here. */
export interface EqBand {
  freq: number;
  q: number;
}

/** Magnitude (dB) of one RBJ peaking biquad at frequency `f`. Identical to
 *  WebAudio's `BiquadFilterNode` "peaking" math. */
export function peakingDb(f: number, f0: number, gainDb: number, q: number, fs: number): number {
  const A = 10 ** (gainDb / 40);
  const w0 = (2 * Math.PI * f0) / fs;
  const cw0 = Math.cos(w0);
  const alpha = Math.sin(w0) / (2 * q);

  const b0 = 1 + alpha * A;
  const b1 = -2 * cw0;
  const b2 = 1 - alpha * A;
  const a0 = 1 + alpha / A;
  const a1 = -2 * cw0;
  const a2 = 1 - alpha / A;

  const w = (2 * Math.PI * f) / fs;
  const cw = Math.cos(w);
  const c2w = Math.cos(2 * w);
  const sw = Math.sin(w);
  const s2w = Math.sin(2 * w);

  const numRe = b0 + b1 * cw + b2 * c2w;
  const numIm = -(b1 * sw + b2 * s2w);
  const denRe = a0 + a1 * cw + a2 * c2w;
  const denIm = -(a1 * sw + a2 * s2w);

  const mag2 = (numRe * numRe + numIm * numIm) / (denRe * denRe + denIm * denIm);
  return 10 * Math.log10(mag2);
}

/** Summed response (dB) of the whole band cascade at frequency `f`. The
 *  function the inverse-EQ `factor` lens inverts. */
export function responseDb(
  f: number,
  gains: readonly number[],
  bands: readonly EqBand[],
  fs: number,
): number {
  let db = 0;
  for (let k = 0; k < bands.length; k++)
    db += peakingDb(f, bands[k]!.freq, gains[k]!, bands[k]!.q, fs);
  return db;
}

/** A seamless looping chord pad as a context-free mono `Clip`. Additive saw-ish
 *  partials over a few notes — broadband (so EQ is audible) and musical. Note
 *  frequencies are snapped to whole cycles per buffer so the loop is click-free. */
export function renderChordClip(sampleRate: number, seconds: number): Clip {
  const n = Math.floor(seconds * sampleRate);
  const d = new Float32Array(n);
  // A2 · E3 · A3 · E4, each snapped to integer cycles per buffer (seamless loop).
  const notes = [110, 164.81, 220, 329.63].map(f => Math.round(f * seconds) / seconds);
  for (const f0 of notes) {
    const K = Math.min(40, Math.floor(8000 / f0));
    for (let k = 1; k <= K; k++) {
      const amp = 0.6 / k / notes.length;
      const w = (2 * Math.PI * k * f0) / sampleRate;
      for (let i = 0; i < n; i++) d[i]! += amp * Math.sin(w * i);
    }
  }
  let max = 0;
  for (let i = 0; i < n; i++) {
    const a = Math.abs(d[i]!);
    if (a > max) max = a;
  }
  const g = max > 0 ? 0.9 / max : 1;
  for (let i = 0; i < n; i++) d[i]! *= g;
  return stamp([d], sampleRate);
}

/** Fetch + decode a URL into a context-free `Clip` (channels copied out of the
 *  decoded buffer so the value owns its PCM). Needs CORS on the source. */
export async function loadClip(ctx: AudioContext, url: string): Promise<Clip> {
  const resp = await fetch(url);
  const bytes = await resp.arrayBuffer();
  const buf = await ctx.decodeAudioData(bytes);
  const pcm: Float32Array[] = [];
  for (let c = 0; c < buf.numberOfChannels; c++) pcm.push(buf.getChannelData(c).slice());
  return stamp(pcm, buf.sampleRate);
}

const FFT_SIZE = 2048;
// Assumed rate for the visual response curve before a live context exists.
// The live filters use the real ctx rate; the curve difference is negligible.
const FALLBACK_RATE = 44100;

/** Live native-WebAudio engine: source → peaking cascade → master → analyser →
 *  destination. The reactive layer drives `setGain`, points playback at a clip
 *  via `setSource`, and reads `spectrum`.
 *
 *  The AudioContext is created lazily on the first user gesture (`resume`/
 *  `play`/`ensureContext`) so browsers don't warn about an auto-started
 *  context. Until then, gains and source are buffered and the spectrum reads
 *  as silence. */
export class AudioEngine {
  #ctx: AudioContext | null = null;
  #master: GainNode | null = null;
  #analyser: AnalyserNode | null = null;
  #filters: BiquadFilterNode[] = [];
  #source: AudioBufferSourceNode | null = null;
  #clip: Clip | null = null;
  // Buffered band gains (dB), applied to the filters once the context exists.
  readonly #gains: number[];
  playing = false;

  constructor(private readonly bands: readonly EqBand[]) {
    this.#gains = bands.map(() => 0);
  }

  /** Create the AudioContext + graph on first use. Must be reached from a user
   *  gesture; idempotent thereafter. */
  ensureContext(): AudioContext {
    if (this.#ctx) return this.#ctx;
    // biome-ignore lint/suspicious/noExplicitAny: webkit-prefixed fallback
    const Ctx: typeof AudioContext = window.AudioContext ?? (window as any).webkitAudioContext;
    const ctx = new Ctx();

    const master = ctx.createGain();
    master.gain.value = 0.6;
    const analyser = ctx.createAnalyser();
    analyser.fftSize = FFT_SIZE;
    analyser.smoothingTimeConstant = 0.75;

    this.#filters = this.bands.map((b, i) => {
      const f = ctx.createBiquadFilter();
      f.type = "peaking";
      f.frequency.value = b.freq;
      f.Q.value = b.q;
      f.gain.value = this.#gains[i]!;
      return f;
    });
    for (let i = 0; i < this.#filters.length - 1; i++)
      this.#filters[i]!.connect(this.#filters[i + 1]!);
    this.#filters[this.#filters.length - 1]!.connect(master);
    master.connect(analyser);
    analyser.connect(ctx.destination);

    this.#ctx = ctx;
    this.#master = master;
    this.#analyser = analyser;
    return ctx;
  }

  /** Live context rate, or the assumed fallback before one exists. */
  get sampleRate(): number {
    return this.#ctx?.sampleRate ?? FALLBACK_RATE;
  }

  /** Push a solved band gain (dB) onto the live filter (smoothed, clamped so
   *  macro solves can't blow up the output). Buffered until the context exists. */
  setGain(i: number, db: number): void {
    const c = db < -24 ? -24 : db > 24 ? 24 : db;
    this.#gains[i] = c;
    if (this.#ctx) this.#filters[i]?.gain.setTargetAtTime(c, this.#ctx.currentTime, 0.02);
  }

  /** Point playback at a clip; rebuilds the live source if already playing. The
   *  reactive layer calls this from an `effect` over an `Audio` cell. */
  setSource(clip: Clip): void {
    this.#clip = clip;
    if (this.playing) this.#restart();
  }

  #toBuffer(ctx: AudioContext, clip: Clip): AudioBuffer {
    const len = clip.pcm[0]?.length ?? 1;
    const buf = ctx.createBuffer(Math.max(1, clip.pcm.length), len, clip.sampleRate);
    for (let c = 0; c < clip.pcm.length; c++)
      buf.copyToChannel(clip.pcm[c]! as Float32Array<ArrayBuffer>, c);
    return buf;
  }

  #stopSource(): void {
    try {
      this.#source?.stop();
      this.#source?.disconnect();
    } catch {}
    this.#source = null;
  }

  #restart(): void {
    this.#stopSource();
    const ctx = this.#ctx;
    if (!ctx || !this.#clip || this.#clip.pcm.length === 0) return;
    const s = ctx.createBufferSource();
    s.buffer = this.#toBuffer(ctx, this.#clip);
    s.loop = true;
    s.connect(this.#filters[0]!);
    s.start();
    this.#source = s;
  }

  get binCount(): number {
    return FFT_SIZE / 2;
  }
  freqForBin(i: number): number {
    return (i * this.sampleRate) / FFT_SIZE;
  }
  /** Fill `out` (length `binCount`) with the live magnitude spectrum (dB), or
   *  silence before the context exists. */
  spectrum(out: Float32Array<ArrayBuffer>): void {
    if (this.#analyser) this.#analyser.getFloatFrequencyData(out);
    else out.fill(Number.NEGATIVE_INFINITY);
  }

  async resume(): Promise<void> {
    const ctx = this.ensureContext();
    if (ctx.state !== "running") await ctx.resume();
  }
  play(): void {
    if (this.playing) return;
    this.ensureContext();
    this.playing = true;
    this.#restart();
  }
  pause(): void {
    if (!this.playing) return;
    this.playing = false;
    this.#stopSource();
  }
  dispose(): void {
    try {
      this.pause();
    } catch {}
    try {
      void this.#ctx?.close();
    } catch {}
  }
}
