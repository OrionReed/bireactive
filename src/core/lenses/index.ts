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
export { angle, clampedMean, diff, distance, pulleySum, reflection, vecLerp } from "./geometry";
export {
  type ContinuousOpts,
  continuous,
  type RememberOpts,
  remember,
} from "./memory";
export {
  between,
  type ClosestOpts,
  closest,
  hullWeights,
  nearestDistance,
  nearestIndex,
  whenFar,
} from "./snap";
export {
  bundle,
  type FactorOpts,
  type FactorResult,
  factor,
  factorTuple,
  type OutputSpec,
  type PackedInput,
} from "./typed-factor";
