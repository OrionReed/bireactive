// Lists of lists — the Dragology comparison, on the drag algebra. The model is
// the structural state `{ tree, origin }`, and the layout is a pure function of
// it (`treeStack`). The drag is one expression:
//
//     d.withFloating(pointer, d.vary(pointer, place, …))
//
// where `place` is the backward map pointer→state: reinsert the dragged node at
// the slot it's over (deepest list wins), or wrap a far-flung leaf in a fresh
// list. `vary` makes that previewed state live (neighbours reflow to open the
// slot, the wrap forms as you go), `withFloating` floats the node, and
// `dragModel` commits the previewed state verbatim on release — the drop is
// "stop floating", nothing to recompute. The structural hit-test is the only
// bespoke part; everything temporal comes from the algebra.

import {
  box,
  cell,
  Diagram,
  d,
  derive,
  dragModel,
  effect,
  label,
  type Mount,
  raise,
  rect,
  spring,
  treeStack,
} from "@bireactive";

type Tree = { kids: Record<string, string[]>; roots: string[] };
type V = { x: number; y: number };
type State = { tree: Tree; origin: Record<string, V> };
type Meta = { kind: "leaf" | "list"; label: string; fill: string };

const LEAF_W = 116;
const LEAF_H = 34;
const HEADER = 24;
const PAD = 10;
const GAP = 8;
const MIN_W = LEAF_W + 2 * PAD;
const EMPTY_H = HEADER + 26;
const WRAP_RADIUS = 70;

const NODES: Record<string, Meta> = {
  B0: { kind: "leaf", label: "fix the bug", fill: "#5b8def" },
  B1: { kind: "leaf", label: "write docs", fill: "#e25c5c" },
  B2: { kind: "leaf", label: "review PR", fill: "#f5a623" },
  B3: { kind: "leaf", label: "deploy", fill: "#3bb273" },
  B4: { kind: "leaf", label: "triage", fill: "#9b5de5" },
  B5: { kind: "leaf", label: "refactor", fill: "#00b8a9" },
  L0: { kind: "list", label: "backlog", fill: "#8882" },
  L1: { kind: "list", label: "this week", fill: "#8882" },
  L2: { kind: "list", label: "done", fill: "#8882" },
  L3: { kind: "list", label: "group", fill: "#8882" },
  L4: { kind: "list", label: "group", fill: "#8882" },
};
const LIST_POOL = ["L0", "L1", "L2", "L3", "L4"];
// The two named columns persist even when empty; every other list is a group.
const KEEP_COLUMNS = new Set(["L0", "L2"]);
const ALL = Object.keys(NODES);
const isList = (id: string) => NODES[id]!.kind === "list";

const subtree = (t: Tree, id: string, acc = new Set<string>()): Set<string> => {
  acc.add(id);
  if (isList(id)) for (const c of t.kids[id] ?? []) subtree(t, c, acc);
  return acc;
};
const withoutNode = (t: Tree, id: string): Tree => {
  const kids: Record<string, string[]> = {};
  for (const k of Object.keys(t.kids)) kids[k] = t.kids[k]!.filter(x => x !== id);
  return { kids, roots: t.roots.filter(x => x !== id) };
};
const depthOf = (t: Tree, id: string): number => {
  let depth = 0;
  let frontier = t.roots.slice();
  while (frontier.length) {
    if (frontier.includes(id)) return depth;
    const next: string[] = [];
    for (const f of frontier) if (isList(f)) next.push(...(t.kids[f] ?? []));
    frontier = next;
    depth++;
  }
  return depth;
};
const rectDist = (p: V, b: { x: number; y: number; w: number; h: number }) =>
  Math.hypot(Math.max(b.x - p.x, 0, p.x - (b.x + b.w)), Math.max(b.y - p.y, 0, p.y - (b.y + b.h)));
const freeList = (t: Tree): string | null => {
  const used = new Set<string>();
  const walk = (id: string) => {
    used.add(id);
    if (isList(id)) for (const c of t.kids[id] ?? []) walk(c);
  };
  for (const r of t.roots) walk(r);
  return LIST_POOL.find(l => !used.has(l)) ?? null;
};
// Groups are ephemeral containers: an empty list dissolves (and frees its id
// back to the pool), except the two named columns and whatever's being dragged.
const pruneEmpty = (t: Tree, keep: Set<string>): Tree => {
  const kids: Record<string, string[]> = {};
  for (const k of Object.keys(t.kids)) kids[k] = t.kids[k]!.slice();
  let roots = t.roots.slice();
  for (;;) {
    const dead = new Set(
      [...roots, ...Object.values(kids).flat()].filter(
        id => isList(id) && !keep.has(id) && (kids[id]?.length ?? 0) === 0,
      ),
    );
    if (!dead.size) return { kids, roots };
    roots = roots.filter(r => !dead.has(r));
    for (const k of Object.keys(kids)) kids[k] = kids[k]!.filter(x => !dead.has(x));
    for (const dn of dead) delete kids[dn];
  }
};

export class MdNested extends Diagram {
  protected scene(s: Mount): void {
    const view = this.view(640, 460);

    const state = cell<State>({
      tree: {
        kids: { L0: ["B0", "B1", "L1"], L1: ["B2", "B3"], L2: ["B4", "B5"], L3: [], L4: [] },
        roots: ["L0", "L2"],
      },
      origin: { L0: { x: 70, y: 90 }, L2: { x: 340, y: 90 } },
    });
    const originOf = (st: State, id: string): V => st.origin[id] ?? { x: 0, y: 0 };

    // The committed layout — stable during a drag, so hit-testing never chases
    // its own reflow.
    const stackOpts = {
      container: isList,
      leaf: () => ({ w: LEAF_W, h: LEAF_H }),
      header: HEADER,
      pad: PAD,
      gap: GAP,
      minWidth: MIN_W,
      emptyHeight: EMPTY_H,
    };
    const base = treeStack<string>({
      roots: () => state.value.tree.roots,
      kids: id => state.value.tree.kids[id] ?? [],
      origin: id => originOf(state.value, id),
      ...stackOpts,
    });

    // The drag spec: float the node, and let `vary` make the previewed state
    // live. `place` (below, via `previewState`) is the pointer→state map.
    const dm = dragModel<State, string>(state, (_id, pointer) =>
      d.withFloating(
        pointer,
        d.vary(
          pointer,
          () => previewState.value,
          () => pointer.value,
        ),
      ),
    );

    // Where the drag would land: deepest list under the pointer (excluding its
    // own subtree), else wrap (a leaf dropped far) or a bare root.
    const dropInfo = derive(
      (): { list: string | null; index: number; wrap: boolean; nl: string | null } => {
        const id = dm.active.value;
        if (id === null) return { list: null, index: 0, wrap: false, nl: null };
        const lay = base.boxes.value;
        const l = dm.pointer.value;
        const sz = lay.get(id) ?? { w: LEAF_W, h: LEAF_H };
        const c = { x: l.x + sz.w / 2, y: l.y + sz.h / 2 };
        const sub = subtree(state.value.tree, id);
        let best: string | null = null;
        let bestDepth = -1;
        let near = Number.POSITIVE_INFINITY;
        for (const [nid, b] of lay) {
          if (!isList(nid) || sub.has(nid)) continue;
          near = Math.min(near, rectDist(c, b));
          if (c.x >= b.x && c.x <= b.x + b.w && c.y >= b.y && c.y <= b.y + b.h) {
            const dep = depthOf(state.value.tree, nid);
            if (dep > bestDepth) {
              bestDepth = dep;
              best = nid;
            }
          }
        }
        if (best) {
          let idx = 0;
          for (const ch of state.value.tree.kids[best] ?? []) {
            if (sub.has(ch)) continue;
            const cb = lay.get(ch);
            if (cb && cb.y + cb.h / 2 < c.y) idx++;
          }
          return { list: best, index: idx, wrap: false, nl: null };
        }
        const wrap = NODES[id]!.kind === "leaf" && near > WRAP_RADIUS;
        return { list: null, index: 0, wrap, nl: wrap ? freeList(state.value.tree) : null };
      },
    );

    // The previewed state: the dragged node reinserted at the drop slot, or
    // wrapped in a fresh list (live), or a bare root. New roots get a pointer-
    // anchored origin, so committing is just adopting this value. Lists emptied
    // by the move dissolve at once (except the columns and the dragged subtree).
    const previewState = derive((): State => {
      const id = dm.active.value;
      if (id === null) return state.value;
      const dt = dropInfo.value;
      const t = withoutNode(state.value.tree, id);
      const origin = { ...state.value.origin };
      const l = dm.pointer.value;
      let tree: Tree;
      if (dt.list) {
        const arr = (t.kids[dt.list] ?? []).slice();
        arr.splice(Math.min(dt.index, arr.length), 0, id);
        tree = { kids: { ...t.kids, [dt.list]: arr }, roots: t.roots };
      } else if (dt.wrap && dt.nl) {
        origin[dt.nl] = { x: l.x - PAD, y: l.y - HEADER - PAD };
        tree = { kids: { ...t.kids, [dt.nl]: [id] }, roots: [...t.roots, dt.nl] };
      } else {
        origin[id] = l;
        tree = { kids: t.kids, roots: [...t.roots, id] };
      }
      const keep = new Set([...KEEP_COLUMNS, ...subtree(state.value.tree, id)]);
      return { tree: pruneEmpty(tree, keep), origin };
    });

    const preview = treeStack<string>({
      roots: () => previewState.value.tree.roots,
      kids: id => previewState.value.tree.kids[id] ?? [],
      origin: id => originOf(previewState.value, id),
      ...stackOpts,
    });

    // The dragged subtree renders rigidly at the pointer: shift it by the gap
    // between its slot and the pointer (zero once it's a floated root).
    const offset = derive(() => {
      const id = dm.active.value;
      if (id === null) return { x: 0, y: 0 };
      const m = preview.boxes.value.get(id);
      const l = dm.at.value;
      return m ? { x: l.x - m.x, y: l.y - m.y } : { x: 0, y: 0 };
    });

    const shapes: Record<
      string,
      { rect: ReturnType<typeof rect>; label: ReturnType<typeof label> }
    > = {};

    for (const id of ALL) {
      const meta = NODES[id]!;
      const isLeaf = meta.kind === "leaf";
      const dispBox = box(0, 0, isLeaf ? LEAF_W : MIN_W, isLeaf ? LEAF_H : EMPTY_H);

      const inDrag = derive(() => {
        const dd = dm.active.value;
        if (dd === null) return false;
        if (subtree(state.value.tree, dd).has(id)) return true;
        // The fresh wrap list travels with the leaf it's forming around.
        const di = dropInfo.value;
        return di.wrap && di.nl === id;
      });
      const present = derive(() => preview.boxes.value.has(id));
      const target = derive(() => {
        const m = preview.boxes.value.get(id);
        if (!m) return dispBox.peek();
        if (inDrag.value) {
          const o = offset.value;
          return { x: m.x + o.x, y: m.y + o.y, w: m.w, h: m.h };
        }
        return m;
      });
      dispBox.value = target.peek();
      this.anim.start(
        spring(dispBox, target, {
          omega: 26,
          zeta: 0.9,
          precision: 0,
          rate: () => (inDrag.value ? 0 : 1),
        }),
      );
      effect(() => {
        if (inDrag.value) dispBox.value = target.value;
      });

      const isDropTarget = derive(() => dropInfo.value.list === id);
      const opacity = derive(() => (present.value ? 1 : 0));

      const r = s(
        rect(dispBox, {
          corner: isLeaf ? 8 : 12,
          fill: isLeaf ? meta.fill : derive(() => (isDropTarget.value ? "#5b8def33" : meta.fill)),
          stroke: isLeaf
            ? "var(--bg-color, #fff)"
            : derive(() => (isDropTarget.value ? "#5b8def" : "var(--text-secondary, #888)")),
          strokeWidth: isLeaf ? 2 : derive(() => (isDropTarget.value ? 2 : 1)),
          opacity,
        }),
      );
      const lbl = s(
        label(isLeaf ? dispBox.center : dispBox.top.down(HEADER / 2), meta.label, {
          size: isLeaf ? 13 : 11,
          bold: !isLeaf,
          fill: isLeaf ? "#fff" : "var(--text-secondary, #888)",
          opacity,
        }),
      );
      shapes[id] = { rect: r, label: lbl };

      r.el.style.cursor = "grab";
      dm.grip(
        r,
        id,
        () => {
          const b = dispBox.peek();
          return { x: b.x, y: b.y };
        },
        () => {
          for (const sid of subtree(state.peek().tree, id)) {
            const sh = shapes[sid];
            if (sh) raise(sh.rect, sh.label);
          }
        },
      );
    }

    s(
      label(view.top.down(20), "drag boxes and lists — drop in a list to nest, in space to wrap", {
        size: 14,
        bold: true,
      }),
      label(
        view.bottom.up(14),
        "d.vary(pointer, place) previews the tree live · d.withFloating floats the node · release commits the preview",
        { size: 10, fill: "var(--text-secondary, #888)" },
      ),
    );
  }
}
