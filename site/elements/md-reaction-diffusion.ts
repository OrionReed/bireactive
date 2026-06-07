// Reaction–diffusion on a `Field<Vec>`: a continuously-running GPU simulation
// observed through reactive reductions. The Gray–Scott PDE steps the field on
// its own raf clock (`field.evolve`); a probe rectangle's mean V is an ordinary
// derived cell (`field.regionMean`), so `density ≥ threshold` is a plain `Bool`
// the rest of the UI reacts to. The reactive logic never mentions a frame — it
// is loosely coupled to the sim's time, observing a GPU texture as it evolves.

import {
  type ColorStop,
  cell,
  derive,
  effect,
  type Field,
  field,
  type Read,
  Vector,
} from "@bireactive";
import { blit } from "./canvas-demo-util";

const W = 220;
const H = 220;
const STEPS = 6; // PDE substeps per displayed frame.

// Gray–Scott: U in .r, V in .g. 9-point Laplacian, Euler step, clamped.
const RD = `#version 300 es
precision highp float;
in vec2 v_uv;
out vec4 o;
uniform sampler2D u_src;
uniform vec2 u_texel;
uniform float u_feed, u_kill, u_du, u_dv, u_dt;
vec2 samp(vec2 d){ return texture(u_src, v_uv + d).xy; }
void main(){
  vec2 c = texture(u_src, v_uv).xy;
  vec2 lap = vec2(0.0);
  lap += samp(vec2(-u_texel.x, 0.0)) * 0.2;
  lap += samp(vec2( u_texel.x, 0.0)) * 0.2;
  lap += samp(vec2(0.0, -u_texel.y)) * 0.2;
  lap += samp(vec2(0.0,  u_texel.y)) * 0.2;
  lap += samp(vec2(-u_texel.x,-u_texel.y)) * 0.05;
  lap += samp(vec2( u_texel.x,-u_texel.y)) * 0.05;
  lap += samp(vec2(-u_texel.x, u_texel.y)) * 0.05;
  lap += samp(vec2( u_texel.x, u_texel.y)) * 0.05;
  lap -= c;
  float U = c.x, V = c.y;
  float r = U * V * V;
  float nU = U + (u_du * lap.x - r + u_feed * (1.0 - U)) * u_dt;
  float nV = V + (u_dv * lap.y + r - (u_feed + u_kill) * V) * u_dt;
  o = vec4(clamp(nU, 0.0, 1.0), clamp(nV, 0.0, 1.0), 0.0, 1.0);
}`;

// V-channel colormap: dark → teal → amber → white.
const STOPS: readonly ColorStop[] = [
  [0.0, [0.03, 0.04, 0.1]],
  [0.12, [0.1, 0.25, 0.55]],
  [0.22, [0.12, 0.75, 0.72]],
  [0.32, [0.95, 0.85, 0.3]],
  [0.45, [1.0, 1.0, 1.0]],
];

interface Preset {
  name: string;
  feed: number;
  kill: number;
}
const PRESETS: Preset[] = [
  { name: "worms", feed: 0.058, kill: 0.065 },
  { name: "spots", feed: 0.0367, kill: 0.0649 },
  { name: "maze", feed: 0.029, kill: 0.057 },
  { name: "coral", feed: 0.0545, kill: 0.062 },
  { name: "waves", feed: 0.018, kill: 0.051 },
];

// Canonical Gray–Scott: U diffuses twice as fast as V; dt = 1 with the
// folded-Laplacian kernel is the maximal stable explicit step.
const PARAMS = { du: 1.0, dv: 0.5, dt: 1.0 };

export class MdReactionDiffusion extends HTMLElement {
  static get tagName(): string {
    return "md-reaction-diffusion";
  }
  static define(): void {
    if (!customElements.get(this.tagName)) customElements.define(this.tagName, this);
  }

  private shadow: ShadowRoot;
  private disposers: Array<() => void> = [];
  private raf = 0;
  private preset = PRESETS[0]!;
  private brushV = 0.5;

  constructor() {
    super();
    this.shadow = this.attachShadow({ mode: "open" });
    const sheet = new CSSStyleSheet();
    sheet.replaceSync(`
      :host { display: block; margin: 1.25rem auto; max-width: 560px; }
      .toolbar { display: flex; gap: 10px; align-items: center; justify-content: center; flex-wrap: wrap; margin-bottom: 8px; font: 11px var(--font, system-ui); color: var(--text-color); }
      .toolbar button { font: 11px var(--font, system-ui); padding: 3px 9px; border-radius: 5px; border: 1px solid var(--text-color); background: transparent; color: var(--text-color); cursor: pointer; opacity: 0.7; }
      .toolbar button:hover { opacity: 1; }
      .toolbar button.on { opacity: 1; background: color-mix(in srgb, var(--text-color) 14%, transparent); }
      .toolbar .grp { display: inline-flex; align-items: center; gap: 6px; }
      .toolbar input[type=range] { width: 90px; accent-color: var(--text-color); }
      .frame { position: relative; width: 100%; max-width: 440px; margin: 0 auto; aspect-ratio: 1; }
      canvas { width: 100%; height: 100%; display: block; border-radius: 8px; background: #07080f; cursor: crosshair; touch-action: none; box-shadow: 0 0 0 1px #fff2; }
      .probe { position: absolute; box-sizing: border-box; border: 1.5px solid #ffffffcc; box-shadow: 0 0 0 1px #0008; border-radius: 3px; cursor: move; transition: border-color 0.12s, box-shadow 0.12s; }
      .probe.hot { border-color: #ff5b6e; box-shadow: 0 0 10px #ff5b6e, 0 0 0 1px #0008; }
      .probe .handle { position: absolute; right: -5px; bottom: -5px; width: 10px; height: 10px; background: #fff; border-radius: 50%; cursor: nwse-resize; box-shadow: 0 0 0 1px #0008; }
      .probe .tag { position: absolute; left: 0; top: -18px; font: 10px var(--font, system-ui); color: var(--text-color); white-space: nowrap; }
      .readout { display: flex; gap: 14px; align-items: center; justify-content: center; margin-top: 8px; font: 11px var(--font, system-ui); color: var(--text-color); }
      .readout .led { width: 10px; height: 10px; border-radius: 50%; background: #3a4256; box-shadow: inset 0 0 0 1px #fff3; }
      .readout .led.on { background: #ff5b6e; box-shadow: 0 0 8px #ff5b6e; }
      .readout b { font-variant-numeric: tabular-nums; }
      .hint { text-align: center; margin: 8px auto 0; max-width: 94%; font: 10px/1.5 var(--font, system-ui); color: var(--text-color); opacity: 0.5; }
    `);
    this.shadow.adoptedStyleSheets = [sheet];
  }

  connectedCallback(): void {
    const d = this.disposers;

    // One reactive node holds the whole 220×220 field. Seed U=1, V=0.
    const f = field(Vector, W, H, () => ({ x: 1, y: 0 }));
    for (let i = 0; i < 14; i++) {
      const a = (i * 2654435761) % 1000;
      const b = (i * 40503 + 137) % 1000;
      f.splat((a / 1000) * W, (b / 1000) * H, 6, { x: 0.5, y: 0.5 }, 1);
    }

    // Probe rectangle in canvas fractions; its data-space box drives the reduction.
    const probe = cell({ x: 0.34, y: 0.34, w: 0.32, h: 0.32 });
    const dataBox = derive(() => {
      const p = probe.value;
      return { x: p.x * W, y: p.y * H, w: p.w * W, h: p.h * H };
    });
    const density = f.regionMean(dataBox) as Read<{ x: number; y: number }>;
    const densityV = derive(() => density.value.y);
    const threshold = cell(0.12);
    const hot = derive(() => densityV.value >= threshold.value);

    // ── DOM ────────────────────────────────────────────────────────────
    const toolbar = document.createElement("div");
    toolbar.className = "toolbar";
    const presetBtns: HTMLButtonElement[] = [];
    const pGrp = document.createElement("div");
    pGrp.className = "grp";
    for (const ps of PRESETS) {
      const b = document.createElement("button");
      b.textContent = ps.name;
      b.classList.toggle("on", ps === this.preset);
      b.addEventListener("click", () => {
        this.preset = ps;
        for (const x of presetBtns) x.classList.toggle("on", x === b);
      });
      presetBtns.push(b);
      pGrp.append(b);
    }
    const reset = document.createElement("button");
    reset.textContent = "reset";
    reset.addEventListener("click", () => {
      // Wipe U back to 1 / V to 0 (a saturating full-field splat), then re-kick.
      f.splat(W / 2, H / 2, W * 2, { x: 1, y: 0 }, 4);
      for (let i = 0; i < 14; i++) {
        const a = (i * 2654435761) % 1000;
        const b = (i * 40503 + 137) % 1000;
        f.splat((a / 1000) * W, (b / 1000) * H, 6, { x: 0.5, y: 0.5 }, 1);
      }
    });
    const tGrp = document.createElement("div");
    tGrp.className = "grp";
    const tLabel = document.createElement("span");
    tLabel.textContent = "threshold";
    const tInput = document.createElement("input");
    tInput.type = "range";
    tInput.min = "0";
    tInput.max = "0.4";
    tInput.step = "0.005";
    tInput.value = String(threshold.peek());
    tInput.addEventListener("input", () => {
      threshold.value = Number(tInput.value);
    });
    tGrp.append(tLabel, tInput);
    toolbar.append(pGrp, reset, tGrp);

    const frame = document.createElement("div");
    frame.className = "frame";
    const cv = document.createElement("canvas");
    const ctx = cv.getContext("2d", { alpha: false })!;
    const probeEl = document.createElement("div");
    probeEl.className = "probe";
    const handle = document.createElement("div");
    handle.className = "handle";
    const tag = document.createElement("div");
    tag.className = "tag";
    probeEl.append(handle, tag);
    frame.append(cv, probeEl);

    const readout = document.createElement("div");
    readout.className = "readout";
    const led = document.createElement("div");
    led.className = "led";
    const dText = document.createElement("span");
    const cText = document.createElement("span");
    readout.append(led, dText, cText);

    const hint = document.createElement("div");
    hint.className = "hint";
    hint.textContent =
      "Gray–Scott reaction–diffusion stepping on the GPU each frame. Drag/resize the probe; its mean concentration is a reactive cell, so the alarm, count, and readout react to a continuously-running simulation without any of them knowing a frame exists. Paint to inject.";

    this.shadow.append(toolbar, frame, readout, hint);

    // ── reactive edges (the bridge) ────────────────────────────────────
    const cmap = f.colormap(1, STOPS);
    d.push(effect(() => blit(cmap.value, ctx)));
    d.push(
      effect(() => {
        const v = densityV.value;
        dText.innerHTML = `region density <b>${(v * 100).toFixed(1)}%</b>`;
      }),
    );
    let crossings = 0;
    let was = false;
    d.push(
      effect(() => {
        const h = hot.value;
        led.classList.toggle("on", h);
        probeEl.classList.toggle("hot", h);
        tag.textContent = h ? "● above threshold" : "";
        if (h && !was) crossings++;
        was = h;
        cText.innerHTML = `crossings <b>${crossings}</b>`;
      }),
    );
    d.push(
      effect(() => {
        const p = probe.value;
        probeEl.style.left = `${p.x * 100}%`;
        probeEl.style.top = `${p.y * 100}%`;
        probeEl.style.width = `${p.w * 100}%`;
        probeEl.style.height = `${p.h * 100}%`;
      }),
    );

    this.bindProbe(probeEl, handle, probe);
    this.bindPaint(cv, f);

    // ── the sim clock (loosely coupled to all of the above) ────────────
    const tick = (): void => {
      f.evolve(
        RD,
        {
          u_feed: this.preset.feed,
          u_kill: this.preset.kill,
          u_du: PARAMS.du,
          u_dv: PARAMS.dv,
          u_dt: PARAMS.dt,
        },
        STEPS,
      );
      this.raf = requestAnimationFrame(tick);
    };
    this.raf = requestAnimationFrame(tick);
  }

  /** Drag-to-move / handle-to-resize the probe (fractions, clamped). */
  private bindProbe(
    el: HTMLElement,
    handle: HTMLElement,
    probe: {
      value: { x: number; y: number; w: number; h: number };
      peek(): { x: number; y: number; w: number; h: number };
    },
  ): void {
    const frame = el.parentElement!;
    let mode: "move" | "size" | null = null;
    let px = 0;
    let py = 0;
    const start =
      (m: "move" | "size") =>
      (e: PointerEvent): void => {
        mode = m;
        px = e.clientX;
        py = e.clientY;
        e.stopPropagation();
        e.preventDefault();
        try {
          (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
        } catch {}
      };
    const move = (e: PointerEvent): void => {
      if (!mode) return;
      const r = frame.getBoundingClientRect();
      const dx = (e.clientX - px) / r.width;
      const dy = (e.clientY - py) / r.height;
      px = e.clientX;
      py = e.clientY;
      const b = probe.peek();
      if (mode === "move") {
        probe.value = {
          ...b,
          x: Math.max(0, Math.min(1 - b.w, b.x + dx)),
          y: Math.max(0, Math.min(1 - b.h, b.y + dy)),
        };
      } else {
        probe.value = {
          ...b,
          w: Math.max(0.06, Math.min(1 - b.x, b.w + dx)),
          h: Math.max(0.06, Math.min(1 - b.y, b.h + dy)),
        };
      }
    };
    const end = (): void => {
      mode = null;
    };
    el.addEventListener("pointerdown", start("move"));
    handle.addEventListener("pointerdown", start("size"));
    el.addEventListener("pointermove", move);
    handle.addEventListener("pointermove", move);
    el.addEventListener("pointerup", end);
    handle.addEventListener("pointerup", end);
    this.disposers.push(() => {
      el.removeEventListener("pointermove", move);
      handle.removeEventListener("pointermove", move);
    });
  }

  /** Inject V (and lower U) under the pointer — paint reaction seeds. */
  private bindPaint(cv: HTMLCanvasElement, f: Field<{ x: number; y: number }>): void {
    let drawing = false;
    const at = (e: PointerEvent): [number, number] => {
      const r = cv.getBoundingClientRect();
      return [((e.clientX - r.left) / r.width) * W, ((e.clientY - r.top) / r.height) * H];
    };
    const stroke = (e: PointerEvent): void => {
      const [x, y] = at(e);
      f.splat(x, y, 7, { x: 0.3, y: this.brushV }, 0.9);
    };
    const down = (e: PointerEvent): void => {
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

  disconnectedCallback(): void {
    if (this.raf) cancelAnimationFrame(this.raf);
    this.raf = 0;
    for (const x of this.disposers) x();
    this.disposers = [];
  }
}
