// core/lenses/index.ts — N→1, N→M and 1→M bidirectional lens primitives.
//
// Layers:
//   1. CLOSED-FORM POLICIES — `rigidTranslate`, `rotateAbout`,
//      `scaleAbout`, `scaleAboutXY`: exact group-action primitives.
//   2. AGGREGATES — `mean`, `spread`, `palette`, `total`, `bezierGestalt`,
//      `timeSeries`, `mix`/`select`/`crossfade`: closed-form N→1 views.
//   3. DECOMPOSITIONS — `procrustes`, `bbox`, `meanDiff`, `bestFitLine`,
//      `bestFitCircle`, `pca`: exact M-output views over the policies.
//   4. NUMERICAL — `factor`, `factorTuple`, `bundle`, `argminNum`,
//      `argminVec`: generic Jacobian-LSQ, the escape hatch when no
//      closed form fits.
//
// See BIDIRECTIONAL-LENSES.md for the engine substrate.

export {
  type ArgminOpts,
  type ArgminVecOpts,
  argminNum,
  argminVec,
  clampToDisc,
} from "./aggregates";
export {
  bestFitCircle,
  bestFitLine,
  pca,
  rigidTranslate,
  rotateAbout,
  scaleAbout,
  scaleAboutXY,
  total,
} from "./closed-form-policies";
export { bbox, meanDiff, procrustes } from "./decompositions";
export {
  bezierGestalt,
  crossfade,
  mean,
  meanSpread,
  mix,
  select,
  spread,
  timeSeries,
} from "./domain-aggregates";
export {
  angle,
  bezier2,
  bezier3,
  clampedMean,
  diff,
  distance,
  pulleySum,
  reflection,
  vecLerp,
} from "./geometry";
export {
  type ContinuousOpts,
  continuous,
  type RememberOpts,
  remember,
} from "./memory";
export {
  bundle,
  type FactorOpts,
  type FactorResult,
  factor,
  factorTuple,
  type OutputSpec,
  type PackedInput,
} from "./typed-factor";
