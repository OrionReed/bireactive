// Forward bench — the "bireactive tax". bireactive's forward path is
// alien-signals verbatim, but every cell carries the backward machinery
// (pendingValue dual-keying, plus a `_rel` transfer on writable derived
// cells). The gap between bireactive and raw alien/preact on identical
// forward graphs is the cost of being bidirectional on a workload that never
// writes backward.

import { group } from "mitata";
import { bireactive } from "../adapters/bireactive";
import { alien, preact } from "../adapters/forward";
import { reconcile } from "../adapters/reconcile";
import { reg } from "./runner";
import { fwdChain, fwdFan } from "./workloads";

const engines = [bireactive, reconcile, alien, preact] as const;

group("forward chain (depth 50)", () => {
  for (const rx of engines) reg(rx.name, fwdChain(rx, 50));
});

group("forward fan-in (width 50)", () => {
  for (const rx of engines) reg(rx.name, fwdFan(rx, 50));
});
