// RGB ⇌ HSV picker. Three Num cells hold hue/saturation/value; `Color.lens`
// derives RGB forward (hsvToRgb) and inverts it backward (rgbToHsv). The
// RGB sliders are field-lenses on the derived colour, the HSV sliders write
// the source cells — every control reads and writes the one value.
//
// HSV is degenerate where RGB is achromatic: hue is meaningless at grey,
// saturation at black. Rather than snapping the angle to red on the way
// through, the backward returns `undefined` for those channels, which tells
// the multiparent lens to leave them untouched — so the stored hue survives
// a trip through grey and back.

import { Color, effect, type Num, num, SKIP, type Writable } from "@bireactive";
import { BaseElement, css } from "./base-element";

/** RGB→HSV. Channels in [0, 1]; `h ∈ [0, 360)`, `s, v ∈ [0, 1]`. */
function rgbToHsv(r: number, g: number, b: number) {
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
  return { h, s: max === 0 ? 0 : d / max, v: max };
}

/** HSV→RGB. `h` wraps mod 360, `s, v ∈ [0, 1]`; channels in [0, 1]. */
function hsvToRgb(h: number, s: number, v: number) {
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
  return { r: r + m, g: g + m, b: b + m, a: 1 };
}

export class MdColorHsv extends BaseElement {
  static styles = css`
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
      margin: 0.55rem 0 1.2rem;
      text-align: center;
      font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
      font-size: 0.95rem;
      color: var(--text-secondary);
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

  #dispose: Array<() => void> = [];

  disconnectedCallback(): void {
    for (const d of this.#dispose) d();
    this.#dispose.length = 0;
  }

  protected render(): void {
    for (const d of this.#dispose) d();
    this.#dispose.length = 0;
    this.shadow.replaceChildren();

    // #873c3c — a desaturated red. HSV are the source; RGB is the view.
    const seed = rgbToHsv(0x87 / 255, 0x3c / 255, 0x3c / 255);
    const h = num(seed.h);
    const s = num(seed.s);
    const v = num(seed.v);
    const color = Color.lens(
      [h, s, v] as const,
      ([h, s, v]) => hsvToRgb(h, s, v),
      ({ r, g, b }) => {
        const c = rgbToHsv(r, g, b);
        return [c.s === 0 ? SKIP : c.h, c.v === 0 ? SKIP : c.s, c.v];
      },
    );

    const title = document.createElement("h3");
    title.textContent = "Color Picker";

    const swatch = document.createElement("div");
    swatch.className = "swatch";
    this.#dispose.push(
      effect(() => {
        swatch.style.background = color.css.value;
      }),
    );

    const hexEl = document.createElement("div");
    hexEl.className = "hex";
    const hex = (n: number) =>
      Math.round(n * 255)
        .toString(16)
        .padStart(2, "0");
    this.#dispose.push(
      effect(() => {
        const c = color.value;
        hexEl.textContent = `#${hex(c.r)}${hex(c.g)}${hex(c.b)}`;
      }),
    );

    const rgbField = this.#group("RGB", [
      { name: "Red", cell: color.r, max: 255, unit: "", scale: 255 },
      { name: "Green", cell: color.g, max: 255, unit: "", scale: 255 },
      { name: "Blue", cell: color.b, max: 255, unit: "", scale: 255 },
    ]);
    const hsvField = this.#group("HSV", [
      { name: "Hue", cell: h, max: 360, unit: "°", scale: 1 },
      { name: "Saturation", cell: s, max: 100, unit: "%", scale: 100 },
      { name: "Value", cell: v, max: 100, unit: "%", scale: 100 },
    ]);

    this.shadow.append(title, swatch, hexEl, rgbField, hsvField);
  }

  #group(
    legendText: string,
    rows: readonly {
      name: string;
      cell: Writable<Num>;
      max: number;
      unit: string;
      scale: number;
    }[],
  ): HTMLFieldSetElement {
    const fs = document.createElement("fieldset");
    const lg = document.createElement("legend");
    lg.textContent = legendText;
    fs.append(lg, ...rows.map(r => this.#slider(r)));
    return fs;
  }

  /** A labelled slider bound bidirectionally to `cell`; the slider's
   *  integer range is `cell · scale` over `[0, max]`. */
  #slider(opts: {
    name: string;
    cell: Writable<Num>;
    max: number;
    unit: string;
    scale: number;
  }): HTMLElement {
    const { name, cell, max, unit, scale } = opts;
    const row = document.createElement("div");
    row.className = "row";

    const label = document.createElement("label");
    label.textContent = name;

    const input = document.createElement("input");
    input.type = "range";
    input.min = "0";
    input.max = String(max);
    input.step = "1";

    const val = document.createElement("span");
    val.className = "val";

    input.addEventListener("input", () => {
      cell.value = Number(input.value) / scale;
    });
    this.#dispose.push(
      effect(() => {
        const n = Math.round(cell.value * scale);
        val.textContent = `${n}${unit}`;
        if (this.shadow.activeElement !== input && Number(input.value) !== n) {
          input.value = String(n);
        }
      }),
    );

    row.append(label, input, val);
    return row;
  }
}
