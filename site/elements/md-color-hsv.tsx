/** @jsxImportSource @bireactive */
// RGB ⇌ HSV picker as one bidirectional graph. Three cells hold hue/saturation/
// value in their *home* scales (h ∈ [0, 360], s, v ∈ [0, 100]); a single
// object-keyed lens derives RGB in [0, 255] forward (hsvToRgb) and inverts it
// backward (rgbToHsv). `fields(rgb)` exposes the writable r/g/b channels, the
// hex input is a parse/print lens, and every control is a `lens=` terminal on
// the one graph — no per-control event/effect wiring, no value↔display scaling.
//
// HSV is degenerate where RGB is achromatic: hue is undefined at grey,
// saturation at black. The backward omits those keys (≡ SKIP) so the stored
// hue/saturation survive a round-trip through grey/black.

import { type Cell, cell, fields, lens, type Writable } from "@bireactive";
import { css } from "./base-element";

/** RGB (each [0, 255]) → HSV (h ∈ [0, 360], s, v ∈ [0, 100]). */
function rgbToHsv(r: number, g: number, b: number) {
  r /= 255;
  g /= 255;
  b /= 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const d = max - min;
  let h = 0;
  if (d !== 0) {
    if (max === r) h = ((g - b) / d) % 6;
    else if (max === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    h = (h * 60 + 360) % 360;
  }
  return { h, s: max === 0 ? 0 : (d / max) * 100, v: max * 100 };
}

/** HSV (h ∈ [0, 360], s, v ∈ [0, 100]) → RGB (each [0, 255]). */
function hsvToRgb(h: number, s: number, v: number) {
  s /= 100;
  v /= 100;
  const hh = (((h % 360) + 360) % 360) / 60;
  const c = v * s;
  const x = c * (1 - Math.abs((hh % 2) - 1));
  const m = v - c;
  const [r, g, b] =
    hh < 1
      ? [c, x, 0]
      : hh < 2
        ? [x, c, 0]
        : hh < 3
          ? [0, c, x]
          : hh < 4
            ? [0, x, c]
            : hh < 5
              ? [x, 0, c]
              : [c, 0, x];
  return { r: (r + m) * 255, g: (g + m) * 255, b: (b + m) * 255 };
}

type Rgb = { r: number; g: number; b: number };

const hx = (n: number) => Math.round(n).toString(16).padStart(2, "0");
const toHex = ({ r, g, b }: Rgb) => `#${hx(r)}${hx(g)}${hx(b)}`;

/** Parse `#rrggbb` (hash optional) to RGB, or `null` if not a complete hex. */
function parseHex(text: string): Rgb | null {
  const m = /^#?([0-9a-fA-F]{6})$/.exec(text.trim());
  if (!m) return null;
  const n = Number.parseInt(m[1] as string, 16);
  return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
}

function Slider(props: { name: string; max: number; unit: string; lens: Writable<Cell<number>> }) {
  return (
    <div class="row">
      <label>{props.name}</label>
      <input type="range" min="0" max={props.max} step="1" lens={props.lens} />
      <span class="val">{() => `${Math.round(props.lens.value)}${props.unit}`}</span>
    </div>
  );
}

export default function ColorPicker() {
  const seed = rgbToHsv(0x87, 0x3c, 0x3c); // #873c3c — a desaturated red
  const h = cell(seed.h);
  const s = cell(seed.s);
  const v = cell(seed.v);

  // HSV (source) → RGB (view). The backward omits hue at grey / saturation at
  // black (≡ SKIP), leaving those source cells put through achromatic colours.
  const rgb = lens(
    { h, s, v },
    ({ h, s, v }) => hsvToRgb(h, s, v),
    (target): Partial<{ h: number; s: number; v: number }> => {
      const c = rgbToHsv(target.r, target.g, target.b);
      const out: Partial<{ h: number; s: number; v: number }> = { v: c.v };
      if (c.s !== 0) out.h = c.h;
      if (c.v !== 0) out.s = c.s;
      return out;
    },
  );
  const { r, g, b } = fields(rgb);
  const hexed = lens(rgb, toHex, (text: string, cur: Rgb) => parseHex(text) ?? cur);

  return (
    <div class="picker">
      <h3>Color Picker</h3>
      <div
        class="swatch"
        style={() => `background:rgb(${rgb.value.r} ${rgb.value.g} ${rgb.value.b})`}
      />
      <input class="hex" lens={hexed} />
      <fieldset>
        <legend>RGB</legend>
        <Slider name="Red" max={255} unit="" lens={r} />
        <Slider name="Green" max={255} unit="" lens={g} />
        <Slider name="Blue" max={255} unit="" lens={b} />
      </fieldset>
      <fieldset>
        <legend>HSV</legend>
        <Slider name="Hue" max={360} unit="°" lens={h} />
        <Slider name="Saturation" max={100} unit="%" lens={s} />
        <Slider name="Value" max={100} unit="%" lens={v} />
      </fieldset>
    </div>
  );
}

export const styles = css`
  :host {
    display: block;
    margin: 1.5rem auto;
    width: 100%;
    max-width: 420px;
    font-family: inherit;
    color: var(--text-color);
  }
  h3 {
    margin: 0 0 0.9rem;
    text-align: center;
    font-size: 1.2rem;
    font-weight: 600;
  }
  .swatch {
    width: 220px;
    height: 220px;
    margin: 0 auto;
    border-radius: 6px;
    border: 1px solid var(--border-color);
  }
  .hex {
    display: block;
    width: 9ch;
    margin: 0.55rem auto 1.2rem;
    padding: 0.2rem 0;
    text-align: center;
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
    font-size: 0.95rem;
    color: var(--text-secondary);
    background: transparent;
    border: 1px solid var(--border-color);
    border-radius: 4px;
  }
  .hex:focus {
    color: var(--text-color);
    border-color: var(--ink-fill, #5b8def);
  }
  fieldset {
    border: 1px solid var(--border-color);
    border-radius: 6px;
    padding: 0.7rem 0.9rem 0.85rem;
    margin: 0 0 1rem;
  }
  legend {
    padding: 0 0.4rem;
    font-size: 0.78rem;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    color: var(--text-secondary);
  }
  .row {
    display: grid;
    grid-template-columns: 6.5rem 1fr 3ch;
    align-items: center;
    gap: 0.6rem;
    margin: 0.35rem 0;
  }
  .row label {
    font-size: 0.9rem;
  }
  .row input[type="range"] {
    width: 100%;
    min-width: 0;
    accent-color: var(--ink-fill, #5b8def);
  }
  .row .val {
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
    font-size: 0.8rem;
    text-align: right;
    color: var(--text-secondary);
  }
  input:focus {
    outline: none;
  }
`;
