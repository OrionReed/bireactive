// Same `meanSpread(inputs) → {mean, spread}` across Vec, Color, and Pose domains, wired into one master.

import {
  type Cell,
  type Color,
  Diagram,
  handle,
  label,
  line,
  type Mount,
  mean,
  meanSpread,
  Num,
  pose,
  rect,
  rgba,
  Vec,
  vec,
  type Writable,
} from "@bireactive";

type PoseV = { x: number; y: number; theta: number };
type ColorV = { r: number; g: number; b: number; a: number };

export class MdTraitsCrossDomain extends Diagram {
  protected scene(s: Mount): void {
    const view = this.view(720, 500);

    // Domain 1: Vecs
    const VX = 110;
    const VSP = 50;
    const vecs = [
      vec(VX, 80),
      vec(VX + VSP, 80),
      vec(VX + 2 * VSP, 98),
      vec(VX + 3 * VSP, 80),
      vec(VX + 4 * VSP, 68),
    ];
    const { mean: vecMean, spread: vecSpread } = meanSpread(vecs as never) as unknown as {
      mean: Writable<Vec>;
      spread: Writable<Num>;
    };

    // Domain 2: Colors
    const colors = [
      rgba(0.9, 0.2, 0.3, 1),
      rgba(0.2, 0.7, 0.4, 1),
      rgba(0.3, 0.4, 0.9, 1),
      rgba(0.9, 0.7, 0.2, 1),
      rgba(0.5, 0.2, 0.8, 1),
    ];
    const { mean: colorMean, spread: colorSpread } = meanSpread(colors as never) as unknown as {
      mean: Writable<Color>;
      spread: Writable<Num>;
    };

    // Domain 3: Poses
    const PY = 360;
    const poses = [
      pose({ x: VX, y: PY, theta: -0.5 }),
      pose({ x: VX + VSP, y: PY + 10, theta: -0.25 }),
      pose({ x: VX + 2 * VSP, y: PY, theta: 0 }),
      pose({ x: VX + 3 * VSP, y: PY - 10, theta: 0.25 }),
      pose({ x: VX + 4 * VSP, y: PY, theta: 0.5 }),
    ];
    const { mean: poseMean, spread: poseSpread } = meanSpread(poses as never) as unknown as {
      mean: Writable<Cell<PoseV>>;
      spread: Writable<Num>;
    };

    // Normalised spreads (so master can be unit-agnostic)
    const v0 = vecSpread.value;
    const c0 = colorSpread.value;
    const p0 = poseSpread.value;
    const SMAX = 2.0;
    const vecRel = Num.lens(
      vecSpread,
      sv => sv / v0,
      t => t * v0,
    );
    const colorRel = Num.lens(
      colorSpread,
      sv => sv / c0,
      t => t * c0,
    );
    const poseRel = Num.lens(
      poseSpread,
      sv => sv / p0,
      t => t * p0,
    );
    const master = mean([vecRel, colorRel, poseRel] as never);

    // Slider layout
    const SX = 440;
    const SW = 220;
    const sliderHandle = (val: Writable<Num>, y: number) =>
      Vec.lens(
        val,
        (sv: number) => ({ x: SX + (sv / SMAX) * SW, y }),
        (t: { x: number; y: number }) => Math.max(0, Math.min(SMAX, ((t.x - SX) / SW) * SMAX)),
      );
    const vecSliderH = sliderHandle(vecRel, 90);
    const colorSliderH = sliderHandle(colorRel, 210);
    const poseSliderH = sliderHandle(poseRel, 360);
    const masterSliderH = sliderHandle(master as never as Writable<Num>, 450);

    // Color picker geometry: square right of the swatches
    const SW_SIZE = 38;
    const SW_Y = 200;
    const PICK_SIZE = 56;
    const PICK_CX = VX + 5 * VSP + 4;
    const PICK_CY = SW_Y;
    const PICK_R = PICK_SIZE - 16; // dot's draggable range, leaves margin
    const PICK_X0 = PICK_CX - PICK_R / 2;
    const PICK_Y0 = PICK_CY - PICK_R / 2;
    const colorMeanHandle = Vec.lens(
      colorMean,
      (c: ColorV) => ({
        x: PICK_X0 + c.r * PICK_R,
        y: PICK_Y0 + c.g * PICK_R,
      }),
      (t: { x: number; y: number }, c: ColorV) => ({
        r: Math.max(0, Math.min(1, (t.x - PICK_X0) / PICK_R)),
        g: Math.max(0, Math.min(1, (t.y - PICK_Y0) / PICK_R)),
        b: c.b,
        a: c.a,
      }),
    );

    s(
      // Row 1: Vecs
      ...vecs.map(v => handle(v, { fill: "#5b8def", r: 7 })),
      handle(vecMean, { fill: "#f5a623", r: 11 }),

      // Row 2: Colors
      ...colors.map((c, i) => rect(vec(VX + i * VSP, SW_Y), SW_SIZE, SW_SIZE, { fill: c.css })),
      // The picker IS the mean swatch — filled with the live mean
      // colour. Drag the dot inside to translate the palette in RGB.
      rect(vec(PICK_CX, PICK_CY), PICK_SIZE, PICK_SIZE, { fill: colorMean.css }),
      rect(vec(PICK_CX, PICK_CY), PICK_SIZE, PICK_SIZE, { thin: true, stroke: "#222" }),
      handle(colorMeanHandle, { fill: "#222", r: 5 }),

      // Row 3: Poses
      ...poses.flatMap(p => {
        const pPos = Vec.lens(
          p,
          (pv: PoseV) => ({ x: pv.x, y: pv.y }),
          (t: { x: number; y: number }, pv: PoseV) => ({ ...pv, x: t.x, y: t.y }),
        );
        const pTip = Vec.derive(p, (pv: PoseV) => ({
          x: pv.x + 20 * Math.cos(pv.theta),
          y: pv.y + 20 * Math.sin(pv.theta),
        }));
        return [
          line(pPos, pTip, { stroke: "#7ed321", strokeWidth: 2.5 }),
          handle(pPos, { fill: "#7ed321", r: 5 }),
        ];
      }),
      handle(
        Vec.lens(
          poseMean,
          (pv: PoseV) => ({ x: pv.x, y: pv.y }),
          (t: { x: number; y: number }, pv: PoseV) => ({ ...pv, x: t.x, y: t.y }),
        ),
        { fill: "#f5a623", r: 11 },
      ),

      // Slider tracks
      line(vec(SX, 90), vec(SX + SW, 90), { thin: true, opacity: 0.4 }),
      line(vec(SX, 210), vec(SX + SW, 210), { thin: true, opacity: 0.4 }),
      line(vec(SX, 360), vec(SX + SW, 360), { thin: true, opacity: 0.4 }),
      line(vec(SX, 450), vec(SX + SW, 450), { thin: true, opacity: 0.7 }),

      // Slider handles
      handle(vecSliderH, { fill: "#222", r: 7 }),
      handle(colorSliderH, { fill: "#222", r: 7 }),
      handle(poseSliderH, { fill: "#222", r: 7 }),
      handle(masterSliderH, { fill: "#e25c5c", r: 11 }),

      // Labels
      label(vec(SX, 72), "vec spread", { size: 11, opacity: 0.7 }),
      label(vec(SX, 192), "color spread", { size: 11, opacity: 0.7 }),
      label(vec(SX, 342), "pose spread", { size: 11, opacity: 0.7 }),
      label(vec(SX, 432), "MASTER = mean(spreads)", { size: 11, opacity: 0.9 }),
      label(
        view.top.down(18),
        "drag any spread slider — the master tracks the mean; drag master, all three follow",
      ),
      label(
        view.bottom.up(14),
        "meanSpread · trait-dispatched Linear + Metric · works the same on Vec, Color, Pose",
        { size: 10 },
      ),
    );
  }
}
