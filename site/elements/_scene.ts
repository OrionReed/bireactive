// One shared document, viewed three ways. The CRDT holds a `Scene` — a title, an
// array of shapes (each a nested record with geometry + HSL colour), and the id
// of the selected shape. The canvas, inspector, and table demos are all lenses
// over this single doc via one `connectDoc` bridge (memoised below), so they sync
// to each other and across tabs. This module is the lens kit they share:
//   • shapeById   — focus one shape by id; writes splice it back into the array;
//   • selectedShape — focus whatever `selected` points at (a dynamic optic);
//   • field        — a null-safe field lens into the selected shape;
//   • hexColor     — present the shape's HSL as an editable #rrggbb.

import { atKey, type Cell, cell, type Optic, optic, type Store, type Writable } from "@bireactive";
import { connectDoc } from "@bireactive/automerge";
import { findOrCreate, loadDoc } from "./_automerge-repo";

export type Shape = {
  id: string;
  kind: "rect" | "ellipse";
  x: number;
  y: number;
  w: number;
  h: number;
  hue: number; // 0..360
  sat: number; // 0..100
  lum: number; // 0..100
  label: string;
};

export type Scene = {
  title: string;
  shapes: Shape[];
  selected: string | null;
};

export const WIDTH = 320;
export const HEIGHT = 240;

const EMPTY: Shape = {
  id: "",
  kind: "rect",
  x: 0,
  y: 0,
  w: 0,
  h: 0,
  hue: 0,
  sat: 0,
  lum: 0,
  label: "",
};

const SEED: Scene = {
  title: "Shared scene",
  selected: "sun",
  shapes: [
    {
      id: "sun",
      kind: "ellipse",
      x: 40,
      y: 36,
      w: 76,
      h: 76,
      hue: 45,
      sat: 90,
      lum: 60,
      label: "sun",
    },
    {
      id: "roof",
      kind: "rect",
      x: 150,
      y: 60,
      w: 130,
      h: 90,
      hue: 9,
      sat: 70,
      lum: 52,
      label: "roof",
    },
    {
      id: "lake",
      kind: "ellipse",
      x: 70,
      y: 168,
      w: 190,
      h: 46,
      hue: 205,
      sat: 72,
      lum: 50,
      label: "lake",
    },
  ],
};

export interface SceneCtx {
  cell: Writable<Cell<Scene>>;
  store: Store<Scene>;
  /** Current doc id (reactive) — surfaced in the UI for copy/share. */
  docId: Writable<Cell<string>>;
  /** Switch every view to a different doc id, in place (no reload). Throws if
   *  the id can't be resolved. */
  load: (id: string) => Promise<void>;
  dispose: () => void;
}

let ctxPromise: Promise<SceneCtx> | null = null;

/** The shared scene bridge (memoised per tab). */
export function scene(): Promise<SceneCtx> {
  ctxPromise ??= setup();
  return ctxPromise;
}

async function setup(): Promise<SceneCtx> {
  const handle = await findOrCreate("scene", SEED);
  const bridge = connectDoc(handle);
  const docId = cell<string>(handle.url);
  return {
    cell: bridge.cell,
    store: bridge.store,
    docId,
    load: async (id: string) => {
      const next = await loadDoc<Scene>("scene", id);
      bridge.retarget(next);
      docId.value = next.url;
    },
    dispose: bridge.dispose,
  };
}

// ── Optics over the scene (composable values) ────────────────────────────────
//
// These are the A▸B▸C building blocks the three views share. The canvas reads
// the doc (A); the inspector focuses one shape with `byId` (B); the spreadsheet
// is *a view of the inspector* — it takes the very same shape lens and composes
// one more optic on top (C = B `.through` field / hex). Because optics are plain
// values, `shapeLens(doc, id).lens(toField("hue"))` is the inspector's lens
// with a field selector appended; edits flow C ▸ B ▸ A and back out everywhere.

/** A▸B: focus one shape by id; writing splices it back into the array. */
export function byId(id: string): Optic<Scene, Shape> {
  return optic<Scene, Shape>(
    s => s.shapes.find(sh => sh.id === id) ?? EMPTY,
    (shape, s) => ({ ...s, shapes: s.shapes.map(sh => (sh.id === id ? shape : sh)) }),
  );
}

/** B▸C: a single field of a shape. */
export function toField<K extends keyof Shape>(key: K): Optic<Shape, Shape[K]> {
  return atKey<Shape, K>(key);
}

/** B▸C: a shape's HSL colour reprojected as an editable `#rrggbb`. */
export const hexOptic: Optic<Shape, string> = optic<Shape, string>(
  s => hslToHex(s.hue, s.sat, s.lum),
  (hex, s) => {
    const c = hexToHsl(hex);
    return c ? { ...s, hue: c.hue, sat: c.sat, lum: c.lum } : s;
  },
);

/** The inspector's writable lens onto shape `id` (layer B). */
export function shapeLens(doc: Writable<Cell<Scene>>, id: string): Writable<Cell<Shape>> {
  return doc.lens(byId(id));
}

// Derived B▸C optics — these read several fields at once, so the spreadsheet
// shows the shape through a genuinely different basis than the inspector's raw
// sliders. Each is still just an optic value composed onto the same shape lens.

const clampW = (n: number) => Math.max(10, Math.min(WIDTH, Math.round(n)));
const clampH = (n: number) => Math.max(10, Math.min(HEIGHT, Math.round(n)));

/** Centre X (writes back to `x`, holding width). */
export const centerX: Optic<Shape, number> = optic<Shape, number>(
  s => Math.round(s.x + s.w / 2),
  (cx, s) => ({ ...s, x: Math.round(cx - s.w / 2) }),
);

/** Centre Y (writes back to `y`, holding height). */
export const centerY: Optic<Shape, number> = optic<Shape, number>(
  s => Math.round(s.y + s.h / 2),
  (cy, s) => ({ ...s, y: Math.round(cy - s.h / 2) }),
);

/** Area in px² — editing scales w and h together, preserving aspect ratio. */
export const area: Optic<Shape, number> = optic<Shape, number>(
  s => s.w * s.h,
  (a, s) => {
    const k = Math.sqrt(Math.max(a, 1) / Math.max(s.w * s.h, 1));
    return { ...s, w: clampW(s.w * k), h: clampH(s.h * k) };
  },
);

/** Aspect ratio w∶h (2 dp) — editing sets width, holding height. */
export const aspect: Optic<Shape, number> = optic<Shape, number>(
  s => Math.round((s.w / s.h) * 100) / 100,
  (r, s) => ({ ...s, w: clampW(s.h * Math.max(r, 0.05)) }),
);

// ── Mutations (commit a fresh scene; reconcile diffs it into the CRDT) ────────

export function selectShape(doc: Writable<Cell<Scene>>, id: string | null): void {
  doc.value = { ...doc.value, selected: id };
}

export function addShape(doc: Writable<Cell<Scene>>): void {
  const id = crypto.randomUUID().slice(0, 8);
  const shape: Shape = {
    id,
    kind: Math.random() < 0.5 ? "rect" : "ellipse",
    x: Math.round(20 + Math.random() * (WIDTH - 120)),
    y: Math.round(20 + Math.random() * (HEIGHT - 100)),
    w: 70,
    h: 60,
    hue: Math.round(Math.random() * 360),
    sat: 70,
    lum: 55,
    label: "shape",
  };
  const s = doc.value;
  doc.value = { ...s, shapes: [...s.shapes, shape], selected: id };
}

export function removeShape(doc: Writable<Cell<Scene>>, id: string): void {
  const s = doc.value;
  doc.value = {
    ...s,
    shapes: s.shapes.filter(sh => sh.id !== id),
    selected: s.selected === id ? null : s.selected,
  };
}

// ── Colour helpers ───────────────────────────────────────────────────────────

/** CSS colour for a shape's HSL. */
export const cssColor = (s: Pick<Shape, "hue" | "sat" | "lum">): string =>
  `hsl(${s.hue} ${s.sat}% ${s.lum}%)`;

function hslToRgb(h: number, s: number, l: number): [number, number, number] {
  s /= 100;
  l /= 100;
  const k = (n: number) => (n + h / 30) % 12;
  const a = s * Math.min(l, 1 - l);
  const f = (n: number) => l - a * Math.max(-1, Math.min(k(n) - 3, 9 - k(n), 1));
  return [Math.round(f(0) * 255), Math.round(f(8) * 255), Math.round(f(4) * 255)];
}

function rgbToHsl(r: number, g: number, b: number): { hue: number; sat: number; lum: number } {
  r /= 255;
  g /= 255;
  b /= 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const d = max - min;
  const l = (max + min) / 2;
  let h = 0;
  if (d !== 0) {
    if (max === r) h = ((g - b) / d) % 6;
    else if (max === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    h = (h * 60 + 360) % 360;
  }
  const s = d === 0 ? 0 : d / (1 - Math.abs(2 * l - 1));
  return { hue: Math.round(h), sat: Math.round(s * 100), lum: Math.round(l * 100) };
}

const hx = (n: number) => n.toString(16).padStart(2, "0");

function hslToHex(h: number, s: number, l: number): string {
  const [r, g, b] = hslToRgb(h, s, l);
  return `#${hx(r)}${hx(g)}${hx(b)}`;
}

function hexToHsl(text: string): { hue: number; sat: number; lum: number } | null {
  const m = /^#?([0-9a-fA-F]{6})$/.exec(text.trim());
  if (!m) return null;
  const n = Number.parseInt(m[1] as string, 16);
  return rgbToHsl((n >> 16) & 255, (n >> 8) & 255, n & 255);
}
