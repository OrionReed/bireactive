# Unified acyclic + cyclic reactivity

*Lenses and propagators over a component DAG.*

This note captures the design model we landed on for making **cyclic relations
(propagators)** and **acyclic lenses** first-class peers in one reactive graph —
transparently, with local reasoning, and **without a planner, strengths, or
ordering knobs at the engine level**. It is a reference for our future selves
before we return to code. It records what we decided, what we deliberately
deferred, the two pieces of grounding research, and a per-value-class audit.

Prior art / context this supersedes in spirit: `_notes/propagators.md` (the
retired `network()`/`solve()` framing) and `_notes/SEMANTICS.md`'s footguns
(esp. "cycle through a lens silently leaves the system inconsistent"). Those
footguns are exactly what this model is meant to dissolve.

---

## 1. The goal, stated precisely

We are **not** building a multi-way constraint solver (DeltaBlue / SkyBlue /
QuickPlan / HotDrink) and we are **not** doing UI layout specifically. No
planner, no constraint hierarchies, no engine-level "strength". Those belong in
a *userland* combinator library if anyone wants them.

We *are* building a **propagator network** (Radul/Sussman flavour) that
coexists with our existing **lens DAG**, such that:

> computation, scheduling, composition, types, and semantics operate
> **transparently** over cyclic and acyclic subgraphs, maintaining the
> invariants each regime can offer, with **principled and local reasoning**.

"Transparent" is load-bearing: a user wiring up relations should not have to
think about fixpoints, SCCs, or iteration, and — critically — **the cyclic
machinery must not "colour" the rest of the graph**. The acyclic 99% stays
exactly as cheap and simple as it is today.

---

## 2. The structural insight (the spine of everything)

Take the whole graph: ordinary directed lens/computed edges **plus** symmetric
relation edges. Decompose it into **strongly connected components (SCCs)**.

- An SCC with one node and no self-loop is **acyclic** (a "trivial" component).
- An SCC with a real cycle is **cyclic** (a "non-trivial" component).
- **The condensation graph — one node per SCC — is *always* a DAG.**

This is the definitive answer to "which regions are cyclic": SCC membership.
Topology no longer matters. A graph can start cyclic and fan out into a DAG, end
in a cycle, or interleave arbitrarily. The condensation flattens all of that
into a single DAG of components, and **the engine only ever schedules over that
DAG.**

So there are exactly two component kinds, and the engine evaluates the
condensation in topological order:

| Component | How it evaluates | Guarantee |
|---|---|---|
| **Trivial (acyclic)** | one function application (today's lens/computed pull) | lens laws; glitch-free |
| **Non-trivial (SCC)** | iterate monotone lattice merges to a least fixpoint | confluent ⇒ order-independent, no oscillation |

The user never sees the distinction. Pulling a cell pulls its component; a
trivial component is the fast path we already have; a cyclic component runs an
internal fixpoint solver that behaves, from the outside, **like a generalized
computed**.

---

## 3. Two regimes, two invariant sets

**Acyclic (lens DAG).** Unchanged. Forward = function composition along the DAG;
backward = lens `put` recursing toward sources, short-circuiting where a lens is
1-arg / source-independent. Lens laws hold locally. This is the transparent
default and stays first-class.

**Cyclic (propagator SCC).** A cell's value is the **least fixpoint of the
monotone propagators over its current inputs**, computed by repeated lattice
`meet` until quiescence. Because every contribution is monotone and `meet` is
commutative/associative/idempotent, the fixpoint is **confluent**: order of
firing cannot change the result, so there is no oscillation and no
schedule-dependence *within a solve*.

The bridge principle:

> **Monotone *within* a solve; reactive *across* solves.**

Inside one solve, information only narrows (monotone → confluent → terminating).
Between ticks, an external write can move a cell *anywhere* (anti-monotone is
fine) — that just starts a **fresh** monotone solve from the new seed. Reactivity
is "re-seed and re-converge each tick", not "one monotone climb forever".

---

## 4. The lens ↔ lattice contract

A single lens edge plays one of two roles, decided **purely by SCC membership**
(local, type-free decision):

- **Role B — Channel** (edge crosses *between* components). The lens is a
  concrete conduit. `get` produces a forward value that **seeds** the downstream
  component; `put` sends a backward write that **re-seeds** the upstream
  component. This is just today's lens behaviour at component boundaries — no
  lattice needed. Backward flow across the whole graph is a chain of these
  re-seeds running "up" the condensation DAG.

- **Role A — Constraint** (edge lives *inside* an SCC). The lens contributes its
  best **sound monotone abstract transformers** over the relevant lattices: a
  forward transformer `F` and a backward transformer `B`. These are merged into
  the fixpoint like any other propagator.

The same authored lens serves both roles; the engine picks the role from where
the edge sits. This is what makes lenses and propagators "true equals".

---

## 5. Abstract transformers (Role A), and the precision spectrum

Inside an SCC a lens is lifted from a function on *values* to a pair of
**transformers on lattice elements**. Soundness = the transformer must
over-approximate the true image/preimage (never narrow away a real solution).
Precision is then a spectrum:

1. **Homomorphism (exact both directions).** The lens commutes with `meet`.
   Forward and backward transformers are exact; the lens is a fully first-class
   cyclic citizen. Examples: translations (`add`, `sub`, `offset`, `shift`),
   positive scaling, affine `k·x+c` (k≠0), `not`, `xor`, monotone bijections
   (`exp`), and **coordinate/field projections** (`.x`, `.lo`) *against a
   componentwise lattice*.

2. **Abstraction (forward narrows, backward abstains).** The lens loses
   information (non-injective or a functional onto a lower-dim space). Forward can
   still narrow soundly; backward usually **abstains** (returns ⊤ — "no
   constraint", contributing nothing to the meet) or narrows only coarsely.
   Examples: `width`, `center`, `area`, `magnitude`, `distance`, `clamp`,
   `quantize`, `sin`, `normalize`, fan-in booleans (`and`/`or`/…), predicates.

3. **Flat-only (free, pointwise).** Any lens at all gets a sound transformer for
   **free** on the flat lattice: if input is a known concrete value, forward =
   apply the function; otherwise ⊥/⊤. No authoring required. This is the
   universal fallback that guarantees *every* value class and *every* lens can
   participate soundly (if coarsely) with zero extra work.

**"Abstain ⊤" precisely:** ⊤ is the top of the lattice ("contradiction / no
information narrows this"). A backward transformer that returns ⊤ means "I have
nothing to say about my source"; in the `meet`, `x ∧ ⊤ = x`, so it's a clean
no-op. (Don't confuse with ⊥ = "fully unknown".)

The authoring burden (transformers per lens) is real but **opt-in**: leave it off
and you get flat-lattice behaviour, which is sound. Add transformers where you
want precision inside cycles. This was accepted as a necessary, bounded cost.

---

## 6. Lattices must be **domain-faithful** (one level up from the value)

The single most important correctness lever: **the lattice has to represent the
true value domain of the cell**, "the meta of narrowing, one level up". Get the
level wrong and projections silently misbehave.

- **Flat** is the universal default: ⊥ (unknown) / `value` / ⊤ (conflict).
  Finite-height, terminates trivially, sound for everything. Plain `Num`/`Bool`
  cells live here unless they opt into something richer.

- **Componentwise** (a product of per-field lattices) makes **field projections
  homomorphisms** and makes **partial backward demands** (Section 8) compose
  field-wise. This is what `Vec` (x,y), and a *corrected* `Range`/`Box` want.

- **Geometric / coupled** lattices (interval-intersection, rectangle-overlap)
  are a *different modelling*: "the value lies somewhere in this region". They're
  fine when that's the intent, but they **couple fields** (e.g. a `Range`'s
  scalar interval couples `lo`/`hi`/`width`; a `Box`'s overlap couples `x`/`w`
  via `right = x+w`), which breaks clean field projection. The audit (Section 11)
  flags `Range` and `Box` as currently mis-levelled for projection use.

Rule of thumb: **pick the lattice so the field lenses you care about are
homomorphisms.** If a value is fundamentally a tuple you project into, use the
componentwise product.

---

## 7. Decisions locked in this conversation

### 7a. Hard edge #4 — underdetermined reads as the *current value*

When a cyclic cell is not determined by the constraints, it **reads as its
current concrete value** — not ⊥, not "unknown". The solver carries information
*about* what a value should be; **if it can change the value it does, otherwise
no-op.** No ⊥/⊤/partial element ever escapes a component into the wider DAG.

Consequence (subtle but clarifying): a member's **current value is the *weakest*
input — a fallback/default, not an asserted fact.** Genuine constraint
information overrides it; where no constraint determines the cell, the current
value stands. This keeps the system **transparent**: from the acyclic DAG's
point of view, every cell always holds an ordinary concrete value. The cyclic
machinery never "colours" downstream consumers with lattice elements.

This also means conflict only arises between **two genuine constraints**
(over-determination → ⊤/contradiction, or the "who yields" question), never
between a constraint and a mere current value.

### 7b. Freeze stateful-lens complements per solve

A stateful lens (e.g. `cyclic`, `polar` with `nearestAngle`) has hidden
complement state. **Freeze that state as part of the seed layer at the start of
each solve**, making it a constant input for that solve. This restores purity and
confluence within the solve; the state updates *between* ticks like any other
re-seed. Clean and consistent with the seed-layer model. ✔ adopted.

### 7c. "Who yields" is deferred (but kept in mind)

When multiple **concrete, conflicting** external assertions meet (the classic
"drag one box in a fully-pinned chain"), *something* must yield. We are **not**
answering this yet. The model **operates fully without it** — under-determination
falls back to current value (7a), genuine over-determination is an honest
contradiction. Deferring "who yields" only **restricts the APIs we can build on
top** (e.g. nice drag-to-redistribute), it doesn't block the core. Candidate for
later: **recency-based seed retraction** (most-recent write wins; older
conflicting seed resets to ⊥ and is re-derived) — monotone *per solve*, reactive
*across*. Explicitly a future, incremental improvement.

### 7d. Reactivity = re-seed + fresh solve

Each tick: gather the seed layer (external writes + cross-component channel
values + frozen stateful complements), run a fresh monotone solve to least
fixpoint, publish concrete values. No long-lived monotone climb; no manual
`solve()`/`network()` wrapper (both retired).

---

## 8. Partial backward demands (a spin-off worth keeping)

Field lenses today rebuild the *whole* source on backward (`{...s, x: v}`), which
carries stale sibling fields. When several such demands converge on one source,
they spuriously conflict (last-write-wins loses updates). The fix that falls out
of componentwise lattices: **backward returns only the sub-locations it
constrains** (`{x: v}`), and the engine merges demands field-wise via `meet`.

This is independently valuable: (A) nicer lens authoring (distinct from
edit/delta lenses), (B) potentially faster even in today's acyclic engine
(less object churn), (C) still correct for ordinary lenses, not just
propagators. Worth pursuing on its own.

---

## 9. Worked examples and their lessons

- **Diamond `eq(a.sub(5), a.add(5))`.** Both views share source `a`; the
  relation forces `a−5 = a+5`, i.e. `0 = 10`. This is an **honest mathematical
  contradiction → ⊤**, not a topology bug. Rigid lens offsets leave the shared
  source no freedom. Correct behaviour; a feature.

- **Abutting boxes via `eq` on edges + `distance` on endpoints.** A pure
  propagator **fills determinable unknowns; it does not move conflicting
  knowns.** If widths are concrete fallbacks and the chain over-determines a
  position two ways, you get a contradiction; if the constraint can't uniquely
  determine a fix, the cell stays at its current value and the constraint is
  simply not satisfied (the solver "shrugs"). Resizing/redistribution is exactly
  the "who yields" question (7c) — out of scope for now, and **acceptable** that
  it shrugs.

- **Box edges related to relations, box "outside" the cycle.** Whether the box
  is "in" the cycle is answered by SCC membership of the *referenced lens nodes*.
  Field views pulled into the cycle make the box's relevant fields part of the
  SCC; backward demands combine field-wise (Section 8) instead of trampling.

---

## 10. Termination on continuous lattices (research grounding)

We narrow (descending: cells gain info, intervals shrink), so our termination
risk is **infinite descending chains**, the dual of the classic widening case.
From abstract interpretation (Cousot & Cousot; Amato/Scozzari; Apinis et al.):

- **Finite / finite-height lattices terminate for free.** Flat, bitset
  (`Flags`), boolean — all bounded height. No cap needed.

- **Integer/discrete numeric domains (intervals, octagons, template polyhedra)
  have *no* infinite descending chains** ⇒ naive iteration already terminates
  (Amato et al., FM'15). Quantized/integer ranges are safe.

- **Real/continuous intervals *do* have infinite descending chains** (e.g.
  halving forever). The principled fixes, in order of preference:
  1. **Finite precision is finite.** IEEE floats form a finite lattice ⇒ DCC
     holds ⇒ it *does* terminate — just potentially in many steps. So a wave cap
     is a crude proxy for a real (huge) bound, not a correctness primitive.
  2. **Narrowing operator / ε-threshold.** Stop descending when the change is
     below ε (or after k steps), accepting a sound post-fixpoint. This is the
     textbook accelerated descent and the right tool for continuous lattices.
  3. **Landmark/threshold ramps** for the dual (widening) side if we ever climb.

- **Takeaway for us:** replace the blunt `MAX_WAVES` with (i) "finite/flat ⇒
  exact, no cap", (ii) "continuous ⇒ ε-narrowing operator with a sound stop".
  Termination becomes a *property of the lattice*, declared alongside it, not a
  global magic number.

---

## 11. Value-class audit

For each class: its **domain**, the **faithful lattice** (and whether today's is
right), and each lens classified **H** = homomorphism (exact both ways),
**A** = abstraction (forward-narrow / backward-abstain), **S** = stateful
(freeze complement), **C** = channel/RO-only. Everything also has the free
**flat** transformer as a fallback.

### Num — domain: scalar ℝ
Faithful lattice: **flat** (a plain number is known/unknown). A richer "interval"
domain is really a *separate* value type, not plain `Num`.

| Lens | Class | Notes |
|---|---|---|
| `add`,`sub`,`offset` | **H** | translation; exact both ways |
| `scale(k)`,`affine` | **H** (k>0) | homothety; k<0 flips order on an ordered lattice |
| `exp` | **H** | monotone bijection ℝ→ℝ⁺; `log` exact inverse |
| `sin` | **A** | non-injective; multivalued inverse → backward abstains |
| `clamp`,`quantize` | **A** | lossy; off-range/step collapses → backward abstains |
| `greaterThan`,`lessThan`,`divisibleBy` | **A** | → Bool; predicate, backward abstains |
| `cyclic(period)` | **S** | hidden representative; freeze per solve |

### Vec — domain: ℝ²
Faithful lattice: **componentwise** (interval on x × interval on y), or flat.

| Lens | Class | Notes |
|---|---|---|
| `add`,`sub`,`offset`,`up/down/left/right` | **H** | translation; exact |
| `scale(k,pivot)` | **H** (k>0) | homothety |
| `x`,`y` | **H** | coordinate projection (against componentwise) |
| `rotate(θ,pivot)` | **A** on box / **H** on flat | rotates a box into a non-box → forward = bounding box (lossy) |
| `normalize`,`magnitude`,`distance` | **A**/**C** | projection to circle / scalar; RO derives |
| `polar(...)` | **S** | `nearestAngle` carries cyclic state; freeze |

### Range — domain: ordered pair `(lo, hi)`
Faithful lattice: **componentwise over (lo,hi)** (interval on lo × interval on
hi). ⚠ **Current lattice is a *scalar* interval-intersection — wrong level.** It
couples `lo`/`hi`/`width` and breaks clean projection. **Action: re-level to the
(lo,hi) product** so `.lo`/`.hi` become homomorphisms.

| Lens | Class | Notes (under corrected lattice) |
|---|---|---|
| `shift` | **H** | translates both coords |
| `scale(k)` | **H** (k>0) | |
| `lo`,`hi` | **H** | coordinate projection |
| `width` (hi−lo) | **A** | forward exact (interval subtraction); backward = anti-diagonal band, abstain |
| `center` ((lo+hi)/2) | **A** | forward exact; backward abstain |
| `start` | **A** | width-preserving policy on backward |
| `slider`,`sample`,`contains`,`paramOf` | **A**/**C** | RO derives / predicates |

### Box — domain: `{x, y, w, h}`
Faithful lattice for projection: **componentwise (4 independent intervals)**.
⚠ **Current lattice is rectangle-overlap (a "region" reading)** which couples
`x`/`w` (and `y`/`h`) via `right = x+w`. Fine if you genuinely mean "the rect lies
in this region", but it makes `.x`/`.w` abstractions instead of clean
projections. **Action: decide intent; use componentwise for field-projection
use.**

| Lens | Class | Notes |
|---|---|---|
| `add`,`sub`,`scale`,`expand` | **H** | componentwise linear (translation exact under both lattices) |
| `x`,`y`,`w`,`h` | **H** componentwise / **A** overlap | projection clean only under componentwise |
| `area` (w·h) | **A** | functional; backward abstain |
| `center`,`top`,`bottom`,`left`,`right`,`at` | **A**/**C** | → Vec; RO point projections |
| `contains(vec)` | **A** | → Bool predicate |

### Flags — domain: bitset (number as set of bits)
Faithful lattice: **bit-intersection (bitwise AND)** — ✔ **already correct** (a
mask *is* a set; `meet` = ∩, finite height ⇒ terminates).

| Lens | Class | Notes |
|---|---|---|
| `flag(name)` | **H** | bit projection: `bitᵢ(a∧b)=bitᵢ(a)∧bitᵢ(b)`; → Bool; backward touches one bit (partial) |

### Bool — domain: boolean
Faithful lattice: **flat** (false / true / ⊥ / ⊤) — the classic 4-element.

| Lens | Class | Notes |
|---|---|---|
| `not` | **H** | involution; exact both ways |
| `xor(b)` | **H** | F₂-linear; `a^b=c ↔ a=c^b` |
| `and`,`or`,`implies`,`eq`,`nand`,`nor` | **A** | fan-in, ambiguous backward → abstain (RO derives today) |

**Pattern across the audit:**
- *Translations & linear-invertibles & field projections* → **H** (first-class in
  cycles).
- *Functionals / lossy / predicates / fan-ins* → **A** (sound forward, abstain
  backward).
- *Cyclic/representative-carrying* → **S** (freeze complement).
- The two **actionable lattice corrections** are **Range** and **Box**:
  re-level to componentwise where field projection is the intent.

---

## 12. Implementation implications (for when we return to code)

Already in place (`src/core3`): the acyclic executor, microtask-scheduled
effects, SCC condensation (`condense.ts`, incremental + decremental), pull-driven
"SCC as generalized computed", `relate.ts`.

What this model asks for next:

1. **Lattice on the value class, faithfully.** Static `lattice` per class
   (`{ top, meet, equals, isBottom, height? }`); flat as the universal default so
   *every* value participates. Correct `Range`/`Box` to componentwise. The engine
   resolves the lattice only when a cell is actually in an SCC (no cost to the
   acyclic path).
2. **Transformers per lens, flat-by-default.** Optional `(F, B)` on lens specs;
   absent ⇒ flat transformer (sound, coarse). Homomorphic lenses get exact ones.
3. **Per-SCC fixpoint solver** that pulls like a computed, seeds from **current
   values** (7a) + channels + frozen complements (7b), merges via `meet`, and
   **publishes concrete values** (never lattice elements) downstream.
4. **Termination by lattice, not by cap** (Section 10): finite/flat exact;
   continuous via ε-narrowing.
5. **Partial backward demands** (Section 8) — merge field-wise; nice on its own.
6. Keep `latticeOf` membership **local and type-driven**; with a flat default the
   silent "scalars excluded from relations" hole disappears.

## 13. Honest open edges

- **Transformer soundness is on the author.** A wrong `B` can narrow away real
  solutions. Mitigation: flat default, and maybe a debug "randomized soundness
  check" (compare transformer image vs. sampled concrete image).
- **Lattice-domain faithfulness audit** must actually be applied (Range/Box).
- **"Who yields"** (7c) — deferred; gates the nicest reactive-UI APIs.
- **Continuous-lattice narrowing operator** design — ε vs. landmarks vs.
  float-finite; needs a concrete choice per continuous value class.
- **Partial→concrete materialization** is resolved by 7a (current value), but
  watch for cases where a downstream genuinely wants "is this determined yet?".
