import { Cell, type Read, reader, type Val } from "../cell";
import type { Pack, TraitDict } from "../traits";
import { Canvas, stamp as canvasStamp } from "./canvas";
import { Color } from "./color";
import { newTex, pass, reduceMean, type Setup, scratch, scratch2, type Tex } from "./gpu";
import { Num } from "./num";
import { Vec } from "./vec";

/** Field cell value: a GPU handle. The graph compares `epoch`. */
export interface FieldVal {
  readonly tex: WebGLTexture;
  readonly w: number;
  readonly h: number;
  readonly epoch: number;
}

let EPOCH = 0;
/** Stamp a texture with a fresh epoch — the only way to mint a value. */
const stamp = (tex: WebGLTexture, w: number, h: number): FieldVal => ({
  tex,
  w,
  h,
  epoch: ++EPOCH,
});

const equals = (a: FieldVal, b: FieldVal): boolean => a.epoch === b.epoch;

type Ctor<T> = new (...args: never[]) => Cell<T>;

/** Texel encoding: channel count, the flat-buffer codec, and the boundary
 *  cell class that reductions return. */
export interface Kind<T> {
  readonly dim: 1 | 2 | 4;
  readonly pack: Pack<T>;
  readonly cls: Ctor<T>;
}

/** Scalar field (1 channel) — heatmaps, SDFs, density, height. */
export const Scalar: Kind<number> = { dim: 1, pack: Num.traits.pack!, cls: Num };
/** Vector field (2 channels) — flow, gradient, displacement, RD chemicals. */
export const Vector: Kind<{ x: number; y: number }> = { dim: 2, pack: Vec.traits.pack!, cls: Vec };
/** Colour field (4 channels) — i.e. a Canvas. */
export const Colour: Kind<{ r: number; g: number; b: number; a: number }> = {
  dim: 4,
  pack: Color.traits.pack!,
  cls: Color,
};

const HEAD = `#version 300 es
precision highp float;
in vec2 v_uv;
out vec4 o;`;

const MASK = `${HEAD}
uniform sampler2D u_src; uniform vec2 u_res; uniform vec2 u_o; uniform vec2 u_wh;
void main() {
  vec2 px = v_uv * u_res;
  vec4 s = texture(u_src, v_uv);
  bool inside = px.x >= u_o.x && px.y >= u_o.y && px.x < u_o.x + u_wh.x && px.y < u_o.y + u_wh.y;
  o = inside ? vec4(s.rgb, 1.0) : vec4(0.0);
}`;

const SPLAT = `${HEAD}
uniform sampler2D u_src; uniform vec2 u_res; uniform vec2 u_c; uniform float u_r;
uniform vec3 u_v; uniform float u_mix;
void main() {
  vec4 s = texture(u_src, v_uv);
  float d = distance(v_uv * u_res, u_c);
  float f = clamp(exp(-(d * d) / (u_r * u_r)) * u_mix, 0.0, 1.0);
  o = vec4(mix(s.rgb, u_v, f), s.a);
}`;

/** GLSL float literal (always carries a decimal point). */
const glf = (n: number): string => (Number.isInteger(n) ? `${n}.0` : String(n));
const glv3 = (c: readonly [number, number, number]): string =>
  `${glf(c[0])}, ${glf(c[1])}, ${glf(c[2])}`;

/** A colormap stop: a field value mapped to an RGB triple (0–1). */
export type ColorStop = readonly [number, readonly [number, number, number]];

/** Build a piecewise-linear ramp shader over `channel`. */
function rampFrag(channel: number, stops: readonly ColorStop[]): string {
  const ch = "rgba"[channel] ?? "r";
  let body = `  vec3 c = vec3(${glv3(stops[0]![1])});\n`;
  for (let i = 1; i < stops.length; i++) {
    const p0 = stops[i - 1]![0];
    const [p1, col] = stops[i]!;
    body += `  c = mix(c, vec3(${glv3(col)}), smoothstep(${glf(p0)}, ${glf(p1)}, x));\n`;
  }
  return `${HEAD}
uniform sampler2D u_src;
void main() {
  float x = texture(u_src, v_uv).${ch};
${body}  o = vec4(c, 1.0);
}`;
}

/** Read-only typed view via the kind's boundary class. The cast bypasses the
 *  polymorphic `this` rejecting the abstract `Ctor<T>`; `k.cls` is concrete at
 *  runtime. */
function deriveT<T>(k: Kind<T>, parent: Read<FieldVal>, fn: (v: FieldVal) => T): Read<T> {
  const d = k.cls as unknown as {
    derive(p: Read<FieldVal>, fn: (v: FieldVal) => T): Read<T>;
  };
  return d.derive(parent, fn);
}

const TMP = new Float64Array(4);
/** Pack a reduction's `[r,g,b,a]` mean into a boundary value of kind `k`. */
function packT<T>(k: Kind<T>, m: ArrayLike<number>): T {
  TMP[0] = m[0]!;
  TMP[1] = m[1]!;
  TMP[2] = m[2]!;
  TMP[3] = m[3]!;
  return k.pack.write(TMP, 0);
}

function bindUniform(s: Setup, name: string, val: number | readonly number[]): void {
  if (typeof val === "number") s.f(name, val);
  else if (val.length === 2) s.v2(name, val[0]!, val[1]!);
  else if (val.length === 3) s.v3(name, val[0]!, val[1]!, val[2]!);
  else throw new Error(`field.evolve: uniform ${name} must be number | vec2 | vec3`);
}

const EMPTY: FieldVal = { tex: null as unknown as WebGLTexture, w: 0, h: 0, epoch: 0 };

export class Field<T> extends Cell<FieldVal> {
  static traits = { equals } satisfies TraitDict<FieldVal>;
  declare readonly _t: typeof Field.traits;

  /** Feedback-safe ping-pong pair for `evolve`/`splat`, lazily allocated. */
  private io: ((w: number, h: number, avoid: WebGLTexture | null) => Tex) | null = null;

  constructor(
    readonly kind: Kind<T>,
    v: FieldVal = EMPTY,
  ) {
    super(v, { equals });
  }

  private pingTex(): (w: number, h: number, avoid: WebGLTexture | null) => Tex {
    return (this.io ??= scratch2());
  }

  /** Step the field by `steps` GPU passes of `frag` (which samples the current
   *  field as `u_src`; `u_texel` = 1/size is provided). One value is committed
   *  after the substeps, so the reactive graph sees a single new epoch/frame. */
  evolve(frag: string, uniforms?: Record<string, number | readonly number[]>, steps = 1): void {
    const ping = this.pingTex();
    const v = this.peek();
    const w = v.w;
    const h = v.h;
    let src = v.tex;
    let last: Tex | null = null;
    const entries = uniforms ? Object.entries(uniforms) : null;
    for (let i = 0; i < steps; i++) {
      const dst = ping(w, h, src);
      pass(frag, dst, s => {
        s.tex("u_src", 0, src);
        s.v2("u_texel", 1 / w, 1 / h);
        if (entries) for (const [name, val] of entries) bindUniform(s, name, val);
      });
      src = dst.tex;
      last = dst;
    }
    if (last) (this as { value: FieldVal }).value = stamp(last.tex, w, h);
  }

  /** Stamp a Gaussian disc of `value` at data pixel `(x, y)`, radius `r`. */
  splat(x: number, y: number, r: number, value: T, strength = 1): void {
    const ping = this.pingTex();
    const v = this.peek();
    this.kind.pack.read(value, TMP, 0);
    const dst = ping(v.w, v.h, v.tex);
    pass(SPLAT, dst, s => {
      s.tex("u_src", 0, v.tex);
      s.v2("u_res", v.w, v.h);
      s.v2("u_c", x, y);
      s.f("u_r", r);
      s.v3("u_v", TMP[0]!, TMP[1]!, TMP[2]!);
      s.f("u_mix", strength);
    });
    (this as { value: FieldVal }).value = stamp(dst.tex, v.w, v.h);
  }

  /** Whole-field mean as a read-only `T` cell. Recomputes per epoch; one 1×1
   *  GPU readback. */
  mean(): Read<T> {
    const k = this.kind;
    return deriveT(k, this, v => packT(k, reduceMean({ tex: v.tex, w: v.w, h: v.h })));
  }

  /** Mean over a sub-rectangle (data pixels, reactive `box`) as a read-only
   *  `T` cell. */
  regionMean(box: Val<{ x: number; y: number; w: number; h: number }>): Read<T> {
    const k = this.kind;
    const bf = reader(box);
    const sc = scratch();
    return deriveT(k, this, v => {
      const b = bf();
      const dst = sc(v.w, v.h);
      pass(MASK, dst, s => {
        s.tex("u_src", 0, v.tex);
        s.v2("u_res", v.w, v.h);
        s.v2("u_o", b.x, b.y);
        s.v2("u_wh", b.w, b.h);
      });
      const m = reduceMean({ tex: dst.tex, w: v.w, h: v.h });
      const cov = m[3];
      if (cov < 1e-6) return packT(k, [0, 0, 0, 0]);
      return packT(k, [m[0] / cov, m[1] / cov, m[2] / cov, 1]);
    });
  }

  /** Render `channel` through a colormap to a read-only `Canvas`; re-renders
   *  per epoch. */
  colormap(channel: number, stops: readonly ColorStop[]): Canvas {
    const frag = rampFrag(channel, stops);
    const sc = scratch();
    return Canvas.derive(this as Read<FieldVal>, (v: FieldVal) => {
      const out = sc(v.w, v.h);
      pass(frag, out, s => s.tex("u_src", 0, v.tex));
      return canvasStamp(out.tex, v.w, v.h);
    });
  }
}

/** Writable `Field<T>` of size `w×h`. `painter` fills each texel (returns a
 *  `T`); omit for an all-zero field. Linear-filtered for continuous sampling. */
export function field<T>(
  kind: Kind<T>,
  w: number,
  h: number,
  painter?: (x: number, y: number) => T,
): Field<T> {
  const buf = new Float32Array(w * h * 4);
  if (painter !== undefined) {
    const t = new Float64Array(4);
    let o = 0;
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++, o += 4) {
        kind.pack.read(painter(x, y), t, 0);
        for (let c = 0; c < kind.dim; c++) buf[o + c] = t[c]!;
        if (kind.dim < 4) buf[o + 3] = 1;
      }
    }
  }
  return new Field<T>(kind, stamp(newTex(w, h, buf, true), w, h));
}
