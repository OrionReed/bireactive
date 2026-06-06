// Code morph + token animation on the monospace substrate: parts are
// positioned spans animated with `.to(...)`; cut/uncut carve and merge
// regions; highlights ride CSS Custom Highlights so repaints don't drop them.

import { type Content, cell, css, Diagram, label, loop, type Mount } from "@bireactive";
import { type CodeShape, code, codeStyles, type Part } from "@bireactive/code";

const STATES = [
  `function* fadeOut(opacity, secs) {
  let t = 0;
  while (t < secs) {
    const dt = yield;
    t += dt;
    opacity.value = 1 - t / secs;
  }
}`,
  `function* drive(dur, step) {
  let t = 0;
  while (t < dur) {
    const dt = yield;
    t += dt;
    step(t / dur);
  }
}

function* fadeOut(opacity, secs) {
  yield* drive(secs, u => opacity.value = 1 - u);
}`,
  `let t = 0;

function* drive(dur, step) {
  while (t < dur) {
    const dt = yield;
    t += dt;
    step(t / dur);
  }
}

function* fadeOut(opacity, secs) {
  yield* drive(secs, u => opacity.value = 1 - u);
}`,
];

const PULSE = "bireactive-code-pulse";
const UNDERLINE = "bireactive-code-underline";

/** Find the first part containing `text`. Returns the part plus the
 *  start/end character offsets within its text, or null. */
function findInCode(c: CodeShape, text: string): { part: Part; start: number; end: number } | null {
  for (const p of c.parts) {
    const i = p.text.indexOf(text);
    if (i >= 0) return { part: p, start: i, end: i + text.length };
  }
  return null;
}

/** Add a Range over `[start, end)` chars of the part's text node to
 *  the named Custom Highlight. Returns a disposer. */
function highlightRange(part: Part, start: number, end: number, name: string): () => void {
  if (typeof CSS === "undefined" || !("highlights" in CSS)) return () => {};
  const tn = part.el.firstChild;
  if (!tn || tn.nodeType !== Node.TEXT_NODE) return () => {};
  const r = new Range();
  try {
    r.setStart(tn as Text, start);
    r.setEnd(tn as Text, end);
  } catch {
    return () => {};
  }
  let h = CSS.highlights.get(name);
  if (!h) {
    h = new Highlight();
    CSS.highlights.set(name, h);
  }
  h.add(r);
  return () => h?.delete(r);
}

export class MdCode extends Diagram {
  static styles = css`
    ${codeStyles}

    ::highlight(${PULSE}) {
      background: rgba(255, 220, 80, 0.55);
      border-radius: 2px;
    }
    ::highlight(${UNDERLINE}) {
      text-decoration: underline wavy var(--prettylights-keyword, #cf222e);
      text-decoration-thickness: 1.5px;
    }
  `;

  protected scene(s: Mount): void {
    const view = this.view(680, 400);

    const status = cell<Content>("");

    s(
      label(view.top.down(20), "code — morph + token animation"),
      label(view.bottom.up(20), status),
    );

    const c = s(code(STATES[0], { size: 13, translate: { x: 40, y: 48 } }));

    this.anim.start(
      loop(function* () {
        yield 1.0;

        status.value = "highlight — flash background on a token";
        yield 0.4;
        for (const txt of ["opacity", "secs"]) {
          const found = findInCode(c, txt);
          if (!found) continue;
          const dispose = highlightRange(found.part, found.start, found.end, PULSE);
          yield 0.4;
          dispose();
          yield 0.15;
        }
        yield 0.5;

        status.value = "pluck — cut, animate, uncut";
        yield 0.4;
        const yieldFound = findInCode(c, "yield");
        if (yieldFound) {
          const subs = c.cut(yieldFound.part, [yieldFound.start, yieldFound.end]);
          const middle = yieldFound.start > 0 ? subs[1] : subs[0];
          const home = middle.position.peek();
          yield [
            middle.position.to({ x: home.x, y: home.y - 10 }, 0.25),
            middle.rotation.to(0.18, 0.25),
          ];
          yield 0.6;
          yield [middle.position.to(home, 0.25), middle.rotation.to(0, 0.25)];
          c.uncut(subs);
        }
        yield 0.5;

        status.value = "morph — extract a loop generator (body collapses to one line)";
        yield* c.morphTo(STATES[1], 0.9);
        yield 0.8;

        status.value = "underline — persistent decoration";
        yield 0.4;
        const callFound = findInCode(c, "yield* drive");
        if (callFound) {
          const dispose = highlightRange(callFound.part, callFound.start, callFound.end, UNDERLINE);
          yield 1.0;
          dispose();
        }
        yield 0.5;

        status.value = "morph — lift `let t = 0` out (line moves, indent shrinks)";
        yield* c.morphTo(STATES[2], 0.9);
        yield 0.8;

        status.value = "cascade — sequence of highlights";
        yield 0.4;
        for (const txt of ["let t = 0", "t < dur", "t += dt", "step(t / dur)"]) {
          const found = findInCode(c, txt);
          if (!found) continue;
          const dispose = highlightRange(found.part, found.start, found.end, PULSE);
          yield 0.35;
          dispose();
          yield 0.05;
        }
        yield 0.8;

        status.value = "morph — back to the start";
        yield* c.morphTo(STATES[0], 0.9);
        yield 0.8;
      }),
    );
  }
}
