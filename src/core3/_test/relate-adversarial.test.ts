// Adversarial: try to BREAK the pull-driven SCC engine. Each block targets a
// specific suspected weakness. `Flags` (bit-AND candidate sets) is the
// narrowing lattice — it genuinely narrows between concretes, so re-solves are
// observable and contradictions (empty meet) are reachable.

import { describe, expect, it } from "vitest";
import { cell, effect, Flags, num, settle } from "../index";
import { assert, constrain, equal } from "../relate";

const F = ["b0", "b1", "b2", "b3"] as const;
const fl = (m: number) => new Flags([...F], m);

// ── 1. diamond: one upstream feeds two branches into a sink ──────────

describe("diamond glitch-freedom", () => {
  it("a sink reading two branches of a shared upstream fires once", () => {
    const a = fl(0b1111);
    const a2 = fl(0b1111);
    equal(a, a2); // upstream SCC A

    const b = fl(0b1111);
    const b2 = fl(0b1111);
    equal(b, b2);
    constrain([a], [b], (get, emit) => emit(b, get(a))); // b ⊓= a

    const c = fl(0b1111);
    const c2 = fl(0b1111);
    equal(c, c2);
    constrain([a], [c], (get, emit) => emit(c, get(a)));

    const d = fl(0b1111);
    const d2 = fl(0b1111);
    equal(d, d2);
    constrain([b], [d], (get, emit) => emit(d, get(b)));
    constrain([c], [d], (get, emit) => emit(d, get(c)));

    let fires = 0;
    let seen = 0;
    const stop = effect(() => {
      fires++;
      seen = d.value;
    });
    expect(fires).toBe(1);
    expect(seen).toBe(0b1111);

    a.value = 0b0011; // one change at the apex
    settle();
    expect(fires).toBe(2); // single coherent fire at the sink
    expect(seen).toBe(0b0011);
    stop();
  });
});

// ── 2. contradiction (empty meet) ───────────────────────────────────

describe("contradiction", () => {
  it("disjoint candidate sets meet to bottom without looping or crashing", () => {
    const a = fl(0b1100);
    const b = fl(0b0011);
    equal(a, b);
    expect(a.value).toBe(0); // AND = 0 ⇒ bottom (no candidates)
    expect(b.value).toBe(0);
  });
});

// ── 3. self-constraint (self-loop) ──────────────────────────────────

describe("self-loop", () => {
  it("a cell constraining itself solves to its own fixpoint", () => {
    const a = fl(0b1111);
    constrain([a], [a], (_get, emit) => emit(a, 0b0111));
    expect(a.value).toBe(0b0111);
  });
});

// ── 4. re-entrancy: rule reads a co-member via .value (misuse) ───────

describe("re-entrancy footgun", () => {
  it("reading a co-member's .value inside a rule is caught, not silently wrong", () => {
    const a = fl(0b1111);
    const b = fl(0b1111);
    // BUG-shaped rule: should use get(a); reads a.value directly instead.
    constrain([a], [b], (_get, emit) => emit(b, a.value));
    constrain([b], [a], (get, emit) => emit(a, get(b)));
    expect(() => b.value).toThrow();
  });
});

// ── 5. base staleness: write a value equal to the SOLVED projection ──

describe("write-equal-to-solved vs base", () => {
  it("a no-op-looking write still pins the standing base", () => {
    const a = fl(0b1111);
    const b = fl(0b0101);
    const unlink = equal(a, b); // a shows 0b0101
    expect(a.value).toBe(0b0101);

    a.value = 0b0101; // equals what a currently shows, but pins base
    unlink(); // relax to the asserted base (write reached base, not skipped)
    expect(a.value).toBe(0b0101);
  });

  it("assert() always updates the base", () => {
    const a = fl(0b1111);
    const b = fl(0b0101);
    const unlink = equal(a, b);
    assert(a, 0b0101);
    unlink();
    expect(a.value).toBe(0b0101);
  });
});

// ── 6. plain (non-lattice) cell as a write target ───────────────────

describe("plain cell as constraint target", () => {
  it("constraining a non-lattice cell is a silent no-op (no throw)", () => {
    const x = fl(0b1111);
    const y = cell(5); // bare Cell — no static lattice, can never be a member
    expect(() =>
      constrain([x], [y as unknown as typeof x], (get, emit) => emit(y as never, get(x) as never)),
    ).not.toThrow();
    expect(y.value).toBe(5); // untouched
  });
});

// ── 7. churn: merge/split many times, reads interleaved ─────────────

describe("topology churn", () => {
  it("repeated link/unlink keeps values correct (stale-link stress)", () => {
    const a = fl(0b1111);
    const b = fl(0b0110);
    for (let i = 0; i < 50; i++) {
      const unlink = equal(a, b);
      expect(a.value).toBe(0b0110);
      expect(b.value).toBe(0b0110);
      unlink();
      expect(a.value).toBe(0b1111);
      expect(b.value).toBe(0b0110);
    }
  });

  it("growing then shrinking an SCC stays consistent", () => {
    const a = fl(0b1111);
    const b = fl(0b0111);
    const c = fl(0b1110);
    const u1 = equal(a, b);
    const u2 = equal(b, c); // {a,b,c} → 0b0110
    expect(a.value).toBe(0b0110);
    u2(); // split off c
    expect(a.value).toBe(0b0111);
    expect(c.value).toBe(0b1110);
    u1();
    expect(a.value).toBe(0b1111);
  });
});

// ── 8. feedback: an effect writes a member it reads ─────────────────

describe("effect feedback into a member", () => {
  it("a bit-clearing effect converges (no infinite flush)", () => {
    const a = fl(0b1111);
    const b = fl(0b1111);
    equal(a, b);
    let fires = 0;
    const stop = effect(() => {
      fires++;
      const v = a.value;
      if (v & 0b1000) a.value = v & 0b0111; // clear top bit
    });
    settle();
    expect(a.value).toBe(0b0111);
    expect(fires).toBeLessThan(10);
    stop();
  });
});

// ── 9. scale + laziness: deep SCC-DAG chain ─────────────────────────

describe("deep SCC-DAG chain", () => {
  it("solves lazily and propagates correctly down a long chain", () => {
    const N = 40;
    let runs = 0;
    const xs: ReturnType<typeof fl>[] = [];
    for (let k = 0; k < N; k++) {
      const x = fl(0b1111);
      const y = fl(0b1111);
      constrain([x], [y], (get, emit) => {
        runs++;
        emit(y, get(x));
      });
      constrain([y], [x], (get, emit) => {
        runs++;
        emit(x, get(y));
      });
      xs.push(x);
      if (k > 0) {
        const prev = xs[k - 1]!;
        constrain([prev], [x], (get, emit) => emit(x, get(prev)));
      }
    }

    expect(runs).toBe(0); // fully lazy: nothing read yet

    xs[0]!.value = 0b0111; // drive the head
    expect(runs).toBe(0); // still lazy — no read

    expect(xs[N - 1]!.value).toBe(0b0111); // reading the tail pulls the chain
    expect(runs).toBeGreaterThan(0);
  });

  it("disjoint components solve independently (reading one ≠ solving all)", () => {
    let runsA = 0;
    let runsB = 0;
    const a = fl(0b1111);
    const a2 = fl(0b1111);
    constrain([a], [a2], (get, emit) => {
      runsA++;
      emit(a2, get(a));
    });
    constrain([a2], [a], (get, emit) => {
      runsA++;
      emit(a, get(a2));
    });

    const b = fl(0b1111);
    const b2 = fl(0b1111);
    constrain([b], [b2], (get, emit) => {
      runsB++;
      emit(b2, get(b));
    });
    constrain([b2], [b], (get, emit) => {
      runsB++;
      emit(b, get(b2));
    });

    void a.value;
    expect(runsA).toBeGreaterThan(0);
    expect(runsB).toBe(0); // B never pulled
  });
});

// ── 10. coalesced writes ────────────────────────────────────────────

describe("sequential writes", () => {
  it("repeated writes last-write-win; reads after see the solved fixpoint", () => {
    const a = fl(0b1111);
    const b = fl(0b1111);
    equal(a, b);
    a.value = 0b0111;
    a.value = 0b0011;
    expect(a.value).toBe(0b0011);
    expect(b.value).toBe(0b0011);
  });
});

// ── 11. peek vs value on a member ───────────────────────────────────

describe("peek on a member", () => {
  it("peek returns the solved value without establishing a dependency", () => {
    const a = fl(0b1111);
    const b = fl(0b0110);
    equal(a, b);
    expect(a.peek()).toBe(0b0110);
  });
});

// ── 12. effect survives topology rebuilds under it ──────────────────

describe("effect refires across rebuilds", () => {
  it("merging a member's component refires its subscribers", () => {
    const a = fl(0b1111);
    const a2 = fl(0b1111);
    equal(a, a2);
    let fires = 0;
    let seen = 0;
    const stop = effect(() => {
      fires++;
      seen = a.value;
    });
    expect(seen).toBe(0b1111);

    const c = fl(0b0110);
    equal(a, c); // merge → {a,a2,c}
    settle();
    expect(fires).toBe(2);
    expect(seen).toBe(0b0110);
    stop();
  });

  it("disposing the last relation refires subscribers with the base", () => {
    const a = fl(0b1111);
    const b = fl(0b0110);
    const unlink = equal(a, b);
    let seen = 0;
    const stop = effect(() => {
      seen = a.value;
    });
    expect(seen).toBe(0b0110);
    unlink();
    settle();
    expect(seen).toBe(0b1111);
    stop();
  });

  it("two effects on two members each fire once per upstream change", () => {
    const a = fl(0b1111);
    const b = fl(0b1111);
    equal(a, b);
    let fa = 0;
    let fb = 0;
    const sa = effect(() => {
      fa++;
      void a.value;
    });
    const sb = effect(() => {
      fb++;
      void b.value;
    });
    expect([fa, fb]).toEqual([1, 1]);
    a.value = 0b0101;
    settle();
    expect([fa, fb]).toEqual([2, 2]); // each once, no glitch double-fire
    sa();
    sb();
  });
});

// ── 13. read-after-write reflects the staged base ───────────────────

describe("synchronous read-after-write", () => {
  it("reading a member right after a write sees the just-written base", () => {
    const a = fl(0b1111);
    const b = fl(0b1111);
    equal(a, b);
    a.value = 0b0111;
    expect(a.value).toBe(0b0111);
  });
});

// ── 14. adversarial rule bodies (non-monotone emits) ────────────────

describe("adversarial rule bodies", () => {
  it("a rule emitting the top element still converges (meet only shrinks)", () => {
    const a = fl(0b1111);
    constrain([a], [a], (_get, emit) => {
      emit(a, Flags.lattice.top); // tries to widen — meet ignores it
      emit(a, 0b0111); // and narrow
    });
    expect(a.value).toBe(0b0111);
  });

  it("an unrelated external Num change re-solves to the same fixpoint", () => {
    const ext = num(0);
    const a = fl(0b1111);
    constrain([ext], [a], (_get, emit) => emit(a, 0b0111));
    expect(a.value).toBe(0b0111);
    ext.value = 1; // forces a re-solve; result unchanged
    expect(a.value).toBe(0b0111);
  });
});

// ── 15. reconverging triangle (one SCC) ─────────────────────────────

describe("reconverging cycle", () => {
  it("a 3-cycle of equals is a single SCC at the full bit-AND", () => {
    const a = fl(0b1111);
    const b = fl(0b0111);
    const c = fl(0b1110);
    equal(a, b);
    equal(b, c);
    equal(c, a); // triangle
    expect(a.value).toBe(0b0110);
    expect(b.value).toBe(0b0110);
    expect(c.value).toBe(0b0110);
  });
});
