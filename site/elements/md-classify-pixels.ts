// Draw on a tiny grid; a net trained on an endless stream of procedurally
// generated shapes says "circle or not" live as you draw. The training data
// problem is solved by the generator — the label is whatever it drew — which
// ties proc-gen (the data engine) to learning. Training is user-invoked
// (Train toggle); drawing and "dream" are the only other per-frame work.
//
// "Dream" runs the net backward: gradient-ascend the input pixels toward a
// class. That's the lens' backward leg doing inference-time inversion — paint
// the prototype the net most associates with "circle".

import { cell, effect } from "@bireactive";
import {
  accuracy,
  inputGradient,
  type MLP,
  mlp,
  predict,
  rasterShape,
  rng,
  type Sample,
  type ShapeKind,
  shapeBatch,
  trainStep,
} from "@bireactive/learn";

const G = 12; // grid is G×G
const N = G * G;
const SIZE = 252; // draw canvas px
const BATCH = 64;

export class MdClassifyPixels extends HTMLElement {
  static get tagName(): string {
    return "md-classify-pixels";
  }
  static define(): void {
    if (!customElements.get(this.tagName)) customElements.define(this.tagName, this);
  }

  private shadow: ShadowRoot;
  private disposers: Array<() => void> = [];
  private raf = 0;
  private dreamRaf = 0;
  private seed = 1;

  private net!: MLP;
  private grid = new Float64Array(N);
  private trainRng: () => number = rng(1);
  private testSet: Sample[] = [];

  private ctx!: CanvasRenderingContext2D;
  private examplesEl!: HTMLElement;

  private epoch = cell(0);
  private testAcc = cell(0);
  private prob = cell(0.5);
  private training = cell(false);

  constructor() {
    super();
    this.shadow = this.attachShadow({ mode: "open" });
    const sheet = new CSSStyleSheet();
    sheet.replaceSync(STYLE);
    this.shadow.adoptedStyleSheets = [sheet];
  }

  connectedCallback(): void {
    this.buildDom();
    this.reset();
  }

  disconnectedCallback(): void {
    this.stop();
    if (this.dreamRaf) cancelAnimationFrame(this.dreamRaf);
    for (const d of this.disposers) d();
    this.disposers = [];
  }

  private buildDom(): void {
    const toolbar = document.createElement("div");
    toolbar.className = "toolbar";
    const train = document.createElement("button");
    train.addEventListener("click", () => (this.training.value ? this.stop() : this.start()));
    const reset = document.createElement("button");
    reset.textContent = "reset net";
    reset.addEventListener("click", () => {
      this.seed++;
      this.reset();
    });
    const clear = document.createElement("button");
    clear.textContent = "clear";
    clear.addEventListener("click", () => {
      this.stopDream();
      this.grid.fill(0);
      this.renderDraw();
      this.predictNow();
    });
    const dreamC = document.createElement("button");
    dreamC.textContent = "dream ◯";
    dreamC.addEventListener("click", () => this.dream(1));
    const dreamN = document.createElement("button");
    dreamN.textContent = "dream ▢";
    dreamN.addEventListener("click", () => this.dream(0));
    toolbar.append(train, reset, clear, dreamC, dreamN);

    const stage = document.createElement("div");
    stage.className = "stage";
    const cv = document.createElement("canvas");
    cv.className = "draw";
    cv.width = G;
    cv.height = G;
    this.ctx = cv.getContext("2d")!;

    const panel = document.createElement("div");
    panel.className = "panel";
    const verdict = document.createElement("div");
    verdict.className = "verdict";
    const bar = document.createElement("div");
    bar.className = "bar";
    const fill = document.createElement("i");
    bar.append(fill);
    const scale = document.createElement("div");
    scale.className = "scale";
    scale.innerHTML = "<span>▢ not</span><span>◯ circle</span>";
    panel.append(verdict, bar, scale);
    stage.append(cv, panel);

    this.examplesEl = document.createElement("div");
    this.examplesEl.className = "examples";

    const readout = document.createElement("div");
    readout.className = "readout";

    const hint = document.createElement("div");
    hint.className = "hint";
    hint.innerHTML =
      `Draw a shape on the ${G}×${G} grid; the bar is the net's live P(circle). ` +
      "Press <b>train</b> to learn from an endless stream of generated shapes (samples shown below). " +
      "<b>dream</b> runs the net backward — ascending the pixels toward a class.";

    this.shadow.replaceChildren(toolbar, stage, this.examplesEl, readout, hint);
    this.bindPaint(cv);

    this.disposers.push(
      effect(() => {
        const p = this.prob.value;
        fill.style.width = `${(p * 100).toFixed(1)}%`;
        verdict.innerHTML =
          p >= 0.5
            ? `<b>circle</b> · ${(p * 100).toFixed(0)}%`
            : `<b>not circle</b> · ${((1 - p) * 100).toFixed(0)}%`;
      }),
    );
    this.disposers.push(
      effect(() => {
        readout.innerHTML = `batches trained <b>${this.epoch.value}</b> · test accuracy <b>${(this.testAcc.value * 100).toFixed(0)}%</b>`;
      }),
    );
    this.disposers.push(
      effect(() => {
        train.textContent = this.training.value ? "⏸ pause" : "▶ train";
        train.classList.toggle("on", this.training.value);
      }),
    );
  }

  private reset(): void {
    this.stop();
    this.stopDream();
    this.net = mlp([N, 24, 1], { seed: this.seed, hidden: "tanh", lr: 0.01 });
    this.trainRng = rng(1000 + this.seed);
    this.testSet = shapeBatch(G, 300, rng(7));
    this.epoch.value = 0;
    this.testAcc.value = accuracy(this.net, this.testSet);
    this.renderExamples();
    this.renderDraw();
    this.predictNow();
  }

  private start(): void {
    if (this.raf) return;
    this.stopDream();
    this.training.value = true;
    let n = 0;
    const tick = (): void => {
      for (let i = 0; i < 4; i++) trainStep(this.net, shapeBatch(G, BATCH, this.trainRng));
      this.epoch.value = this.epoch.peek() + 4;
      if (++n % 4 === 0) this.testAcc.value = accuracy(this.net, this.testSet);
      this.predictNow();
      this.raf = requestAnimationFrame(tick);
    };
    this.raf = requestAnimationFrame(tick);
  }

  private stop(): void {
    if (this.raf) cancelAnimationFrame(this.raf);
    this.raf = 0;
    if (this.training.peek()) {
      this.training.value = false;
      this.testAcc.value = accuracy(this.net, this.testSet);
    }
  }

  private stopDream(): void {
    if (this.dreamRaf) cancelAnimationFrame(this.dreamRaf);
    this.dreamRaf = 0;
  }

  // Inference-time inversion: carve the input pixels toward a class by
  // gradient ascent (cls=1, circle) or descent (cls=0) on the circle logit.
  // Starts from noise and regularises each step (gradient normalisation +
  // mild decay + periodic blur) so it paints a coherent prototype rather than
  // an adversarial blob. A finite, user-invoked animation.
  private dream(cls: number): void {
    this.stop();
    this.stopDream();
    for (let i = 0; i < N; i++) this.grid[i] = 0.15 + Math.random() * 0.1;
    const dir = cls === 1 ? 1 : -1;
    let step = 0;
    const run = (): void => {
      const g = inputGradient(this.net, this.grid, 0);
      const k = rms(g);
      for (let i = 0; i < N; i++) this.grid[i] = clamp01(this.grid[i]! * 0.9 + (dir * 0.18 * g[i]!) / k);
      if (step % 3 === 2) blurInto(this.grid);
      this.renderDraw();
      this.predictNow();
      if (++step < 80) this.dreamRaf = requestAnimationFrame(run);
      else this.dreamRaf = 0;
    };
    this.dreamRaf = requestAnimationFrame(run);
  }

  private predictNow(): void {
    this.prob.value = predict(this.net, this.grid)[0]!;
  }

  private renderDraw(): void {
    paintGrid(this.ctx, this.grid);
  }

  private renderExamples(): void {
    const r = rng(2024 + this.seed);
    this.examplesEl.replaceChildren();
    const kinds: ShapeKind[] = ["circle", "square", "triangle"];
    for (let i = 0; i < 8; i++) {
      const kind = kinds[Math.floor(r() * 3)]!;
      const pose = {
        cx: 0.5 + (r() - 0.5) * 0.16,
        cy: 0.5 + (r() - 0.5) * 0.16,
        r: 0.26 + r() * 0.12,
        rot: r() * Math.PI * 2,
      };
      const buf = rasterShape(kind, G, pose);
      const c = document.createElement("canvas");
      c.width = G;
      c.height = G;
      c.style.setProperty("--ex", kind === "circle" ? "#5fd07a" : "#d2a24a");
      paintGrid(c.getContext("2d")!, buf);
      this.examplesEl.append(c);
    }
  }

  private bindPaint(cv: HTMLCanvasElement): void {
    let drawing = false;
    const at = (e: PointerEvent): [number, number] => {
      const r = cv.getBoundingClientRect();
      return [
        Math.floor(((e.clientX - r.left) / r.width) * G),
        Math.floor(((e.clientY - r.top) / r.height) * G),
      ];
    };
    const stamp = (gx: number, gy: number): void => {
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const x = gx + dx;
          const y = gy + dy;
          if (x < 0 || y < 0 || x >= G || y >= G) continue;
          const w = dx === 0 && dy === 0 ? 0.9 : 0.34;
          this.grid[y * G + x] = clamp01(this.grid[y * G + x]! + w);
        }
      }
    };
    const stroke = (e: PointerEvent): void => {
      const [gx, gy] = at(e);
      stamp(gx, gy);
      this.renderDraw();
      this.predictNow();
    };
    const down = (e: PointerEvent): void => {
      this.stopDream();
      drawing = true;
      try {
        cv.setPointerCapture(e.pointerId);
      } catch {}
      stroke(e);
    };
    const move = (e: PointerEvent): void => {
      if (drawing) stroke(e);
    };
    const up = (): void => {
      drawing = false;
    };
    cv.addEventListener("pointerdown", down);
    cv.addEventListener("pointermove", move);
    cv.addEventListener("pointerup", up);
    cv.addEventListener("pointercancel", up);
    this.disposers.push(() => {
      cv.removeEventListener("pointerdown", down);
      cv.removeEventListener("pointermove", move);
      cv.removeEventListener("pointerup", up);
      cv.removeEventListener("pointercancel", up);
    });
  }
}

// Render a G×G coverage buffer into a context's ImageData (dark → ink).
function paintGrid(ctx: CanvasRenderingContext2D, buf: Float64Array): void {
  const img = ctx.createImageData(G, G);
  for (let i = 0; i < N; i++) {
    const v = buf[i]!;
    img.data[i * 4] = 11 + v * 230;
    img.data[i * 4 + 1] = 13 + v * 224;
    img.data[i * 4 + 2] = 20 + v * 215;
    img.data[i * 4 + 3] = 255;
  }
  ctx.putImageData(img, 0, 0);
}

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

function rms(g: Float64Array): number {
  let s = 0;
  for (const v of g) s += v * v;
  return Math.sqrt(s / g.length) || 1;
}

// In-place 3×3 box blur — keeps the dream's strokes coherent.
function blurInto(buf: Float64Array): void {
  const src = buf.slice();
  for (let y = 0; y < G; y++) {
    for (let x = 0; x < G; x++) {
      let s = 0;
      let c = 0;
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const nx = x + dx;
          const ny = y + dy;
          if (nx < 0 || ny < 0 || nx >= G || ny >= G) continue;
          s += src[ny * G + nx]!;
          c++;
        }
      }
      buf[y * G + x] = s / c;
    }
  }
}

const STYLE = `
  :host { display: block; margin: 1.25rem auto; max-width: 520px; }
  .toolbar { display: flex; gap: 8px; align-items: center; justify-content: center; flex-wrap: wrap; margin-bottom: 8px; font: 11px var(--font, system-ui); color: var(--text-color); }
  .toolbar button { font: 11px var(--font, system-ui); padding: 3px 9px; border-radius: 5px; border: 1px solid var(--text-color); background: transparent; color: var(--text-color); cursor: pointer; opacity: 0.7; }
  .toolbar button:hover { opacity: 1; }
  .toolbar button.on { opacity: 1; background: color-mix(in srgb, var(--text-color) 14%, transparent); }
  .stage { display: flex; gap: 16px; align-items: center; justify-content: center; flex-wrap: wrap; }
  canvas.draw { width: ${SIZE}px; height: ${SIZE}px; display: block; border-radius: 8px; background: #0b0d14; cursor: crosshair; touch-action: none; box-shadow: 0 0 0 1px #fff2; image-rendering: pixelated; }
  .panel { display: flex; flex-direction: column; gap: 10px; min-width: 150px; }
  .verdict { font: 13px var(--font, system-ui); color: var(--text-color); text-align: center; }
  .verdict b { font-size: 15px; }
  .bar { position: relative; height: 14px; border-radius: 7px; background: #2a3142; overflow: hidden; box-shadow: inset 0 0 0 1px #fff2; }
  .bar > i { position: absolute; left: 0; top: 0; bottom: 0; background: linear-gradient(90deg, #4a82d2, #5fd07a); }
  .scale { display: flex; justify-content: space-between; font: 9px var(--font, system-ui); color: var(--text-color); opacity: 0.6; }
  .examples { display: grid; grid-template-columns: repeat(8, 1fr); gap: 3px; margin: 10px auto 0; max-width: ${SIZE + 180}px; }
  .examples canvas { width: 100%; aspect-ratio: 1; image-rendering: pixelated; border-radius: 3px; box-shadow: 0 0 0 1.5px var(--ex, #4a82d2); }
  .readout { text-align: center; margin-top: 8px; font: 11px var(--font, system-ui); color: var(--text-color); }
  .readout b { font-variant-numeric: tabular-nums; }
  .hint { text-align: center; margin: 8px auto 0; max-width: 96%; font: 10px/1.5 var(--font, system-ui); color: var(--text-color); opacity: 0.55; }
`;
