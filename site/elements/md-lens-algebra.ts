// Lens-as-a-cell. A lens is an ordinary value here — an affine `Frame`
// held in a `Cell` — so the *transformation* is reactive: swap or blend
// it and the pipeline reconfigures while data flows through, both ways.
// `through(src, frame)` is one writable edge; stack two and you get a
// reconfigurable bidirectional pipeline. Drag the source or the image
// shape; change either stage; everything stays in sync.

import {
  Anchor,
  type Cell,
  Diagram,
  derive,
  group,
  handle,
  label,
  line,
  type Mount,
  Num,
  num,
  type Read,
  rect,
  Vec,
  vec,
  type Writable,
} from "@bireactive";

type V = { x: number; y: number };

// An affine map as a plain value: x' = a·x + c·y + e, y' = b·x + d·y + f.
// Because it's just data, a `Cell<Aff>` makes the lens itself reactive.
type Aff = { a: number; b: number; c: number; d: number; e: number; f: number };

const ID: Aff = { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 };

const apply = (m: Aff, v: V): V => ({
  x: m.a * v.x + m.c * v.y + m.e,
  y: m.b * v.x + m.d * v.y + m.f,
});

const invert = (m: Aff): Aff => {
  const det = m.a * m.d - m.b * m.c || 1e-9;
  const id = 1 / det;
  const a = m.d * id;
  const b = -m.b * id;
  const c = -m.c * id;
  const d = m.a * id;
  return { a, b, c, d, e: -(a * m.e + c * m.f), f: -(b * m.e + d * m.f) };
};

const lerp = (m1: Aff, m2: Aff, s: number): Aff => ({
  a: m1.a + (m2.a - m1.a) * s,
  b: m1.b + (m2.b - m1.b) * s,
  c: m1.c + (m2.c - m1.c) * s,
  d: m1.d + (m2.d - m1.d) * s,
  e: m1.e + (m2.e - m1.e) * s,
  f: m1.f + (m2.f - m1.f) * s,
});

// A linear part, re-centered about pivot p:  x' = p + L·(x − p).
type Lin = { a: number; b: number; c: number; d: number };
const about = (L: Lin, p: V): Aff => ({
  ...L,
  e: p.x - (L.a * p.x + L.c * p.y),
  f: p.y - (L.b * p.x + L.d * p.y),
});
const rot = (deg: number): Lin => {
  const r = (deg * Math.PI) / 180;
  const cs = Math.cos(r);
  const sn = Math.sin(r);
  return { a: cs, b: sn, c: -sn, d: cs };
};
const scl = (k: number): Lin => ({ a: k, b: 0, c: 0, d: k });
const shr = (m: number): Lin => ({ a: 1, b: 0, c: m, d: 1 });
const mir = (): Lin => ({ a: -1, b: 0, c: 0, d: 1 });

/** One reactive lens edge: forward applies the current frame, backward
 *  inverts it. The frame is a cell, so swapping it reconfigures BOTH
 *  directions live (forward auto-tracks `.value`; backward reads the
 *  current frame via `.peek()`). */
const through = (src: Writable<Vec>, m: Cell<Aff>): Writable<Vec> =>
  Vec.lens(
    src,
    (v: V) => apply(m.value, v),
    (t: V) => apply(invert(m.peek()), t),
  );

const ARROW: V[] = [
  { x: -46, y: -9 },
  { x: 6, y: -9 },
  { x: 6, y: -26 },
  { x: 46, y: 0 },
  { x: 6, y: 26 },
  { x: 6, y: 9 },
  { x: -46, y: 9 },
];

const ACCENT = "#5b8def";
const GHOST = "rgba(127,127,127,0.5)";

export class MdLensAlgebra extends Diagram {
  protected scene(s: Mount): void {
    const view = this.view(720, 400);
    const C = view.center.up(40).value;

    // Stage 1: a discrete palette. The selected index drives a derived
    // frame cell, so the whole pipeline reconfigures on click.
    const palette: { name: string; make: (p: V) => Aff }[] = [
      { name: "identity", make: () => ID },
      { name: "rotate", make: p => about(rot(40), p) },
      { name: "scale", make: p => about(scl(1.35), p) },
      { name: "shear", make: p => about(shr(0.5), p) },
      { name: "mirror", make: p => about(mir(), p) },
    ];
    const sel = num(1);
    const m1 = derive(() => palette[sel.value]!.make(C));

    // Stage 2: a continuous blend between identity and a swirl, lerped
    // by a slider — a lens-valued crossfade.
    const swirl = about(
      {
        a: 0.65 * Math.cos((50 * Math.PI) / 180),
        b: 0.65 * Math.sin((50 * Math.PI) / 180),
        c: -0.65 * Math.sin((50 * Math.PI) / 180),
        d: 0.65 * Math.cos((50 * Math.PI) / 180),
      },
      C,
    );
    const blend = num(0);
    const m2 = derive(() => lerp(ID, swirl, blend.value));

    // Source shape (writable points) → stacked through two reactive edges.
    const srcPts = ARROW.map(p => vec(C.x + p.x, C.y + p.y));
    const imgPts = srcPts.map(p => through(through(p, m1), m2));

    const polyline = (pts: Writable<Vec>[], opts: Parameters<typeof line>[2]) => {
      for (let i = 0; i < pts.length; i++) s(line(pts[i]!, pts[(i + 1) % pts.length]!, opts));
    };
    polyline(srcPts, { thin: true, dashed: true, stroke: GHOST });
    polyline(imgPts, { stroke: ACCENT });

    for (const p of srcPts) s(handle(p, { r: 4, fill: GHOST }));
    for (const p of imgPts) s(handle(p, { r: 5, fill: ACCENT }));

    // Stage-1 palette buttons (centered row).
    palette.forEach((opt, i) => {
      button(
        s,
        152 + i * 104,
        330,
        96,
        opt.name,
        () => {
          sel.value = i;
        },
        derive(() => sel.value === i),
      );
    });

    // Stage-2 blend slider.
    slider(s, 255, 465, 372, blend);

    s(
      label(
        view.top.down(18),
        "the lens is a value — stage 1 swaps a frame, stage 2 blends one, both ways",
      ),
      label(vec(360, 308), "stage 1  ·  src ⇌ m1 ⇌ m2 ⇌ img", { size: 10, opacity: 0.55 }),
    );
  }
}

/** Clickable pill that runs `onClick`; highlights while `active`. */
function button(
  s: Mount,
  cx: number,
  cy: number,
  w: number,
  text: string,
  onClick: () => void,
  active: Read<boolean>,
): void {
  const h = 24;
  const g = group(
    { translate: vec(cx - w / 2, cy - h / 2) },
    rect(0, 0, w, h, {
      corner: 12,
      fill: derive(() => (active.value ? ACCENT : "rgba(127,127,127,0.12)")),
      stroke: "rgba(127,127,127,0.35)",
      thin: true,
    }),
    label(vec(w / 2, h / 2), text, {
      size: 11,
      bold: true,
      align: Anchor.Center,
      fill: derive(() => (active.value ? "#fff" : "var(--text-color, #333)")),
    }),
  );
  g.el.style.cursor = "pointer";
  g.on("click", onClick);
  s(g);
}

/** Drag slider over [0, 1] writing a Num through an affine+clamp chain. */
function slider(s: Mount, x0: number, x1: number, y: number, t: Writable<Num>): void {
  const knobPos = vec(t.clamp(0, 1).affine(x1 - x0, x0), Num.pin(y));
  s(
    line(vec(x0, y), vec(x1, y), { thin: true, opacity: 0.4 }),
    label(
      vec((x0 + x1) / 2, y - 16),
      derive(() => `blend = ${t.value.toFixed(2)}`),
      {
        size: 10,
        opacity: 0.7,
      },
    ),
    handle(knobPos, { fill: "#222", r: 7 }),
  );
}
