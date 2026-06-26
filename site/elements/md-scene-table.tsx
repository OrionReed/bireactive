/** @jsxImportSource @bireactive */
// The spreadsheet view — and the payoff of composition. Every editable cell is
// `shapeLens(doc, id).lens(toField(col))`: the *exact* lens the inspector
// binds (layer B), with one more optic stacked on top (layer C). So the
// spreadsheet is a view of the inspector, which is a view of the doc — A ▸ B ▸ C,
// all from plain composable optic values. The Hex column stacks `hexOptic`
// instead, editing the same HSL triple through a colour reprojection. Edits run
// the whole chain back into the CRDT and out to the canvas, cards, and tabs. The
// footer is read-only projection over the array.

import type { Cell, Writable } from "@bireactive";
import { each, mount } from "@bireactive/jsx-runtime";
import {
  area,
  aspect,
  centerX,
  centerY,
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

export class MdSceneTable extends BaseElement {
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
      <div class="wrap">
        <div class="sheet">
          <div class="grid head">
            <span />
            <span>label</span>
            <span>cx</span>
            <span>cy</span>
            <span>area</span>
            <span>ratio</span>
            <span>hex</span>
            <span />
          </div>
          <div
            class="body"
            ref={el =>
              each(
                el as Element,
                () => doc.value.shapes,
                s => s.id,
                s => row(doc, s),
              )
            }
          />
        </div>
        <Stats doc={doc} />
      </div>
    );
  }

  static styles = css`
    :host {
      display: block;
      margin: 1.5rem auto;
      max-width: 100%;
      font-family: inherit;
      color: var(--text-color);
    }
    .status {
      text-align: center;
      color: var(--text-secondary);
      padding: 2rem 0;
    }
    .wrap {
      border: 1px solid var(--border-color);
      border-radius: 6px;
      overflow: hidden;
    }
    .sheet {
      overflow-x: auto;
    }
    .grid {
      display: grid;
      grid-template-columns: 1.4rem minmax(5rem, 1fr) 3.4rem 3.4rem 4.4rem 3.6rem 5.5rem 1.4rem;
      align-items: center;
      gap: 0.3rem;
      padding: 0.25rem 0.55rem;
      min-width: max-content;
    }
    .head {
      font-size: 0.68rem;
      text-transform: uppercase;
      letter-spacing: 0.03em;
      color: var(--text-secondary);
      border-bottom: 1px solid var(--border-color);
    }
    .head span {
      text-align: center;
    }
    .row {
      cursor: pointer;
      border-bottom: 1px solid var(--border-color);
    }
    .row.sel {
      background: color-mix(in srgb, var(--ink-fill, #5b8def) 16%, transparent);
    }
    .sw {
      width: 1.1rem;
      height: 1.1rem;
      border-radius: 3px;
      border: 1px solid var(--border-color);
    }
    .cell {
      width: 100%;
      min-width: 0;
      box-sizing: border-box;
      font: inherit;
      font-size: 0.8rem;
      padding: 0.12rem 0.25rem;
      color: var(--text-color);
      background: transparent;
      border: 1px solid transparent;
      border-radius: 3px;
      text-align: right;
      font-variant-numeric: tabular-nums;
      -moz-appearance: textfield;
    }
    .cell.text {
      text-align: left;
    }
    .cell.hex {
      font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
      text-align: left;
    }
    .cell::-webkit-outer-spin-button,
    .cell::-webkit-inner-spin-button {
      -webkit-appearance: none;
      margin: 0;
    }
    .cell:hover {
      border-color: var(--border-color);
    }
    .cell:focus {
      outline: none;
      border-color: var(--ink-fill, #5b8def);
    }
    .del {
      font: inherit;
      color: var(--text-secondary);
      background: transparent;
      border: none;
      cursor: pointer;
      line-height: 1;
    }
    .del:hover {
      color: var(--text-color);
    }
    .stats {
      display: flex;
      align-items: center;
      gap: 1rem;
      padding: 0.45rem 0.6rem;
      border-top: 1px solid var(--border-color);
      font-size: 0.78rem;
      color: var(--text-secondary);
    }
    .stats .avg {
      width: 1rem;
      height: 1rem;
      border-radius: 3px;
      border: 1px solid var(--border-color);
    }
    .stats .spacer {
      margin-left: auto;
    }
  `;
}

function row(doc: Writable<Cell<Scene>>, shape: Shape): Node {
  const s = shapeLens(doc, shape.id); // layer B — the inspector's lens
  return (
    <div
      class={() => `grid row${doc.value.selected === shape.id ? " sel" : ""}`}
      onClick={() => selectShape(doc, shape.id)}
    >
      <div class="sw" style={() => `background:${cssColor(s.value)}`} />
      <input class="cell text" type="text" lens={s.lens(toField("label"))} />
      <input class="cell" type="number" lens={s.lens(centerX)} />
      <input class="cell" type="number" lens={s.lens(centerY)} />
      <input class="cell" type="number" step="100" lens={s.lens(area)} />
      <input class="cell" type="number" step="0.05" lens={s.lens(aspect)} />
      <input class="cell hex" type="text" lens={s.lens(hexOptic)} />
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
  );
}

function Stats(props: { doc: Writable<Cell<Scene>> }): Node {
  const shapes = () => props.doc.value.shapes;
  const totalArea = () => shapes().reduce((a, s) => a + s.w * s.h, 0);
  const avg = () => {
    const xs = shapes();
    if (xs.length === 0) return { hue: 0, sat: 0, lum: 12 };
    const sum = xs.reduce(
      (a, s) => ({ hue: a.hue + s.hue, sat: a.sat + s.sat, lum: a.lum + s.lum }),
      {
        hue: 0,
        sat: 0,
        lum: 0,
      },
    );
    return { hue: sum.hue / xs.length, sat: sum.sat / xs.length, lum: sum.lum / xs.length };
  };
  return (
    <div class="stats">
      <span>{() => `${shapes().length} shapes`}</span>
      <span>{() => `area ${Math.round(totalArea()).toLocaleString()}`}</span>
      <span class="spacer">avg</span>
      <div class="avg" style={() => `background:${cssColor(avg())}`} />
    </div>
  );
}
