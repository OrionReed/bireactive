/** @jsxImportSource @bireactive */
// The spatial view of the shared scene. Each shape is a `shapeLens`; drag writes
// its x/y straight back to the CRDT (so the inspector and spreadsheet — other
// lenses over the same doc — move with it, here and in every other tab). `each`
// keeps the shape divs in sync with the array by id. Click to select (sticky;
// click again to deselect). The share bar shows the doc id for copy/paste so a
// second tab can join the same scene — no URL bar, no reload.

import { cell } from "@bireactive";
import { each, mount } from "@bireactive/jsx-runtime";
import {
  addShape,
  cssColor,
  HEIGHT,
  removeShape,
  type SceneCtx,
  type Shape,
  scene,
  selectShape,
  shapeLens,
  WIDTH,
} from "./_scene";
import { BaseElement, css } from "./base-element";

export class MdSceneCanvas extends BaseElement {
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
    let stage: HTMLElement;
    let drag: {
      id: string;
      dx: number;
      dy: number;
      sx: number;
      sy: number;
      wasSelected: boolean;
      moved: boolean;
    } | null = null;

    const renderShape = (shape: Shape): Node => {
      const sl = shapeLens(doc, shape.id);
      const onDown = (e: PointerEvent) => {
        e.preventDefault();
        const r = stage.getBoundingClientRect();
        const wasSelected = doc.value.selected === shape.id;
        if (!wasSelected) selectShape(doc, shape.id);
        drag = {
          id: shape.id,
          dx: e.clientX - r.left - sl.value.x,
          dy: e.clientY - r.top - sl.value.y,
          sx: e.clientX,
          sy: e.clientY,
          wasSelected,
          moved: false,
        };
        (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
      };
      const onMove = (e: PointerEvent) => {
        if (drag?.id !== shape.id) return;
        if (Math.abs(e.clientX - drag.sx) > 3 || Math.abs(e.clientY - drag.sy) > 3)
          drag.moved = true;
        const r = stage.getBoundingClientRect();
        const s = sl.value;
        const x = Math.max(0, Math.min(WIDTH - s.w, e.clientX - r.left - drag.dx));
        const y = Math.max(0, Math.min(HEIGHT - s.h, e.clientY - r.top - drag.dy));
        sl.value = { ...s, x: Math.round(x), y: Math.round(y) };
      };
      const onUp = (e: PointerEvent) => {
        // A click (no drag) on an already-selected shape toggles it off.
        if (drag?.id === shape.id && drag.wasSelected && !drag.moved) selectShape(doc, null);
        drag = null;
        (e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId);
      };
      return (
        <div
          class="shape"
          style={() => shapeStyle(sl.value, doc.value.selected === shape.id)}
          onPointerdown={onDown}
          onPointermove={onMove}
          onPointerup={onUp}
        >
          <span>{() => sl.value.label}</span>
        </div>
      );
    };

    return (
      <div class="canvas">
        <div class="bar">
          <button type="button" onClick={() => addShape(doc)}>
            + shape
          </button>
          <button
            type="button"
            onClick={() => doc.value.selected && removeShape(doc, doc.value.selected)}
          >
            − delete
          </button>
          <span class="count">{() => `${doc.value.shapes.length} shapes`}</span>
        </div>
        <div
          class="stage"
          ref={el => {
            stage = el as HTMLElement;
            each(
              el as Element,
              () => doc.value.shapes,
              s => s.id,
              renderShape,
            );
          }}
          onClick={(e: MouseEvent) => {
            if (e.target === stage) selectShape(doc, null);
          }}
        />
        <ShareBar ctx={ctx} />
      </div>
    );
  }

  static styles = css`
    :host {
      display: block;
      margin: 1.5rem auto;
      max-width: ${WIDTH}px;
      font-family: inherit;
      color: var(--text-color);
    }
    .status {
      text-align: center;
      color: var(--text-secondary);
      padding: 2rem 0;
    }
    .bar {
      display: flex;
      align-items: center;
      gap: 0.5rem;
      margin-bottom: 0.5rem;
    }
    .bar button {
      font: inherit;
      font-size: 0.85rem;
      padding: 0.25rem 0.6rem;
      color: var(--text-color);
      background: transparent;
      border: 1px solid var(--border-color);
      border-radius: 4px;
      cursor: pointer;
    }
    .bar .count {
      margin-left: auto;
      font-size: 0.8rem;
      color: var(--text-secondary);
    }
    .stage {
      position: relative;
      width: ${WIDTH}px;
      height: ${HEIGHT}px;
      max-width: 100%;
      background:
        linear-gradient(var(--border-color) 1px, transparent 1px) 0 0 / 100% 24px,
        linear-gradient(90deg, var(--border-color) 1px, transparent 1px) 0 0 / 24px 100%,
        var(--bg-secondary, #0e1116);
      border: 1px solid var(--border-color);
      border-radius: 6px;
      overflow: hidden;
      touch-action: none;
    }
    .shape {
      position: absolute;
      display: grid;
      place-items: center;
      cursor: grab;
      user-select: none;
      box-shadow: 0 1px 4px rgba(0, 0, 0, 0.3);
    }
    .shape:active {
      cursor: grabbing;
    }
    .shape span {
      font-size: 0.7rem;
      color: rgba(0, 0, 0, 0.6);
      pointer-events: none;
      mix-blend-mode: overlay;
    }
    .share {
      display: flex;
      align-items: center;
      gap: 0.4rem;
      margin-top: 0.6rem;
      flex-wrap: wrap;
    }
    .share .docid {
      flex: 1;
      min-width: 6rem;
      max-width: 100%;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
      font-size: 0.72rem;
      padding: 0.25rem 0.4rem;
      color: var(--text-secondary);
      background: var(--bg-secondary, rgba(127, 127, 127, 0.08));
      border: 1px solid var(--border-color);
      border-radius: 4px;
      cursor: pointer;
    }
    .share input {
      flex: 1;
      min-width: 6rem;
      font: inherit;
      font-size: 0.75rem;
      padding: 0.25rem 0.4rem;
      color: var(--text-secondary);
      background: transparent;
      border: 1px solid var(--border-color);
      border-radius: 4px;
    }
    .share button {
      font: inherit;
      font-size: 0.75rem;
      padding: 0.25rem 0.6rem;
      color: var(--text-color);
      background: transparent;
      border: 1px solid var(--border-color);
      border-radius: 4px;
      cursor: pointer;
    }
    .share .note {
      font-size: 0.72rem;
      color: var(--text-secondary);
      min-width: 4rem;
    }
  `;
}

function shapeStyle(s: Shape, selected: boolean): string {
  return [
    `left:${s.x}px`,
    `top:${s.y}px`,
    `width:${s.w}px`,
    `height:${s.h}px`,
    `background:${cssColor(s)}`,
    `border-radius:${s.kind === "ellipse" ? "50%" : "4px"}`,
    `outline:${selected ? "2px solid var(--ink-fill, #5b8def)" : "none"}`,
    `outline-offset:2px`,
    `z-index:${selected ? 2 : 1}`,
  ].join(";");
}

function ShareBar(props: { ctx: SceneCtx }): Node {
  const { ctx } = props;
  let input: HTMLInputElement;
  const note = cell("");
  const copy = () => {
    navigator.clipboard?.writeText(ctx.docId.value);
    note.value = "copied";
    setTimeout(() => (note.value = ""), 1200);
  };
  const open = async () => {
    const id = input.value.trim();
    if (!id || id === ctx.docId.value) return;
    note.value = "loading…";
    try {
      await ctx.load(id);
      input.value = "";
      note.value = "";
    } catch {
      note.value = "not found";
    }
  };
  return (
    <div class="share">
      <code class="docid" title="this scene's id — click to copy" onClick={copy}>
        {() => ctx.docId.value}
      </code>
      <button type="button" onClick={copy}>
        copy
      </button>
      <input
        ref={el => {
          input = el as HTMLInputElement;
        }}
        type="text"
        placeholder="paste an id to join…"
        onKeydown={(e: KeyboardEvent) => e.key === "Enter" && open()}
      />
      <button type="button" onClick={open}>
        open
      </button>
      <span class="note">{() => note.value}</span>
    </div>
  );
}
