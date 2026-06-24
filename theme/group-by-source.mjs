// Local TypeDoc plugin: assign each top-level export to a domain @group based on
// the source file it's defined in, so the API reference is organized by domain
// (Reactivity, Values, Lenses, …) rather than by reflection kind. Value types
// also get an @category sub-bucket. Deriving groups from the source tree keeps
// the taxonomy in one place instead of scattered across ~470 declarations.

import { Comment, CommentTag, Converter, ReflectionKind } from "typedoc";

const TOP_LEVEL =
  ReflectionKind.Class |
  ReflectionKind.Interface |
  ReflectionKind.Function |
  ReflectionKind.TypeAlias |
  ReflectionKind.Variable |
  ReflectionKind.Enum;

// First match wins; order matters (specific paths before their parents).
const GROUP_RULES = [
  [/[/\\]core[/\\]values[/\\]/, "Values"],
  [/[/\\]core[/\\]lenses[/\\]/, "Lenses"],
  [/[/\\]core[/\\]derived-geometry/, "Lenses"],
  [/[/\\]core[/\\]/, "Reactivity"],
  [/[/\\]animation[/\\]/, "Animation"],
  [/[/\\]shapes[/\\]/, "Shapes"],
  [/[/\\](code|tex|web)[/\\]/, "Rendering"],
  // assert/ext are folders, tree is a single file — match both forms.
  [/[/\\](assert|ext|tree)([/\\]|\.ts$)/, "Utilities"],
];

// Sub-buckets within the Values group, keyed by value-type file.
const VALUE_CATEGORY = [
  [/[/\\](num|range)\.ts/, "Numeric"],
  [/[/\\](vec|box|tri|matrix|transform|pose|anchor)\.ts/, "Geometry"],
  [/[/\\](color|field)\.ts/, "Color"],
  [/[/\\](str|template)\.ts|[/\\]reg[/\\.]/, "Text"],
  [/[/\\](arr|flags)\.ts/, "Collections"],
  [/[/\\](audio|canvas|gpu)\.ts/, "Media"],
  [/[/\\]bool\.ts/, "Logic"],
];

const GROUP_DESCRIPTIONS = {
  Reactivity: "Cells, derivations, effects, and the bidirectional lens engine — the reactive core.",
  Values:
    "Typed value cells (numbers, vectors, colors, text, …) with field lenses and domain operators.",
  Lenses: "Free-function lenses that compose values into writable derived views.",
  Animation: "Springs, tweens, and timeline-driven animators.",
  Shapes: "Drawable geometric primitives.",
  Rendering: "Diagrams, DOM binding, syntax highlighting, and math typesetting.",
  Utilities: "Assorted helpers.",
};

// TypeDoc reads a @groupDescription's target from the first line of the tag
// content (header), with the rest as the description body — see GroupPlugin's
// `splitPartsToHeaderAndBody`. So encode the group name as the leading line.
function setGroupDescription(comment, name, text) {
  comment.blockTags.push(
    new CommentTag("@groupDescription", [{ kind: "text", text: `${name}\n${text}` }]),
  );
}

function setGroup(reflection, name) {
  if (!reflection.comment) reflection.comment = new Comment();
  reflection.comment.blockTags = reflection.comment.blockTags.filter(t => t.tag !== "@group");
  reflection.comment.blockTags.push(new CommentTag("@group", [{ kind: "text", text: name }]));
}

function setCategory(reflection, name) {
  reflection.comment.blockTags = reflection.comment.blockTags.filter(t => t.tag !== "@category");
  reflection.comment.blockTags.push(new CommentTag("@category", [{ kind: "text", text: name }]));
}

/** @param {import("typedoc").Application} app */
export function load(app) {
  app.converter.on(Converter.EVENT_RESOLVE_BEGIN, context => {
    const project = context.project;

    // The reflection that actually holds the grouped exports: a single-entry
    // project with `projectDocuments` wraps its exports in a child Module, so
    // descriptions must attach there (collected below), not to the project.
    const containers = new Set();

    for (const refl of project.getReflectionsByKind(TOP_LEVEL)) {
      const parent = refl.parent;
      const parentKind = parent?.kind;
      if (parentKind !== ReflectionKind.Project && parentKind !== ReflectionKind.Module) continue;

      const file = refl.sources?.[0]?.fileName ?? "";
      const rule = GROUP_RULES.find(([re]) => re.test(file));
      if (!rule) continue;

      setGroup(refl, rule[1]);
      if (rule[1] === "Values") {
        const cat = VALUE_CATEGORY.find(([re]) => re.test(file));
        if (cat) setCategory(refl, cat[1]);
      }
      containers.add(parent);
    }

    // Group descriptions render under each group heading.
    for (const container of containers.size > 0 ? containers : [project]) {
      if (!container.comment) container.comment = new Comment();
      for (const [name, text] of Object.entries(GROUP_DESCRIPTIONS)) {
        setGroupDescription(container.comment, name, text);
      }
    }
  });
}
