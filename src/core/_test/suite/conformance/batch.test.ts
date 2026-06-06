// Batched view writes — single-parent lenses run the backward walk
// eagerly inside a batch: `_writeSource` stages the source (Dirty +
// pending) and defers only the flush, so the source's pending value gives
// last-write-wins and write-then-read consistency without a queue.

import { describe, expect, it } from "vitest";
import { bireactive } from "../adapters/bireactive";

const identityView = (init: number) => {
  const source = bireactive.signal(init);
  const view = bireactive.lens(
    source,
    x => x,
    nv => nv,
  );
  return { source, view };
};

describe("batched view writes", () => {
  it("last write wins when the final value differs from baseline", () => {
    const { source, view } = identityView(0);
    bireactive.batch(() => {
      view.write(5);
      view.write(9);
    });
    expect(source.read()).toBe(9);
  });

  it("a revert to the pre-batch value lands (write 5 then 0 ⇒ source 0)", () => {
    const { source, view } = identityView(0);
    bireactive.batch(() => {
      view.write(5);
      view.write(0);
    });
    expect(source.read()).toBe(0);
  });

  it("a view is write-then-read consistent inside a batch", () => {
    const { view } = identityView(0);
    let seen = Number.NaN;
    bireactive.batch(() => {
      view.write(7);
      seen = view.read();
    });
    expect(seen).toBe(7);
  });
});
