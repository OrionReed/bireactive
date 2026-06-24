import type { Cell, Writable } from "../cell";
import { Str } from "../values/str";

type V = string;

// ── word parsing ─────────────────────────────────────────────────────

/** A "word" character: letters, digits, underscore, apostrophe, hyphen
 *  (handles "don't", "co-op"). Everything else is a separator. */
const WORD_CHAR = /[\p{L}\p{N}_'-]/u;

/** Split `s` into words and separators. Returns:
 *
 *    words[i] — the i-th run of word characters
 *    seps[0]  — leading non-word characters (possibly empty)
 *    seps[i]  — for 1 ≤ i ≤ words.length-1, the separator BETWEEN
 *               `words[i-1]` and `words[i]`
 *    seps[words.length] — trailing non-word characters
 *
 *  Always satisfies `seps.length === words.length + 1`. */
export function parseWords(s: V): { words: V[]; seps: V[] } {
  const words: V[] = [];
  const seps: V[] = [];
  let cur = "";
  let inWord = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i]!;
    if (WORD_CHAR.test(c)) {
      if (!inWord) {
        seps.push(cur);
        cur = "";
        inWord = true;
      }
      cur += c;
    } else {
      if (inWord) {
        words.push(cur);
        cur = "";
        inWord = false;
      }
      cur += c;
    }
  }
  if (inWord) {
    words.push(cur);
    seps.push("");
  } else {
    seps.push(cur);
  }
  return { words, seps };
}

/** Inverse of `parseWords`. Interleaves words with `seps`; added words
 *  get `" "` gaps, removed words keep the original trailing separator.
 *  A zero-word original (`seps.length === 1`) treats its one entry as
 *  lead only, so words append after it without double-counting as trail. */
export function rebuildWords(words: V[], seps: V[]): V {
  const n = words.length;
  if (n === 0) return seps[0] ?? "";
  const lead = seps[0] ?? "";
  const trail = seps.length > 1 ? (seps[seps.length - 1] ?? "") : "";
  let out = lead;
  for (let i = 0; i < n; i++) {
    out += words[i];
    if (i < n - 1) {
      const idx = i + 1;
      // Interior separators only; the final `seps` entry is the trail.
      const sep = idx < seps.length - 1 ? seps[idx] : undefined;
      out += sep !== undefined ? sep : " ";
    } else {
      out += trail;
    }
  }
  return out;
}

// ── case masks ───────────────────────────────────────────────────────

/** Per-character case mask: `U` upper letter, `L` lower letter,
 *  `" "` non-letter. Length matches the source. */
export function caseMaskOf(s: V): string {
  let mask = "";
  for (let i = 0; i < s.length; i++) {
    const c = s[i]!;
    if (c >= "A" && c <= "Z") mask += "U";
    else if (c >= "a" && c <= "z") mask += "L";
    else mask += " ";
  }
  return mask;
}

/** Apply a case mask to `target`, position by position. Mask positions
 *  beyond `target.length` are ignored; target positions beyond the
 *  mask keep their native case (e.g. user appended a longer word). */
export function applyCaseMask(target: V, mask: string): V {
  let out = "";
  for (let i = 0; i < target.length; i++) {
    const c = target[i]!;
    const m = i < mask.length ? mask[i] : " ";
    if (m === "U") out += c.toUpperCase();
    else if (m === "L") out += c.toLowerCase();
    else out += c;
  }
  return out;
}

const ASCII_LETTER = (c: string): boolean => (c >= "a" && c <= "z") || (c >= "A" && c <= "Z");

/** Apply the case pattern of a source word to a target word. Detects
 *  all-upper / all-lower / title case, else falls back to position-wise
 *  `applyCaseMask`. Non-letter target chars always pass through unchanged
 *  (title-casing "-gng" → "-Gng"). */
export function applyCasePattern(target: V, mask: string): V {
  if (target.length === 0 || mask.length === 0) return target;
  const letters = [...mask].filter(c => c === "U" || c === "L");
  if (letters.length === 0) return target;
  if (letters.every(c => c === "U")) return target.toUpperCase();
  if (letters.every(c => c === "L")) return target.toLowerCase();
  if (letters[0] === "U" && letters.slice(1).every(c => c === "L")) {
    // Title case: uppercase the first letter (skipping leading
    // non-letters), lowercase the rest, pass non-letters through.
    let out = "";
    let firstLetterDone = false;
    for (let i = 0; i < target.length; i++) {
      const c = target[i]!;
      if (ASCII_LETTER(c)) {
        out += firstLetterDone ? c.toLowerCase() : c.toUpperCase();
        firstLetterDone = true;
      } else {
        out += c;
      }
    }
    return out;
  }
  return applyCaseMask(target, mask);
}

// ── case complement ──────────────────────────────────────────────────

interface CaseComplement {
  /** Per-position case mask (positional fallback for new content — a
   *  word added at `i` inherits the source mask at `i`). */
  wordMasks: string[];
  /** Case masks keyed by lowercased word — the primary lookup; survives
   *  split / insert / reorder. Duplicates stay in source order
   *  (FIFO-consumed in the backward pass). */
  byContent: Map<string, string[]>;
}

/** (Re)build the case complement: positional `wordMasks` and content-keyed
 *  `byContent` in one pass. `byContent` lists stay in source order for FIFO
 *  consumption on write-back. */
function refreshCaseComplement(s: V, c: CaseComplement): void {
  const { words } = parseWords(s);
  const wordMasks = words.map(caseMaskOf);
  const byContent = new Map<string, string[]>();
  for (let i = 0; i < words.length; i++) {
    const key = words[i]!.toLowerCase();
    let list = byContent.get(key);
    if (list === undefined) {
      list = [];
      byContent.set(key, list);
    }
    list.push(wordMasks[i]!);
  }
  c.wordMasks = wordMasks;
  c.byContent = byContent;
}

/** Apply the case complement to a target string and rebuild. Each
 *  target word goes through three lookup tiers — content match
 *  (FIFO-consumed from a per-call clone), positional fallback, then
 *  native pass-through. */
function applyCaseComplement(target: V, c: CaseComplement): V {
  const { words, seps } = parseWords(target);
  // Per-call clone: consume FIFO without mutating the stored map, so
  // repeated writes start from the same state.
  const remaining = new Map<string, string[]>();
  for (const [k, list] of c.byContent) remaining.set(k, list.slice());
  const cased = words.map((w, i) => {
    const key = w.toLowerCase();
    const matches = remaining.get(key);
    if (matches !== undefined && matches.length > 0) {
      return applyCasePattern(w, matches.shift()!);
    }
    const mask = i < c.wordMasks.length ? c.wordMasks[i]! : "";
    return mask.length === 0 ? w : applyCasePattern(w, mask);
  });
  return rebuildWords(cased, seps);
}

function buildCaseComplement(s: V): CaseComplement {
  const c: CaseComplement = { wordMasks: [], byContent: new Map() };
  refreshCaseComplement(s, c);
  return c;
}

// ── caseFold ─────────────────────────────────────────────────────────

/** Case-folded view of a string cell with word-aware case recovery on
 *  write. Read folds to lower (default) or upper; write recovers the
 *  source's per-word case — lookup priority: (1) content match (FIFO
 *  across duplicates); (2) per-position fallback for new content; (3)
 *  native for content beyond the source structure. */
export function caseFold(parent: Cell<V>, to: "lower" | "upper" = "lower"): Writable<Str> {
  const fold = to === "upper" ? (s: V) => s.toUpperCase() : (s: V) => s.toLowerCase();
  return Str.lens(parent, {
    init: (s: V) => buildCaseComplement(s),
    fwd: (s: V) => fold(s),
    bwd: (target: V, _s: V, c: CaseComplement) => ({
      update: applyCaseComplement(target, c),
      complement: c,
    }),
  }) as Writable<Str>;
}
