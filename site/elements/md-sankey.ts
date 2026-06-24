// A Sankey diagram with a cycle. Flow fans out from a hub through three
// parallel branches into a collector, part of it recirculates around the
// bottom back to the hub, and the rest leaves as output. Node conservation
// (in = out) holds everywhere, so the picture is pinned by four free
// quantities — the three branch flows and the recirculation — and every
// other width (hub/collector throughput, the input stub) derives from them.
//
// Those four are the roots; widths are lenses over them. Each branch flow is
// the throughput of its node, so dragging a branch's bar height writes it
// directly; dragging the hub/collector scales all three at once; dragging the
// return band sets how much recirculates (the input fills the remainder).
// Conservation is the coordinate system, not a constraint to solve.

import { Diagram, derive, handle, label, type Mount, num, pathD, SKIP, Vec } from "@bireactive";

// ── Layout constants ────────────────────────────────────────────────────
const S = 0.62; // px of band width per unit flow
const BW = 16; // node bar width
const HBW = BW / 2;
const X0 = 150; // hub column
const X1 = 410; // branch column
const X2 = 670; // collector column
const YC = 210; // vertical centre line
const GAP = 116; // branch spacing
const Y1 = YC - GAP; // top branch
const Y2 = YC + GAP; // bottom branch
const XL = 52; // feedback wrap, left
const XR = 768; // feedback wrap, right
const YB = 446; // feedback bottom run
const EXT_L = 96; // input stub start x
const EXT_R = 724; // output stub end x
const XMID = (XL + XR) / 2;

// ── Palette ─────────────────────────────────────────────────────────────
const C_HUB = "#6b7cff";
const C_TOP = "#2bb6a3";
const C_MID = "#f2b134";
const C_BOT = "#e8705b";
const C_COL = "#5566cc";
const C_EXT = "#9aa3b2";
const RIBBON_OP = 0.42;

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

// Bounds that keep the picture legible: a per-branch cap below (GAP − margin)/S
// guarantees adjacent bars never collide, and the feedback cap below keeps the
// return band clear of the bottom branch and its label.
const FLOW_MIN = 14;
const FLOW_MAX = 150;
const LBL = 9; // gap between a label and the edge it tracks

// ── Path builders ─────────────────────────────────────────────────────────
/** Rounded node bar. */
function barPath(cx: number, cy: number, h: number): string {
  const r = Math.min(3, HBW, h / 2);
  const x = cx - HBW;
  const y = cy - h / 2;
  const w = BW;
  return (
    `M ${x + r} ${y} h ${w - 2 * r} a ${r} ${r} 0 0 1 ${r} ${r} v ${h - 2 * r} ` +
    `a ${r} ${r} 0 0 1 ${-r} ${r} h ${-(w - 2 * r)} a ${r} ${r} 0 0 1 ${-r} ${-r} ` +
    `v ${-(h - 2 * r)} a ${r} ${r} 0 0 1 ${r} ${-r} Z`
  );
}

/** Constant-width horizontal Sankey ribbon (two mirrored cubics). */
function ribbon(sx: number, sy: number, tx: number, ty: number, w: number): string {
  const h = w / 2;
  const xm = (sx + tx) / 2;
  return (
    `M ${sx} ${sy - h} C ${xm} ${sy - h} ${xm} ${ty - h} ${tx} ${ty - h} ` +
    `L ${tx} ${ty + h} C ${xm} ${ty + h} ${xm} ${sy + h} ${sx} ${sy + h} Z`
  );
}

function arcPts(cx: number, cy: number, r: number, a0: number, a1: number, k: number) {
  const out: { x: number; y: number }[] = [];
  for (let i = 0; i <= k; i++) {
    const t = ((a0 + ((a1 - a0) * i) / k) * Math.PI) / 180;
    out.push({ x: cx + r * Math.cos(t), y: cy + r * Math.sin(t) });
  }
  return out;
}

/** Centreline for the feedback loop: out of the collector, around the
 *  bottom with rounded corners, back into the hub. */
function feedbackCenter(sy: number, ty: number, rC: number) {
  const sx = X2 + HBW;
  const tx = X0 - HBW;
  let p: { x: number; y: number }[] = [{ x: sx, y: sy }];
  p.push({ x: XR - rC, y: sy });
  p = p.concat(arcPts(XR - rC, sy + rC, rC, -90, 0, 8));
  p.push({ x: XR, y: YB - rC });
  p = p.concat(arcPts(XR - rC, YB - rC, rC, 0, 90, 8));
  p.push({ x: XL + rC, y: YB });
  p = p.concat(arcPts(XL + rC, YB - rC, rC, 90, 180, 8));
  p.push({ x: XL, y: ty + rC });
  p = p.concat(arcPts(XL + rC, ty + rC, rC, 180, 270, 8));
  p.push({ x: tx, y: ty });
  // Drop consecutive duplicates from arc/segment seams.
  return p.filter((q, i) => i === 0 || Math.hypot(q.x - p[i - 1]!.x, q.y - p[i - 1]!.y) > 0.01);
}

/** Offset a centreline by ±w/2 into a filled band. */
function bandFrom(pts: { x: number; y: number }[], w: number): string {
  const n = pts.length;
  const h = w / 2;
  const nrm = (i: number) => {
    const p0 = pts[Math.max(0, i - 1)]!;
    const p1 = pts[Math.min(n - 1, i + 1)]!;
    const tx = p1.x - p0.x;
    const ty = p1.y - p0.y;
    const L = Math.hypot(tx, ty) || 1;
    return { x: -ty / L, y: tx / L };
  };
  let d = "";
  for (let i = 0; i < n; i++) {
    const v = nrm(i);
    d += `${i === 0 ? "M" : "L"} ${pts[i]!.x + v.x * h} ${pts[i]!.y + v.y * h} `;
  }
  for (let i = n - 1; i >= 0; i--) {
    const v = nrm(i);
    d += `L ${pts[i]!.x - v.x * h} ${pts[i]!.y - v.y * h} `;
  }
  return `${d}Z`;
}

export class MdSankey extends Diagram {
  protected scene(s: Mount): void {
    const view = this.view(820, 530);

    // Roots: three branch flows + the recirculation.
    const a = num(86); // top branch
    const c = num(72); // middle branch
    const b = num(60); // bottom branch
    const fb = num(96); // recirculation

    // Derived geometry: stacked face centres for every ribbon, in one place.
    const geo = derive(() => {
      const av = a.value;
      const bv = b.value;
      const cv = c.value;
      const tot = av + bv + cv;
      const fbv = clamp(fb.value, 0, tot);
      const ext = tot - fbv;
      const wT = tot * S;
      const top = YC - wT / 2;
      // hub/collector right/left stacks share the order top→mid→bottom.
      const ya = top + (av * S) / 2;
      const yc = top + (av + cv / 2) * S;
      const yb = top + (av + cv + bv / 2) * S;
      // hub left / collector right: input(top) then feedback(below).
      const yIn = top + (ext * S) / 2;
      const yFb = top + (ext + fbv / 2) * S;
      return {
        tot,
        fbv,
        ext,
        wT,
        e0: ribbon(X0 + HBW, ya, X1 - HBW, Y1, av * S),
        e1: ribbon(X0 + HBW, yb, X1 - HBW, Y2, bv * S),
        e2: ribbon(X0 + HBW, yc, X1 - HBW, YC, cv * S),
        e3: ribbon(X1 + HBW, Y1, X2 - HBW, ya, av * S),
        e4: ribbon(X1 + HBW, Y2, X2 - HBW, yb, bv * S),
        e5: ribbon(X1 + HBW, YC, X2 - HBW, yc, cv * S),
        extIn: ribbon(EXT_L, yIn, X0 - HBW, yIn, ext * S),
        extOut: ribbon(X2 + HBW, yIn, EXT_R, yIn, ext * S),
        feedback: bandFrom(feedbackCenter(yFb, yFb, Math.max(30, (fbv * S) / 2 + 14)), fbv * S),
        bars: {
          hub: barPath(X0, YC, wT),
          col: barPath(X2, YC, wT),
          t: barPath(X1, Y1, av * S),
          m: barPath(X1, YC, cv * S),
          b: barPath(X1, Y2, bv * S),
        },
      };
    });

    // ── Ribbons (under the bars) ──
    const rib = (pick: (g: typeof geo.value) => string, color: string) =>
      s(
        pathD(
          derive(() => pick(geo.value)),
          { fill: color, opacity: RIBBON_OP, stroke: "none" },
        ),
      );
    rib(g => g.extIn, C_EXT);
    rib(g => g.feedback, C_COL);
    rib(g => g.e0, C_HUB);
    rib(g => g.e1, C_HUB);
    rib(g => g.e2, C_HUB);
    rib(g => g.e3, C_TOP);
    rib(g => g.e4, C_BOT);
    rib(g => g.e5, C_MID);
    rib(g => g.extOut, C_COL);

    // ── Node bars ──
    const bar = (pick: (g: typeof geo.value) => string, color: string) =>
      s(
        pathD(
          derive(() => pick(geo.value)),
          { fill: color, stroke: "none" },
        ),
      );
    bar(g => g.bars.hub, C_HUB);
    bar(g => g.bars.col, C_COL);
    bar(g => g.bars.t, C_TOP);
    bar(g => g.bars.m, C_MID);
    bar(g => g.bars.b, C_BOT);

    // ── Drag handles (bar tops set flows; bottom band sets recirculation) ──
    const GRIP = "#334155";

    // A branch's bar height is its flow, so this writes the flow directly.
    // The cap keeps adjacent bars from colliding; the floor keeps it grabbable.
    const branchHandle = (cell: typeof a, yc0: number) =>
      handle(
        Vec.lens(
          [cell],
          ([v]) => ({ x: X1, y: yc0 - (v * S) / 2 }),
          t => [clamp(((yc0 - t.y) * 2) / S, FLOW_MIN, FLOW_MAX)],
        ),
        { r: 5, fill: GRIP, cursor: "ns-resize" },
      );
    s(branchHandle(a, Y1), branchHandle(c, YC), branchHandle(b, Y2));

    // Hub / collector scale all three branches proportionally, with the scale
    // factor clamped so no branch leaves [FLOW_MIN, FLOW_MAX].
    const scaleHandle = (x: number) =>
      handle(
        Vec.lens(
          [a, b, c],
          ([av, bv, cv]) => ({ x, y: YC - ((av + bv + cv) * S) / 2 }),
          (t, [av, bv, cv]) => {
            const tot = av + bv + cv;
            const want = ((YC - t.y) * 2) / S;
            let k = tot > 0 ? want / tot : 1;
            k = Math.min(k, FLOW_MAX / Math.max(av, bv, cv));
            k = Math.max(k, FLOW_MIN / Math.min(av, bv, cv));
            return [av * k, bv * k, cv * k];
          },
        ),
        { r: 5, fill: GRIP, cursor: "ns-resize" },
      );
    s(scaleHandle(X0), scaleHandle(X2));

    // Recirculation: drag the bottom run (input absorbs the remainder). Capped
    // at the throughput and kept clear of the bottom branch bar + its label.
    s(
      handle(
        Vec.lens(
          [fb, a, b, c],
          ([fv, av, bv, cv]) => ({ x: XMID, y: YB - (clamp(fv, 0, av + bv + cv) * S) / 2 }),
          (t, [, av, bv, cv]) => {
            const cBottom = Y2 + (bv * S) / 2;
            const limit = Math.min(av + bv + cv, Math.max(0, ((YB - cBottom - LBL - 16) * 2) / S));
            return [clamp(((YB - t.y) * 2) / S, 0, limit), SKIP, SKIP, SKIP];
          },
        ),
        { r: 5, fill: GRIP, cursor: "ns-resize" },
      ),
    );

    // ── Labels (each tracks the edge it names) ──
    const tot = () => a.value + b.value + c.value;
    const stubY = () => YC - (clamp(fb.value, 0, tot()) * S) / 2; // input/output stub centre
    const at = (fn: () => { x: number; y: number }) => Vec.derive(fn);
    s(
      label(
        at(() => ({ x: EXT_L - 6, y: stubY() })),
        "input",
        { size: 11, align: { x: 1, y: 0.5 } },
      ),
      label(
        at(() => ({ x: EXT_R + 6, y: stubY() })),
        "output",
        { size: 11, align: { x: 0, y: 0.5 } },
      ),
      label(
        at(() => ({ x: X1, y: Y1 - (a.value * S) / 2 - LBL })),
        "A",
        {
          size: 12,
          bold: true,
          align: { x: 0.5, y: 1 },
        },
      ),
      label(
        at(() => ({ x: X1, y: YC - (c.value * S) / 2 - LBL })),
        "B",
        {
          size: 12,
          bold: true,
          align: { x: 0.5, y: 1 },
        },
      ),
      label(
        at(() => ({ x: X1, y: Y2 + (b.value * S) / 2 + LBL })),
        "C",
        {
          size: 12,
          bold: true,
          align: { x: 0.5, y: 0 },
        },
      ),
      label(
        at(() => ({ x: X0, y: YC - (tot() * S) / 2 - LBL })),
        "hub",
        {
          size: 11,
          align: { x: 0.5, y: 1 },
        },
      ),
      label(
        at(() => ({ x: X2, y: YC - (tot() * S) / 2 - LBL })),
        "collector",
        {
          size: 11,
          align: { x: 0.5, y: 1 },
        },
      ),
      label(
        at(() => ({ x: XMID, y: YB + (clamp(fb.value, 0, tot()) * S) / 2 + LBL })),
        "recirculation",
        {
          size: 10,
          bold: true,
          align: { x: 0.5, y: 0 },
        },
      ),
    );
    s(
      label(
        view.top.down(18),
        "drag a branch to resize it · drag the hub or collector to scale all flow · drag the return band to set how much recirculates",
        { size: 11 },
      ),
    );
  }
}
