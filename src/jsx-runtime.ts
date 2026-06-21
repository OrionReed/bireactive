// jsx-runtime.ts — minimal runtime JSX for bireactive (no compiler step).
//
// esbuild's automatic runtime (`jsxImportSource: "@bireactive"`) lowers JSX to
// `jsx`/`jsxs`/`Fragment` calls; this module builds real DOM nodes and wires
// reactive props and children through `effect`. The one binding with no React
// analogue is the `lens` prop: a single bidirectional terminal — the dual of
// the value-plus-onInput pair — that reads a writable cell forward into the
// control and writes edits back, so a chain of lenses can be driven from the
// leaf. Components are plain `props → Node`; reactive expressions are passed as
// thunks (`{() => expr}`) or cells, since there is no compile step to wrap them.

import { Cell, effect, untracked, type Writable } from "./core/cell";

/** Marker for `<>…</>`; lowered to `jsx(Fragment, …)`. */
export const Fragment = Symbol.for("bireactive.jsx.Fragment");

type Disposer = () => void;

// The active mount scope: reactive teardowns created while building a tree are
// collected here so `mount` can release them all on unmount. Non-reentrant —
// `mount` saves/restores the previous owner around the render.
let currentOwner: Disposer[] | null = null;

function track(d: Disposer): void {
  currentOwner?.push(d);
}

/** Register a teardown with the active scope (`mount` / `scope` / an `each`
 *  item) — for raw `effect`s or listeners created in a component body, which
 *  the JSX helpers otherwise track for you. No-op outside a scope. */
export function onCleanup(fn: Disposer): void {
  track(fn);
}

type Props = Record<string, unknown> & { children?: unknown };
type Component = (props: Props) => Node;

/** Build a DOM node for one JSX element. */
export function jsx(type: string | symbol | Component, props?: Props): Node {
  if (typeof type === "function") return type(props ?? {});
  if (type === Fragment) {
    const frag = document.createDocumentFragment();
    append(frag, props?.children);
    return frag;
  }
  const el = document.createElement(type as string);
  if (props) for (const key in props) applyProp(el, key, props[key]);
  return el;
}

/** Static-children variant; behaviourally identical in a runtime builder. */
export const jsxs = jsx;

function applyProp(el: Element, key: string, value: unknown): void {
  if (key === "children") return append(el, value);
  if (key === "ref") {
    if (typeof value === "function") (value as (e: Element) => void)(el);
    return;
  }
  if (key === "lens") return bindLens(el as HTMLInputElement, value as Writable<Cell<unknown>>);
  if (key.startsWith("on") && typeof value === "function") {
    el.addEventListener(key.slice(2).toLowerCase(), value as EventListener);
    return;
  }
  if (value instanceof Cell) {
    track(effect(() => setProp(el, key, (value as Cell<unknown>).value)));
    return;
  }
  if (typeof value === "function") {
    track(effect(() => setProp(el, key, (value as () => unknown)())));
    return;
  }
  setProp(el, key, value);
}

function setProp(el: Element, key: string, value: unknown): void {
  if (key === "class" || key === "className") {
    el.setAttribute("class", value == null ? "" : String(value));
  } else if (key === "style") {
    if (value && typeof value === "object") Object.assign((el as HTMLElement).style, value);
    else el.setAttribute("style", value == null ? "" : String(value));
  } else if (key === "value") {
    (el as HTMLInputElement).value = value == null ? "" : String(value);
  } else if (key === "checked" || key === "disabled" || key === "selected") {
    // biome-ignore lint/suspicious/noExplicitAny: boolean DOM properties
    (el as any)[key] = !!value;
  } else if (value == null || value === false) {
    el.removeAttribute(key);
  } else {
    el.setAttribute(key, value === true ? "" : String(value));
  }
}

/** Append a child (array / Node / text / cell / thunk) to `parent`. */
function append(parent: Node, child: unknown): void {
  if (Array.isArray(child)) {
    for (const c of child) append(parent, c);
  } else if (child instanceof Node) {
    parent.appendChild(child);
  } else if (child instanceof Cell) {
    parent.appendChild(reactiveText(() => (child as Cell<unknown>).value));
  } else if (typeof child === "function") {
    parent.appendChild(reactiveText(child as () => unknown));
  } else if (child != null && child !== false && child !== true) {
    parent.appendChild(document.createTextNode(String(child)));
  }
}

/** A text node whose content tracks `get()`. Primitive children only — the
 *  minimal runtime does not reconcile dynamic element children. */
function reactiveText(get: () => unknown): Text {
  const node = document.createTextNode("");
  track(
    effect(() => {
      const v = get();
      node.data = v == null ? "" : String(v);
    }),
  );
  return node;
}

/** Two-way bind a form control to a writable cell: read forward into the
 *  control, write back on input. The forward write is skipped while the
 *  control is focused, so a live edit is never clobbered mid-drag (the
 *  controlled-input focus guard, written once). */
function bindLens(el: HTMLInputElement, lens: Writable<Cell<unknown>>): void {
  const checkbox = el.type === "checkbox";
  track(
    effect(() => {
      const v = lens.value;
      if (checkbox) {
        el.checked = !!v;
        return;
      }
      const next = v == null ? "" : String(v);
      const root = el.getRootNode() as Document | ShadowRoot;
      if (root.activeElement !== el && el.value !== next) el.value = next;
    }),
  );
  const evt = checkbox || el.tagName === "SELECT" ? "change" : "input";
  el.addEventListener(evt, () => {
    lens.value = checkbox
      ? el.checked
      : el.type === "range" || el.type === "number"
        ? Number(el.value)
        : el.value;
  });
}

/** Render `component` into `host`, collecting reactive teardowns. The returned
 *  disposer releases them — call it on unmount (e.g. `disconnectedCallback`). */
export function mount(component: () => Node, host: Node): Disposer {
  const [node, dispose] = scope(component);
  host.appendChild(node);
  return dispose;
}

/** Run `fn` under a fresh reactive scope, returning its result and a disposer
 *  for every effect created during it — `mount` without a host. `each` gives
 *  each keyed item its own scope so its effects die when the item leaves. */
export function scope<T>(fn: () => T): [T, Disposer] {
  const prev = currentOwner;
  const owner: Disposer[] = [];
  currentOwner = owner;
  try {
    return [
      fn(),
      () => {
        for (const d of owner) d();
        owner.length = 0;
      },
    ];
  } finally {
    currentOwner = prev;
  }
}

/** Keyed list rendering: keep `parent`'s children in sync with a reactive array,
 *  reusing and reordering nodes by key, disposing those that leave. Each item is
 *  rendered in its own `scope` (untracked from the list effect, so item-internal
 *  reads don't retrigger the whole list). Attach via `ref`:
 *  `<div ref={el => each(el, items, s => s.id, render)} />`. */
export function each<T>(
  parent: Element,
  items: Cell<T[]> | (() => readonly T[]),
  key: (item: T, index: number) => string,
  render: (item: T, index: number) => Node,
): void {
  const read = typeof items === "function" ? items : () => items.value;
  const cache = new Map<string, { node: Node; dispose: Disposer }>();
  const stop = effect(() => {
    const arr = read();
    const seen = new Set<string>();
    const nodes: Node[] = [];
    arr.forEach((item, i) => {
      const k = key(item, i);
      seen.add(k);
      let entry = cache.get(k);
      if (entry === undefined) {
        const [node, dispose] = untracked(() => scope(() => render(item, i)));
        entry = { node, dispose };
        cache.set(k, entry);
      }
      nodes.push(entry.node);
    });
    for (const [k, entry] of cache) {
      if (!seen.has(k)) {
        entry.dispose();
        cache.delete(k);
      }
    }
    // Only touch the DOM when the ordered node set actually changed — re-inserting
    // identical children mid-interaction would steal focus and reset clicks.
    const cur = parent.childNodes;
    let same = cur.length === nodes.length;
    for (let i = 0; same && i < nodes.length; i++) same = cur[i] === nodes[i];
    if (!same) parent.replaceChildren(...nodes);
  });
  track(() => {
    stop();
    for (const entry of cache.values()) entry.dispose();
    cache.clear();
  });
}

// JSX typing. Tag names are checked against the DOM tag maps; attribute value
// types are intentionally loose for the prototype (an index signature is the
// escape hatch — tighten per-element later). The bireactive-specific additions
// are the `lens` attribute and reactive-valued (`Cell` | thunk) props/children.
type Reactive<T> = T | Cell<T> | (() => T);

export namespace JSX {
  export type Element = Node;
  export interface ElementChildrenAttribute {
    children: unknown;
  }
  export interface IntrinsicAttributes {
    children?: unknown;
  }
  export interface CommonProps {
    class?: Reactive<string>;
    style?: Reactive<string | Partial<CSSStyleDeclaration>>;
    id?: Reactive<string>;
    // biome-ignore lint/suspicious/noExplicitAny: any writable cell is bindable
    lens?: Cell<any>;
    ref?: (el: Element) => void;
    children?: unknown;
    // biome-ignore lint/suspicious/noExplicitAny: prototype attribute escape hatch
    [attr: string]: any;
  }
  type Tag = keyof HTMLElementTagNameMap | keyof SVGElementTagNameMap;
  export type IntrinsicElements = { [K in Tag]: CommonProps };
}
