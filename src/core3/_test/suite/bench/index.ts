// Bench entry — registers every group, then runs once.
//
//   node --expose-gc node_modules/.bin/vite-node \
//        src/core/suite/bench/index.ts

import { run } from "mitata";
import "./forward.bench";
import "./backward.bench";
import "./mixed.bench";
import "./cyclic.bench";

await run({ format: "mitata" });
