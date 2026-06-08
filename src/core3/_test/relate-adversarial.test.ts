// Adversarial: try to BREAK the pull-driven SCC engine. Each block targets a
// specific suspected weakness. Where behaviour is a genuine design question
// the test documents what actually happens (so we learn), rather than
// asserting a wish.

import { describe, expect, it } from "vitest";
import { effect, num, range, settle } from "../index";
import { assert, constrain, equal } from "../relate";

const PINF = Number.POSITIVE_INFINITY;
const NINF = Number.NEGATIVE_INFINITY;
const span = (lo = NINF, hi = PINF) => range(lo, hi);

// ── 1. diamond: one upstream feeds two branches into a sink ──────────

describe("diamond glitch-freedom", () => {
  it("a sink reading two branches of a shared upstream fires once", () => {
    const a = span(0, 100);
    const a2 = span(0, 100);
    equal(a, a2); // upstream SCC A

    const b = span();
    const b2 = span();
    equal(b, b2);
    constrain([a], [b], (get, emit) => emit(b, { lo: get(a).lo, hi: PINF }));

    const c = span();
    const c2 = span();
    equal(c, c2);
    constrain([a], [c], (get, emit) => emit(c, { lo: NINF, hi: get(a).hi }));

    const d = span();
    const d2 = span();
    equal(d, d2);
    constrain([b], [d], (get, emit) => emit(d, { lo: get(b).lo, hi: PINF }));
    constrain([c], [d], (get, emit) => emit(d, { lo: NINF, hi: get(c).hi }));

    let fires = 0;
    let seen = { lo: 0, hi: 0 };
    const stop = effect(() => {
      fires++;
      seen = d.value;
    });
    expect(fires).toBe(1);
    expect(seen).toEqual({ lo: 0, hi: 100 });

    a.value = { lo: 30, hi: 70 }; // one change at the apex
    settle();
    expect(fires).toBe(2); // single coherent fire at the sink
    expect(seen).toEqual({ lo: 30, hi: 70 });
    stop();
  });
});

// ── 2. contradiction (empty meet) ───────────────────────────────────

describe("contradiction", () => {
  it("disjoint intervals meet to bottom without looping or crashing", () => {
    const a = span(0, 10);
    const b = span(20, 30);
    equal(a, b);
    const v = a.value;
    expect(v.lo).toBe(20);
    expect(v.hi).toBe(10); // lo > hi ⇒ bottom
    expect(range(20, 10).constructor as unknown).toBeDefined();
  });
});

// ── 3. self-constraint (self-loop) ──────────────────────────────────

describe("self-loop", () => {
  it("a cell constraining itself solves to its own fixpoint", () => {
    const a = span(0, 100);
    constrain([a], [a], (get, emit) => emit(a, { lo: get(a).lo, hi: Math.min(get(a).hi, 50) }));
    expect(a.value).toEqual({ lo: 0, hi: 50 });
  });
});

// ── 4. re-entrancy: rule reads a co-member via .value (misuse) ───────

describe("re-entrancy footgun", () => {
  it("reading a co-member's .value inside a rule is caught, not silently wrong", () => {
    const a = span(0, 100);
    const b = span(0, 100);
    // BUG-shaped rule: should use get(a); reads a.value directly instead.
    constrain([a], [b], (_get, emit) => emit(b, a.value));
    constrain([b], [a], (get, emit) => emit(a, get(b)));
    expect(() => b.value).toThrow();
  });
});

// ── 5. base staleness: write a value equal to the SOLVED projection ──

describe("write-equal-to-solved vs base", () => {
  it("documents whether a no-op-looking write updates the standing base", () => {
    const a = span(0, 100);
    const b = span(40, 60);
    const unlink = equal(a, b); // a shows [40,60]
    expect(a.value).toEqual({ lo: 40, hi: 60 });

    a.value = { lo: 40, hi: 60 }; // equals what a currently shows, but pins base
    unlink(); // relax to the asserted base (write reaches base, not skipped)
    expect(a.value).toEqual({ lo: 40, hi: 60 });
  });

  it("assert() always updates the base (unlike a no-op-looking write)", () => {
    const a = span(0, 100);
    const b = span(40, 60);
    const unlink = equal(a, b);
    assert(a, { lo: 40, hi: 60 });
    unlink();
    expect(a.value).toEqual({ lo: 40, hi: 60 });
  });
});

// ── 6. plain (non-lattice) cell as a write target ───────────────────

describe("plain cell as constraint target", () => {
  it("constraining a non-lattice cell is a silent no-op (no throw)", () => {
    const x = span(0, 100);
    const y = num(5);
    expect(() =>
      constrain([x], [y as unknown as typeof x], (get, emit) => emit(y as never, get(x) as never)),
    ).not.toThrow();
    expect(y.value).toBe(5); // untouched — y has no lattice, never a member
  });
});

// ── 7. churn: merge/split many times, reads interleaved ─────────────

describe("topology churn", () => {
  it("repeated link/unlink keeps values correct (stale-link stress)", () => {
    const a = span(0, 100);
    const b = span(20, 80);
    for (let i = 0; i < 50; i++) {
      const unlink = equal(a, b);
      expect(a.value).toEqual({ lo: 20, hi: 80 });
      expect(b.value).toEqual({ lo: 20, hi: 80 });
      unlink();
      expect(a.value).toEqual({ lo: 0, hi: 100 });
      expect(b.value).toEqual({ lo: 20, hi: 80 });
    }
  });

  it("growing then shrinking an SCC stays consistent", () => {
    const a = span(0, 100);
    const b = span(10, 90);
    const c = span(20, 80);
    const u1 = equal(a, b);
    const u2 = equal(b, c); // {a,b,c} → [20,80]
    expect(a.value).toEqual({ lo: 20, hi: 80 });
    u2(); // split off c
    expect(a.value).toEqual({ lo: 10, hi: 90 });
    expect(c.value).toEqual({ lo: 20, hi: 80 });
    u1();
    expect(a.value).toEqual({ lo: 0, hi: 100 });
  });
});

// ── 8. feedback: an effect writes a member it reads ─────────────────

describe("effect feedback into a member", () => {
  it("a clamping effect converges (no infinite flush)", () => {
    const a = span(0, 100);
    const b = span(0, 100);
    equal(a, b);
    let fires = 0;
    const stop = effect(() => {
      fires++;
      const v = a.value;
      if (v.lo < 50) a.value = { lo: 50, hi: v.hi };
    });
    settle();
    expect(a.value).toEqual({ lo: 50, hi: 100 });
    expect(fires).toBeLessThan(10);
    stop();
  });
});

// ── 9. scale + laziness: deep SCC-DAG chain ─────────────────────────

describe("deep SCC-DAG chain", () => {
  it("solves lazily and propagates correctly down a long chain", () => {
    const N = 40;
    let runs = 0;
    // chain of 2-cycles; component k narrowed by component k-1's member.
    const lo: ReturnType<typeof span>[] = [];
    const hi: ReturnType<typeof span>[] = [];
    for (let k = 0; k < N; k++) {
      const x = span(0, 1000);
      const y = span(0, 1000);
      constrain([x], [y], (get, emit) => {
        runs++;
        emit(y, get(x));
      });
      constrain([y], [x], (get, emit) => {
        runs++;
        emit(x, get(y));
      });
      lo.push(x);
      hi.push(y);
      if (k > 0) {
        const prev = lo[k - 1]!;
        constrain([prev], [x], (get, emit) => emit(x, { lo: get(prev).lo, hi: PINF }));
      }
    }

    expect(runs).toBe(0); // fully lazy: nothing read yet

    lo[0]!.value = { lo: 100, hi: 1000 }; // drive the head
    expect(runs).toBe(0); // still lazy — no read

    // Reading the tail pulls the whole chain upstream-first.
    expect(lo[N - 1]!.value.lo).toBe(100);
    expect(runs).toBeGreaterThan(0);
  });

  it("disjoint components solve independently (reading one ≠ solving all)", () => {
    let runsA = 0;
    let runsB = 0;
    const a = span(0, 100);
    const a2 = span(0, 100);
    constrain([a], [a2], (get, emit) => {
      runsA++;
      emit(a2, get(a));
    });
    constrain([a2], [a], (get, emit) => {
      runsA++;
      emit(a, get(a2));
    });

    const b = span(0, 100);
    const b2 = span(0, 100);
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
    const a = span(0, 100);
    const b = span(0, 100);
    equal(a, b);
    // No batch() in this engine: the value graph is synchronous, so two
    // back-to-back writes simply last-write-win and read back the fixpoint.
    a.value = { lo: 10, hi: 100 };
    a.value = { lo: 20, hi: 90 };
    expect(a.value).toEqual({ lo: 20, hi: 90 });
    expect(b.value).toEqual({ lo: 20, hi: 90 });
  });
});

// ── 11. peek vs value on a member ───────────────────────────────────

describe("peek on a member", () => {
  it("peek returns the solved value without establishing a dependency", () => {
    const a = span(0, 100);
    const b = span(30, 70);
    equal(a, b);
    expect(a.peek()).toEqual({ lo: 30, hi: 70 });
  });
});

// ── 12. effect survives topology rebuilds under it ──────────────────

describe("effect refires across rebuilds", () => {
  it("merging a member's component refires its subscribers", () => {
    const a = span(0, 100);
    const a2 = span(0, 100);
    equal(a, a2);
    let fires = 0;
    let seen = { lo: 0, hi: 0 };
    const stop = effect(() => {
      fires++;
      seen = a.value;
    });
    expect(seen).toEqual({ lo: 0, hi: 100 });

    const c = span(20, 80);
    equal(a, c); // merge → {a,a2,c}
    settle();
    expect(fires).toBe(2);
    expect(seen).toEqual({ lo: 20, hi: 80 });
    stop();
  });

  it("disposing the last relation refires subscribers with the base", () => {
    const a = span(0, 100);
    const b = span(30, 70);
    const unlink = equal(a, b);
    let seen = { lo: 0, hi: 0 };
    const stop = effect(() => {
      seen = a.value;
    });
    expect(seen).toEqual({ lo: 30, hi: 70 });
    unlink();
    settle();
    expect(seen).toEqual({ lo: 0, hi: 100 });
    stop();
  });

  it("two effects on two members each fire once per upstream change", () => {
    const a = span(0, 100);
    const b = span(0, 100);
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
    a.value = { lo: 25, hi: 75 };
    settle();
    expect([fa, fb]).toEqual([2, 2]); // each once, no glitch double-fire
    sa();
    sb();
  });
});

// ── 13. read-after-write reflects the staged base ───────────────────

describe("synchronous read-after-write", () => {
  it("reading a member right after a write sees the just-written base", () => {
    const a = span(0, 100);
    const b = span(0, 100);
    equal(a, b);
    // The value graph is synchronous, so the read sees the re-solved value
    // immediately — no batch, no settle needed (that's effects only).
    a.value = { lo: 30, hi: 100 };
    const mid = a.value;
    expect(mid).toEqual({ lo: 30, hi: 100 });
  });
});

// ── 14. adversarial rule bodies (non-monotone emits) ────────────────

describe("adversarial rule bodies", () => {
  it("a rule emitting WIDER intervals still converges (meet only shrinks)", () => {
    const a = span(0, 100);
    constrain([a], [a], (_get, emit) => {
      emit(a, { lo: NINF, hi: PINF }); // tries to widen — meet ignores it
      emit(a, { lo: 10, hi: 90 }); // and narrow
    });
    expect(a.value).toEqual({ lo: 10, hi: 90 });
  });

  it("an infinitely-descending (halving) cycle terminates via ε", () => {
    const a = range(0, 1);
    constrain([a], [a], (get, emit) => {
      const v = get(a);
      emit(a, { lo: (v.lo + v.hi) / 2, hi: v.hi });
    });
    const r = a.value;
    expect(r.hi).toBe(1);
    expect(r.lo).toBeGreaterThan(0.9);
    expect(r.lo).toBeLessThanOrEqual(1);
  });
});

// ── 15. reconverging triangle (one SCC) ─────────────────────────────

describe("reconverging cycle", () => {
  it("a 3-cycle of equals is a single SCC at the full intersection", () => {
    const a = span(0, 100);
    const b = span(10, 90);
    const c = span(20, 80);
    equal(a, b);
    equal(b, c);
    equal(c, a); // triangle
    expect(a.value).toEqual({ lo: 20, hi: 80 });
    expect(b.value).toEqual({ lo: 20, hi: 80 });
    expect(c.value).toEqual({ lo: 20, hi: 80 });
  });
});
