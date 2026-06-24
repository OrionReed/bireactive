export {
  clampedMean,
  crossfade,
  mean,
  meanDiff,
  meanSpread,
  mix,
  select,
  spread,
  timeSeries,
} from "./aggregates";
export {
  angle,
  bezierGestalt,
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
export {
  type ArgminOpts,
  type ArgminVecOpts,
  argminNum,
  argminVec,
  bundle,
  clampToDisc,
  type FactorOpts,
  type FactorResult,
  factor,
  factorTuple,
  type OutputSpec,
  type PackedInput,
} from "./numerical";
export {
  bbox,
  bestFitCircle,
  bestFitLine,
  pca,
  procrustes,
  rotateAbout,
  scaleAbout,
  scaleAboutXY,
  total,
} from "./point-cloud";
export { type ClosestOpts, hullWeights, nearestIndex } from "./snap";
export {
  applyCaseMask,
  applyCasePattern,
  caseFold,
  caseMaskOf,
  parseWords,
  rebuildWords,
} from "./text";
