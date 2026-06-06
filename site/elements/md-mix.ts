import {
  circle,
  Diagram,
  derive,
  driven,
  easeInOut,
  label,
  loop,
  type Mount,
  num,
  rect,
  tween,
  Vec,
  vec,
} from "@bireactive";

export class MdMix extends Diagram {
  protected scene(s: Mount): void {
    const view = this.view(560, 360);
    const cx = view.center.value.x;
    const cy = view.center.value.y - 14;

    const t = num(0);
    this.anim.start(driven(t, (dt, _, cur) => cur + dt));
    const seqA = Vec.derive(() => ({
      x: cx + 95 * Math.cos(t.value * 1.4),
      y: cy + 70 * Math.sin(t.value * 1.4),
    }));

    const STAR_R = 95;
    const star = (i: number) => {
      const a = (i / 4) * Math.PI * 2 - Math.PI / 2;
      return { x: cx + STAR_R * Math.cos(a), y: cy + STAR_R * Math.sin(a) };
    };
    const seqB = vec(star(0).x, star(0).y);
    this.anim.start(
      loop(function* () {
        yield* tween(seqB, star(2), 0.6, easeInOut);
        yield* tween(seqB, star(0), 0.6, easeInOut);
        yield* tween(seqB, star(3), 0.6, easeInOut);
        yield* tween(seqB, star(1), 0.6, easeInOut);
      }),
    );

    const w = num(0);
    this.anim.start(
      loop(function* () {
        yield* tween(w, 1, 4, easeInOut);
        yield 1.0;
        yield* tween(w, 0, 4, easeInOut);
        yield 1.0;
      }),
    );

    const blend = Vec.derive([seqA, seqB, w] as const, vals => {
      const [a, b, wv] = vals;
      return {
        x: a.x * (1 - wv) + b.x * wv,
        y: a.y * (1 - wv) + b.y * wv,
      };
    });

    s(
      circle(seqA, 5, {
        fill: "#5b8def",
        opacity: derive(() => 0.2 + 0.55 * (1 - w.value)),
      }),
      circle(seqB, 5, {
        fill: "#e25c5c",
        opacity: derive(() => 0.2 + 0.55 * w.value),
      }),
    );

    s(
      rect(-10, -10, 20, 20, {
        translate: blend,
        fill: "#1a1a1a",
        corner: 4,
      }),
    );

    const SLIDER_W = 240;
    const SLIDER_X0 = cx - SLIDER_W / 2;
    const SLIDER_Y = view.h.value - 38;
    s(
      rect(SLIDER_X0, SLIDER_Y - 1, SLIDER_W, 2, {
        fill: "rgba(127,127,127,0.3)",
        aside: true,
      }),
    );
    s(circle(vec(w.affine(SLIDER_W, SLIDER_X0), SLIDER_Y), 6, { fill: "#1a1a1a" }));

    s(
      label(
        view.top.down(20),
        "two looping sequences (orbit · star-tween) blended via Vec.derive([a, b, w], weightedMean)",
      ),
      label(
        view.bottom.up(64),
        "weight cycles 0 ↔ 1 over ~10s; the blend is the per-frame weighted mean",
        { size: 10 },
      ),
    );
  }
}
