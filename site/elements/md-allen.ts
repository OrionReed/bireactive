// `(Range, Range) → AllenRelation` as a writable cell: the read classifies
// the two intervals, the write reshapes B into a canonical realization.

import {
  Anchor,
  Cell,
  Diagram,
  derive,
  drag,
  group,
  handle,
  label,
  type Mount,
  Num,
  type Range,
  range,
  rect,
  SKIP,
  vec,
  type Writable,
} from "@bireactive";

const W = 720;
const H = 360;

// Allen's thirteen, in canonical order (each paired with its inverse
// across the centre `equals`).
const RELATIONS = [
  "before",
  "meets",
  "overlaps",
  "finished-by",
  "contains",
  "starts",
  "equals",
  "started-by",
  "during",
  "finishes",
  "overlapped-by",
  "met-by",
  "after",
] as const;
type Rel = (typeof RELATIONS)[number];

const equals = (a: Rel, b: Rel) => a === b;

class Allen extends Cell<Rel> {
  static traits = { equals };
  declare readonly _t: typeof Allen.traits;
  constructor(v: Rel = "equals") {
    super(v, { equals });
  }
}

type RV = { lo: number; hi: number };

/** Classify A relative to B, with `eps` slack on the equality boundaries. */
function classify(a: RV, b: RV, eps: number): Rel {
  const a0 = Math.min(a.lo, a.hi);
  const a1 = Math.max(a.lo, a.hi);
  const b0 = Math.min(b.lo, b.hi);
  const b1 = Math.max(b.lo, b.hi);
  const eq = (x: number, y: number) => Math.abs(x - y) <= eps;

  if (a1 < b0 - eps) return "before";
  if (eq(a1, b0)) return "meets";
  if (a0 > b1 + eps) return "after";
  if (eq(a0, b1)) return "met-by";
  if (eq(a0, b0) && eq(a1, b1)) return "equals";
  if (eq(a0, b0)) return a1 < b1 ? "starts" : "started-by";
  if (eq(a1, b1)) return a0 > b0 ? "finishes" : "finished-by";
  if (a0 < b0 && b1 < a1) return "contains";
  if (b0 < a0 && a1 < b1) return "during";
  if (a0 < b0 && b0 < a1 && a1 < b1) return "overlaps";
  if (b0 < a0 && a0 < b1 && b1 < a1) return "overlapped-by";
  return "equals";
}

/** Canonical B-placement realizing `rel` against fixed A, minimal-ish and
 *  keeping B's width where the relation allows. */
function realize(rel: Rel, a: RV, b: RV): RV {
  const a0 = Math.min(a.lo, a.hi);
  const a1 = Math.max(a.lo, a.hi);
  const wA = a1 - a0;
  const wB = Math.abs(b.hi - b.lo) || wA * 0.6;
  const gap = Math.max(4, wA * 0.25);
  const mk = (lo: number, hi: number): RV => ({ lo, hi });
  switch (rel) {
    case "before":
      return mk(a1 + gap, a1 + gap + wB);
    case "meets":
      return mk(a1, a1 + wB);
    case "overlaps":
      return mk(a0 + wA * 0.5, a1 + wA * 0.5);
    case "finished-by":
      return mk(a0 + wA * 0.4, a1);
    case "contains":
      return mk(a0 + wA * 0.25, a1 - wA * 0.25);
    case "starts":
      return mk(a0, a1 + wA * 0.5);
    case "equals":
      return mk(a0, a1);
    case "started-by":
      return mk(a0, a0 + wA * 0.5);
    case "during":
      return mk(a0 - wA * 0.25, a1 + wA * 0.25);
    case "finishes":
      return mk(a0 - wA * 0.5, a1);
    case "overlapped-by":
      return mk(a0 - wA * 0.5, (a0 + a1) / 2);
    case "met-by":
      return mk(a0 - wB, a0);
    case "after":
      return mk(a0 - gap - wB, a0 - gap);
  }
}

export class MdAllen extends Diagram {
  protected scene(s: Mount): void {
    const view = this.view(W, H);

    const T = 100;
    const x0 = 70;
    const x1 = 650;
    const xOf = (v: number) => x0 + (v / T) * (x1 - x0);
    const EPS = 1.6;

    const yA = 70;
    const yB = 110;
    const barH = 18;

    const A = range(34, 58);
    const B = range(62, 80);

    const rel = Allen.lens(
      [A, B] as const,
      ([a, b]) => classify(a, b, EPS),
      (target, [a, b]) => [SKIP, realize(target, a, b)],
    );

    // The bar drags the whole interval; endpoint handles resize. Each
    // on-track handle is a scalar chain pinned to the row: `.center`
    // body-drags (width preserved), `.lo` / `.hi` move the endpoints.
    const bar = (R: Writable<Range>, y: number, color: string) => {
      const onTrack = (n: Writable<Num>) =>
        vec(n.clamp(0, T).affine((x1 - x0) / T, x0), Num.pin(y));
      const body = onTrack(R.center);
      const barRect = rect(
        derive(() => xOf(Math.min(R.value.lo, R.value.hi))),
        y - barH / 2,
        derive(() => Math.abs(xOf(R.value.hi) - xOf(R.value.lo))),
        barH,
        { fill: color, corner: 4, stroke: "transparent", opacity: 0.85 },
      );
      s(barRect);
      drag(barRect, body);
      barRect.el.style.cursor = "grab";
      s(
        handle(onTrack(R.lo), { fill: "#222", r: 5 }),
        handle(onTrack(R.hi), { fill: "#222", r: 5 }),
      );
    };
    bar(A, yA, "#5b8def");
    bar(B, yB, "#e8833a");

    s(
      label(vec(x0 - 14, yA), "A", { size: 12, bold: true, align: Anchor.Right }),
      label(vec(x0 - 14, yB), "B", { size: 12, bold: true, align: Anchor.Right }),
      label(
        vec(view.center.value.x, 158),
        derive(() => `A ${rel.value} B`),
        {
          size: 16,
          bold: true,
          align: Anchor.Center,
        },
      ),
    );

    const COLS = 7;
    const CW = 96;
    const CH = 26;
    const gridX0 = (W - COLS * CW) / 2 + CW / 2;
    const gridY0 = 210;
    RELATIONS.forEach((r, i) => {
      const col = i % COLS;
      const row = Math.floor(i / COLS);
      const cx = gridX0 + col * CW;
      const cy = gridY0 + row * (CH + 10);
      const active = derive(() => rel.value === r);
      const g = group(
        { translate: vec(cx - CW / 2 + 4, cy - CH / 2) },
        rect(0, 0, CW - 8, CH, {
          corner: 7,
          fill: derive(() => (active.value ? "#2f6df0" : "rgba(150,150,150,0.12)")),
          stroke: derive(() => (active.value ? "#2f6df0" : "#bbb")),
          thin: true,
        }),
        label(vec((CW - 8) / 2, CH / 2), r, {
          size: 10,
          align: Anchor.Center,
          fill: derive(() => (active.value ? "#fff" : "#444")),
        }),
      );
      g.el.style.cursor = "pointer";
      g.on("click", () => {
        rel.value = r;
      });
      s(g);
    });

    s(
      label(
        view.top.down(18),
        "(Range, Range) → AllenRelation — a large domain projected onto 13 labels",
      ),
      label(
        view.bottom.up(12),
        "read = classify the two intervals · write a chip = reshape B into that relation (B's width kept where free)",
        { size: 10 },
      ),
    );
  }
}
