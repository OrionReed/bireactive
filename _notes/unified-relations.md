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
backward = lens `put` recursing toward sources. The only short-circuit is a
**concrete no-op stop**: propagation halts at a parent that already holds the
target value (`parent._equals(push, settled(parent))`), independent of lens
arity. (Arity only affects the inverse *memo* — a source-reading 1→1 lens keys
its 1-slot memo on `(target, parentRead)`; it does not change where propagation
stops.) Lens laws hold locally. This is the transparent default and stays
first-class.

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

**Lens-structure edges are folded into the condensation (implemented).** A lens
member reads its parent(s) — a dataflow dependency the SCC decomposition *must*
see. If it didn't, two components coupled only through a lens channel would form
a cycle the condensation can't detect and would oscillate (invalidating each
other across settles forever). So when a cell becomes a member, `relate.ts`
walks its whole lens chain and registers each `parent → child` read-edge (and
gives every chain cell a base, so an *intermediate* lens that lands in an SCC
solves as a real member instead of re-entering the solve through a live `.value`
read). With the lens edges present, a genuine cycle-through-a-lens condenses into
**one SCC** and solves as a unit — Role A — rather than crashing or looping.

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

**The contract (implemented): `Lattice<T, K = T>`.** The knowledge type `K` is
**distinct from the value type `T`**. Alongside the meet-semilattice core
(`top: K`, `meet`, `equals`, `isBottom`) it carries the adjunction maps and two
solver hooks:

- `abstract(v: T): K` — **α**, lift a concrete seed/external input into knowledge.
- `concretize(k: K, fallback: T): T` — **γ**, collapse knowledge to a concrete
  value, returning `fallback` (the cell's current value) when underdetermined or
  over-constrained (7a). No `K` ever leaves a component.
- `pinned(k: K): T | undefined` — the concrete value iff `k` is a singleton
  (a point interval, a flat known), else `undefined`. Lens transformers consult
  this: a forward/backward transformer only fires once its input is *pinned* to
  a value (Section 5).
- `widen?(prev, next): K` — optional convergence accelerator for infinite-height
  lattices (Section 10). Finite-height lattices omit it.

Combinators (`lattice.ts`): `flat` (the universal default), `interval` (an
ordered scalar `[min,max]`), and `tuple` (componentwise product over named
fields). A value class declares one as a static `lattice`; the relate layer
resolves it only when the cell joins a cyclic relation, so the acyclic core
never pays.

- **Interval** is the default for *scalars and coordinates*: `K = [min,max]`,
  `meet` = intersection, α lifts a point, γ clamps the current value into the
  surviving interval (moves only if forced). It is a **strict superset of flat**
  (a flat "known v" is the point `[v,v]`; "unknown" is `[-∞,+∞]`) but adds
  *ordered narrowing* — "x ≥ 3" is expressible — for free. So `Num` and `Vec`'s
  coordinates now use `interval`, not flat. Its only cost is infinite height,
  handled by `widen` (Section 10).

- **Flat** remains the universal *fallback* for any domain without an order:
  `K = ⊤ (unknown) | value | ⊥ (conflict)`. Finite-height, terminates trivially,
  sound for everything. `Bool` lives here.

- **Componentwise** (`tuple` — a product of per-field lattices) makes **field
  projections homomorphisms** and makes **partial backward demands** (Section 8)
  compose field-wise. **Now implemented** for `Vec` (`interval x × interval y`),
  `Range` (`K = interval lo × interval hi`), and `Box` (four independent
  intervals). So `equal` is field-wise: an endpoint both sides agree on unifies;
  a conflicting one keeps its own value (per 7a). `Flags` stays `K = T = mask`
  with bit-AND.

- **Geometric / coupled** lattices (interval-intersection, rectangle-overlap)
  are a *different modelling*: "the value lies somewhere in this region". They're
  fine when that's the intent, but they **couple fields** (e.g. a `Range`'s
  scalar interval couples `lo`/`hi`/`width`; a `Box`'s overlap couples `x`/`w`
  via `right = x+w`), which breaks clean field projection. We deliberately did
  **not** pick this reading for `Range`/`Box`; one consequence is that
  inequality-narrowing of a *concrete* endpoint (e.g. "lo ≥ 1" on a point base)
  is a contradiction, not a narrowing — that pattern belongs to the region
  reading and is out of scope for the componentwise default.

Rule of thumb: **pick the lattice so the field lenses you care about are
homomorphisms.** If a value is fundamentally a tuple you project into, use the
componentwise product.

---

## 7. Decisions locked in this conversation

### 7a. Hard edge #4 — base-as-fact seed, current-value fallback on publish

Two distinct mechanisms, made precise in the implementation:

- **Seed (α / `abstract`).** A member's standing assertion (its `base` channel)
  is lifted into knowledge — `abstract(base.value) → K` — and seeded into the
  solve as a concrete *fact*, folded by `meet` alongside every rule contribution.
  So the base is a genuine participant, not a passive default.
- **Publish (γ / `concretize`).** At the component boundary,
  `concretize(K, fallback = current value)` collapses knowledge back to a
  concrete `T`, returning the **current value** whenever the field is
  *underdetermined* (no constraint pinned it) *or over-constrained* (the meet hit
  ⊥). So **if the constraints can refine the value, they do; otherwise it keeps
  its current value.** No ⊥/⊤/partial element ever escapes a component into the
  wider DAG — the cyclic machinery never "colours" downstream consumers.

With **domain-faithful** lattices (Section 6) this is **field-wise**: in a
`Range`, an endpoint the constraints agree on is refined while a conflicting one
independently keeps its current value — there is no whole-value collapse.

A consequence worth stating plainly: because the base is itself seeded as a
fact, a single constraint that *conflicts* with the base drives that field to ⊥
and so the cell **keeps its base** on publish — the standing assertion dominates
a lone contradicting constraint. Genuine over-determination between two
*independent* constraints is still an honest contradiction (the "who yields"
question, deferred — 7c); it just resolves per field to the fallback rather than
leaking a lattice element.

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

**Attempted and reverted (recency-only is non-confluent).** A recency TMS was
prototyped: each work slot carried a `gen` (its base's monotone `writeGen`); a
body folded the max `gen` of the cells it read; on a `meet` hitting ⊥ the
higher-`gen` contribution won instead of collapsing. It *worked* on a directed
drag, but it **breaks confluence on equality cliques** — the bread-and-butter
topology. In a clique every member converges to the same value, but its `gen`
ends up depending on **rule fire order** (a slot reading a fresher fellow inherits
its `gen` even when its own value is unchanged), so a later conflict is arbitrated
by an order-dependent `gen` and the *final values* become order-dependent. Monotone
`meet` is associative/commutative/idempotent ⇒ its fixpoint is order-independent;
grafting a non-monotone recency notion on top of the worklist destroys exactly
that. Confluent recency needs the **support-set** half (each value carries the SET
of assertions justifying it, so arbitration is over sets, not a folded scalar) —
which is the real "later" of 7c. So the engine stays at pure monotone `meet`
(conflict → ⊥ → 7a fallback); recency is deferred until support-sets land.

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

- **Cycle through a lens, e.g. `equal(p, p.shift(5))`.** Both `p` and its shift
  are members, so the shift is a *constraint lens* (Role A): `equal` says
  `p = shifted`, the lens says `shifted = p + 5`, i.e. `p = p + 5` — an honest
  contradiction. The solver **shrugs** (each field keeps its current value) and
  publishes `p = [0,100]`, `shifted = [5,105]`. No error, no loop: this used to
  throw "relation cycle through a lens"; it is now first-class. The dual
  consistent case (`equal(a, a.shift(0))`) settles to the lens relation and
  writes route both ways through it. A re-entrant read that the engine's own
  cyclic-read guard trips (a lens chain looping back into a mid-solve member)
  simply contributes ⊤ (no information) and uses the cached value as fallback —
  sound, never fatal.

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

- **Takeaway for us (implemented):** the blunt `MAX_WAVES` cap is **gone**.
  Termination is now a *property of the lattice*: (i) finite/flat ⇒ exact, no
  cap; (ii) continuous ⇒ the lattice's `widen` snaps a bound shut once it inches
  by less than `WIDEN_EPS` (1e-6), a sound post-fixpoint. The solver runs exact
  `meet` waves and only flips into widening after `WIDEN_AFTER` (64) waves — a
  threshold any finite-height lattice reaches its fixpoint *well* before, so
  widening never engages for them and their result is exact. Only a genuine
  infinite descent crosses it, where `widen` guarantees a finite stop. There is
  **no hard wave cap** and no watchdog: a solve that doesn't have a `widen` and
  doesn't converge would be a lattice bug, not something a magic number papers
  over.

---

## 11. Value-class audit

For each class: its **domain**, the **faithful lattice** (and whether today's is
right), and each lens classified **H** = homomorphism (exact both ways),
**A** = abstraction (forward-narrow / backward-abstain), **S** = stateful
(freeze complement), **C** = channel/RO-only. Everything also has the free
**flat** transformer as a fallback.

### Num — domain: scalar ℝ
Faithful lattice: **interval** `[min,max]` (✔ implemented, replacing flat). A
plain number abstracts to a point `[v,v]`; ordered narrowing ("x ≥ 3") is now
expressible, and flat is recovered as the point/full-line special cases.

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
Faithful lattice: **componentwise** `interval x × interval y` (✔ implemented).

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
hi). ✔ **Implemented** as `tuple({ lo: interval, hi: interval })`, replacing the
old scalar interval-intersection (which coupled `lo`/`hi`/`width`). `.lo`/`.hi`
are now homomorphisms.

| Lens | Class | Notes |
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
✔ **Implemented** as `tuple({ x, y, w, h: interval })`, replacing the old
rectangle-overlap region reading (which coupled `x`/`w` and `y`/`h` via
`right = x+w`). `.x`/`.y`/`.w`/`.h` are now clean projections.

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
- The lattice corrections are **done**: `Num` and `Vec` now use `interval`
  (scalar/coordinate narrowing), and **Range**/**Box** are componentwise
  (`tuple` of intervals), so field projection is clean.

---

## 12. Implementation implications (for when we return to code)

Already in place (`src/core3`): the acyclic executor, microtask-scheduled
effects, SCC condensation (`condense.ts`, incremental + decremental) **with
lens-structure edges folded in** (so lens-coupled cycles condense correctly,
Section 4), the first-class **`Component`** solver node + member projection
(`cell.ts`, replacing the old external Cell-poking hooks), domain-faithful
`Lattice<T,K>` + `flat`/`interval`/`tuple` combinators with `pinned`/`widen`
(`lattice.ts`), auto-lifted constraint-lens transformers, and `relate.ts`
driving components off `condense.drainDirty()`. The condensation owns a single
**refcounted** edge store (relation + lens-structure edges share it; no parallel
edge map in `relate`), `relate`'s member-keyed maps are `WeakMap`s, and a 1→1
lens uses ONE shared forward getter derived from `BwdSpec.fwd` (no per-lens
closure). Coverage includes a cross-layer
oracle fuzz and a structural robustness fuzz (cycles-through-lenses,
self-relations, dense churn, lens-member writes) asserting no edit a user can
make throws, leaks a lattice element, or fails to reach an idempotent fixpoint.

What this model asks for next:

1. **Lattice on the value class, faithfully.** ✔ Static `lattice` per class
   (`{ top, meet, equals, isBottom, abstract, concretize }`, `K` distinct from
   `T`); flat as the universal default so *every* value participates; `Range`/
   `Box` corrected to componentwise. The engine resolves the lattice only when a
   cell is actually in an SCC (no cost to the acyclic path).
2. **Transformers auto-lifted from the existing lens (implemented).** A
   constraint lens (Role A) needs no new authoring: `buildComponent` reuses the
   lens's *own* forward function (stored on `BwdSpec.fwd`) and inverse (`put`) to
   synthesize a forward transformer (`m ⊒ abstract(fwd(pinned(parent)))`) and,
   for a source-*independent* inverse, a backward one (`parent ⊒
   abstract(put(pinned(m)))`). Both fire only once the input is `pinned`. A
   source-reading inverse (clamp, field spread-replace) abstains backward, still
   sound. Richer non-homomorphic transformers remain a future opt-in.
3. **Per-SCC fixpoint solver** (the `Component` node) that pulls like a computed,
   seeds from **bases** (α) + channels + frozen complements (7b), merges via
   `meet`, and **publishes concrete values** via γ (never lattice elements,
   fallback to current value when underdetermined — 7a) downstream. Re-entrant
   reads (a lens chain looping back into a mid-solve member) are caught and
   contribute ⊤, so a cycle through a lens never throws.
   - **Freshness-gated worklist (semi-naive), ✔ implemented.** Each rule is a
     `CompiledRule` = body + the member cells it READS; the `Component` builds a
     reverse index (`readers[slot]` → rule ids). Wave 0 fires every rule; later
     waves fire **only the readers of slots that narrowed** in the prior wave.
     Replaces the old chaotic all-rules-every-wave sweep (parity on a fully-
     conflicting component, a real win on sparse/clean ones — fewer body runs to
     reach the same least fixpoint). External reads are constant within a solve,
     so a rule reading only externals fires exactly once.
   - **Member holds its own assertion, ✔ implemented.** The base channel (the
     cell the solver reads / member writes flow to) lives on the member's own
     transfer (`_rel.base`), set once when it joins and carried across every
     re-compile and relax — no `baseOf` side-table. `captureBase` snapshots a
     source (or clones a lens, so the solver reads the LIVE upstream and writes
     route back through the lens); `relaxToBase` turns a departed source member
     back into a plain source adopting the base value (no passthrough indirection).
4. **Native interval contractors, ✔ implemented.** Alongside `equal`, `relate.ts`
   exports `bound`/`order`/`add`/`total` as two-way interval contractors over the
   `interval` lattice (Num's lattice), ported from `src/propagators/numeric.ts`,
   so intervals actually narrow (e.g. `x ≥ 3` flows through `add`) instead of the
   old pin-gated flat precision. **Free variables** (`free(c)`) seed ⊤ (no standing
   fact) with the cell's value kept as a *soft fallback* — the preferred value when
   constraints leave it underdetermined — so a contractor can pull `x = 0` up to a
   `bound(x, 3, ∞)` but leaves `x = 8` alone. Monotone Iso lenses (`add`/`scale`/
   `affine`/`exp`) are lifted as real interval transformers (the band flows
   through), not pin-gated.
5. **Termination by lattice, not by cap** (✔ Section 10): `MAX_WAVES` removed;
   finite/flat exact, continuous via the lattice's `widen` after `WIDEN_AFTER`
   exact waves.
6. **Partial backward demands** (Section 8) — merge field-wise; nice on its own.
7. Keep `latticeOf` membership **local and type-driven**; with a flat default the
   silent "scalars excluded from relations" hole disappears.

## 13. Honest open edges

- **Transformer soundness is on the author.** A wrong `B` can narrow away real
  solutions. Mitigation: flat default, and maybe a debug "randomized soundness
  check" (compare transformer image vs. sampled concrete image).
- **Lattice-domain faithfulness audit** — applied for Range/Box/Vec/Num/Bool/
  Flags; other value classes still default to flat until they opt in.
- **"Who yields"** (7c) — deferred; recency-newer-wins was prototyped and
  reverted (non-confluent on equality cliques); needs support-sets first.
- **Warm-start across solves** — deferred. The recency-gated "keep the prior
  fixpoint when all seeds only narrowed, else cold-restart" plan is *partial*
  (the fine-grained version needs support-sets), and reactive edits are usually
  anti-monotone (a fact changes to an arbitrary new value ⇒ cold restart anyway),
  so it buys little over the semi-naive worklist while adding hot-path state and
  soundness corners (externals widening, rule-set changes). Revisit with
  support-sets.
- **Continuous-lattice narrowing operator** design — ε vs. landmarks vs.
  float-finite; needs a concrete choice per continuous value class.
- **Partial→concrete materialization** is resolved by 7a (current value), but
  watch for cases where a downstream genuinely wants "is this determined yet?".

## 14. Future side-thought: cycle-once for NON-lattice SCCs

Today an ordinary computed/effect cycle (no relation, no lattice) throws
`RangeError: Cyclic computed`. The SCC machinery opens a principled alternative:
treat a non-trivial SCC that carries **no lattice** as a **cycle-once** region —
read the last committed value across the back-edge, evaluate each member **once**
in a fixed (condensation-determined) order, publish, stop. No fixpoint, no
convergence, O(component size).

This unifies cleanly with the existing model: a cyclic SCC is "a generalized
computed", and there are then two evaluation strategies — **lattice present →
iterate to a `meet`-fixpoint** (today's `Component`); **no lattice →
cycle-once**. The lattice is simply the upgrade from "one stale-read pass" to
"iterate to fixpoint". Most of the machinery already exists: `Component.solve`
*already* catches the re-entrant self-read and substitutes the cached value
(`cell.ts`, the `RangeError` guard) — cycle-once is that same move without the
fold.

Two honest caveats before pursuing it:
- **Order-dependent, not confluent.** The result depends on which edge is the
  back-edge (who reads stale). The condensation makes that deterministic and
  reproducible, but it is *not* order-independent the way a `meet` fixpoint is.
  So: "principled and deterministic", not "confluent".
- **Bug-masking.** Throwing on cycles catches real mistakes. Cycle-once silently
  accepts `a = b; b = a`. Make it **opt-in** (a flag on the computed, or only
  for SCCs explicitly marked) so the default stays loud on accidental cycles.

Status: deferred, not the current focus — recorded here so the option isn't
lost. It would make even plain computeds first-class cyclic citizens, the
cleanest expression of "lenses and propagators are true equals".
