// schema — composable, complement-carrying lenses between plain-POJO schema
// versions. See lens.ts for the kit and the design rationale.

export {
  addField,
  type FieldMap,
  mapField,
  nestFields,
  type Obj,
  pipe,
  removeField,
  renameField,
  type SplitSpec,
  type Step,
  splitField,
} from "./lens";
