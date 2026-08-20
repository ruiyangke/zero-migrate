# One-sided preflight proposal

Status: Draft
Date: 2026-08-20

This proposal replaces step 6 of `single-fold-and-effects.md`, which hoists five
existence assertions from their own plan step up into preflight so a whole plan can
be refused before it touches anything.

Hoisting is right. The way step 6 specifies it is not, and the reason is one
sentence:

> Finding something is proof. Not finding it is not proof.

Two of the five assertions are NEGATIVE. They do not range over objects the model
found; they range over its COMPLEMENT, over everything it did not find. Step 6
justifies all five with one line, that they "range over objects the model NAMES",
and that justification is simply false for those two.

The central design rule of this proposal is:

> Preflight may REFUSE. Preflight may say UNKNOWN. Preflight may never APPROVE a
> negative assertion.

That asymmetry removes the failure by CONSTRUCTION rather than by keeping a
definition correct over time, which is what every other option on the table
requires.

## Proposed decisions

1. Preflight evaluation of an existence assertion is THREE-VALUED:
   `Refuted` / `Unknown` / `Confirmed`, not a boolean.
2. A NEGATIVE assertion may only ever resolve to `Refuted` or `Unknown` at
   preflight. It can never resolve to `Confirmed`. This is enforced by the type,
   not by a convention.
3. `Unknown` is not a failure. It means the authoritative check at the step still
   runs, exactly as it does today.
4. All five assertions hoist. The two negative ones hoist as one-sided refusers.
5. `RowCount` resolves to `Unknown` unconditionally and therefore never hoists in
   practice. It is included so the vocabulary is total, not to make it useful.
6. The step-level check is NOT removed for any assertion that can resolve
   `Unknown`. Preflight is an optimization layered over the authoritative check,
   never a replacement for it.
7. Widening catalog coverage is an OPTIMIZATION under this design, not a
   correctness requirement. It raises the `Refuted` hit rate and can be done later
   or never.

## Goals

- A plan that will certainly fail is refused before any DDL executes.
- A wrong `Confirmed` on a negative assertion is impossible to write, not merely
  unlikely.
- No new promise about what "absent" means, and nothing new to keep in sync across
  three dialects.
- Correct behaviour when a third party changes the schema between preflight and
  apply.

## Non-goals

- Removing the step-level checks. They stay.
- Making `RowCount` answerable offline. It is not.
- Guaranteeing that every refusable plan IS refused at preflight. This design
  refuses what it can prove and defers the rest. Missing a refusal costs a late
  failure, which is the status quo.

## What is measured, and what it costs the current plan

Measured at `2aae4155`.

**The engine has two sources of state, and neither can answer absence.**

`fold(ops) -> SchemaModel` replays recorded migrations. It is authoritative about
objects THIS TOOL created and structurally blind to everything else. It has no
mechanism by which a DBA's table could ever enter it.

Live introspection reads the server, but every query is scoped. Each introspection
statement in `apply/drift.rs` carries `WHERE n.nspname = $1`, one schema. And the
relation-kind filters are narrower still: `relkind IN ('r','p')` for tables at
`drift.rs:1148`, `relkind IN ('v','m')` for views and matviews at `:1227`.

In PostgreSQL every relation shares one namespace per schema. Sequences (`S`) and
foreign tables (`f`) are in that namespace and in neither filter. So:

```
  someone runs:   CREATE SEQUENCE archive;
  model asks:     relkind IN ('r','p') ... and ('v','m')
  model answers:  "no table named archive"        -> absence SATISFIED
  plan proceeds
  step runs:      CREATE TABLE archive
  server says:    relation "archive" already exists
```

The snapshot was COMPLETE for what it asked and still WRONG, because the assertion
ranges over a larger namespace than the query does.

**The apply lock does not close the window.** `MigrationBackend::acquire_project_lock`
is `pg_advisory_lock(hashtext($1))` on PostgreSQL and `GET_LOCK` on MySQL
(`apply/backend/mod.rs:384-390`). It serializes this tool's applies against each
other. It is ADVISORY, so a DBA in psql does not honour it. Any design that blesses
a plan on the strength of a point-in-time snapshot is wrong under concurrency no
matter how complete the snapshot is.

**The failure direction is the one step 6 never analyses.** Every risk step 6
lists runs toward OVER-refusal; it is described as "the only step that can refuse a
plan that previously applied", which is why it is scheduled last and behind a flag.
Under-refusal is not mentioned anywhere, and it is the direction these two fail in.

**And it is worse than doing nothing.** The point of hoisting is to refuse before
touching the database. A wrong `Confirmed` buys the preflight cost AND still dies
partway through, now as a raw server rejection rather than a clean refusal from the
engine. `backend-conformance.md` classifies that outcome, `ServerError`, as a
conformance failure under every circumstance.

**Step 6's own precondition cannot currently be met.** It says it should ship only
after the simulation "has run in production long enough to be trusted". Nothing in
production calls it, so trust cannot accumulate. One-sidedness removes the need for
that trust: a refuser does not need to be trusted to be safe, only to be right when
it fires, and it fires only on positive evidence.

## The design

### Three-valued, and the type does the work

```
  enum PreflightVerdict {
      Refuted,     // proven false from positive evidence. refuse the plan.
      Unknown,     // cannot be decided offline. the step's live check runs.
      Confirmed,   // proven true. POSITIVE assertions only.
  }
```

The negative assertions are evaluated by a function whose return type cannot
express `Confirmed`:

```
  enum NegativeVerdict { Refuted, Unknown }

  fn evaluate_absence(model: &SchemaModel, name: &Ident) -> NegativeVerdict
```

That is decision 2, and it is the whole proposal. A future contributor cannot
reintroduce the bug by widening a catalog query and deciding absence is now
provable, because there is no variant to return.

### What each assertion resolves to

```
  TableExists      model finds it        -> Confirmed   (hoists, terminates)
                   model does not        -> Unknown     (live check at the step)

  ColumnExists     same

  TableNotExists   model FINDS it        -> Refuted     (refuse the whole plan)
                   model does not        -> Unknown     (live check at the step)

  ColumnNotExists  same

  RowCount         always                -> Unknown
```

Note `TableExists` also yields `Unknown` rather than `Refuted` when the model does
not find it. Absence from the model is not evidence in either direction, and that
is true no matter which way the assertion points.

### Flow

```
  PREFLIGHT                              APPLY

  for each assertion:                    for each step:
    evaluate against the model             assertion Unknown?
      |                                       |
      +-- Refuted  -> refuse plan,            +-- yes -> live check, as today
      |              nothing executed         |
      +-- Confirmed -> satisfied,             +-- no  -> already settled at
      |               skip step check         |          preflight
      +-- Unknown  -> defer                   |
                                              v
                                        server is final authority
```

### Why not the alternatives

- **Hoist only the positives.** Correct, and gives up early refusal on exactly the
  cases most worth refusing: a name collision that will certainly fail.
- **Hoist all five as written.** The wrong-accept bug above.
- **Declare a scope, then widen the query to match it.** Correct on the day it
  lands. It requires a definition of "absent" that stays true across three dialects
  with three different namespace rules, forever, with no test that fails when it
  drifts. And it is still wrong under a concurrent DDL race, because it still
  approves from a snapshot.
- **Defer.** Keeps a documented plan whose analysis is wrong.

Only one-sidedness removes the failure by construction. The others remove it by
diligence.

## What this makes worse

**Two code paths per negative assertion instead of one.** The preflight refuser and
the step-level check both exist and can disagree in the harmless direction
(preflight says `Unknown`, step says refuse). Anyone reading it must understand why
duplication is deliberate. The doc comment on `evaluate_absence` must say so.

**A `Refuted` can be stale.** The model saw `archive`, a DBA dropped it, the plan
is refused though it would have worked. Over-refusal, the safe direction, and the
one step 6 already accepted.

**Early refusal is best-effort and must be described that way.** Operators should
not learn to read "preflight passed" as "this plan will apply". It means "nothing
was proven fatal offline".

## Required test matrix

Every row must be proven RED before it is believed green.

1. **The type refuses the bug.** `NegativeVerdict` has no `Confirmed` variant.
   Adding one must fail the build. Prove by adding it and observing the failure.
2. **`Refuted` fires on positive evidence.** Model contains `archive`; a plan
   asserting `TableNotExists(archive)` is refused at preflight with NO DDL
   executed. Assert the executed-statement count is zero, not just that an error
   was returned.
3. **The sequence case yields `Unknown`, not `Confirmed`.** Create a SEQUENCE named
   `archive` on a live PostgreSQL server, out of band. Preflight must return
   `Unknown` and the step's live check must then refuse. This is the exact case
   that fails today, and it is the test that would have caught it.
4. **`Unknown` does not skip the step check.** Neuter the step-level check and
   confirm the suite goes RED on an `Unknown` path. If it stays green, the step
   check is not load-bearing and the test is measuring nothing.
5. **The race.** Preflight returns `Unknown`, a third session creates the object,
   the step refuses. Under the advisory lock, which the third session does not
   take.
6. **All three dialects.** PostgreSQL, MySQL and SQLite have different namespace
   rules. The one-sided property must hold on each; it is a property of the
   VERDICT, not of any catalog.
7. **`RowCount` never hoists.** Assert it resolves `Unknown` for every input,
   including inputs where a naive implementation might think it knows.

## Risks and open questions

- **Is `Confirmed` on the POSITIVE assertions sound?** It rests on the model having
  found the object, which is positive evidence, but it is still a snapshot. A
  concurrent DROP between preflight and apply makes a `Confirmed` stale, and the
  step check was skipped. Two answers are available and this proposal does not pick
  one: keep the step check for `Confirmed` too, making preflight purely advisory
  everywhere; or accept that a concurrent DROP of an object your migration depends
  on is a lost race by definition. UNRESOLVED, and it should be settled before
  implementation rather than during.
- **Should `Refuted` be advisory as well?** A stale `Refuted` refuses a plan that
  would have worked. Cheap to make it a warning; that trades a false refusal for a
  late failure. Not obviously correct either way.
- **Where does this live once backends are crates?** The refuser reads a
  `SchemaModel`, which is neutral, so it belongs in core. But raising the `Refuted`
  hit rate means asking each backend what shares a namespace, which is a capability
  question and interacts with `pluggable-backends.md`. Not needed for correctness
  under this design, which is the point.

## What was verified, and what was not

VERIFIED at `2aae4155`: the introspection scope (`WHERE n.nspname = $1` on every
statement in `apply/drift.rs`); the relkind filters at `drift.rs:1148` and `:1227`;
that `acquire_project_lock` is `pg_advisory_lock` / `GET_LOCK` at
`apply/backend/mod.rs:384-390`; that step 6 of `single-fold-and-effects.md` names
all five assertions and justifies them in one line; that its analysis mentions only
over-refusal.

INFERRED, NOT MEASURED: that a `CREATE SEQUENCE archive` followed by
`CREATE TABLE archive` produces the collision described. This follows from
PostgreSQL's single-namespace rule and the measured relkind filters, but it has not
been executed against a live server. Test-matrix row 3 exists to execute it. Do not
cite the example as measured until that test runs.
