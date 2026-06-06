// Animation debugger: three time-aligned tracks (factory gantt, α(t) plot
// colored by author, claim pass/fail strips) over a buggy `intro` factory
// whose `nudge` overshoots α=1 — the violation is the lesson.

import {
  Anchor,
  type Animator,
  type AnyShape,
  cell,
  circle,
  Diagram,
  derive,
  forEach,
  group,
  label,
  line,
  loop,
  type Mount,
  type Num,
  pathD,
  type Read,
  rect,
  type Val,
  Vec,
  vec,
  type Writable,
} from "@bireactive";
import { authorOf, claim, record, type Span, scope } from "@bireactive/assert";

interface HasOpacity {
  opacity: Writable<Num>;
}

const fadeIn = scope("fadeIn", function* (s: HasOpacity, dur: number): Animator<void> {
  yield* s.opacity.to(1, dur);
});

const nudge = scope("nudge", function* (s: HasOpacity, delta: number): Animator<void> {
  // BUG: doesn't clamp; pushes opacity above 1.0 → claim violates.
  yield* s.opacity.to(s.opacity.peek() + delta, 0.18);
});

const fadeOut = scope("fadeOut", function* (s: HasOpacity, dur: number): Animator<void> {
  yield* s.opacity.to(0, dur);
});

const intro = scope("intro", function* (s: HasOpacity): Animator<void> {
  yield* fadeIn(s, 0.4);
  yield 0.2;
  yield* nudge(s, 0.4);
  yield 0.25;
  yield* fadeOut(s, 0.4);
});

const W = 600;
const H = 470;
const PAD_X = 16;

const HEADER_Y = 22;
const SUBHEAD_Y = 38;

const SCENE_Y = 56;
const SCENE_H = 56;

const TIMELINE_TOP = SCENE_Y + SCENE_H + 16;
const GANTT_W = W - 2 * PAD_X;
const GANTT_TRACK_H = 14;
const GANTT_TRACK_GAP = 3;

// Order matters for visual nesting — parent on top.
const TRACK_OF: Record<string, number> = {
  intro: 0,
  fadeIn: 1,
  nudge: 2,
  fadeOut: 3,
};
const N_GANTT_TRACKS = 4;
const GANTT_H = N_GANTT_TRACKS * (GANTT_TRACK_H + GANTT_TRACK_GAP);

const PLOT_TOP = TIMELINE_TOP + GANTT_H + 12;
const PLOT_H = 76;
const PLOT_BOT = PLOT_TOP + PLOT_H;

const CLAIMS_TOP = PLOT_BOT + 14;
const CLAIM_TRACK_H = 14;
const CLAIM_TRACK_GAP = 3;
const N_CLAIMS = 2;
const CLAIMS_H = N_CLAIMS * (CLAIM_TRACK_H + CLAIM_TRACK_GAP);
const CLAIMS_BOT = CLAIMS_TOP + CLAIMS_H;

const TRANSPORT_Y = CLAIMS_BOT + 14;
const BTN_W = 56;
const BTN_H = 24;

const FOOTER_Y = H - 14;

const FN_COLOR: Record<string, string> = {
  intro: "#a5c2f5",
  fadeIn: "#5b8def",
  nudge: "#e25c5c",
  fadeOut: "#7aa6f0",
};
const PASS = "#2ecc71";
const FAIL = "#e74c3c";
const NEUTRAL = "#bbb";

// ~120 covers ~2s at 60fps, plenty for the loop's intro window.
const SAMPLES = 120;
type Sample = {
  t: number;
  v: number;
  fn?: string;
  safe: boolean;
  reaches: boolean;
};

export class MdDebugger extends Diagram {
  protected scene(s: Mount): void {
    this.view(W, H);

    const playing = cell(true);
    const speed = cell(1);
    let stepBudget = 0;

    // Override `anim.step` so RAF still fires but our gate decides whether the
    // engine advances. Cast through `unknown` to patch an instance method.
    const origStep = this.anim.step.bind(this.anim);
    (this.anim as unknown as { step: (dt: number) => void }).step = (dt: number): void => {
      if (playing.peek()) {
        origStep(Math.min(dt, 0.032) * speed.peek());
      } else if (stepBudget > 0) {
        const consume = Math.min(stepBudget, 0.016);
        stepBudget -= consume;
        origStep(consume);
      }
    };

    record(this.anim);

    const c = s(
      circle(vec(W / 2, SCENE_Y + SCENE_H / 2), 22, {
        fill: "#5b8def",
        opacity: 0,
        stroke: "none",
      }),
    );

    const safe = claim(c.opacity, "α").stays.in([0, 1]).during(intro);
    const reaches = claim(c.opacity, "α").becomes.equal(1).during(intro);
    const allHold = derive(() => safe.value && reaches.value);

    // Registered before any writes so the writer signal is hooked up.
    const author = authorOf(c.opacity);

    const samples = cell<readonly Sample[]>([]);
    this.anim.onStep(() => {
      const arr = samples.peek();
      const next: Sample[] =
        arr.length >= SAMPLES ? arr.slice(arr.length - SAMPLES + 1) : arr.slice();
      next.push({
        t: this.anim.clock,
        v: c.opacity.peek(),
        fn: author.peek()?.name,
        safe: safe.peek(),
        reaches: reaches.peek(),
      });
      samples.value = next;
    });

    const winStart = derive(() => intro.last.value?.start ?? 0);
    const winEnd = derive(() => {
      const last = intro.last.value;
      const now = this.anim.clock;
      if (!last) return Math.max(1.6, now);
      const tail = (last.end ?? now) + 0.2;
      return Math.max(tail, last.start + 1.6);
    });
    const xScale = derive(() => GANTT_W / Math.max(0.001, winEnd.value - winStart.value));
    const xFor = (t: number): number => PAD_X + (t - winStart.value) * xScale.value;

    // Range [-0.1, 1.4] so the overshoot above 1.0 is visible.
    const plotYFor = (v: number): number => {
      const lo = -0.1;
      const hi = 1.4;
      return PLOT_BOT - ((v - lo) / (hi - lo)) * PLOT_H;
    };

    s(
      label(vec(PAD_X, HEADER_Y), "animation debugger", { bold: true, align: Anchor.Left }),
      label(
        vec(PAD_X, SUBHEAD_Y),
        "scope tags every factory · α(t) is colored by author · claim strips align with the gantt",
        { size: 9, align: Anchor.Left },
      ),
      label(
        vec(W - PAD_X, HEADER_Y),
        derive(() => {
          if (allHold.value) return "✓ all claims hold";
          if (!safe.value) {
            const last = intro.last.value;
            const arr = samples.value;
            const lo = winStart.value;
            let bad: Sample | undefined;
            for (const sample of arr) {
              if (sample.t < lo) continue;
              if (sample.v < 0 || sample.v > 1) {
                bad = sample;
                break;
              }
            }
            if (!bad || !last) return "✗ violated";
            return `✗ violated by ${bad.fn ?? "?"} at t+${(bad.t - last.start).toFixed(2)}s · α=${bad.v.toFixed(3)}`;
          }
          return "✗ violated";
        }),
        {
          size: 11,
          align: Anchor.Right,
          bold: true,
          fill: derive(() => (allHold.value ? PASS : FAIL)),
        },
      ),
    );

    Object.entries(TRACK_OF).forEach(([name, lane]) => {
      const y = TIMELINE_TOP + lane * (GANTT_TRACK_H + GANTT_TRACK_GAP);
      s(
        rect(PAD_X, y, GANTT_W, GANTT_TRACK_H, {
          fill: "#fafafa",
          stroke: "none",
        }),
      );
      // Faded: the lane is empty until a span shows up.
      s(
        label(vec(PAD_X + 4, y + GANTT_TRACK_H / 2 + 0.5), name, {
          size: 9,
          align: Anchor.Left,
          opacity: 0.4,
        }),
      );
    });

    // Every span whose ancestor chain includes `last`. Walking via parent
    // back-links is O(N²) but N is tiny. Reading `intro.last` tracks
    // `traceVersion`, so a new span open dirties this computed transitively.
    const visibleSpans = derive<readonly Span[]>(() => {
      const last = intro.last.value;
      if (!last) return [];
      const out: Span[] = [last];
      for (const fn of [fadeIn, nudge, fadeOut] as const) {
        const list = fn.last.value ? [fn.last.value] : [];
        for (const span of list) {
          if (!span) continue;
          let cur = span.parent;
          while (cur) {
            if (cur === last) {
              out.push(span);
              break;
            }
            cur = cur.parent;
          }
        }
      }
      return out;
    });

    forEach(
      s.root,
      visibleSpans,
      span => {
        const lane = TRACK_OF[span.name] ?? 0;
        const y = TIMELINE_TOP + lane * (GANTT_TRACK_H + GANTT_TRACK_GAP);
        const x = derive(() => xFor(span.start));
        const w = derive(() => {
          const end = span.end ?? this.anim.clock;
          return Math.max(2, (end - span.start) * xScale.value);
        });
        const fill = FN_COLOR[span.name] ?? "#888";
        const bar = rect(x, y, w, GANTT_TRACK_H, {
          fill,
          opacity: derive(() => (span.end === undefined ? 0.7 : 0.92)),
          corner: 2,
          stroke: "none",
        });
        // Don't use `bar.left.right(5)` here: that's a writable anchor
        // whose getter chain reads bar.transform, and the box's box
        // changes propagate into the label's box, which propagates into
        // bar's group geometry — alien-signals' Lens-bind machinery can
        // get into a write loop. Use a direct computed position instead.
        const labelPos = Vec.derive(() => ({
          x: xFor(span.start) + 5,
          y: y + GANTT_TRACK_H / 2 + 0.5,
        }));
        const tagShape = label(labelPos, span.name, {
          size: 9,
          align: Anchor.Left,
          fill: "white",
        });
        return [bar, tagShape];
      },
      { key: span => span },
    );

    s(
      label(vec(PAD_X, PLOT_TOP - 6), "α(t) — colored by author", {
        size: 9,
        align: Anchor.Left,
      }),
      rect(PAD_X, PLOT_TOP, GANTT_W, PLOT_H, {
        fill: "#fafafa",
        stroke: "#ececec",
        corner: 3,
      }),
      // y=1: the claim bound.
      line(vec(PAD_X, plotYFor(1)), vec(PAD_X + GANTT_W, plotYFor(1)), {
        stroke: FAIL,
        opacity: 0.5,
        thin: true,
        dashed: true,
      }),
      line(vec(PAD_X, plotYFor(0)), vec(PAD_X + GANTT_W, plotYFor(0)), {
        stroke: NEUTRAL,
        opacity: 0.4,
        thin: true,
      }),
    );

    const windowed = derive(() => {
      const arr = samples.value;
      const lo = winStart.value;
      return arr.filter(sample => sample.t >= lo);
    });

    // One <path> per author color (vs ~3000 bind-effects with per-segment
    // lines), so the engine's flush stack stays shallow.
    const authorNames = Object.keys(FN_COLOR);
    for (const fnName of authorNames) {
      const dStr = derive(() => {
        const arr = windowed.value;
        const parts: string[] = [];
        let inSeg = false;
        for (let i = 0; i < arr.length - 1; i++) {
          const a = arr[i];
          const b = arr[i + 1];
          if (a.fn !== fnName) {
            inSeg = false;
            continue;
          }
          const ax = xFor(a.t);
          const ay = plotYFor(a.v);
          const bx = xFor(b.t);
          const by = plotYFor(b.v);
          if (!inSeg) {
            parts.push(`M${ax.toFixed(2)} ${ay.toFixed(2)}`);
            inSeg = true;
          }
          parts.push(`L${bx.toFixed(2)} ${by.toFixed(2)}`);
        }
        return parts.join(" ");
      });
      s(pathD(dStr, { stroke: FN_COLOR[fnName], thin: true }));
    }
    const dGray = derive(() => {
      const arr = windowed.value;
      const parts: string[] = [];
      let inSeg = false;
      for (let i = 0; i < arr.length - 1; i++) {
        const a = arr[i];
        const b = arr[i + 1];
        if (a.fn !== undefined) {
          inSeg = false;
          continue;
        }
        const ax = xFor(a.t);
        const ay = plotYFor(a.v);
        const bx = xFor(b.t);
        const by = plotYFor(b.v);
        if (!inSeg) {
          parts.push(`M${ax.toFixed(2)} ${ay.toFixed(2)}`);
          inSeg = true;
        }
        parts.push(`L${bx.toFixed(2)} ${by.toFixed(2)}`);
      }
      return parts.join(" ");
    });
    s(pathD(dGray, { stroke: "#bbb", thin: true }));

    const claimRows = [
      { name: "α stays in [0, 1]", pick: (sm: Sample) => sm.safe },
      { name: "α reaches 1", pick: (sm: Sample) => sm.reaches },
    ] as const;

    claimRows.forEach((row, i) => {
      const y = CLAIMS_TOP + i * (CLAIM_TRACK_H + CLAIM_TRACK_GAP);
      s(
        rect(PAD_X, y, GANTT_W, CLAIM_TRACK_H, {
          fill: "#fafafa",
          stroke: "none",
          corner: 2,
        }),
        label(vec(PAD_X + 4, y + CLAIM_TRACK_H / 2 + 0.5), row.name, {
          size: 9,
          align: Anchor.Left,
        }),
      );

      const passD = derive(() => runsPath(windowed.value, row.pick, true, xFor, y, CLAIM_TRACK_H));
      const failD = derive(() => runsPath(windowed.value, row.pick, false, xFor, y, CLAIM_TRACK_H));
      s(pathD(passD, { fill: PASS, stroke: "none" }), pathD(failD, { fill: FAIL, stroke: "none" }));
    });

    const cursorX = derive(() => xFor(this.anim.clock));
    const cursorD = derive(() => {
      const x = cursorX.value.toFixed(2);
      return `M${x} ${TIMELINE_TOP - 3} L${x} ${CLAIMS_BOT + 3}`;
    });
    s(pathD(cursorD, { stroke: "#222", thin: true }));

    const playPause = chunkButton(
      vec(PAD_X, TRANSPORT_Y),
      derive(() => (playing.value ? "⏸ pause" : "▶ play")),
      derive(() => false),
      () => {
        playing.value = !playing.value;
      },
      BTN_W + 14,
    );
    s(playPause);

    const stepBtn = chunkButton(
      vec(PAD_X + BTN_W + 14 + 6, TRANSPORT_Y),
      "▏▶ step",
      derive(() => false),
      () => {
        playing.value = false;
        stepBudget += 0.016;
      },
      BTN_W,
    );
    s(stepBtn);

    const speeds = [0.25, 1, 2] as const;
    const speedX = PAD_X + BTN_W + 14 + 6 + BTN_W + 26;
    speeds.forEach((sp, i) => {
      const x = speedX + i * (BTN_W + 4);
      const isActive = derive(() => speed.value === sp);
      s(
        chunkButton(
          vec(x, TRANSPORT_Y),
          `${sp}×`,
          isActive,
          () => {
            speed.value = sp;
          },
          BTN_W,
        ),
      );
    });

    s(
      label(
        vec(W - PAD_X, TRANSPORT_Y + BTN_H / 2),
        derive(() => {
          const last = intro.last.value;
          if (!last) return `t = 0.00`;
          const t = Math.max(0, this.anim.clock - last.start);
          return `t = ${t.toFixed(2)}s`;
        }),
        { size: 11, align: Anchor.Right, opacity: 0.7 },
      ),
    );

    s(
      label(
        vec(W / 2, FOOTER_Y),
        "intro → fadeIn → nudge (overshoots) → fadeOut · pause and step to inspect the violation",
        { size: 10 },
      ),
    );

    this.anim.start(
      loop(function* () {
        yield* intro(c);
        yield 0.6;
      }),
    );
  }
}

/** Build a path string covering all maximal contiguous runs of
 *  samples where `pick(sample) === target`. Each run becomes a
 *  rectangle at the given y / height. */
function runsPath(
  arr: readonly Sample[],
  pick: (s: Sample) => boolean,
  target: boolean,
  xFor: (t: number) => number,
  y: number,
  h: number,
): string {
  const parts: string[] = [];
  let runStart = -1;
  for (let i = 0; i < arr.length; i++) {
    const ok = pick(arr[i]) === target;
    if (ok && runStart < 0) runStart = i;
    if ((!ok || i === arr.length - 1) && runStart >= 0) {
      const endIdx = ok ? i : i - 1;
      const xs = xFor(arr[runStart].t);
      const xe = xFor(arr[endIdx].t);
      const w = Math.max(1, xe - xs);
      parts.push(`M${xs.toFixed(2)} ${y} h${w.toFixed(2)} v${h} h${(-w).toFixed(2)} Z`);
      runStart = -1;
    }
  }
  return parts.join(" ");
}

/** Toggle/action button with an `active` highlight. The library's
 *  `button()` doesn't expose fill/border styling for active state,
 *  so we hand-roll a thin variant here. */
function chunkButton(
  pos: Vec,
  content: Val<string>,
  active: Read<boolean>,
  onClick: () => void,
  width: number = BTN_W,
): AnyShape {
  const g = group(
    { translate: pos },
    rect(0, 0, width, BTN_H, {
      fill: derive(() => (active.value ? "#dceaff" : "#ffffff")),
      stroke: "#222",
      thin: true,
      corner: 4,
    }),
    label(vec(width / 2, BTN_H / 2 + 1), content),
  );
  g.on("click", onClick);
  g.el.style.cursor = "pointer";
  return g;
}
