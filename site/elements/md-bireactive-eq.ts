// Inverse EQ: drag the response curve and `factor` solves the band gains, which
// an `effect` pushes onto live BiquadFilters. The source is a first-class
// `Audio` cell, so switching chord ⇄ music is an ordinary reactive write.

import {
  audio,
  type AudioClip as Clip,
  cell,
  circle,
  Diagram,
  derive,
  drag,
  drive,
  effect,
  factor,
  label,
  line,
  type Mount,
  Num,
  num,
  pathD,
  rect,
  tokens,
  Vec,
  vec,
  type Writable,
} from "@bireactive";
import { AudioEngine, type EqBand, loadClip, renderChordClip, responseDb } from "./eq-audio";

const MUSIC_URL = "https://mdn.github.io/webaudio-examples/audio-basics/outfoxing.mp3";

const W = 660;
const H = 392;
const PX0 = 96; // plot starts after the macro-fader lane on the left
const PX1 = 620;

// EQ response plot (top): ±EQ_DB around 0 dB.
const EQ_TOP = 44;
const EQ_MID = 112;
const EQ_DB = 18;
const PX_PER_DB = (EQ_MID - EQ_TOP) / EQ_DB;

// Measured spectrum plot (bottom).
const SP_TOP = 214;
const SP_BOT = 330;
const SP_DB_HI = -18;
const SP_DB_LO = -96;

const LOGMIN = Math.log(20);
const LOGMAX = Math.log(20000);

const freqToX = (f: number): number =>
  PX0 + ((Math.log(f) - LOGMIN) / (LOGMAX - LOGMIN)) * (PX1 - PX0);
const dbToY = (db: number): number => EQ_MID - db * PX_PER_DB;
const yToDb = (y: number): number => {
  const db = (EQ_MID - y) / PX_PER_DB;
  return db < -EQ_DB ? -EQ_DB : db > EQ_DB ? EQ_DB : db;
};
const specToY = (db: number): number => {
  const t = (db - SP_DB_LO) / (SP_DB_HI - SP_DB_LO);
  const c = t < 0 ? 0 : t > 1 ? 1 : t;
  return SP_BOT - c * (SP_BOT - SP_TOP);
};

const BANDS: EqBand[] = [
  { freq: 90, q: 1.0 },
  { freq: 260, q: 1.1 },
  { freq: 750, q: 1.1 },
  { freq: 2200, q: 1.1 },
  { freq: 6400, q: 1.0 },
];

const ACCENT = "#5b8def";
const MEASURED = "#e0a458";
const META = "#46c08a";
const FADER_DB = 14;

export class MdBireactiveEq extends Diagram {
  #engine: AudioEngine | null = null;

  disconnectedCallback(): void {
    super.disconnectedCallback();
    this.#engine?.dispose();
    this.#engine = null;
  }

  protected scene(s: Mount): void {
    const view = this.view(W, H);
    const engine = new AudioEngine(BANDS);
    this.#engine = engine;
    const fs = engine.sampleRate;

    // `setSource` runs in an effect, rebuilding the live BufferSource only when
    // the clip's epoch changes (O(1) handle equality).
    const chordClip = renderChordClip(44100, 3);
    const source = audio(chordClip);
    const sourceKind = cell<"chord" | "music">("chord");
    const musicReady = cell(false);
    let musicClip: Clip | null = null;
    effect(() => engine.setSource(source.value));

    // Fetch + decode the remote track lazily — decoding needs an AudioContext,
    // so it waits for the first user gesture (when one is created) rather than
    // forcing the context to start on load.
    let musicRequested = false;
    const ensureMusic = (): void => {
      if (musicRequested) return;
      musicRequested = true;
      void loadClip(engine.ensureContext(), MUSIC_URL)
        .then(c => {
          musicClip = c;
          musicReady.value = true;
        })
        .catch(() => {});
    };

    const gains = BANDS.map(() => num(0));
    gains.forEach((g, i) => effect(() => engine.setGain(i, g.value)));

    // Each output is a lens over all five gains; dragging one sends a sparse δ
    // through factor's min-norm LSQ. The macros:
    //   level — uniform gain (∂/∂gₖ = 1/N): drags all bands together.
    //   tilt  — spectral slope (∂/∂gₖ = sₖ/Σs², Σsₖ = 0): see-saws the bands,
    //           loudness-preserving by construction (δlevel = 0).
    const N = BANDS.length;
    const tiltW = BANDS.map((_, k) => (k - (N - 1) / 2) / ((N - 1) / 2));
    const tiltSS = tiltW.reduce((a, v) => a + v * v, 0);
    const outputs: Record<string, { Cls: typeof Num; fwd: (g: readonly number[]) => number }> = {};
    BANDS.forEach((band, j) => {
      outputs[`b${j}`] = {
        Cls: Num,
        fwd: (g: readonly number[]) => responseDb(band.freq, g, BANDS, fs),
      };
    });
    outputs.level = {
      Cls: Num,
      fwd: (g: readonly number[]) => {
        let acc = 0;
        for (let k = 0; k < N; k++) acc += g[k]!;
        return acc / N;
      },
    };
    outputs.tilt = {
      Cls: Num,
      fwd: (g: readonly number[]) => {
        let acc = 0;
        for (let k = 0; k < N; k++) acc += tiltW[k]! * g[k]!;
        return acc / tiltSS;
      },
    };
    const curve = factor(gains, outputs as never, {
      converge: true,
      damping: 1e-3,
      maxIters: 8,
    }) as Record<string, Writable<Num>>;

    s(line(vec(PX0, dbToY(0)), vec(PX1, dbToY(0)), { thin: true, opacity: 0.35 }));
    s(line(vec(PX0, SP_BOT), vec(PX1, SP_BOT), { thin: true, opacity: 0.35 }));
    for (const f of [100, 1000, 10000]) {
      const x = freqToX(f);
      s(line(vec(x, EQ_TOP), vec(x, SP_BOT), { thin: true, opacity: 0.08 }));
      s(label(vec(x, SP_BOT + 12), f >= 1000 ? `${f / 1000}k` : `${f}`, { size: 9, opacity: 0.5 }));
    }

    // Measured spectrum: a derived cell whose only dependency is the frame tick;
    // recompute reads the FFT.
    const buf = new Float32Array(engine.binCount);
    const frame = cell(0);
    this.anim.start(
      drive(() => {
        frame.value++;
      }),
    );
    const specD = derive(() => {
      frame.value; // tick dependency
      engine.spectrum(buf);
      let d = "";
      let started = false;
      for (let i = 1; i < buf.length; i++) {
        const f = engine.freqForBin(i);
        if (f < 20 || f > 20000) continue;
        const x = freqToX(f);
        const y = specToY(buf[i]!);
        d += started ? ` L ${x.toFixed(1)} ${y.toFixed(1)}` : `M ${x.toFixed(1)} ${y.toFixed(1)}`;
        started = true;
      }
      return d;
    });
    s(
      pathD(specD, {
        stroke: MEASURED,
        strokeWidth: 1.5,
        opacity: 0.85,
        cap: "round",
        join: "round",
      }),
    );

    const eqD = derive(() => {
      const g = gains.map(c => c.value);
      const N = 140;
      let d = "";
      for (let i = 0; i < N; i++) {
        const x = PX0 + (i / (N - 1)) * (PX1 - PX0);
        const f = Math.exp(LOGMIN + (i / (N - 1)) * (LOGMAX - LOGMIN));
        const y = dbToY(responseDb(f, g, BANDS, fs));
        d += i === 0 ? `M ${x.toFixed(1)} ${y.toFixed(1)}` : ` L ${x.toFixed(1)} ${y.toFixed(1)}`;
      }
      return d;
    });
    s(pathD(eqD, { stroke: ACCENT, strokeWidth: 2.5, cap: "round", join: "round" }));

    BANDS.forEach((b, j) => {
      const out = curve[`b${j}`]!;
      const bx = freqToX(b.freq);
      const handle = Vec.lens(
        out,
        (db: number) => ({ x: bx, y: dbToY(db) }),
        t => yToDb(t.y),
      ) as Writable<Vec>;
      const dot = s(circle(handle, 7, { fill: ACCENT, stroke: ACCENT }));
      drag(dot, handle);
      dot.el.style.cursor = "ns-resize";
    });

    const macro = (x: number, out: Writable<Num>, name: string): void => {
      s(line(vec(x, dbToY(FADER_DB)), vec(x, dbToY(-FADER_DB)), { thin: true, opacity: 0.25 }));
      const h = vec(Num.pin(x), out.clamp(-FADER_DB, FADER_DB).affine(-PX_PER_DB, EQ_MID));
      const dot = s(circle(h, 6.5, { fill: META, stroke: META }));
      drag(dot, h);
      dot.el.style.cursor = "ns-resize";
      s(label(vec(x, dbToY(-FADER_DB) + 14), name, { size: 9, opacity: 0.65 }));
    };
    macro(28, curve.level!, "level");
    macro(60, curve.tilt!, "tilt");

    const pill = (
      cx: number,
      text: string,
      active: () => boolean,
      enabled: () => boolean,
      onClick: () => void,
    ): void => {
      const r = s(rect(vec(cx, 16), 50, 22, { corner: 11, thin: true, stroke: tokens.stroke }));
      const lbl = s(label(vec(cx, 16), text, { size: 10 }));
      // label/rect wrap their shape in a <g>; the inner node owns the fill/stroke
      // attribute, so style it directly (a group style won't override an attr).
      const rectNode = (r.el.tagName === "rect" ? r.el : r.el.querySelector("rect")) as SVGElement;
      const textNode = (
        lbl.el.tagName === "text" ? lbl.el : lbl.el.querySelector("text")
      ) as SVGElement;
      effect(() => {
        const on = active();
        const en = enabled();
        rectNode.style.stroke = on ? ACCENT : tokens.stroke;
        textNode.style.fill = on ? ACCENT : "";
        r.el.style.opacity = en ? "1" : "0.3";
        lbl.el.style.opacity = en ? "1" : "0.4";
      });
      for (const el of [r.el, lbl.el]) {
        el.style.cursor = "pointer";
        el.style.pointerEvents = "all";
        el.addEventListener("click", onClick);
      }
    };
    const setSrc = (kind: "chord" | "music"): void => {
      if (kind === sourceKind.value) return;
      if (kind === "music") {
        if (!musicClip) return;
        source.value = musicClip;
      } else {
        source.value = chordClip;
      }
      sourceKind.value = kind;
    };
    pill(
      556,
      "chord",
      () => sourceKind.value === "chord",
      () => true,
      () => setSrc("chord"),
    );
    pill(
      610,
      "music",
      () => sourceKind.value === "music",
      () => musicReady.value,
      () => setSrc("music"),
    );

    const playing = cell(false);
    const by = H - 30;
    const btn = s(rect(vec(W / 2, by), 96, 30, { corner: 15, thin: true, stroke: tokens.stroke }));
    const btnLabel = s(
      label(
        vec(W / 2, by),
        derive(() => (playing.value ? "❚❚  pause" : "▶  play")),
      ),
    );
    const toggle = async (): Promise<void> => {
      await engine.resume();
      ensureMusic();
      if (engine.playing) engine.pause();
      else engine.play();
      playing.value = engine.playing;
    };
    for (const el of [btn.el, btnLabel.el]) {
      el.style.cursor = "pointer";
      // The outline rect has no fill, so SVG won't hit-test its interior;
      // `all` captures clicks anywhere in the pill, not just on the glyphs.
      el.style.pointerEvents = "all";
      el.addEventListener("click", toggle);
    }

    s(
      label(view.top.down(18), "drag a band — or a macro — and factor solves every band at once", {
        size: 12,
        bold: true,
      }),
    );
    s(
      label(
        vec(W / 2, by - 26),
        "level moves all bands together · tilt re-slopes them at constant loudness",
        { size: 10, opacity: 0.7 },
      ),
    );
  }
}
