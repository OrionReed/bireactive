// Lists of lists — the Dragology comparison. Boxes and lists are the same
// kind of draggable, and the layout is a pure function of the tree
// (`treeStack`), so dragging just feeds it a *previewed* tree: the dragged
// node is reinserted at where it would land, the neighbours reflow to open
// that slot, and the node floats at the pointer. Releasing commits the same
// preview — so the drop is just "stop floating", with nothing to compute.
// At grab time the projected slot is the node's own home, so it never jumps
// out of its parent.

import {
  Box,
  box,
  cell,
  Diagram,
  derive,
  drag,
  effect,
  label,
  type Mount,
  rect,
  spring,
  treeStack,
  type Vec,
  vec,
  type Writable,
} from "@bireactive";

type Tree = { kids: Record<string, string[]>; roots: string[] };
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
  let d = 0;
  let frontier = t.roots.slice();
  while (frontier.length) {
    if (frontier.includes(id)) return d;
    const next: string[] = [];
    for (const f of frontier) if (isList(f)) next.push(...(t.kids[f] ?? []));
    frontier = next;
    d++;
  }
  return d;
};
const rectDist = (p: { x: number; y: number }, b: { x: number; y: number; w: number; h: number }) =>
  Math.hypot(Math.max(b.x - p.x, 0, p.x - (b.x + b.w)), Math.max(b.y - p.y, 0, p.y - (b.y + b.h)));

export class MdNested extends Diagram {
  protected scene(s: Mount): void {
    const view = this.view(640, 460);

    const tree = cell<Tree>({
      kids: { L0: ["B0", "B1", "L1"], L1: ["B2", "B3"], L2: ["B4", "B5"], L3: [], L4: [] },
      roots: ["L0", "L2"],
    });
    const rootPos: Record<string, Writable<Vec>> = {};
    for (const id of ALL) rootPos[id] = vec(0, 0);
    rootPos.L0!.value = { x: 70, y: 90 };
    rootPos.L2!.value = { x: 340, y: 90 };

    const dragId = cell<string | null>(null);
    // Top-left of the dragged node, tracking the pointer.
    const lift: Record<string, Writable<Vec>> = {};
    for (const id of ALL) lift[id] = vec(0, 0);

    const freeList = (t: Tree): string | null => {
      const used = new Set<string>();
      const walk = (id: string) => {
        used.add(id);
        if (isList(id)) for (const c of t.kids[id] ?? []) walk(c);
      };
      for (const r of t.roots) walk(r);
      return LIST_POOL.find(l => !used.has(l)) ?? null;
    };

    // The committed layout — stable during a drag, so hit-testing never
    // chases its own reflow.
    const base = treeStack<string>({
      roots: () => tree.value.roots,
      kids: id => tree.value.kids[id] ?? [],
      container: isList,
      leaf: () => ({ w: LEAF_W, h: LEAF_H }),
      origin: id => rootPos[id]!.value,
      header: HEADER,
      pad: PAD,
      gap: GAP,
      minWidth: MIN_W,
      emptyHeight: EMPTY_H,
    });

    // Where the drag would land: deepest list under the pointer (excluding
    // its own subtree), else wrap (a leaf dropped far) or a bare root.
    const drop = derive((): { list: string | null; index: number; wrap: boolean } => {
      const d = dragId.value;
      if (d === null) return { list: null, index: 0, wrap: false };
      const lay = base.boxes.value;
      const l = lift[d]!.value;
      const sz = lay.get(d) ?? { w: LEAF_W, h: LEAF_H };
      const c = { x: l.x + sz.w / 2, y: l.y + sz.h / 2 };
      const sub = subtree(tree.value, d);
      let best: string | null = null;
      let bestDepth = -1;
      let near = Number.POSITIVE_INFINITY;
      for (const [id, b] of lay) {
        if (!isList(id) || sub.has(id)) continue;
        near = Math.min(near, rectDist(c, b));
        if (c.x >= b.x && c.x <= b.x + b.w && c.y >= b.y && c.y <= b.y + b.h) {
          const dep = depthOf(tree.value, id);
          if (dep > bestDepth) {
            bestDepth = dep;
            best = id;
          }
        }
      }
      if (best) {
        let idx = 0;
        for (const ch of tree.value.kids[best] ?? []) {
          if (sub.has(ch)) continue;
          const cb = lay.get(ch);
          if (cb && cb.y + cb.h / 2 < c.y) idx++;
        }
        return { list: best, index: idx, wrap: false };
      }
      return { list: null, index: 0, wrap: NODES[d]!.kind === "leaf" && near > WRAP_RADIUS };
    });

    // The previewed tree: the dragged node reinserted at the drop slot (or
    // a bare root in open space). Neighbours reflow around it.
    const previewTree = derive((): Tree => {
      const d = dragId.value;
      if (d === null) return tree.value;
      const dt = drop.value;
      const t = withoutNode(tree.value, d);
      if (dt.list) {
        const arr = (t.kids[dt.list] ?? []).slice();
        arr.splice(Math.min(dt.index, arr.length), 0, d);
        return { kids: { ...t.kids, [dt.list]: arr }, roots: t.roots };
      }
      return { kids: t.kids, roots: [...t.roots, d] };
    });

    const preview = treeStack<string>({
      roots: () => previewTree.value.roots,
      kids: id => previewTree.value.kids[id] ?? [],
      container: isList,
      leaf: () => ({ w: LEAF_W, h: LEAF_H }),
      // A dragged node placed as a root sits under the pointer; everyone
      // else keeps their committed origin.
      origin: id =>
        dragId.value === id && drop.value.list === null ? lift[id]!.value : rootPos[id]!.value,
      header: HEADER,
      pad: PAD,
      gap: GAP,
      minWidth: MIN_W,
      emptyHeight: EMPTY_H,
    });

    // The dragged subtree renders rigidly at the pointer: shift it by the
    // gap between its slot and the pointer.
    const offset = derive(() => {
      const d = dragId.value;
      if (d === null) return { x: 0, y: 0 };
      const m = preview.boxes.value.get(d);
      const l = lift[d]!.value;
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
        const d = dragId.value;
        return d !== null && subtree(tree.value, d).has(id);
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
      // The reflow springs every box (xywh); the dragged subtree is written
      // directly so it tracks the pointer crisply.
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

      const isDropTarget = derive(() => drop.value.list === id);
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
      r.on("pointerdown", () => {
        const b = dispBox.peek();
        lift[id]!.value = { x: b.x, y: b.y };
      });
      const dragging = cell(false);
      drag(r, lift[id]!, dragging);

      let was = false;
      effect(() => {
        const now = dragging.value;
        if (now && !was) {
          dragId.value = id;
          // Raise the dragged subtree (rect then label, so text stays on top).
          for (const sid of subtree(tree.peek(), id)) {
            const sh = shapes[sid];
            if (sh) {
              sh.rect.el.parentElement?.appendChild(sh.rect.el);
              sh.label.el.parentElement?.appendChild(sh.label.el);
            }
          }
        } else if (!now && was) {
          const dt = drop.peek();
          const t = withoutNode(tree.peek(), id);
          const kids = { ...t.kids };
          let roots = t.roots.slice();
          if (dt.list) {
            const arr = (kids[dt.list] ?? []).slice();
            arr.splice(Math.min(dt.index, arr.length), 0, id);
            kids[dt.list] = arr;
          } else if (dt.wrap && isLeaf) {
            const nl = freeList(tree.peek());
            const l = lift[id]!.peek();
            if (nl) {
              kids[nl] = [id];
              roots = [...roots, nl];
              rootPos[nl]!.value = { x: l.x - PAD, y: l.y - HEADER - PAD };
            } else {
              roots = [...roots, id];
              rootPos[id]!.value = l;
            }
          } else {
            roots = [...roots, id];
            rootPos[id]!.value = lift[id]!.peek();
          }
          tree.value = { kids, roots };
          dragId.value = null;
        }
        was = now;
      });
    }

    // Ghost of the list a far-dropped leaf would be wrapped in.
    const wrapBox = derive(() => {
      const d = dragId.value;
      if (d === null || !drop.value.wrap) return { x: 0, y: 0, w: 0, h: 0 };
      const l = lift[d]!.value;
      return {
        x: l.x - PAD,
        y: l.y - HEADER - PAD,
        w: LEAF_W + 2 * PAD,
        h: LEAF_H + HEADER + 2 * PAD,
      };
    });
    s(
      rect(
        Box.derive(() => wrapBox.value),
        {
          corner: 12,
          fill: "#5b8def22",
          stroke: "#5b8def",
          strokeWidth: 1.5,
          opacity: derive(() => (dragId.value !== null && drop.value.wrap ? 1 : 0)),
        },
      ),
    );

    s(
      label(view.top.down(20), "drag boxes and lists — drop in a list to nest, in space to wrap", {
        size: 14,
        bold: true,
      }),
      label(
        view.bottom.up(14),
        "one treeStack lays out a previewed tree · neighbours reflow to open the drop slot · release just commits it",
        { size: 10, fill: "var(--text-secondary, #888)" },
      ),
    );
  }
}
