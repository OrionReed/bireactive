// End-to-end sync: two independent Repos wired over a BroadcastChannel (a real
// network, real sync protocol), so changes arrive *remotely* and fire `change`
// with sync-driven patches — the path `connectDoc` must survive in production.
// These exercise the doc→cell bridge under genuinely concurrent, out-of-process
// edits (not the synchronous `merge` of bridge.test.ts).

import { initSubduction, Repo } from "@automerge/automerge-repo";
import { BroadcastChannelNetworkAdapter } from "@automerge/automerge-repo-network-broadcastchannel";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { batch, settle } from "../../core/cell";
import { connectCell, connectStore } from "../doc-cell";
import { reconcile } from "../reconcile";

beforeAll(async () => {
  await initSubduction();
});

// Repos opened per test; torn down afterwards so no BroadcastChannel keeps the
// event loop alive between tests.
let repos: Repo[] = [];
afterEach(async () => {
  await Promise.all(repos.map(r => r.shutdown()));
  repos = [];
});

/** A pair of repos sharing one BroadcastChannel (unique per call). */
function peers(): [Repo, Repo] {
  const channelName = `t-${Math.random().toString(36).slice(2)}`;
  const a = new Repo({ network: [new BroadcastChannelNetworkAdapter({ channelName })] });
  const b = new Repo({ network: [new BroadcastChannelNetworkAdapter({ channelName })] });
  repos.push(a, b);
  return [a, b];
}

/** Poll until `pred()` holds (sync is async); throws on timeout. */
async function until(pred: () => boolean, ms = 2000): Promise<void> {
  const start = Date.now();
  while (!pred()) {
    if (Date.now() - start > ms) throw new Error("timed out waiting for sync");
    await new Promise(r => setTimeout(r, 5));
  }
}

type Shape = { props: { text: string; n: number } };
type Doc = { store: Record<string, Shape> };
const shape = (text: string, n: number): Shape => ({ props: { text, n } });

describe("remote sync — doc → cell", () => {
  it("reflects a remote edit in a bridged store", async () => {
    const [a, b] = peers();
    const ha = a.create<Doc>({ store: { s0: shape("hello", 0) } });
    const hb = await b.find<Doc>(ha.url);
    const { store, dispose } = connectStore(hb);
    expect(store.store.s0.props.text.value).toBe("hello");

    ha.change(d => {
      d.store.s0.props.text = "hello world";
    });
    await until(() => store.store.s0.props.text.peek() === "hello world");
    expect(store.store.s0.props.text.value).toBe("hello world");
    dispose();
  });

  it("a remote sibling edit doesn't change an untouched slice's identity", async () => {
    const [a, b] = peers();
    const ha = a.create<Doc>({ store: { s0: shape("a", 0), s1: shape("b", 0) } });
    const hb = await b.find<Doc>(ha.url);
    const { cell, dispose } = connectCell(hb);
    const beforeS0 = cell.value.store.s0;

    ha.change(d => {
      d.store.s1.props.text = "b!";
    });
    await until(() => cell.value.store.s1.props.text === "b!");
    // Patch-driven invalidation: s0 keeps its reference across the remote change.
    expect(cell.value.store.s0).toBe(beforeS0);
    dispose();
  });

  it("remote char-level text edits merge with a concurrent local lens edit", async () => {
    const [a, b] = peers();
    const ha = a.create<{ title: string }>({ title: "hello world" });
    const hb = await b.find<{ title: string }>(ha.url);
    const { cell, dispose } = connectCell(hb);

    // Concurrent: a inserts a word remotely (char-level via reconcile); b appends
    // via the bridged cell (also char-level). Disjoint inserts → both survive.
    ha.change(d => reconcile(d, { title: "hello brave world" }));
    batch(() => {
      cell.value = { title: "hello world!!!" };
    });
    await until(() => {
      const t = ha.doc().title;
      return t.includes("brave") && t.includes("!!!");
    });
    settle();
    // Both edits survive the char-level merge, both sides converge.
    expect(cell.value.title).toBe(ha.doc().title);
    expect(cell.value.title).toContain("brave");
    expect(cell.value.title).toContain("!!!");
    dispose();
  });

  it("reflects a remote key deletion", async () => {
    const [a, b] = peers();
    const ha = a.create<Doc>({ store: { s0: shape("a", 0), s1: shape("b", 0) } });
    const hb = await b.find<Doc>(ha.url);
    const { cell, dispose } = connectCell(hb);
    const beforeS0 = cell.value.store.s0;

    ha.change(d => {
      delete d.store.s1;
    });
    await until(() => cell.value.store.s1 === undefined);
    expect(Object.keys(cell.value.store)).toEqual(["s0"]);
    expect(cell.value.store.s0).toBe(beforeS0); // survivor shared
    dispose();
  });
});

describe("remote sync — cell → doc → remote", () => {
  it("a bridged write propagates to the remote peer", async () => {
    const [a, b] = peers();
    const ha = a.create<Doc>({ store: { s0: shape("a", 1) } });
    const hb = await b.find<Doc>(ha.url);
    const { store, dispose } = connectStore(hb);

    batch(() => {
      store.store.s0.props.n.value = 42;
    });
    await until(() => ha.doc().store.s0.props.n === 42);
    expect(ha.doc().store.s0.props.n).toBe(42);
    dispose();
  });

  it("converges with no echo loop after a round-trip", async () => {
    const [a, b] = peers();
    const ha = a.create<Doc>({ store: { s0: shape("a", 0) } });
    const hb = await b.find<Doc>(ha.url);
    const { cell, dispose } = connectCell(hb);

    batch(() => {
      cell.value = { store: { s0: shape("a", 5) } };
    });
    await until(() => ha.doc().store.s0.props.n === 5);
    // Let any echo settle, then assert both sides are equal and stable.
    await new Promise(r => setTimeout(r, 50));
    settle();
    expect(cell.value).toEqual(structuredClone(hb.doc()));
    expect(cell.value).toEqual(structuredClone(ha.doc()));
    dispose();
  });
});

describe("remote sync — concurrent convergence", () => {
  it("two bridged peers converge on disjoint-field edits", async () => {
    const [a, b] = peers();
    const ha = a.create<Doc>({ store: { s0: shape("x", 0) } });
    const hb = await b.find<Doc>(ha.url);
    const ba = connectCell(ha);
    const bb = connectCell(hb);

    // a edits text via its bridge; b edits n via its bridge — disjoint fields.
    batch(() => {
      ba.cell.value = { store: { s0: shape("y", 0) } };
    });
    batch(() => {
      bb.cell.value = { store: { s0: shape("x", 9) } };
    });
    await until(() => {
      const da = ha.doc().store.s0.props;
      const db = hb.doc().store.s0.props;
      return da.text === db.text && da.n === db.n && da.text === "y" && da.n === 9;
    });
    settle();
    expect(ha.doc().store.s0.props).toEqual({ text: "y", n: 9 });
    expect(ba.cell.value).toEqual(structuredClone(ha.doc()));
    expect(bb.cell.value).toEqual(structuredClone(hb.doc()));
    ba.dispose();
    bb.dispose();
  });

  it("keyed list reorders merge across peers without clobbering edits", async () => {
    type ListDoc = { items: { id: number; v: number }[] };
    const by = (e: unknown): unknown =>
      e !== null && typeof e === "object" && "id" in e ? (e as { id: number }).id : undefined;
    const [a, b] = peers();
    const ha = a.create<ListDoc>({
      items: [
        { id: 1, v: 1 },
        { id: 2, v: 2 },
        { id: 3, v: 3 },
      ],
    });
    const hb = await b.find<ListDoc>(ha.url);
    const ba = connectCell(ha, { by });
    const bb = connectCell(hb, { by });

    // a reorders (id:3 to front); b edits a kept element — concurrent, keyed.
    batch(() => {
      ba.cell.value = {
        items: [
          { id: 3, v: 3 },
          { id: 1, v: 1 },
          { id: 2, v: 2 },
        ],
      };
    });
    batch(() => {
      bb.cell.value = {
        items: [
          { id: 1, v: 111 },
          { id: 2, v: 2 },
          { id: 3, v: 3 },
        ],
      };
    });
    await until(() => {
      const ia = ha.doc().items;
      const ib = hb.doc().items;
      const eq = JSON.stringify(ia) === JSON.stringify(ib);
      return eq && ia.length === 3 && ia.some(i => i.v === 111);
    });
    settle();
    const items = ha.doc().items;
    expect(Object.fromEntries(items.map(i => [i.id, i.v]))).toEqual({ 1: 111, 2: 2, 3: 3 });
    expect(items[0].id).toBe(3); // a's reorder survived the merge
    expect(ba.cell.value).toEqual(structuredClone(ha.doc()));
    ba.dispose();
    bb.dispose();
  });
});

describe("remote sync — late joiner", () => {
  it("a peer that connects after edits catches up to the latest state", async () => {
    const [a, b] = peers();
    const ha = a.create<Doc>({ store: { s0: shape("v0", 0) } });
    // Mutate before b has found the doc.
    ha.change(d => {
      d.store.s0.props.text = "v1";
    });
    ha.change(d => {
      d.store.s1 = shape("new", 7);
    });
    const hb = await b.find<Doc>(ha.url);
    const { cell, dispose } = connectCell(hb);
    await until(
      () => cell.value.store.s0?.props.text === "v1" && cell.value.store.s1 !== undefined,
    );
    expect(cell.value).toEqual(structuredClone(ha.doc()));
    dispose();
  });
});
