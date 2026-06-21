/** @jsxImportSource @bireactive */
// The form view: one inspector card per shape. Each card binds `shapeLens(doc,
// id)` — layer B, a writable focus on that shape — and its controls compose one
// more optic on top: `s.through(toField("hue"))`, `s.through(hexOptic)`. That is
// exactly the lens the spreadsheet reuses (it is a view of these cards). Edits
// flow C ▸ B ▸ A into the CRDT and back out to the canvas, spreadsheet, and other
// tabs. `each` keeps the card list in sync with the array by id.

import type { Cell, Writable } from "@bireactive";
import { each, mount } from "@bireactive/jsx-runtime";
import {
  cssColor,
  hexOptic,
  removeShape,
  type Scene,
  type SceneCtx,
  type Shape,
  scene,
  selectShape,
  shapeLens,
  toField,
} from "./_scene";
import { BaseElement, css } from "./base-element";

export class MdSceneInspector extends BaseElement {
  #dispose?: () => void;

  async connectedCallback(): Promise<void> {
    const status = document.createElement("div");
    status.className = "status";
    status.textContent = "connecting…";
    this.shadow.append(status);

    const ctx = await scene();
    if (!this.isConnected) return;
    this.shadow.replaceChildren();
    this.#dispose = mount(() => this.view(ctx), this.shadow);
  }

  disconnectedCallback(): void {
    this.#dispose?.();
    this.#dispose = undefined;
  }

  private view(ctx: SceneCtx): Node {
    const doc = ctx.cell;
    return (
      <div
        class="list"
        ref={el =>
          each(
            el as Element,
            () => doc.value.shapes,
            s => s.id,
            s => card(doc, s),
          )
        }
      />
    );
  }

  static styles = css`
    :host {
      display: block;
      margin: 1.5rem auto;
      max-width: 320px;
      font-family: inherit;
      color: var(--text-color);
    }
    .status {
      text-align: center;
      color: var(--text-secondary);
      padding: 2rem 0;
    }
    .list {
      display: flex;
      flex-direction: column;
      gap: 0.5rem;
    }
    .card {
      border: 1px solid var(--border-color);
      border-radius: 6px;
      padding: 0.45rem 0.6rem;
      cursor: pointer;
    }
    .card.sel {
      border-color: var(--ink-fill, #5b8def);
      cursor: default;
    }
    .top {
      display: flex;
      align-items: center;
      gap: 0.5rem;
    }
    .swatch {
      width: 1.3rem;
      height: 1.3rem;
      border-radius: 4px;
      border: 1px solid var(--border-color);
      flex: none;
    }
    .top input {
      flex: 1;
      min-width: 0;
      font: inherit;
      font-size: 0.9rem;
      padding: 0.15rem 0.3rem;
      color: var(--text-color);
      background: transparent;
      border: 1px solid transparent;
      border-radius: 3px;
    }
    .top input:hover,
    .top input:focus {
      border-color: var(--border-color);
      outline: none;
    }
    .del {
      font: inherit;
      color: var(--text-secondary);
      background: transparent;
      border: none;
      cursor: pointer;
      line-height: 1;
    }
    .controls {
      display: none;
      margin-top: 0.45rem;
    }
    .card.sel .controls {
      display: block;
    }
    .r {
      display: grid;
      grid-template-columns: 2.6rem 1fr 3.4ch;
      align-items: center;
      gap: 0.5rem;
      margin: 0.18rem 0;
      font-size: 0.8rem;
    }
    .r input[type="range"] {
      width: 100%;
      min-width: 0;
      accent-color: var(--ink-fill, #5b8def);
    }
    .r output {
      text-align: right;
      font-variant-numeric: tabular-nums;
      font-size: 0.75rem;
      color: var(--text-secondary);
    }
    .hex {
      margin-top: 0.3rem;
      width: 100%;
      font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
      font-size: 0.8rem;
      padding: 0.2rem 0.35rem;
      color: var(--text-color);
      background: transparent;
      border: 1px solid var(--border-color);
      border-radius: 4px;
      box-sizing: border-box;
    }
    .hex:focus {
      outline: none;
      border-color: var(--ink-fill, #5b8def);
    }
  `;
}

function card(doc: Writable<Cell<Scene>>, shape: Shape): Node {
  const s = shapeLens(doc, shape.id); // layer B: this shape, writable
  return (
    <div
      class={() => `card${doc.value.selected === shape.id ? " sel" : ""}`}
      onClick={() => selectShape(doc, shape.id)}
    >
      <div class="top">
        <div class="swatch" style={() => `background:${cssColor(s.value)}`} />
        <input type="text" lens={s.through(toField("label"))} />
        <button
          type="button"
          class="del"
          onClick={(e: MouseEvent) => {
            e.stopPropagation();
            removeShape(doc, shape.id);
          }}
        >
          ×
        </button>
      </div>
      <div class="controls">
        <Range label="Hue" min={0} max={360} unit="°" lens={s.through(toField("hue"))} />
        <Range label="Sat" min={0} max={100} unit="%" lens={s.through(toField("sat"))} />
        <Range label="Light" min={0} max={100} unit="%" lens={s.through(toField("lum"))} />
        <Range label="X" min={0} max={320} lens={s.through(toField("x"))} />
        <Range label="Y" min={0} max={240} lens={s.through(toField("y"))} />
        <Range label="W" min={10} max={320} lens={s.through(toField("w"))} />
        <Range label="H" min={10} max={240} lens={s.through(toField("h"))} />
        <input class="hex" type="text" lens={s.through(hexOptic)} />
      </div>
    </div>
  );
}

function Range(props: {
  label: string;
  min: number;
  max: number;
  unit?: string;
  lens: Writable<Cell<number>>;
}): Node {
  return (
    <label class="r">
      <span>{props.label}</span>
      <input type="range" min={props.min} max={props.max} step="1" lens={props.lens} />
      <output>{() => `${Math.round(props.lens.value)}${props.unit ?? ""}`}</output>
    </label>
  );
}
