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
  type Activation,
  accuracy,
  classify,
  forward,
  gaussian,
  inputGradient,
  type MLP,
  meanLoss,
  mlp,
  predict,
  rng,
  type Sample,
  softmax,
  trainStep,
} from "./mlp";
