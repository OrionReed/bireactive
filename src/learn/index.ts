// learn — a tiny, dependency-free MLP framed as a stack of parametric lenses,
// plus reproducible datasets for the classification demos. Imported by the
// site via "@bireactive/learn"; not part of the main barrel.

export {
  circles,
  moons,
  type Points,
  type PointsKind,
  points,
  randomPose,
  rasterShape,
  type ShapeKind,
  type ShapePose,
  shapeBatch,
  shapeSample,
  spirals,
  xor,
} from "./data";
export {
  accuracyOf,
  classifyOf,
  inputGradient,
  type LayerParams,
  type LensLayer,
  type LensNet,
  type LensNetCfg,
  lensNet,
  logitsOf,
  meanLossOf,
  probsOf,
  trainEpoch,
  trainExample,
} from "./lens-net";
export { type Activation, gaussian, rng, type Sample } from "./mlp";
