// Shared Automerge repo for the demos. One Repo per tab, wired to:
//   • BroadcastChannel — tabs of this origin sync live;
//   • IndexedDB        — docs persist across reloads and closes.
// The current doc id is kept in localStorage (so reloads and sibling tabs reuse
// it) and surfaced in the UI for copy/paste sharing — no query string, so the
// address bar stays clean. `loadDoc` switches to any pasted id in place.

import {
  type AnyDocumentId,
  type DocHandle,
  initSubduction,
  Repo,
} from "@automerge/automerge-repo";
import { BroadcastChannelNetworkAdapter } from "@automerge/automerge-repo-network-broadcastchannel";
import { IndexedDBStorageAdapter } from "@automerge/automerge-repo-storage-indexeddb";

let repoPromise: Promise<Repo> | null = null;

function getRepo(): Promise<Repo> {
  repoPromise ??= initSubduction().then(
    () =>
      new Repo({
        network: [new BroadcastChannelNetworkAdapter()],
        storage: new IndexedDBStorageAdapter("bireactive-demos"),
      }),
  );
  return repoPromise;
}

const key = (param: string) => `bireactive.${param}`;

/** Resolve the last-used doc from localStorage (persisted in IndexedDB), else
 *  create a fresh one. */
export async function findOrCreate<T extends object>(
  param: string,
  seed: T,
): Promise<DocHandle<T>> {
  const repo = await getRepo();
  const stored = localStorage.getItem(key(param));
  let handle: DocHandle<T> | undefined;
  if (stored) {
    try {
      handle = await repo.find<T>(stored as AnyDocumentId, { signal: AbortSignal.timeout(3000) });
    } catch {
      // Unknown to storage and no peer has it — fall through and create fresh.
    }
  }
  handle ??= repo.create<T>(seed);
  localStorage.setItem(key(param), handle.url);
  return handle;
}

/** Switch to a specific doc by id/url (for pasting a shared link). Throws if it
 *  can't be found within the timeout. */
export async function loadDoc<T extends object>(param: string, id: string): Promise<DocHandle<T>> {
  const repo = await getRepo();
  const handle = await repo.find<T>(id.trim() as AnyDocumentId, {
    signal: AbortSignal.timeout(5000),
  });
  localStorage.setItem(key(param), handle.url);
  return handle;
}
