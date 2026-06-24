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
  clampedMean,
  diff,
  distance,
  type PolarPolicy,
  polar,
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
export { type ClosestOpts, hullWeights, nearestIndex } from "./snap";
export {
  applyCaseMask,
  applyCasePattern,
  caseFold,
  caseMaskOf,
  parseWords,
  rebuildWords,
} from "./text";
export {
  bundle,
  type FactorOpts,
  type FactorResult,
  factor,
  factorTuple,
  type OutputSpec,
  type PackedInput,
} from "./typed-factor";
