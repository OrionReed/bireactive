// Format adapters: round trips, error tolerance, surgical merges, and
// the full hub-and-spoke write-around scenario.

import { describe, expect, it } from "vitest";
import { effect, settle } from "../../core/cell";
import {
  deepEqual,
  type FormatAdapter,
  type JsonObject,
  type JsonValue,
  mergeText,
  valueOf,
} from "../cst";
import { ednFormat } from "../edn";
import { jsonFormat } from "../json";
import { formatSpoke, valueHub } from "../lens";
import { tomlFormat } from "../toml";
import { yamlFormat } from "../yaml";

const SAMPLE: JsonValue = {
  name: "starship",
  version: "2.4.1",
  active: true,
  retries: 3,
  tags: ["alpha", "fast"],
  server: { host: "example.com", port: 8080, secure: true },
};

const ADAPTERS = [jsonFormat, yamlFormat, tomlFormat, ednFormat];

/** Parse + merge in one go (the lens's `absorb` without the reactive shell). */
function merge(
  adapter: FormatAdapter,
  text: string,
  theirs: JsonValue,
  base: JsonValue | undefined,
): string {
  const { tree, errors } = adapter.parse(text);
  return mergeText(adapter, text, tree, errors, theirs, base).text;
}

describe("round trips", () => {
  for (const a of ADAPTERS) {
    it(`${a.name}: print → parse recovers the value`, () => {
      const text = a.print(SAMPLE);
      const { tree, errors } = a.parse(text);
      expect(errors).toEqual([]);
      expect(deepEqual(valueOf(tree), SAMPLE)).toBe(true);
    });

    it(`${a.name}: merge with no change is identity`, () => {
      const text = a.print(SAMPLE);
      expect(merge(a, text, SAMPLE, SAMPLE)).toBe(text);
    });

    it(`${a.name}: scalar replace touches only the scalar`, () => {
      const text = a.print(SAMPLE);
      const theirs = structuredClone(SAMPLE) as JsonObject;
      (theirs.server as JsonObject).port = 9090;
      const out = merge(a, text, theirs, SAMPLE);
      expect(out).toContain("9090");
      expect(out).not.toContain("8080");
      // Everything else byte-identical.
      expect(out.replace("9090", "8080")).toBe(text);
      const re = a.parse(out);
      expect(re.errors).toEqual([]);
      expect(deepEqual(valueOf(re.tree), theirs)).toBe(true);
    });

    it(`${a.name}: insert and delete keys reparse correctly`, () => {
      const text = a.print(SAMPLE);
      const theirs = structuredClone(SAMPLE) as JsonObject;
      delete theirs.retries;
      theirs.label = "prod";
      (theirs.server as JsonObject).timeout = 30;
      const out = merge(a, text, theirs, SAMPLE);
      const re = a.parse(out);
      expect(re.errors).toEqual([]);
      expect(deepEqual(valueOf(re.tree), theirs)).toBe(true);
    });

    it(`${a.name}: array item edit and shape change reparse correctly`, () => {
      const text = a.print(SAMPLE);
      const theirs = structuredClone(SAMPLE) as JsonObject;
      theirs.tags = ["alpha", "slow"];
      const out1 = merge(a, text, theirs, SAMPLE);
      const re1 = a.parse(out1);
      expect(re1.errors).toEqual([]);
      expect(deepEqual(valueOf(re1.tree), theirs)).toBe(true);

      const theirs2 = structuredClone(theirs) as JsonObject;
      theirs2.tags = ["alpha", "slow", "extra"];
      const out2 = merge(a, out1, theirs2, theirs);
      const re2 = a.parse(out2);
      expect(re2.errors).toEqual([]);
      expect(deepEqual(valueOf(re2.tree), theirs2)).toBe(true);
    });

    it(`${a.name}: nested object replacing a scalar reparses correctly`, () => {
      const text = a.print(SAMPLE);
      const theirs = structuredClone(SAMPLE) as JsonObject;
      theirs.retries = { max: 3, backoff: 1.5 };
      const out = merge(a, text, theirs, SAMPLE);
      const re = a.parse(out);
      expect(re.errors).toEqual([]);
      expect(deepEqual(valueOf(re.tree), theirs)).toBe(true);
    });
  }
});

describe("error tolerance", () => {
  it("JSON: garbage value breaks only its entry", () => {
    const { tree, errors } = jsonFormat.parse('{"a": 1, "b": oops, "c": 3}');
    expect(errors.length).toBeGreaterThan(0);
    expect(tree.kind).toBe("object");
    const v = valueOf(tree) as JsonObject;
    expect(v.a).toBe(1);
    expect(v.c).toBe(3);
    expect("b" in v).toBe(false);
  });

  it("JSON: missing comma recovers both neighbours", () => {
    const { tree, errors } = jsonFormat.parse('{"a": 1 "b": 2}');
    expect(errors.length).toBe(1);
    const v = valueOf(tree) as JsonObject;
    expect(v.a).toBe(1);
    expect(v.b).toBe(2);
  });

  it("JSON: half-typed literal does not push a prefix value", () => {
    const { tree, errors } = jsonFormat.parse('{"a": tru}');
    expect(errors.length).toBeGreaterThan(0);
    expect("a" in (valueOf(tree) as JsonObject)).toBe(false);
  });

  it("YAML: a bad line breaks only itself", () => {
    const { tree, errors } = yamlFormat.parse("a: 1\nwhat even is this\nc: 3\n");
    expect(errors.length).toBe(1);
    const v = valueOf(tree) as JsonObject;
    expect(v.a).toBe(1);
    expect(v.c).toBe(3);
  });

  it("TOML: a bad line breaks only itself", () => {
    const { tree, errors } = tomlFormat.parse("a = 1\nb = 80x80\nc = 3\n");
    expect(errors.length).toBe(1);
    const v = valueOf(tree) as JsonObject;
    expect(v.a).toBe(1);
    expect(v.c).toBe(3);
    expect("b" in v).toBe(false);
  });

  it("EDN: garbage value breaks only its entry", () => {
    const { tree, errors } = ednFormat.parse("{:a 1 :b @nope :c 3}");
    expect(errors.length).toBeGreaterThan(0);
    const v = valueOf(tree) as JsonObject;
    expect(v.a).toBe(1);
    expect(v.c).toBe(3);
  });
});

describe("write-around", () => {
  it("JSON: external change merges around the broken region", () => {
    const text = '{\n  "a": 1,\n  "b": oops,\n  "c": 3\n}';
    const base: JsonValue = { a: 1, b: 2, c: 3 };
    const theirs: JsonValue = { a: 9, b: 2, c: 3 };
    const out = merge(jsonFormat, text, theirs, base);
    expect(out).toContain('"a": 9');
    expect(out).toContain('"b": oops'); // untouched error region
    expect(out).toContain('"c": 3');
  });

  it("JSON: local valid divergence survives unrelated external changes", () => {
    // User changed a → 5 (valid) and broke b in the same burst; the hub
    // never heard about either. An external insert of d must keep both.
    const text = '{\n  "a": 5,\n  "b": oops,\n  "c": 3\n}';
    const base: JsonValue = { a: 1, b: 2, c: 3 };
    const theirs: JsonValue = { a: 1, b: 2, c: 3, d: 4 };
    const out = merge(jsonFormat, text, theirs, base);
    expect(out).toContain('"a": 5'); // theirs.a === base.a ⇒ mine kept
    expect(out).toContain('"b": oops');
    expect(out).toContain('"d": 4');
  });

  it("JSON: deletion from theirs does not delete a broken entry", () => {
    const text = '{\n  "a": 1,\n  "b": oops\n}';
    const base: JsonValue = { a: 1, b: 2 };
    const theirs: JsonValue = { a: 1 }; // theirs deleted b
    const out = merge(jsonFormat, text, theirs, base);
    expect(out).toContain('"b": oops'); // mid-edit region preserved
  });

  it("YAML: external change merges around a broken line", () => {
    const text = "a: 1\nb oops\nc: 3\n";
    const base: JsonValue = { a: 1, b: 2, c: 3 };
    const theirs: JsonValue = { a: 9, b: 2, c: 3 };
    const out = merge(yamlFormat, text, theirs, base);
    expect(out).toContain("a: 9");
    expect(out).toContain("b oops");
    expect(out).toContain("c: 3");
  });

  it("TOML: external change merges around a broken line", () => {
    const text = "a = 1\nb = 80x80\nc = 3\n";
    const base: JsonValue = { a: 1, b: 2, c: 3 };
    const theirs: JsonValue = { a: 9, b: 2, c: 3 };
    const out = merge(tomlFormat, text, theirs, base);
    expect(out).toContain("a = 9");
    expect(out).toContain("b = 80x80");
  });
});

describe("formatting preservation", () => {
  it("YAML: comments survive scalar edits", () => {
    const text = "name: starship # codename\nport: 8080\n";
    const out = merge(
      yamlFormat,
      text,
      { name: "starship", port: 9090 },
      { name: "starship", port: 8080 },
    );
    expect(out).toBe("name: starship # codename\nport: 9090\n");
  });

  it("YAML: standalone comments survive entry deletion", () => {
    const text = "# header\na: 1\n# note about b\nb: 2\nc: 3\n";
    const out = merge(yamlFormat, text, { a: 1, c: 3 }, { a: 1, b: 2, c: 3 });
    expect(out).toContain("# header");
    expect(out).toContain("# note about b");
    expect(out).not.toContain("b: 2");
  });

  it("TOML: comments survive scalar edits", () => {
    const text = 'name = "x" # codename\nport = 8080\n';
    const out = merge(tomlFormat, text, { name: "x", port: 9090 }, { name: "x", port: 8080 });
    expect(out).toBe('name = "x" # codename\nport = 9090\n');
  });

  it("JSON: idiosyncratic whitespace survives sibling edits", () => {
    const text = '{ "a":1,    "b": 2 }';
    const out = merge(jsonFormat, text, { a: 1, b: 7 }, { a: 1, b: 2 });
    expect(out).toBe('{ "a":1,    "b": 7 }');
  });
});

describe("nested write-around", () => {
  it("YAML: broken nested entry, external sibling edit", () => {
    const text = "server:\n  host: example.com\n  port 9090\nname: x\n";
    const base: JsonValue = { server: { host: "example.com", port: 8080 }, name: "x" };
    const theirs: JsonValue = { server: { host: "other.org", port: 8080 }, name: "x" };
    const out = merge(yamlFormat, text, theirs, base);
    expect(out).toContain("host: other.org");
    expect(out).toContain("port 9090"); // broken line untouched
  });

  it("TOML: broken section line, external edit in another section", () => {
    const text = "[a]\nx = 1\ny = ???\n\n[b]\nz = 2\n";
    const base: JsonValue = { a: { x: 1, y: 9 }, b: { z: 2 } };
    const theirs: JsonValue = { a: { x: 1, y: 9 }, b: { z: 5 } };
    const out = merge(tomlFormat, text, theirs, base);
    expect(out).toContain("z = 5");
    expect(out).toContain("y = ???");
  });

  it("EDN: external change merges around a garbage region", () => {
    const text = "{:a 1\n :b @oops\n :c 3}";
    const out = merge(ednFormat, text, { a: 9, b: 2, c: 3 }, { a: 1, b: 2, c: 3 });
    expect(out).toContain(":a 9");
    expect(out).toContain(":b @oops");
  });
});

describe("mutation stress", () => {
  // Deterministic LCG; drives a random walk of value mutations that are
  // merged surgically into each syntax — every step must reparse clean
  // and equal.
  let seed = 42;
  const rand = (): number => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return seed / 0xffffffff;
  };
  const SEEDS = [42, 7, 1234, 99991];
  const pick = <T>(xs: T[]): T => xs[Math.floor(rand() * xs.length)]!;

  function randomScalar(): JsonValue {
    const r = rand();
    if (r < 0.3) return Math.floor(rand() * 1000);
    if (r < 0.5) return rand() < 0.5;
    if (r < 0.6) return Math.round(rand() * 100) / 10;
    return pick(["red", "green", "blue violet", "x_y", "10.0.0.1", 'with "quotes"']);
  }

  function mutate(v: JsonObject): JsonObject {
    const out = structuredClone(v) as JsonObject;
    // Walk to a random object (root or a nested one).
    const objs: JsonObject[] = [out];
    for (const val of Object.values(out)) {
      if (val !== null && typeof val === "object" && !Array.isArray(val)) {
        objs.push(val as JsonObject);
      }
    }
    const target = pick(objs);
    const keys = Object.keys(target);
    const r = rand();
    if (r < 0.35 && keys.length > 0) {
      target[pick(keys)] = randomScalar();
    } else if (r < 0.55) {
      target[`k${Math.floor(rand() * 20)}`] = randomScalar();
    } else if (r < 0.7 && keys.length > 1) {
      delete target[pick(keys)];
    } else if (r < 0.85) {
      const arrs = keys.filter(k => Array.isArray(target[k]));
      if (arrs.length > 0) {
        const arr = target[pick(arrs)] as JsonValue[];
        if (rand() < 0.5 && arr.length > 0) arr.pop();
        else arr.push(randomScalar());
      } else {
        target[`a${Math.floor(rand() * 5)}`] = [randomScalar()];
      }
    } else {
      target[`o${Math.floor(rand() * 5)}`] = { inner: randomScalar() };
    }
    return out;
  }

  for (const a of ADAPTERS) {
    it(`${a.name}: random mutation chains stay clean and faithful`, () => {
      for (const s of SEEDS) {
        seed = s;
        let value = structuredClone(SAMPLE) as JsonObject;
        let text = a.print(value);
        for (let i = 0; i < 120; i++) {
          const next = mutate(value);
          // Surgical merges must never corrupt the document; where a
          // syntax can't express an op in place it reprints wholesale,
          // which must be equally faithful.
          text = merge(a, text, next, value);
          const re = a.parse(text);
          expect(re.errors, `${a.name} seed ${s} step ${i}:\n${text}`).toEqual([]);
          expect(
            deepEqual(valueOf(re.tree), next),
            `${a.name} seed ${s} step ${i}: value drift\n${text}\nwant ${JSON.stringify(next)}`,
          ).toBe(true);
          value = next;
        }
      }
    });
  }
});

describe("hub and spokes", () => {
  it("runs the full break/write-around/repair scenario", () => {
    const hub = valueHub(structuredClone(SAMPLE));
    const json = formatSpoke(hub, jsonFormat);
    const yaml = formatSpoke(hub, yamlFormat);
    const toml = formatSpoke(hub, tomlFormat);
    const edn = formatSpoke(hub, ednFormat);
    void json.value;
    void yaml.value;
    void toml.value;
    void edn.value;

    // 1–3: a valid JSON edit propagates everywhere.
    json.value = json.value.replace("8080", "9090");
    expect((hub.value as JsonObject).server).toMatchObject({ port: 9090 });
    expect(yaml.value).toContain("port: 9090");
    expect(toml.value).toContain("port = 9090");
    expect(edn.value).toContain(":port 9090");

    // 4–5: break the JSON; nothing propagates, the text is held.
    const broken = json.value.replace('"active": true', '"active": tru');
    json.value = broken;
    expect(json.value).toBe(broken);
    expect((hub.value as JsonObject).active).toBe(true);
    expect(yaml.value).toContain("active: true");

    // 6–6.5: edit YAML; JSON updates around its error region.
    yaml.value = yaml.value.replace("name: starship", "name: voyager");
    expect((hub.value as JsonObject).name).toBe("voyager");
    expect(json.value).toContain('"name": "voyager"');
    expect(json.value).toContain('"active": tru'); // not trampled
    expect(toml.value).toContain('name = "voyager"');

    // Repair: fixing the JSON pushes its (last-writer-wins) content.
    json.value = json.value.replace('"active": tru', '"active": false');
    expect((hub.value as JsonObject).active).toBe(false);
    expect(yaml.value).toContain("active: false");
    expect(edn.value).toContain(":active false");
  });

  it("notifies subscribers on broken writes and after them", () => {
    // Regression: a broken write changes the view (the complement echoes
    // it back) without moving the hub. Subscribers must still hear about
    // it — and the cell must not silently go Dirty, which would freeze
    // its subtree out of later hub changes.
    const hub = valueHub({ a: 1, b: 2 });
    const json = formatSpoke(hub, jsonFormat);
    const yaml = formatSpoke(hub, yamlFormat);
    const seen: string[] = [];
    const dispose = effect(() => {
      seen.push(json.value);
    });

    json.value = '{"a": 1, "b": oops}'; // broken — hub unmoved
    settle();
    expect(seen[seen.length - 1]).toBe('{"a": 1, "b": oops}');

    yaml.value = "a: 9\nb: 2\n"; // external change while broken
    settle();
    expect(seen[seen.length - 1]).toContain('"a": 9');
    expect(seen[seen.length - 1]).toContain('"b": oops');
    dispose();
  });

  it("holds local valid edits made alongside a break, then releases them", () => {
    const hub = valueHub({ a: 1, b: 2, c: 3 });
    const json = formatSpoke(hub, jsonFormat);
    const yaml = formatSpoke(hub, yamlFormat);
    void json.value;
    void yaml.value;

    // One burst: a → 5 (valid) and b broken.
    json.value = '{\n  "a": 5,\n  "b": oops,\n  "c": 3\n}';
    expect((hub.value as JsonObject).a).toBe(1); // gated

    // External edit elsewhere flows in; local divergence kept.
    yaml.value = yaml.value.replace("c: 3", "c: 7");
    expect(json.value).toContain('"a": 5');
    expect(json.value).toContain('"b": oops');
    expect(json.value).toContain('"c": 7');

    // Fix b: the whole local state (a=5 included) publishes.
    json.value = json.value.replace("oops", "2");
    expect(hub.value).toEqual({ a: 5, b: 2, c: 7 });
    expect(yaml.value).toContain("a: 5");
  });
});
