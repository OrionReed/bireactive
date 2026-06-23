// Reg throughput: the regex-lens algebra's forward (parse) and backward
// (reflective print) work, plus the cost of `bind` compilation and the
// abstraction tax vs the hand-rolled `Str.split`. Reg is a description that
// compiles to one lens; these measure that compiled lens at work.

import "../_test/setup";
import { type Arr, type Cell, Reg, str, type Writable } from "@bireactive/core";
import { bench, do_not_optimize, group, run } from "mitata";

// A key=value config block: `k1 = v1\nk2 = v2 …`.
const N = 40;
const kvGrammar = Reg.copy(/\w+/)
  .as("key")
  .then(Reg.lit(" = "), Reg.copy(/[^\n]*/).as("val"))
  .star(Reg.lit("\n"));
const csvGrammar = Reg.copy(/[^,]*/).star(Reg.lit(",")).as("cells");

const kvText = Array.from({ length: N }, (_, i) => `key${i} = value${i}`).join("\n");
const csvText = Array.from({ length: N }, (_, i) => `field${i}`).join(",");

group(`Reg pure parse / print (N=${N} records)`, () => {
  const r = kvGrammar;
  const v = r.match(kvText)!;
  bench("match (parse)", () => do_not_optimize(r.match(kvText)));
  bench("print (reflective)", () => do_not_optimize(r.print(v)));
});

group(`Reg.view forward / backward (N=${N})`, () => {
  {
    const s = str(kvText);
    const view = kvGrammar.view(s);
    view.value;
    bench("view read (parse)", () => do_not_optimize(view.value));
  }
  {
    const s = str(kvText);
    const view = kvGrammar.view(s);
    const v = view.peek();
    bench("view write (print → source)", () => {
      view.value = v;
      do_not_optimize(s.peek());
    });
  }
});

group("Reg.bind compile cost", () => {
  bench("bind kv grammar", () => do_not_optimize(kvGrammar.bind(str(kvText))));
  bench("bind csv grammar", () => do_not_optimize(csvGrammar.bind(str(csvText))));
});

group(`Reg.bind handle edits (N=${N})`, () => {
  {
    const s = str(csvText);
    const { cells } = csvGrammar.bind(s);
    const arr = cells as unknown as Arr<string>;
    arr.values.value;
    const seg = arr.cells[N >> 1]! as Writable<Cell<string>>;
    bench("star element edit → source rebuild", () => {
      seg.value = seg.peek() === "x" ? "y" : "x";
      do_not_optimize(s.peek());
    });
  }
  {
    const s = str(csvText);
    const { cells } = csvGrammar.bind(s);
    const arr = cells as unknown as Arr<string>;
    arr.values.value;
    bench("star structural move → source rebuild", () => {
      arr.move(arr.cells[0]!, arr.cells.length - 1);
      do_not_optimize(s.peek());
    });
  }
});

group(`Abstraction tax: Reg star vs Str.split (N=${N})`, () => {
  {
    const s = str(csvText);
    const w = s.split(/,/);
    w.length.value;
    bench("Str.split → length", () => do_not_optimize(w.length.value));
  }
  {
    const s = str(csvText);
    const arr = csvGrammar.bind(s).cells as unknown as Arr<string>;
    arr.length.value;
    bench("Reg star → length", () => do_not_optimize(arr.length.value));
  }
});

await run({ format: "mitata" });
