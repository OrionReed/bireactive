// lens.ts — hub-and-spoke wiring: one abstract-value hub cell, one
// stateful text lens per concrete syntax.
//
// Each spoke's complement is { text, tree, errors, synced }: the
// concrete text, its tolerant CST, current error regions, and the hub
// value this text last agreed with (by identity — the hub only changes
// identity on a real change). The spoke:
//
//   put   — parse the written text. Clean ⇒ push the recovered value to
//           the hub. Errors ⇒ `SKIP` (hub untouched), but the complement
//           keeps the broken text so the view echoes it back instead of
//           trampling the editor.
//   get   — when the hub moved away from `synced`, absorb it by three-way
//           surgical merge around any error regions (the sole refresh,
//           idempotent once synced); then emit the complement's text.

import { type Cell, cell, lens, SKIP, type Writable } from "../core/cell";
import {
  deepEqual,
  type FormatAdapter,
  type JsonValue,
  mergeText,
  type Node,
  type ParseError,
  valueOf,
} from "./cst";

interface Complement {
  text: string;
  tree: Node;
  errors: ParseError[];
  synced: JsonValue;
}

function fromValue(adapter: FormatAdapter, v: JsonValue): Complement {
  const text = adapter.print(v);
  const { tree, errors } = adapter.parse(text);
  return { text, tree, errors, synced: v };
}

function absorb(adapter: FormatAdapter, c: Complement, theirs: JsonValue): Complement {
  const { text } = mergeText(adapter, c.text, c.tree, c.errors, theirs, c.synced);
  if (text === c.text) return { ...c, synced: theirs };
  const { tree, errors } = adapter.parse(text);
  return { text, tree, errors, synced: theirs };
}

/** Writable hub for a shared abstract value (deep-equality pruned). */
export function valueHub(initial: JsonValue): Writable<Cell<JsonValue>> {
  return cell<JsonValue>(initial, { equals: deepEqual });
}

/** Writable text view of `hub` in `adapter`'s syntax. Valid edits push
 *  through; broken edits hold the hub and merge external changes around
 *  the error regions. */
export function formatSpoke(
  hub: Writable<Cell<JsonValue>>,
  adapter: FormatAdapter,
): Writable<Cell<string>> {
  return lens(hub, {
    complement: (v: JsonValue): Complement => fromValue(adapter, v),
    // `get` is the sole refresh: when the hub moved off `synced`, absorb it by
    // surgical merge (idempotent — once `synced === v`, re-reading is a no-op).
    get: (v: JsonValue, c: Complement): string => {
      if (v !== c.synced) Object.assign(c, absorb(adapter, c, v));
      return c.text;
    },
    put: (target: string, _v: JsonValue, c: Complement) => {
      const { tree, errors } = adapter.parse(target);
      if (errors.length === 0) {
        const v = valueOf(tree);
        Object.assign(c, { text: target, tree, errors, synced: v });
        return v;
      }
      // Broken edit: keep the text (so the view echoes it) but hold `synced`.
      Object.assign(c, { text: target, tree, errors });
      return SKIP;
    },
  });
}
