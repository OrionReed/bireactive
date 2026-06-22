// Str primitive throughput: the slimmed core (`trim` / `reverse` / `slice` /
// `split`) plus the `caseFold` free lens. Reads measure forward derivation;
// the write groups measure backward propagation (segment → source, fold →
// source) — the complement work that used to live on `Str` itself.

import "../_test/setup";
import { type Cell, caseFold, str, type Writable } from "@bireactive/core";
import { bench, do_not_optimize, group, run } from "mitata";

const WORDS = "The Quick Brown Fox Jumps Over The Lazy Dog".split(" ");
const sentence = Array.from({ length: 40 }, (_, i) => WORDS[i % WORDS.length]).join(" ");

group(`Str forward reads (sentence: ${sentence.length} chars)`, () => {
  {
    const s = str(`   ${sentence}   `);
    const t = s.trim();
    t.value;
    bench("trim", () => do_not_optimize(t.value));
  }
  {
    const s = str(sentence);
    const f = caseFold(s);
    f.value;
    bench("caseFold (lower)", () => do_not_optimize(f.value));
  }
  {
    const s = str(sentence);
    const r = s.reverse();
    r.value;
    bench("reverse", () => do_not_optimize(r.value));
  }
  {
    const s = str(sentence);
    const w = s.split(/\s+/);
    w.length.value;
    bench("split (words) → length", () => do_not_optimize(w.length.value));
  }
});

group("Str backward writes (complement work)", () => {
  {
    const s = str(sentence);
    const f = caseFold(s);
    f.value;
    bench("caseFold write-back (case recovery)", () => {
      f.value = f.peek();
      do_not_optimize(s.peek());
    });
  }
  {
    const s = str(sentence);
    const w = s.split(/\s+/);
    const seg = w.cells[3]! as Writable<Cell<string>>;
    bench("split segment edit → source rebuild", () => {
      seg.value = seg.peek() === "Fox" ? "Cat" : "Fox";
      do_not_optimize(s.peek());
    });
  }
  {
    const s = str(sentence);
    const w = s.split(/\s+/);
    bench("split structural move → source rebuild", () => {
      w.move(w.cells[0]!, w.cells.length - 1);
      do_not_optimize(s.peek());
    });
  }
});

await run({ format: "mitata" });
