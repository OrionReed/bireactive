import {
  altAll,
  type CharSet,
  CharSet as CS,
  chr,
  EPS,
  type Re,
  repeat,
  seq,
  seqAll,
  star,
} from "./engine";

/** Thrown when a pattern uses a construct outside the regular subset. */
export class RegError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RegError";
  }
}

const LINE_TERMINATORS = CS.of([
  [0x0a, 0x0a],
  [0x0d, 0x0d],
  [0x2028, 0x2029],
]);

// JS \s
const WHITESPACE = CS.of([
  [0x09, 0x0d],
  [0x20, 0x20],
  [0xa0, 0xa0],
  [0x1680, 0x1680],
  [0x2000, 0x200a],
  [0x2028, 0x2029],
  [0x202f, 0x202f],
  [0x205f, 0x205f],
  [0x3000, 0x3000],
  [0xfeff, 0xfeff],
]);
const DIGIT = CS.range(0x30, 0x39);
const WORD = CS.of([
  [0x30, 0x39],
  [0x41, 0x5a],
  [0x5f, 0x5f],
  [0x61, 0x7a],
]);

interface Flags {
  ignoreCase: boolean;
  dotAll: boolean;
}

/** Compile a `RegExp` to an engine `Re`, or throw `RegError`. */
export function compileRegex(re: RegExp): Re {
  const flags: Flags = { ignoreCase: re.flags.includes("i"), dotAll: re.flags.includes("s") };
  const p = new Parser(re.source, flags);
  const r = p.parseAlternation();
  if (!p.atEnd()) throw new RegError(`unexpected "${p.peek()}" at ${p.pos} in /${re.source}/`);
  return r;
}

class Parser {
  pos = 0;
  constructor(
    readonly src: string,
    readonly flags: Flags,
  ) {}

  atEnd(): boolean {
    return this.pos >= this.src.length;
  }
  peek(): string {
    return this.src[this.pos] ?? "";
  }
  next(): string {
    return this.src[this.pos++] ?? "";
  }

  mkChr(set: CharSet): Re {
    return chr(this.flags.ignoreCase ? set.ignoreCase() : set);
  }

  parseAlternation(): Re {
    const branches: Re[] = [this.parseConcat()];
    while (this.peek() === "|") {
      this.next();
      branches.push(this.parseConcat());
    }
    return branches.length === 1 ? branches[0]! : altAll(branches);
  }

  parseConcat(): Re {
    const parts: Re[] = [];
    while (!this.atEnd() && this.peek() !== "|" && this.peek() !== ")") {
      parts.push(this.parseQuantified());
    }
    return seqAll(parts);
  }

  parseQuantified(): Re {
    const atom = this.parseAtom();
    return this.applyQuantifier(atom);
  }

  applyQuantifier(atom: Re): Re {
    const c = this.peek();
    let out: Re;
    if (c === "*") {
      this.next();
      out = star(atom);
    } else if (c === "+") {
      this.next();
      out = seq(atom, star(atom));
    } else if (c === "?") {
      this.next();
      out = altAll([atom, EPS]);
    } else if (c === "{") {
      const saved = this.pos;
      const bounds = this.tryParseBraces();
      if (bounds === null) {
        this.pos = saved;
        return atom; // a literal "{" — handled as a char by parseAtom next round
      }
      out = repeat(atom, bounds[0], bounds[1]);
    } else {
      return atom;
    }
    if (this.peek() === "?") this.next(); // lazy marker: parsed, ignored
    return out;
  }

  /** Parse `{n}` / `{n,}` / `{n,m}` after the `{`. Returns `null` if it isn't a
   *  well-formed quantifier (then `{` is a literal). */
  tryParseBraces(): [number, number | undefined] | null {
    if (this.peek() !== "{") return null;
    this.next();
    const lo = this.readInt();
    if (lo === null) return null;
    let hi: number | undefined = lo;
    if (this.peek() === ",") {
      this.next();
      hi = this.peek() === "}" ? undefined : (this.readInt() ?? undefined);
    }
    if (this.peek() !== "}") return null;
    this.next();
    return [lo, hi];
  }

  readInt(): number | null {
    let s = "";
    while (/[0-9]/.test(this.peek())) s += this.next();
    return s === "" ? null : Number.parseInt(s, 10);
  }

  parseAtom(): Re {
    const c = this.peek();
    if (c === "(") return this.parseGroup();
    if (c === "[") return this.parseClass();
    if (c === ".") {
      this.next();
      return this.mkChr(this.flags.dotAll ? CS.full() : LINE_TERMINATORS.complement());
    }
    if (c === "^" || c === "$") {
      throw new RegError(`anchors (^ $) are not supported: they aren't regular operators`);
    }
    if (c === "\\") return this.parseEscape(false);
    if (c === "*" || c === "+" || c === "?") {
      throw new RegError(`nothing to repeat before "${c}" at ${this.pos}`);
    }
    this.next();
    return this.mkChr(CS.char(c.charCodeAt(0)));
  }

  parseGroup(): Re {
    this.next(); // (
    if (this.peek() === "?") {
      this.next();
      const k = this.peek();
      if (k === ":") {
        this.next();
      } else if (k === "<" && (this.src[this.pos + 1] === "=" || this.src[this.pos + 1] === "!")) {
        throw new RegError("lookbehind (?<=…)/(?<!…) is not supported");
      } else if (k === "<") {
        // named capture (?<name>…): grouping only, name is irrelevant here
        this.next();
        while (!this.atEnd() && this.peek() !== ">") this.next();
        if (this.peek() !== ">") throw new RegError("malformed named group");
        this.next();
      } else if (k === "=" || k === "!") {
        throw new RegError("lookahead (?=…)/(?!…) is not supported");
      } else {
        throw new RegError(`unsupported group "(?${k}" at ${this.pos}`);
      }
    }
    const inner = this.parseAlternation();
    if (this.peek() !== ")") throw new RegError(`unbalanced "(" — expected ")" at ${this.pos}`);
    this.next();
    return inner;
  }

  parseClass(): Re {
    this.next(); // [
    let negated = false;
    if (this.peek() === "^") {
      this.next();
      negated = true;
    }
    let set = CS.empty();
    const add = (s: CharSet) => {
      set = set.union(s);
    };
    while (!this.atEnd() && this.peek() !== "]") {
      // a class member: either an escape, or a char, possibly a range a-b
      let lo: number | CharSet;
      if (this.peek() === "\\") {
        const e = this.parseEscape(true);
        lo = e; // either a single-char CharSet or a class-escape CharSet
      } else {
        lo = this.next().charCodeAt(0);
      }
      if (typeof lo !== "number") {
        add(lo); // class escape (\d etc.) — can't be a range endpoint
        continue;
      }
      if (this.peek() === "-" && this.src[this.pos + 1] !== "]" && this.pos + 1 < this.src.length) {
        this.next(); // -
        let hi: number;
        if (this.peek() === "\\") {
          const e = this.parseEscape(true);
          if (typeof e !== "number") {
            // range with a class escape on the right is invalid; treat literally
            add(CS.char(lo));
            add(CS.char(0x2d));
            add(e);
            continue;
          }
          hi = e;
        } else {
          hi = this.next().charCodeAt(0);
        }
        add(CS.range(lo, hi));
      } else {
        add(CS.char(lo));
      }
    }
    if (this.peek() !== "]") throw new RegError(`unterminated character class`);
    this.next();
    return this.mkChr(negated ? set.complement() : set);
  }

  /** Parse an escape. In a class, returns a `CharSet` (class escapes allowed);
   *  outside, returns an `Re`. The `number` return is a single code point (so a
   *  class can use it as a range endpoint). */
  parseEscape(inClass: true): number | CharSet;
  parseEscape(inClass: false): Re;
  parseEscape(inClass: boolean): number | CharSet | Re {
    this.next(); // backslash
    const c = this.next();
    const set = (s: CharSet): CharSet | Re => (inClass ? s : this.mkChr(s));
    const cp = (code: number): number | CharSet | Re =>
      inClass ? code : this.mkChr(CS.char(code));
    switch (c) {
      case "d":
        return set(DIGIT);
      case "D":
        return set(DIGIT.complement());
      case "w":
        return set(WORD);
      case "W":
        return set(WORD.complement());
      case "s":
        return set(WHITESPACE);
      case "S":
        return set(WHITESPACE.complement());
      case "t":
        return cp(0x09);
      case "n":
        return cp(0x0a);
      case "r":
        return cp(0x0d);
      case "f":
        return cp(0x0c);
      case "v":
        return cp(0x0b);
      case "0":
        return cp(0x00);
      case "b":
        if (inClass) return cp(0x08); // backspace inside a class
        throw new RegError("word boundary \\b is not supported");
      case "B":
        throw new RegError("non-word-boundary \\B is not supported");
      case "x": {
        const h = this.src.slice(this.pos, this.pos + 2);
        if (!/^[0-9a-fA-F]{2}$/.test(h)) throw new RegError("malformed \\xHH escape");
        this.pos += 2;
        return cp(Number.parseInt(h, 16));
      }
      case "u":
        return cp(this.parseUnicodeEscape());
      default:
        if (/[1-9]/.test(c)) throw new RegError(`backreference \\${c} is not supported`);
        if (c === "k") throw new RegError("named backreference \\k<…> is not supported");
        return cp(c.charCodeAt(0)); // escaped literal: \. \\ \( etc.
    }
  }

  parseUnicodeEscape(): number {
    if (this.peek() === "{") {
      this.next();
      let h = "";
      while (this.peek() !== "}" && !this.atEnd()) h += this.next();
      if (this.peek() !== "}") throw new RegError("malformed \\u{…} escape");
      this.next();
      const v = Number.parseInt(h, 16);
      if (Number.isNaN(v)) throw new RegError("malformed \\u{…} escape");
      return v;
    }
    const h = this.src.slice(this.pos, this.pos + 4);
    if (!/^[0-9a-fA-F]{4}$/.test(h)) throw new RegError("malformed \\uHHHH escape");
    this.pos += 4;
    return Number.parseInt(h, 16);
  }
}
