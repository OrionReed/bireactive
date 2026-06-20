# Two-Way Binding, Steelmanned (and why lenses dodge it)

Loose, informal notes from a research conversation — captured before they evaporate. the field (reactive programming) rightfully rejected *undisciplined* bidirectionality, then spent a decade re-adding *disciplined* slivers of it one keyword at a time. A lens is the general, lawful, composable form of the thing that keeps getting reinvented.

---

## steelman

- **`get` is non-injective → `put` reconstructs intent it can't see.** the deepest one. forward maps discard info (hue at grey, the addends of a sum, JSON whitespace). state-based `put : V → S → S` has to invent a source from a view, but one view = many intended source edits. the *edit* carries intent; the *state* doesn't. this is why edit/delta lenses exist. we hit the same wall from inside — it's the whole `ctx-aware-bwd.md` `share` design and the `SKIP`/complement machinery. state-based two-way binding is under-determined; the orthodoxy's caution is correct until intent is supplied (policy or deltas).
- **PutPut fails → history leaks into state.** well-behaved lenses give GetPut + PutGet but generically *not* PutPut. with a complement, two sequential view edits can land in a different source than the same final view reached directly — so backward is history-dependent. one-way reducers are pure fns of (state, action), so replay is trivial. plus the alignment problem: list/tree lenses align positionally and mishandle reorder/insert (the motivation for matching lenses). collections are where naive two-way visibly breaks.
- **a write is not the inverse of a read (CQRS).** real mutations carry auth, validation, audit, server ID-minting, optimistic rollback. `put = get⁻¹` is too thin. command/query separation and event sourcing exist *because* reads and writes genuinely differ — and a principled `put` needs effects, because real backward edges are commands.
- **concurrency / local-first.** state-based binding has no story for concurrent edits (two clients, offline merge). the modern answer is operation-based — CRDTs, deltas — which is edit/delta lenses again. any "two-way is the future" pitch has to concede the networked, durable future is delta-shaped.
- **cognitive / operational floor.** one-way is teachable in an afternoon ("data down, events up") and gives Redux-devtools time-travel for free, since state transitions are a pure log. bidirectional asks the median dev to reason about inverses, complements, least-change, and write-write conflicts (the diamond / merge problem, `ctx-aware-bwd.md` §12). frameworks optimize for the median dev — economics, not cowardice.

so the orthodoxy isn't afraid of backward edges as such. it's afraid of backward edges that are intent-blind, history-dependent, secretly effectful, or concurrency-naive. lenses handle the first and third with policy and effects; the other two are still open, and that's the edit/delta-lens frontier.

---

## a reactive effect *is* a backward pass

earlier insight: "a terminal node like an effect often coincides with a write to its source." that's the effectful-lens thesis generalized past async.

- effectful/monadic lenses model `get`/`put` in monads `M_get`/`M_put`. the ICFP'25 liberation is `M_get ≠ M_put` — fast pure read + slow effectful write is the *normal* case.
- a reactive `effect` is the degenerate terminal lens: `M_get = Identity` (track deps, pure), `M_put = IO` (the side effect). Solid 2.0's two-phase `createEffect(compute, apply)` is *literally* `get`/`put` separation; their "don't write back from `compute`" warning is the 2016 *Reflections on Monadic Lenses* result — keep `get` pure, effects in `put` — rediscovered as an ergonomics rule.
- complement = the universal device. "info `get` discarded" and "in-flight state" are the same field: lossy round-trip (`remember`/`continuous`), optimistic UI (pending value), undo/redo (edit history), async commit (abort token / last-good), parse/validate (`formatSpoke` un-parseable text) — all one construct. async-note §7.1: our symmetric-lens module already *is* the complement-based encoding ICFP'25 says is structurally required.
- tidy framing: reads/writes are algebraic operations; the reactive engine is the handler. async is one handler; optimistic/pessimistic/suspended/streamed (async-note T2) are handler choices for `put`. cleaner story than a 4×5 discipline matrix.

---

## writable-derived is being reinvented everywhere

everyone's re-adding "derived but writable" with a hardcoded backward policy. a lens just leaves that policy open.

| primitive | lens reading | backward policy (fixed) |
| --- | --- | --- |
| Vue `defineModel` / `v-model` | sugar over `:value`+`@update` | explicit prop+event |
| Svelte `$bindable` + `bind:`; `{get,set}` object | opt-in marker; the get/set object is a lens at the bind site | local read/write (+ optional validation in `set`) |
| React controlled comp + "lift state" | hand-rolled lens written inline every time | `value`=get, `onChange`=put, threaded up manually |
| Solid `createSignal(fn)` "writable memo" | lens, complement = override | shadow until recompute |
| Solid `createProjection(fn, {key})` | lens, complement = draft | keyed reconcile (alignment by fiat) |
| Solid `createOptimisticStore` | lens, complement = overlay | revert on transition settle |
| **bireactive `lens(src, get, put)`** | the general case | any declared `put` — propagate, solve (IK), backprop, shadow, parse… |

Solid 2.0 even warns (`pureWrite`) against writing back from reactive scope — then ships three primitives whose whole job is sanctioned write-back. a lens is just the honest name for that: their three are three fixed backward policies, ours leaves it open.

and it's not only the primitives — the runtime obligations line up too (async-note §6.1): microtask batching by default, reads don't update until `flush()`, two-phase effects, write-under-scope warnings, `isPending` as a traversal. Solid already paid those costs; matching their scheduler shape means the bidirectional layer rides a runtime people already trust.

---

where the steelman still wins:

- intent: state-based `put` is under-determined. partial fix is `share` policies; the proper fix is deltas/edit lenses — deferred, but the endgame.
- concurrency / local-first: needs operation-based / CRDT, not a state-lens story at all.
- alignment: collections want traversal/matching optics; Solid punts to `key`, which is a fine interim. (diamond/merge racing → `ctx-aware-bwd.md` §12)
- effectful-`put` runtime: the open questions in async-note P1–P6. the theory's settled (Effectful Lenses + Incremental Relational Lenses); the push-based reactive bidirectional runtime is the empty cell in async-note §5's table.

bottom line: the field rejected undisciplined bidirectionality and has been re-adding disciplined slivers ever since. a lens — lawful, explicit, complement-carrying, effects-in-`put` — is the general form. deltas/edit-lenses are the frontier that closes the intent and concurrency gaps the orthodoxy is still right to worry about.

---

## papers

### the orthodoxy

- **Jing Chen — "Hacker Way: Rethinking Web App Development at Facebook"**, F8 2014. <https://www.youtube.com/watch?v=nYkdrAPrdcw>. the "what we're arguing against is *bi-directional* data flow, where one change can loop back and cascade" quote, and the unread-count derived-data bug.
- **Flux — In-Depth Overview**, facebookarchive/flux. "no two-way bindings… application state maintained only in stores… cascading updates made it very difficult to predict." <https://github.com/facebookarchive/flux/blob/main/docs/In-Depth-Overview.md>
- InfoQ — "Facebook: MVC Does Not Scale, Use Flux Instead" (2014).
- Smashing Magazine — "AngularJS' Internals In Depth" (2015). the `$digest` dirty-check loop, "Maximum iteration limit exceeded" at cap 10.
- Boris Cherny — "The 8 Worst Things About Angular 1" (2017). feedback loops / digest TTL as a postmortem.

### disciplined re-adds

- Vue RFC — `defineModel` (Discussion #503) + "Rethinking Simplicity" (#528). v-model = sugar over prop + `update:` event, plus the type-safety complaints. <https://github.com/vuejs/rfcs/discussions/503>
- Evan You — "I don't think you are looking at it objectively" (Medium). v-model "looks like two-way binding but has none of the gotchas."
- Svelte docs — `$bindable` + `bind:`. "props go one way… overuse makes data flow unpredictable… use sparingly." the `{get,set}` intercept object is a lens at the bind site. <https://svelte.dev/docs/svelte/$bindable>
- Solid 2.0 RFCs (next branch): `01-reactivity-batching-effects`, `02-signals-derived-ownership` (function-form `createSignal`/`createStore`), `04-stores` (`createProjection`), `05-async-data`, `06-actions-optimistic`. beta notes: "v2.0.0 Beta — The <Suspense> is Over." <https://github.com/solidjs/solid/tree/next/documentation/solid-2.0>
- `@solidjs/signals` README — writable memos, push-pull, microtask flush. <https://github.com/solidjs/signals>

### lens foundations

- Foster, Greenwald, Moore, Pierce, Schmitt — **"Combinators for Bidirectional Tree Transformations"** (Harmony/Boomerang), POPL'05 / TOPLAS'07. GetPut / PutGet / PutPut; the canonical well-behaved-lens paper.
- Bohannon, Pierce, Vaughan — **"Relational Lenses: A Language for Updatable Views"**, PODS'06.
- Hofmann, Pierce, Wagner — **"Edit Lenses"**, POPL'12. delta-based; the proper answer to the intent + alignment problems. deferred, but the endgame.
- Diskin et al. — multiary delta lens with amendment (2019). already cited in `ctx-aware-bwd.md` §14.

### effectful / monadic lenses

- Xie, Schrijvers, Hu — **"Effectful Lenses: There and Back with Different Monads"**, ICFP'25 (distinguished). DOI 10.1145/3747523. → async-note §7. `M_get ≠ M_put`; complement-based encoding required.
- Abou-Saleh, Cheney, Gibbons, McKinna, Stevens — **"Reflections on Monadic Lenses"** (2016). arXiv:1601.02484. keep `get` pure, effects in `put`. → async-note.
- Gibbons et al. — **"Bidirectional Transformation is Effectful"** (position paper). the state-monad framing of get/put; "entangled cells."
- Leijen — "Structured Asynchrony with Algebraic Effects", MSR-TR-2017-21. async is one handler among many. → async-note.

### incremental + bidirectional

- Horn, Perera, Cheney — **"Incremental Relational Lenses"**, ICFP'18. DOI 10.1145/3236769. arXiv:1807.01948. the `δput` law `put(S, get(S) ⊕ ΔV) = S ⊕ δput(S, ΔV)`; deltas backward; orders-of-magnitude speedup. the rigorous bridge from state-based `put` to deltas without committing to full edit lenses. probably the one to read first.
- Horn, Fowler, Cheney — "Language-integrated updatable views", IFL'19. DOI 10.1145/3412932.3412945. typechecking relational lenses in Links.

### lens = backprop

- Elliott — **"The Simple Essence of Automatic Differentiation"**, ICFP'18. DOI 10.1145/3236765 (ext. arXiv:1804.00746). RAD as compositional duality; no tapes/graphs/mutation.
- Fong, Spivak, Tuyéras — **"Backprop as Functor"**, arXiv:1711.10455 (LICS'19). request function ≈ lens `put`; `Learn` embeds in spans of lenses. the academic backing for `site/index.md:397`.

### optics

- Pickering, Gibbons, Wu — **"Profunctor Optics: Modular Data Accessors"** (2017). arXiv:1703.10857. lens/prism/traversal compose by ordinary function composition; lattice structure. our `at`/`fields` are the lens optic; the neighbors are prism for sum types, traversal for collections.
- Clarke et al. — **"Profunctor Optics: a Categorical Update"**, Compositionality (2024). arXiv:2001.07488. mixed optics = different category per direction = the categorical echo of `M_get ≠ M_put`.

### adjacent

- Meertens — "Designing Constraint Maintainers for User Interaction" (1998). least-change discipline. → async-note (and main doc §3).
- Nystrom — "What Color is Your Function?" (2015). the function-coloring framing async-note §3 pushes back on.
- TC39 Signals proposal — read-only, async is the consumer's problem.
- Czarnecki et al. — "Bidirectional Transformations: A Cross-Discipline Perspective" (GRACE survey). a good map of the whole bx field for a refresher.
