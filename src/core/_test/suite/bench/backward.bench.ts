// Backward bench — edit-settle time when the edit enters through a view,
// placed next to its forward dual on the same topology. bireactive commits
// backward via the forward path, so a write-through's cost is the
// backward walk plus the forward cascade it induces; the dual pairing
// makes that overhead legible.

import { group } from "mitata";
import { bireactive } from "../adapters/bireactive";
import { reg } from "./runner";
import {
  bwdChain,
  bwdChainBlind,
  bwdChainsPartial,
  bwdCoalesce,
  bwdFan,
  fwdChain,
  fwdFan,
} from "./workloads";

group("chain depth 50: source-edit vs view-edit", () => {
  reg("forward (write source)", fwdChain(bireactive, 50));
  reg("backward (write top view)", bwdChain(bireactive, 50));
});

group("fan width 50: source-edit vs view-edit", () => {
  reg("forward (write 1 source)", fwdFan(bireactive, 50));
  reg("backward (write fan-in view)", bwdFan(bireactive, 50));
});

// Laziness isolation — the cases demand-gating should actually move
// (the paired write+read benches above cannot show it). Eager bireactive
// is the "before"; demand-gated bireactive is the "after".
group("laziness: unobserved write (chain depth 50)", () => {
  reg("bireactive", bwdChainBlind(bireactive, 50));
});

group("laziness: 10 writes per read (chain depth 50)", () => {
  reg("bireactive", bwdCoalesce(bireactive, 50, 10));
});

group("laziness: write 20 chains, read 1 (depth 50)", () => {
  reg("bireactive", bwdChainsPartial(bireactive, 20, 50));
});
