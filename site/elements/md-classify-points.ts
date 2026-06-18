// A 2D classifier you can watch learn: the background is the network's
// predicted class probability over the whole plane, so the decision boundary
// *forms* as you train. Held-out test points (ringed) show generalisation;
// drag/add/flip points and re-train to see it adapt. Training is user-invoked
// (Train toggle / Step) — nothing runs on a clock unless you ask.
//
// The net itself is the plain `@bireactive/learn` MLP (a pipe of parametric
// lenses); the reactive layer here is the metrics — `epoch`, `loss`,
// `trainAcc`, `testAcc` are cells the readout observes via `effect`.

import { cell, effect } from "@bireactive";
import {
  accuracy,
  type MLP,
  meanLoss,
  mlp,
  type PointsKind,
  points,
  predict,
  type Sample,
  trainStep,
} from "@bireactive/learn";

interface Pt {
  x: number;
  y: number;
  label: number;
  test: boolean;
}

const SIZE = 440; // display canvas px (square)
const GR = 80; // heat-field resolution
const R = 2.0; // plane half-extent: view is [-R, R]²
const C0: [number, number, number] = [74, 130, 210]; // class 0 (blue)
const C1: [number, number, number] = [226, 92, 92]; // class 1 (red)

const DATASETS: PointsKind[] = ["moons", "circles", "xor", "spirals"];

export class MdClassifyPoints extends HTMLElement {
  static get tagName(): string {
    return "md-classify-points";
  }
  static define(): void {
    if (!customElements.get(this.tagName)) customElements.define(this.tagName, this);
  }

  private shadow: ShadowRoot;
  private disposers: Array<() => void> = [];
  private raf = 0;

  private net!: MLP;
  private data: Pt[] = [];
  private kind: PointsKind = "moons";
  private seed = 1;
  private addClass = 0;

  private ctx!: CanvasRenderingContext2D;
  private heat!: CanvasRenderingContext2D; // offscreen GR×GR
  private heatImg!: ImageData;

  // Reactive metrics the readout observes.
  private epoch = cell(0);
  private loss = cell(0);
  private trainAcc = cell(0);
  private testAcc = cell(0);
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
    this.reset(false);
  }

  disconnectedCallback(): void {
    this.stop();
    for (const d of this.disposers) d();
    this.disposers = [];
  }

  private buildDom(): void {
    const toolbar = document.createElement("div");
    toolbar.className = "toolbar";

    // Dataset picker.
    const dsSeg = document.createElement("div");
    dsSeg.className = "seg";
    const dsBtns: HTMLButtonElement[] = [];
    for (const k of DATASETS) {
      const b = document.createElement("button");
      b.textContent = k;
      b.classList.toggle("on", k === this.kind);
      b.addEventListener("click", () => {
        this.kind = k;
        for (const x of dsBtns) x.classList.toggle("on", x.textContent === k);
        this.reset(true);
      });
      dsBtns.push(b);
      dsSeg.append(b);
    }

    const train = document.createElement("button");
    const syncTrain = (): void => {
      train.textContent = this.training.peek() ? "⏸ pause" : "▶ train";
      train.classList.toggle("on", this.training.peek());
    };
    train.addEventListener("click", () => (this.training.value ? this.stop() : this.start()));

    const step = document.createElement("button");
    step.textContent = "step ×20";
    step.addEventListener("click", () => {
      this.stop();
      this.steps(20);
    });

    const reset = document.createElement("button");
    reset.textContent = "reset";
    reset.addEventListener("click", () => {
      this.seed++;
      this.reset(true);
    });

    // Add-as class toggle.
    const addSeg = document.createElement("div");
    addSeg.className = "seg";
    const addA = document.createElement("button");
    addA.innerHTML = "add <span class='dotA'></span>";
    const addB = document.createElement("button");
    addB.innerHTML = "add <span class='dotB'></span>";
    const syncAdd = (): void => {
      addA.classList.toggle("on", this.addClass === 0);
      addB.classList.toggle("on", this.addClass === 1);
    };
    addA.addEventListener("click", () => {
      this.addClass = 0;
      syncAdd();
    });
    addB.addEventListener("click", () => {
      this.addClass = 1;
      syncAdd();
    });
    syncAdd();

    toolbar.append(dsSeg, train, step, reset, addSeg);
    addSeg.append(addA, addB);

    const frame = document.createElement("div");
    frame.className = "frame";
    const cv = document.createElement("canvas");
    cv.width = SIZE;
    cv.height = SIZE;
    frame.append(cv);
    this.ctx = cv.getContext("2d", { alpha: false })!;

    const off = document.createElement("canvas");
    off.width = GR;
    off.height = GR;
    this.heat = off.getContext("2d")!;
    this.heatImg = this.heat.createImageData(GR, GR);

    const readout = document.createElement("div");
    readout.className = "readout";
    const text = document.createElement("span");
    readout.append(text);

    const hint = document.createElement("div");
    hint.className = "hint";
    hint.innerHTML =
      "Background = predicted P(class) over the plane; the boundary forms as it trains. " +
      "Click empty space to add a point, drag to move, click a point to flip its label, right-click to remove. " +
      "Ringed points are held-out test data (green = correct, red = wrong).";

    this.shadow.replaceChildren(toolbar, frame, readout, hint);

    this.bindPointer(cv);

    // Reactive readout — observes the metric cells, not a frame loop.
    this.disposers.push(
      effect(() => {
        text.innerHTML =
          `epoch <b>${this.epoch.value}</b> · loss <b>${this.loss.value.toFixed(3)}</b> · ` +
          `train <b>${(this.trainAcc.value * 100).toFixed(0)}%</b> · ` +
          `test <b>${(this.testAcc.value * 100).toFixed(0)}%</b>`;
      }),
    );
    this.disposers.push(effect(() => syncTrain()));
  }

  // Plane → canvas and back.
  private toCanvas(px: number, py: number): [number, number] {
    return [((px + R) / (2 * R)) * SIZE, ((py + R) / (2 * R)) * SIZE];
  }
  private toPlane(sx: number, sy: number): [number, number] {
    return [(sx / SIZE) * 2 * R - R, (sy / SIZE) * 2 * R - R];
  }

  private reset(regen: boolean): void {
    this.stop();
    this.net = mlp([2, 16, 16, 1], { seed: this.seed, hidden: "tanh", lr: 0.03 });
    if (regen || this.data.length === 0) {
      const raw: Sample[] = points(this.kind, 180, { seed: 5, noise: undefined });
      this.data = raw.map((s, i) => {
        const xs = s.x as number[];
        return { x: xs[0]!, y: xs[1]!, label: s.y, test: i % 4 === 0 };
      });
    }
    this.epoch.value = 0;
    this.refreshMetrics();
    this.render();
  }

  private start(): void {
    if (this.raf) return;
    this.training.value = true;
    const tick = (): void => {
      this.steps(3, false);
      this.render();
      this.raf = requestAnimationFrame(tick);
    };
    this.raf = requestAnimationFrame(tick);
  }

  private stop(): void {
    if (this.raf) cancelAnimationFrame(this.raf);
    this.raf = 0;
    if (this.training.peek()) this.training.value = false;
  }

  // Run `n` gradient steps on the training split; refresh metrics + render
  // once unless told otherwise (the live loop renders itself).
  private steps(n: number, draw = true): void {
    const train = this.data.filter(p => !p.test).map(toSample);
    if (train.length === 0) return;
    for (let i = 0; i < n; i++) trainStep(this.net, train);
    this.epoch.value = this.epoch.peek() + n;
    this.refreshMetrics();
    if (draw) this.render();
  }

  private refreshMetrics(): void {
    const train = this.data.filter(p => !p.test).map(toSample);
    const test = this.data.filter(p => p.test).map(toSample);
    this.loss.value = train.length ? meanLoss(this.net, train) : 0;
    this.trainAcc.value = accuracy(this.net, train);
    this.testAcc.value = test.length ? accuracy(this.net, test) : 0;
  }

  private render(): void {
    // Heat field: evaluate the net on a GR×GR grid → ImageData → upscale.
    const d = this.heatImg.data;
    for (let gy = 0; gy < GR; gy++) {
      const py = ((gy + 0.5) / GR) * 2 * R - R;
      for (let gx = 0; gx < GR; gx++) {
        const px = ((gx + 0.5) / GR) * 2 * R - R;
        const p = predict(this.net, [px, py])[0]!;
        const idx = (gy * GR + gx) * 4;
        // Lerp blue→red by P(class 1); darken the margin band into a boundary.
        const margin = 1 - Math.exp(-((p - 0.5) * (p - 0.5)) / 0.01);
        d[idx] = lerp(C0[0], C1[0], p) * (0.35 + 0.65 * margin);
        d[idx + 1] = lerp(C0[1], C1[1], p) * (0.35 + 0.65 * margin);
        d[idx + 2] = lerp(C0[2], C1[2], p) * (0.35 + 0.65 * margin);
        d[idx + 3] = 255;
      }
    }
    this.heat.putImageData(this.heatImg, 0, 0);

    const ctx = this.ctx;
    ctx.imageSmoothingEnabled = true;
    ctx.drawImage(this.heat.canvas, 0, 0, SIZE, SIZE);

    // Points overlay.
    for (const p of this.data) {
      const [sx, sy] = this.toCanvas(p.x, p.y);
      const col = p.label === 0 ? C0 : C1;
      ctx.beginPath();
      ctx.arc(sx, sy, p.test ? 5.5 : 5, 0, Math.PI * 2);
      ctx.fillStyle = `rgb(${col[0]},${col[1]},${col[2]})`;
      ctx.fill();
      ctx.lineWidth = 2;
      if (p.test) {
        const ok = (predict(this.net, [p.x, p.y])[0]! >= 0.5 ? 1 : 0) === p.label;
        ctx.strokeStyle = ok ? "#5fd07a" : "#ff5b6e";
        ctx.lineWidth = 2.5;
        ctx.beginPath();
        ctx.arc(sx, sy, 8.5, 0, Math.PI * 2);
        ctx.stroke();
      } else {
        ctx.strokeStyle = "rgba(0,0,0,0.45)";
        ctx.beginPath();
        ctx.arc(sx, sy, 5, 0, Math.PI * 2);
        ctx.stroke();
      }
    }
  }

  private bindPointer(cv: HTMLCanvasElement): void {
    let dragging: Pt | null = null;
    let downAt: [number, number] | null = null;
    let moved = false;
    const at = (e: PointerEvent): [number, number] => {
      const r = cv.getBoundingClientRect();
      return [((e.clientX - r.left) / r.width) * SIZE, ((e.clientY - r.top) / r.height) * SIZE];
    };
    const hit = (sx: number, sy: number): Pt | null => {
      for (const p of this.data) {
        const [cx, cy] = this.toCanvas(p.x, p.y);
        if ((cx - sx) ** 2 + (cy - sy) ** 2 <= 100) return p;
      }
      return null;
    };
    const down = (e: PointerEvent): void => {
      if (e.button === 2) return;
      const [sx, sy] = at(e);
      downAt = [sx, sy];
      moved = false;
      dragging = hit(sx, sy);
      if (!dragging) {
        const [px, py] = this.toPlane(sx, sy);
        this.data.push({ x: px, y: py, label: this.addClass, test: false });
        this.refreshMetrics();
        this.render();
      }
      try {
        cv.setPointerCapture(e.pointerId);
      } catch {}
    };
    const move = (e: PointerEvent): void => {
      if (!dragging || !downAt) return;
      const [sx, sy] = at(e);
      if ((sx - downAt[0]) ** 2 + (sy - downAt[1]) ** 2 > 9) moved = true;
      const [px, py] = this.toPlane(sx, sy);
      dragging.x = px;
      dragging.y = py;
      this.refreshMetrics();
      this.render();
    };
    const up = (): void => {
      if (dragging && !moved) {
        dragging.label = dragging.label === 0 ? 1 : 0; // click = flip label
        this.refreshMetrics();
        this.render();
      }
      dragging = null;
      downAt = null;
    };
    const ctx = (e: MouseEvent): void => {
      e.preventDefault();
      const [sx, sy] = at(e as unknown as PointerEvent);
      const p = hit(sx, sy);
      if (p) {
        this.data.splice(this.data.indexOf(p), 1);
        this.refreshMetrics();
        this.render();
      }
    };
    cv.addEventListener("pointerdown", down);
    cv.addEventListener("pointermove", move);
    cv.addEventListener("pointerup", up);
    cv.addEventListener("contextmenu", ctx);
    this.disposers.push(() => {
      cv.removeEventListener("pointerdown", down);
      cv.removeEventListener("pointermove", move);
      cv.removeEventListener("pointerup", up);
      cv.removeEventListener("contextmenu", ctx);
    });
  }
}

function toSample(p: Pt): Sample {
  return { x: [p.x, p.y], y: p.label };
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

const STYLE = `
  :host { display: block; margin: 1.25rem auto; max-width: 520px; }
  .toolbar { display: flex; gap: 8px; align-items: center; justify-content: center; flex-wrap: wrap; margin-bottom: 8px; font: 11px var(--font, system-ui); color: var(--text-color); }
  .toolbar button, .seg button { font: 11px var(--font, system-ui); padding: 3px 9px; border-radius: 5px; border: 1px solid var(--text-color); background: transparent; color: var(--text-color); cursor: pointer; opacity: 0.7; }
  .toolbar button:hover { opacity: 1; }
  .toolbar button.on { opacity: 1; background: color-mix(in srgb, var(--text-color) 14%, transparent); }
  .seg { display: inline-flex; gap: 0; }
  .seg button { border-radius: 0; border-right-width: 0; }
  .seg button:first-child { border-radius: 5px 0 0 5px; }
  .seg button:last-child { border-radius: 0 5px 5px 0; border-right-width: 1px; }
  .frame { position: relative; width: 100%; max-width: ${SIZE}px; margin: 0 auto; aspect-ratio: 1; }
  canvas { width: 100%; height: 100%; display: block; border-radius: 8px; background: #0b0d14; cursor: crosshair; touch-action: none; box-shadow: 0 0 0 1px #fff2; }
  .readout { display: flex; gap: 14px; align-items: center; justify-content: center; margin-top: 8px; font: 11px var(--font, system-ui); color: var(--text-color); }
  .readout b { font-variant-numeric: tabular-nums; }
  .dotA, .dotB { display: inline-block; width: 9px; height: 9px; border-radius: 50%; vertical-align: -1px; }
  .dotA { background: rgb(${C0.join(",")}); }
  .dotB { background: rgb(${C1.join(",")}); }
  .hint { text-align: center; margin: 8px auto 0; max-width: 96%; font: 10px/1.5 var(--font, system-ui); color: var(--text-color); opacity: 0.55; }
`;
