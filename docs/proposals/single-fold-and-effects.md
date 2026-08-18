# Single fold and effects proposal

Status: Draft
Date: 2026-08-17

This proposal defines the final-state architecture for interpreting the op
stream. Today the stream is replayed by many independent walkers, each of which
learns dialect and semantic rules separately. Every divergence shipped this
session is a rule one walker learned and the others did not.

The repo has already reached this conclusion in its own words, twice:

- `docs/review-log.md:26392-26398`: "there are THREE replays of the same op
  stream (`authoring_tables_from_ops`, `fold_to_field_defs`, `fold_ops`), plus
  `runtime_metadata_from_ops`, and every divergence above is a rule one of them
  learned and the others did not. [...] That is a design problem, not three
  bugs". It then unified the two snapshot-owning replays for renames and
  explicitly deferred the rest.
- `docs/review-log.md:26780-26783`: "Three replays that must agree by convention
  will diverge again, and this is the second time in two commits that they did."

This proposal pays that deferral. It is the companion to
`pluggable-backends.md`, whose pipeline diagram already names the destination
("FOLD <=== THE ONE INTERPRETER OF WHAT AN OP MEANS") and whose open question
list defers the hard part here: "Whether one model can serve both without
becoming a god-object is UNVERIFIED" (`pluggable-backends.md:339-342`). Section
C answers it.

The central design rule is simple:

> An op means one thing. Decide it once, in one traversal. Every artifact is a
> projection of that decision, and a projection does not walk ops.

## Proposed decisions

1. ONE traversal. `fold(ops) -> SchemaModel` is the only code that decides what
   an op means. Every semantic rule about ops lives in it and nowhere else.
2. `SchemaModel` is dialect-neutral, and its field set is bounded by the IR
   rather than by its consumers. It carries what the 56 `Op` variants can state,
   at the resolution they state it.
3. `TableSnapshot`, `FieldDescriptor`, the runtime descriptor and the authoring
   tables become PROJECTIONS of `SchemaModel`. One traversal, several typed
   projections. This is NOT one struct, and the distinction is the whole answer
   to the god-object objection.
4. A projection is lossy by design, declares in its type what it drops, and MAY
   NOT walk the op stream. A projection that needs a fact the model does not
   carry is a model change, not a second replay.
5. Facets are carried forward, never recovered. `recover_check_facet`
   (`render/fold.rs:4265`) exists because a projection reverse-engineers from
   rendered CHECK text what the op stated directly. In the final state nothing
   re-reads a rendered artifact to recover an authored fact.
6. Every step gets an `Effect`: what it adds, removes, and changes, in model
   terms. `state_at(N) = live_at_0 (+) fold(effects[0..N])` is a real value.
7. Effects are derived from OPS, above the dialect boundary. No effect is ever
   derived by parsing rendered SQL.
8. Plan preflight, validate, preview and drift become one predicate evaluated
   against `state_at(N)` for different N, instead of four hand-written
   approximations of the same walk.
9. Equality is DERIVED on the neutral model. "Equal for this purpose" becomes a
   named, explicit comparator per consumer, never one hand-maintained `eq` that
   every consumer silently inherits.
10. The obstruction/existence classification in
    `apply/plan_precondition.rs` is NOT retired by an effect model. It is
    redrawn along a different axis and its effect is inverted. Section E argues
    this at length, because the shipped code argues the opposite.
11. Migration is by strangler. The new fold is proven equal to each existing
    walker on a recorded corpus BEFORE any consumer is moved onto it, one
    consumer at a time.

## Goals

- A rule about what an op means can be stated in exactly one place, and there is
  no second place where it could have been stated instead.
- Two artifacts emitted from one `renderArtifacts` call cannot describe the same
  column differently, because they are projections of one value.
- `state_at(N)` is answerable, so a question about "the database after step N"
  is a lookup rather than a bespoke approximation.
- Adding an `Op` variant fails to compile in the one traversal, rather than
  silently falling through a `_ => {}` in five others.

## Non-goals

- Merging the declarative and versioned authoring lanes. They converge on one
  fold, and stay two lanes (`pluggable-backends.md:40-41`).
- One struct serving every consumer. Explicitly rejected in section C.
- Modelling the live database. The fold models what the OPS say. The live model
  comes up through `introspect`, and section E turns on the difference.
- Changing the IR wire format. `Checksum::of_ir` folds JCS bytes, so field names
  are inside every deployed migration's checksum
  (`pluggable-backends.md:281-296`). Nothing here renames an op field.
- Retiring per-migration precondition evaluation. It stays the only thing that
  decides whether a migration APPLIES.

## A. The interpreter inventory, measured

The brief's estimate was "about six". Measured, the answer depends entirely on
where the line is drawn, and every reasonable line lands above six.

`Op` has **56 variants** (`crates/zero-migrate-ir/src/ir.rs:2837-3872`). Counting
production functions that `match` over `Op` or walk an op list across
`crates/*/src`, and excluding `cfg(test)` modules and the `UnaryOp::` / `BinOp::`
false positives a naive grep collects, the total is **about 81**. That number is
not useful on its own, because most are per-op classifiers that cannot drift
from each other in a way anyone would notice. Four tiers, narrowest first.

**Tier A: state-building replays. NINETEEN.** These accumulate schema state
across the stream, and these are the ones that have diverged. The load-bearing
subset is the five that are truly independent full replays:

| interpreter | file:line | produces | consumed by | arms / catch-alls |
|---|---|---|---|---|
| `fold_ops_onto` (wrapped by `fold_ops:1039`) | `render/fold.rs:1062` | `SchemaSnapshot` | `refresh_historical_live` (`engine.rs:391`), MySQL expected-state, drift, node rollback/inverse (`node/src/lower.rs:446,624,747,1178`) | 56 arms, 4 `_ =>` |
| `fold_to_field_defs` | `render/fold.rs:4423` | per-table wire `FieldDef` JSON | `schema.runtime.json` (`gen_types.rs:373`); on SQLite `live.sqlite_schemas` (`engine.rs:396,618`), which drives REBUILD DDL | 56 arms, **0 catch-alls** |
| `runtime_metadata_from_ops` | `render/gen_types.rs:237` | collection options, plain indexes | `schema.runtime.json` (`gen_types.rs:442`) and `env.db.ts` | **12 arms, 1 `_ =>` swallowing 44 variants** |
| `authoring_tables_from_ops` | `render/gen_types.rs:520` | authoring tables | `env.db.ts` (`gen_types.rs:443`) | **15 arms, 1 `_ =>` swallowing 41 variants** |
| `IrAuthor::lower_one_op` | `render/lower.rs:4628` | `LoweredOp` -> `PlanStep` -> executor | every apply | 56 arms, 1 `_ =>` |

The other fourteen in Tier A are narrower state advances, and they matter
because they are where "the plan's effect on state" is already being written by
hand: `replay_ops` (`lower.rs:4259`), `LiveSchema::advance_declared_column_generation`
(`lower.rs:770`), `LiveSchema::advance_logical_columns` (`lower.rs:865`),
`collect_logical_declarations_op` (`validate.rs:1678`), `render_ir_ops` plus
`advance_preview_table_presence` (`sql_preview.rs:468,525`),
`resolve_create_table_ops` (`table_shape.rs:310`), `flatten_dialectal_ops`
(`fold.rs:635`), `history_carries_dialectal_ops` (`fold.rs:631`),
`refresh_historical_live` (`engine.rs:375`), and four in the node host
(`node/src/lower.rs:438,1019,1399,1592`).

**Tier B: op-stream scanners. FIFTEEN.** Build lists or sets, no schema state:
`collect_op_database_requirements` (`lower.rs:2621`), `resolved_touched_tables`
(`lower.rs:3383`), `Op::collect_touched_tables` (`ir.rs:4075`),
`classify_forward_op` (`ir/load.rs:651`), `migration_requires_approval`
(`ir/policy_approval.rs:143`), `check_ir_data_security_policy`
(`guard/mod.rs:3140`), and nine more.

**Tier C: per-op classifiers and renderers. TWENTY-FIVE.** `op_support::support`
(`op_support.rs:34`), `render_vendor_op` (`render/vendor.rs:228`),
`Op::is_destructive` (`ir.rs:3981`), `Op::existence_guard` (`ir.rs:4180`), and so
on.

**Tier D: validation walkers. TWENTY-TWO helpers** under six public drivers, all
in `model/validate.rs` (422 `Op::` references, the largest concentration in the
tree).

So the honest headline is: **19 state-building replays, of which 5 are
independent full replays, inside about 81 op-matching functions.** The brief's
"about six" is closest to the five-replay number, which is the right number for
"how many places re-derive what an op means for schema state". Every other
framing is larger.

Six measured details that sharpen the picture:

- **`fold_to_field_defs` already calls `fold_ops` and throws the answer away.**
  It opens with `fold_ops(ops, dialect, project_schema, effective)?;` at
  `render/fold.rs:4431`, discards the result, and does a second independent
  replay. Its own comment says why: "We track FieldDescriptors (not snapshots)
  because the descriptor carries the recoverable facets
  (encrypted/vector*/ref/id_prefix) the snapshot flattens to a `data_type`
  string" (`render/fold.rs:4434-4437`). The traversal is ALREADY shared. What is
  not shared is the state it accumulates, because the first walker's output type
  is lossy for the second walker's purpose. That is the defect in one line.
- **Exhaustiveness is not correctness.** `fold_to_field_defs` has NO catch-all
  and handles all 56 variants, and it is still the walker wrong in eight of the
  seventeen rows in section B. Matching every variant does not mean deciding it
  the same way. This is the single strongest reason a compile-time exhaustiveness
  tripwire is necessary but insufficient, and why decision 1 is about ONE
  traversal rather than about exhaustive matching.
- **The two artifact walkers ignore most of the stream.**
  `runtime_metadata_from_ops` handles 12 of 56 and swallows 44;
  `authoring_tables_from_ops` handles 15 and swallows 41. Both feed shipped
  artifacts. The `Op::Dialectal` defect in section B is exactly this shape.
- **Three partial effect models run in one loop body**,
  `render/sql_preview.rs:511-520`: `advance_logical_columns`,
  `advance_preview_table_presence`, `advance_declared_column_generation`. Each
  covers a different slice of state, each has its own catch-all. Read
  `advance_preview_table_presence` (`sql_preview.rs:525-554`): it handles
  `Op::CreateTable` and `Op::Dialectal` and nothing else, so its table set is
  monotonically additive and a `dropTable` never removes anything from it. The
  engine is already writing an effect model. It is writing it three times,
  incompletely, in one function.
- **Dialectal leg selection is duplicated three times**:
  `fold::selected_dialectal_leg` (`fold.rs:568`), `IrAuthor::selected_dialectal_leg`
  (`lower.rs:4434`), `validate::dialectal_leg` (`validate.rs:4252`). Three
  implementations of "which leg applies", for the one op whose mis-expansion has
  already shipped twice.
- **A live hole with a stale doc.** `gen_types.rs:513` claims
  `runtime_metadata_from_ops` "reads the unflattened op list and so has never
  seen inside a dialectal leg"; the code at `:243` now calls
  `flatten_dialectal_ops`, so the comment is stale. The surrounding block
  (`:505-519`) documents a DIFFERENT hole that is still open: a table created
  only inside an `Op::Dialectal` leg can emit fields but lose runtime options and
  plain indexes, because `render_runtime_descriptor_v1` falls back to
  `unwrap_or_default()` (`gen_types.rs:377`).

Two things are NOT op-stream interpreters, and the correction matters:

- **`apply/plan_precondition.rs`** walks `&[PlanStep]`, not `&[Op]`. Its single
  `Op::` reference is in a doc comment (`:12`). It is a POST-LOWERING
  interpreter, which is precisely the problem section E is about: it re-derives
  from rendered SQL a fact the op stream stated directly.
- **`render/declarative.rs`** does not interpret `Op` either. Its two `Op::`
  hits (`:2839`, `:2966`) are doc comments about the fold. The declarative differ
  runs on a SEPARATE op vocabulary, `DiffOp` (`schema/diff.rs:89`, `ChangeKind`
  at `:107`, produced by `compute_diff:983`). That is a second op stream with its
  own semantics, and unifying it is out of scope here.

The TypeScript side is NOT an interpreter, confirmed by sweep.
`packages/zero-migrate/src/ops.ts` (5185 lines) is a RECORDER
(`recorder().ops.push(op)` at `ops.ts:432`); no `switch` on the `op`
discriminant exists anywhere in `packages/*/src`. All interpretation lives in
Rust. The one op-keyed TS table,
`packages/zero-migrate/src/generated/dialect-table.ts`, is generated from
`crates/zero-migrate/dialect-support.toml`, its header states "NOTHING outside
this file reads the TS mirror", and `tests/dialect_table_faithfulness.rs` proves
it faithful to the live `Support::decision()`. That is a good precedent and
section G reuses it.

## B. The divergences that have shipped

This is the empirical core. Every row is a defect that reached a tree, from
`docs/review-log.md`. "RIGHT" and "WRONG" name interpreters from section A,
abbreviated: **FO** = `fold_ops`, **FFD** = `fold_to_field_defs`, **ATO** =
`authoring_tables_from_ops`, **RMO** = `runtime_metadata_from_ops`.

| op / rule | RIGHT | WRONG | symptom | log |
|---|---|---|---|---|
| `renameColumn` + generated expression | FFD, ATO | FO | SQLite rebuild emitted `GENERATED ALWAYS AS (("qty_on_hand" + 1))` naming a column the new table lacks. Rename undeployable. | 26273-26360 |
| `renameTable` + table-qualified ref in a generated expr | ATO | FFD, FO | THREE answers from ONE `renderArtifacts` call. Two artifacts shipped side by side describing the same column under different collection names. | 26370-26374 |
| `setColumnType` facet residue | FO, ATO | FFD | `text(caseSensitive:false) -> int` left `{"type":"int","caseSensitive":false}`. Deferred once, then fixed. | 26375-26382, 26624-26655 |
| `setColumnType` losing a parameter going in AND keeping it coming out | FO, ATO | FFD | `{"type":"char"}` with no `charLen`. On SQLite this is DDL, not just codegen. | 26632-26654 |
| `setColumnType` + `value_format` | FFD, ATO | FO | Three phantom drift diffs forever on a schema exactly as deployed. | 26383-26387, 26656-26715 |
| `setColumnType` leaving four drift-compared facets | ATO, `validate` | FO, FFD | `citext -> varchar(40)` reported `case_sensitive expected "false" actual ""` on every run forever. The brief for that fix claimed two walkers cleared them; MEASURED FALSE. | 26717-26733 |
| `Op::Dialectal` not expanded | FFD, ATO | RMO | `schema.runtime.json` described a table the database does not have. Six production non-descenders inventoried. | 18524-18583 |
| `Op::Dialectal` under a hard-coded dialect | - | FFD and ATO, both hard-coded `SqlDialect::Postgres` | a MySQL project's artifact claimed `pg_only` while the MySQL database has `mysql_only`. | 2924-2968 |
| named enum members | descriptor route | FFD | `runtimeJson` said `{"type":"string"}`, members dropped. Runtime validates the wrong closed set. | 27938-28048 |
| domain type | FO, ATO | FFD | a domain over `int` told the runtime it was a string; a domain over `varchar(40)` lost `maxLength`. Two of three replays right. | 29149-29156 |
| `renameColumn` + inline CHECK body | catalog-read leg | FO, plus `sqlite_rename_rebuild` | `no such column: "status"`, failed migration inside the transaction. | 28188-28248 |
| `renameColumn` + FK constraint definition | FO | `sqlite_rename_rebuild` | `unknown column "owner_id" in foreign key definition`. Deferred once because of `PartialEq`; see section D. | 28282-28298, 28393-28620 |
| `renameColumn` + `IndexSnapshot` name lists | live PG | FO | phantom `missing_objects` drift; 5 of 6 failing. Four further rendered-SQL carriers still unfixed. | 6801-6847 |
| `dropColumn` cascade + `Expr::Dialectal` | `render::fold` | RMO / gen-types replay | gen-types emitted a table with neither the CHECK nor the partial index live PG keeps. | 6855-6882 |
| retype of an identity / generated column | the SERVER | `validate`, `sql_preview`, and the `declarative` differ lane | validate PASS, preview PASS, apply DIED mid-migration. Half-migrated schema. | 26874-26986 |
| plan preflight vs the executor | the executor | `preflight_plan_column_retypes` | `[dropView, setColumnType]` refused though every step succeeds; a completed retype makes the deploy refused FOREVER. | 28660-28696 |
| online rename's plan-level dependents check | - | same shape, same hole | `[dropView, renameColumn]` refused. Three of the four bespoke preflights were over-refusing or dead-locking. | 28859-28875 |

Headline: `fold_to_field_defs` is wrong in eight of the
seventeen rows, and `setColumnType` alone accounts for five. The log's own
summary of that op is "replayed FOUR times" and "the four disagreed about
everything except the type itself" (`docs/review-log.md:26608-26617`).

The rename family is the other cluster, and it is instructive for a different
reason: a rename must be followed into every carrier that spells a column name.
The log found four carriers one at a time (generated expressions, inline CHECK
bodies, FK constraint definitions, index name lists) and four more remain
unfixed at `6837-6847`. There is no list of carriers anywhere, because there is
no one place that owns "what a rename means". In the final state there is, and
adding a carrier to the model adds it to the rename rule by construction.

## C. Where the projections genuinely differ

This is the strongest argument against a single model, the repo has already made
it, and it is correct as stated. `docs/review-log.md:26780-26791`:

> They cannot literally share one implementation: they mutate three different
> types (`ColumnSnapshot`, `FieldDescriptor`, `IrColumn`) carrying overlapping
> but unequal facet sets - `FieldDescriptor` alone holds seven facets `IrColumn`
> cannot round-trip. [...] A real unification would mean giving the three a
> common facet representation, which is a bigger change than this finding
> justifies.

Verified, and it is worse than a facet-count mismatch. The two types speak
different VOCABULARIES:

- `ColumnSnapshot` (`model/snapshot.rs:30`, 19 fields) carries `data_type` (a
  SQL catalog type), plus catalog identity: `sqlite_rowid`
  (`model/snapshot.rs:136`) and three `mysql_*` fields (`174`, `197`, `215`).
- `FieldDescriptor` (`render/declarative.rs:1757`) carries `ty: String`, which is
  a DSL AUTHORING TOKEN (`string`, `number`, `ref`, `actor`, `id` per its own doc
  at `1760-1762`), plus wire-contract fields with `serde(rename)` attributes
  because it deserializes from the `registerModel` descriptor.

These are not the same information at two resolutions. One is what the catalog
holds; the other is what the author wrote and the runtime consumes. Collapsing
them into one struct produces a type that is simultaneously a catalog record and
a wire contract, and every consumer inherits fields that are meaningless to it.
That is the god-object, and it should be refused.

**The conclusion: one traversal, several typed projections. Not one struct.**
The distinction is load-bearing and is decision 3.

```
                     ops: &[Op]
                         |
                         v
              +---------------------+
              |   fold(ops)         |   <== the only place op semantics live
              +----------+----------+
                         |
                     SchemaModel        (neutral, IR-bounded, DERIVES PartialEq)
                         |
      +---------+--------+--------+-----------+
      v         v                 v           v
  TableSnapshot FieldDescriptor  runtime    authoring
   (+ vendor     (wire            metadata   tables
    side table)   contract)                  (env.db.ts)
```

The god-object objection is answered by a BOUND, not by a promise. `SchemaModel`
carries what the 56 `Op` variants can state. It cannot grow because a consumer
wants something, only because the IR gains the ability to say something, and the
IR is a checksummed wire format that changes rarely and deliberately. Compare
today, where `ColumnSnapshot` grew `sqlite_rowid` and three `mysql_*` fields
because three backends each needed somewhere to put a fact. Those move to the
`VendorFacts` side table that `pluggable-backends.md:264-279` already specifies.

Two consequences worth stating plainly:

- The model must be RICHER than either current type, not a common subset. It
  must retain authored facets so that projection 2 needs no
  `recover_check_facet`, AND retain catalog shape so drift works. A common
  subset would lose exactly the facets the divergences were about.
- `IrColumn` is not a projection target. It is input. The log's framing of three
  types "mutating" is accurate about today and should not survive: the fold
  reads `IrColumn` and writes `SchemaModel`, and nothing mutates an IR column.

## D. The `PartialEq` problem

`ColumnSnapshot::eq` (`model/snapshot.rs:711-724`) compares ten fields by hand.
`ConstraintSnapshot::eq` (`model/snapshot.rs:1244-1251`) compares four. Both are
exclusion lists maintained by whoever last needed a field ignored, and
`TableSnapshot` (`model/snapshot.rs:1256`) does not derive `PartialEq` at all.

The exclusions are individually defensible and collectively unmanageable.
`cascade_columns` is excluded with a good reason written above it
(`model/snapshot.rs:1237-1241`: "this is provenance, not identity"). The log's
standing rule is "before calling an exclusion a defect, read the field's own
doc" (`docs/review-log.md:20782`). Both are right, and neither scales: the
exclusion list is a fifth interpreter, deciding what "the same column" means,
and it is consulted IMPLICITLY by every fix in the other four.

It has already blocked a fix. `docs/review-log.md:28292-28298`, on the FK rename:

> `ConstraintSnapshot`'s `PartialEq` COMPARES `definition`. Rewriting it in
> `sqlite_rename_rebuild` changes what `pure_sqlite_column_rename` compares,
> turns `preserve_stored_shape` off, and stops the CATALOG path - the one that
> actually deploys - from replaying its stored body. The rename-follow has to
> run AFTER that decision, which is a restructuring of the seam, not an addition
> to it.

The fix was deferred one commit and eventually landed a layer down, in
`render_create_table_sqlite_rebuild`. The contrast is explicit at `28483-28484`:
the CHECK and generated-column rewrites were safe ONLY BECAUSE `ColumnSnapshot`'s
`eq` happens to exclude both fields. Whether you may fix a bug depends on an
exclusion list written for an unrelated reason.

There is a second, sharper instance at `docs/review-log.md:9435-9447`:
`IndexSnapshot::only` was wrong in three independent places, and "fixing only the
equality would have left the drift line unchanged - the drift pass runs
independently of `PartialEq`". So the exclusion list is not even the single
authority on comparison; `apply::drift` has its own opinion.

**Final state.** `SchemaModel` DERIVES `PartialEq`. Structural equality means
all fields equal, with no exceptions and nothing to maintain. Every place that
today relies on an exclusion becomes an explicitly named comparator:

- `drift_identity(&Column, &Column) -> bool` for structural drift, which states
  which fields it ignores and why, in one place, with the field docs moved onto
  it.
- `index_pairing_identity(...)` for the differ's index pairing, which is a
  DIFFERENT question and today accidentally shares an answer.
- Vendor facts are compared only by code that knows the vendor, because they
  live in `VendorFacts` and are not reachable from the neutral model.

Three properties follow, and they are the point. A new field is compared by
default rather than silently ignored, so the failure direction flips from
"invisible" to "noisy". A comparator's exclusions are readable as a list rather
than inferred from an `eq` body. And the drift pass consumes a named comparator
instead of rolling a third opinion.

## E. Effects, and whether they retire the classification

### The question

`apply/plan_precondition.rs` classifies every `Precondition` as `Obstruction` or
`PlanDependent` (`plan_precondition.rs:89-114`). The brief asks whether a real
effect model makes that classification unnecessary, on the grounds that you
could instead ask the actual question: is this assertion true at step N given
steps 0..N-1?

This is not rhetorical, and the shipped code argues the opposite, explicitly.
`plan_precondition.rs:60-65`:

> So the prefix test the engine actually needs is ONE boolean per step - "can
> this step clear an obstruction?" - rather than a per-object effect ledger. A
> ledger would have to be right about creation, deletion, column addition,
> column removal and row counts independently, each silently wrong until some
> plan exercised it, and each wrong in the over-refusal direction.

That is a considered position. A fine-grained effect ledger WAS designed, WAS
reviewed, and WAS rejected, on two concrete counterexamples
(`docs/review-log.md:28913-28919`): the reviewer found `CREATE OR REPLACE VIEW`
in the renderer and showed the ledger classified it as a creation, which neuter
N3 then confirmed as a real over-refusal on a live server; and it found the
journal-satisfied hole, which N4 confirmed.

Any proposal for an effect model has to answer that, not talk past it.

### The counterexample was an artifact of ALTITUDE, not of ledgers

Verified: `clears_no_obstruction` (`plan_precondition.rs:219-221`) dispatches to
`sql_clears_no_obstruction(&m.up)`, which parses RENDERED SQL with
`pg_query::protobuf` (`plan_precondition.rs:79-80`). It reads a `ViewStmt` out of
a parse tree and cannot tell a creation from a replacement without the
whitelist.

At the OP level that ambiguity does not exist.
`crates/zero-migrate-ir/src/ir.rs:3401-3414` defines:

```rust
CreateView {
    ...
    replace: Option<bool>,
    ...
}
```

The fact the whitelist exists to avoid guessing is a NAMED FIELD in the op. An
effect model derived from ops gets N3 right by construction, with no whitelist,
no parser, and no `_ => may clear an obstruction` fallback for shapes nobody has
thought of. `CREATE OR REPLACE VIEW` is therefore evidence that reading rendered
SQL is the wrong altitude, not evidence that effects are unknowable. This is
decision 7, and it is the single most important correction this proposal makes
to the shipped design.

The N4 counterexample is orthogonal and survives either design. Judging
journal-satisfied steps is a bug about WHICH STEPS ARE IN THE PLAN, not about
what a step does. An effect model in fact states the fix more clearly: effects
are folded over the steps that WILL RUN, which is exactly the executor's
`set - completed - superseded`.

### What effects retire, and what they do not

`state_at(N) = live_at_0 (+) fold(effects[0..N])`. The two terms are not equally
knowable, and that is the whole answer.

- **Existence assertions** (`TableExists`, `TableNotExists`, `ColumnExists`,
  `ColumnNotExists`, `RowCount`) range over objects the model NAMES. `live_at_0`
  is the introspected `SchemaModel`, which the engine already builds; the prefix
  delta is exact. `state_at(N)` answers them precisely. Today all five are
  classified `PlanDependent` and NEVER hoist (`plan_precondition.rs:107-112`),
  which is safe but is a permanent capability gap. An effect model DOES retire
  the classification for these five, and it retires it in the direction of doing
  more, not less.
- **Obstruction assertions** (`ColumnHasNoBlockingDependents`,
  `ColumnTypeChangeHasNoBlockers`) range over `pg_depend` EDGES, inheritance
  links and partition-key memberships. Those are not in `SchemaModel`, and they
  cannot be, because the blocker set includes objects the engine never created:
  a DBA's view, another application's foreign key, an inheritance child. The
  effect model can prove the plan REMOVES a named blocker. It cannot ENUMERATE
  the blocker set. A live query at step 0 is still required.
- **`SqlBoolean`** is untrusted opaque SQL. Undecidable, permanently.

### Conclusion

**The classification is NOT retired. It is redrawn, and its effect inverts.**

The axis stops being "additive versus removal" (a property of how the assertion
responds to typical plans) and becomes "does this assertion range over objects
the model carries" (a property of the model's closure). Concretely:

| variant | today | with effects |
|---|---|---|
| `TableExists` and four siblings | never hoisted | answered exactly at `state_at(N)` |
| the two obstruction variants | hoisted behind a SQL-parse whitelist | hoisted behind an op-derived effect test, live query still required |
| `SqlBoolean` | never hoisted | never hoisted |

So the honest answer to the brief is: the effect model does not let you delete
`answerability()`. It lets you delete `sql_clears_no_obstruction`, the
`pg_query` dependency, and the whitelist's `_ => false` fallback, while flipping
five variants from never-answerable to precisely-answerable. That is a better
outcome than retirement, and it is achievable; retirement is not.

I record one disagreement with the shipped module's reasoning. Its argument that
a ledger "would have to be right about creation, deletion, column addition,
column removal and row counts independently, each silently wrong until some plan
exercised it" is an argument against a ledger written a SECOND time, beside a
fold that already knows all five. It is not an argument against deriving the
ledger FROM the fold. Under decision 1 there is no independent correctness to
maintain: if the effect model is wrong about column addition, `fold_ops` is
wrong about column addition, and that is caught by the existing snapshot corpus
rather than by waiting for a plan to exercise it. The shipped reasoning is sound
given today's architecture and is the right call for the change that shipped. It
is not sound as a permanent objection.

## F. Consistency with `pluggable-backends.md`

Agreements, and they are structural rather than incidental:

- That proposal's pipeline already places FOLD as the one interpreter and names
  `state_at(N)` as the source of plan preflight
  (`pluggable-backends.md:96-112`). This proposal is that box.
- Its `VendorFacts` side table (`264-279`) is what makes decision 2 possible;
  without it `SchemaModel` cannot be neutral.
- Its derived-equality position (`277-279`) is section D, in more detail.
- Its step 3 ("move spelling into per-backend modules") and this proposal's fold
  unification share a dependency, which it already flags at `318-320`. Agreed:
  sequence them together.

One TENSION, stated rather than smoothed over.
`pluggable-backends.md:23-26` asserts the dialect boundary is crossed in exactly
two directions, and `175-179` that core has NO dialect knowledge. The
precondition phase that shipped hours ago violates that. `apply/plan_precondition.rs`
contains no `SqlDialect` reference and no dialect gate of its own (grepped:
zero hits for `SqlDialect`, `Postgres`, `dialect`), yet
`sql_clears_no_obstruction` parses every prefix step's `up` with PostgreSQL's
parser. It is core code holding a vendor parser and applying it dialect-blind.

Being precise about severity, because it matters: this is LATENT, not live. The
only obstruction precondition the engine stamps is gated to PostgreSQL at
`render/lower.rs:5361` ("PostgreSQL is the only backend with this evaluator"),
and `plan_declares_hoistable_shape` (`plan_precondition.rs:198`) skips the whole
phase when no obstruction precondition is present. So on SQLite and MySQL the
parser is not reached today. But the invariant is enforced by a dialect check
five thousand lines away in a different module, not by the boundary. A second
backend that stamps an obstruction precondition reaches it immediately.

Decision 7 resolves the tension in the direction `pluggable-backends.md` wants:
effects come from ops, above the boundary, so core never parses SQL and
`pg_query` leaves `apply/` entirely.

No contradiction found on the frozen wire format. Nothing here renames or
restructures an op field, and `Op::Dialectal`'s `pg` / `sqlite` / `mysql` legs
are untouched. The fold consumes them through the existing
`flatten_dialectal_ops` path, which two of the four current replays already use
correctly (`docs/review-log.md:18524-18583`).

## G. Implementation sequence

A 146k-line engine with deployed journals cannot take this as one change. Each
step below leaves the tree green and is independently valuable, and the ordering
is chosen so that the risky step is last and the safety net is first.

1. **A differential corpus, against today's walkers.** Record N op streams,
   replay each through all four of `fold_ops`, `fold_to_field_defs`,
   `authoring_tables_from_ops`, `runtime_metadata_from_ops`, and assert what each
   produces. This does not fix anything. It makes every later step falsifiable,
   and it is the mechanism the review log used by hand for every row in section
   B. Precedent: `tests/dialect_table_faithfulness.rs` already proves a
   generated table faithful to a live decision function.
2. **`SchemaModel` plus derived `PartialEq`, and `VendorFacts`.** Shared with
   `pluggable-backends.md` step 2. No consumer moves. The hand-written `eq`
   impls stay on `ColumnSnapshot` until step 4.
3. **The fold, proven equal before it is used.** Write `fold(ops) ->
   SchemaModel` and the four projections. Gate: every projection must reproduce
   its current walker byte-for-byte on the step 1 corpus. Where they differ, the
   difference is a section B defect and is triaged individually. This step ships
   with the new fold DEAD, reachable only from tests.
4. **Move consumers one at a time**, in this order, chosen by blast radius
   ascending: `runtime_metadata_from_ops` (one artifact, no DDL);
   `authoring_tables_from_ops` (one artifact, no DDL); `fold_to_field_defs`
   (two consumers, and one of them is SQLite REBUILD DDL, so it is third);
   `fold_ops` (drift and the MySQL expected-state, so it is last). Each move
   deletes a walker. Named comparators replace the exclusion lists here.
5. **Effects, over the fold.** Add `Effect` per step and `state_at(N)`. Replace
   `sql_clears_no_obstruction` with the op-derived test and delete `pg_query`
   from `apply/plan_precondition.rs`. Keep `answerability()`, redrawn per section
   E. The three preview `advance_*` helpers collapse into `state_at(N)` here.
6. **Existence assertions become hoistable.** Only after step 5 has run in
   production long enough to trust `state_at(N)`. This is the only step that
   grants a NEW capability, and it is the only one that can refuse a plan that
   previously applied, so it goes last and behind a flag.

Steps 1 through 3 change no behaviour at all. Step 4 is where value lands.

## H. Required test matrix

- **Differential replay.** The step 1 corpus, every stream through every
  projection, asserted per projection. This is the gate on steps 3 and 4 and it
  is not optional.
- **Artifact agreement.** One `renderArtifacts` call, both artifacts, asserted to
  describe the same column identically. The log calls this "a contract nothing
  enforces in general" (`docs/review-log.md:24103-24106`); this makes it
  enforced. It would have caught divergence 2 in section B directly.
- **Op exhaustiveness.** A test that fails when `Op` gains a variant the fold
  does not handle. Today the failure mode is a silent `_ => {}` in five places.
- **Rename carrier sweep.** For every carrier that can spell a column name
  (generated expressions, inline CHECK bodies, FK definitions, index name lists,
  index predicates, index expressions, exclusion constraints, composite PK
  definitions), a rename must follow it. Section B shows four found one at a time
  and four still open at `docs/review-log.md:6837-6847`.
- **`state_at(N)` against a live server.** For a plan of N steps, apply steps
  0..N-1 for real, introspect, and assert the introspected model equals
  `state_at(N)`. This is the only check that proves the effect model rather than
  asserting it, and per the standing rule both the RED and the GREEN must run
  through the real path.
- **Preflight regression.** The five existing neuters N1 through N5
  (`docs/review-log.md:28820-28852`) must still fail exactly the tests they fail
  today, including `a_drop_behind_a_replaced_view_still_applies` for N3. If the
  op-derived test cannot reproduce N3's control, decision 7 is wrong and this
  proposal is wrong with it.
- **Checksum stability.** A recorded migration corpus must produce
  byte-identical checksums throughout. Shared with `pluggable-backends.md:331-333`.

## I. What this makes worse

Every real refactor has a cost. These are this one's.

- **The fold becomes a single point of failure.** Today a bug in
  `fold_to_field_defs` corrupts one artifact. After this, a bug in `fold`
  corrupts everything at once. The mitigation is that the surface is smaller and
  tested harder, but the blast radius per defect genuinely increases, and the
  first production defect after step 4 will be worse than any defect in section
  B.
- **Step 4 touches SQLite rebuild DDL.** `fold_to_field_defs` feeds
  `live.sqlite_schemas` (`engine.rs:396`, `engine.rs:618`), which drives the
  12-step rebuild. That is the most dangerous code path in the engine and it is
  the third consumer moved. It is ordered third rather than last only because
  `fold_ops` feeds drift AND the MySQL expected-state, which is worse.
- **`SchemaModel` will be pressured to grow.** Decision 2's bound is a
  discipline, not a compiler check. The first consumer that wants one more field
  will make a reasonable case, and the god-object arrives one reasonable case at
  a time. The `VendorFacts` side table absorbs the vendor pressure; nothing
  absorbs the neutral pressure except review.
- **Steps 1 through 3 deliver no user-visible value** and cost real time, which
  makes them the steps most likely to be truncated under pressure. Truncating
  step 1 specifically converts this from a refactor into a rewrite.
- **Section E step 6 can refuse plans that previously applied.** Hoisting
  existence assertions is a new gate. It fails toward over-refusal, exactly as
  the shipped phase does, and over-refusal is a production outage for the
  operator who hits it.
- **Most of section A is not addressed here.** This proposal unifies the four
  state-building replays that produce artifacts and snapshots. It leaves
  `lower_one_op` (the fifth full replay), all of Tier B, all of Tier C, and all
  22 of Tier D's validation walkers matching on `Op` independently. Decision 1
  says op SEMANTICS live in the fold; it does not claim 81 functions stop
  matching. Concretely: the retype-of-an-identity-column row in section B
  (validate, preview and the declarative differ all passed an op the server
  refuses) is a defect this proposal does NOT fix. That family needs a shared
  refusal vocabulary in the `Capability` style, which is a third proposal.
- **The declarative lane keeps a second op vocabulary.** `DiffOp`
  (`schema/diff.rs:89`) is a parallel stream with its own semantics, and
  `pluggable-backends.md:40-41` commits to keeping the two authoring lanes
  separate. So "one interpreter of what an op means" is true within the
  versioned lane and false across the product. That is a real limit on the
  claim, and it should not be oversold in review.

## J. What was verified, and what was not

VERIFIED by reading the tree at `7d27adcd`, file and line cited inline:
`Op`'s 56 variants (`awk` over `ir.rs:2837-3872`); `fold_to_field_defs` calling
and discarding `fold_ops` at `fold.rs:4431`; `advance_preview_table_presence`
handling only `CreateTable` and `Dialectal` with a `_ => {}`
(`sql_preview.rs:525-554`); both hand-written `PartialEq` impls and their exact
field lists (`snapshot.rs:711-724`, `1244-1251`); `TableSnapshot` not deriving
`PartialEq` (`snapshot.rs:1256`); `FieldDescriptor`'s DSL-token vocabulary
(`declarative.rs:1757-1804`); `CreateView`'s `replace: Option<bool>`
(`ir.rs:3401-3414`); `plan_precondition.rs` having zero `SqlDialect` /
`dialect` references while importing `pg_query::protobuf` (`:79-80`); the phase
call order at `engine.rs:2885-2889`; the PG gate at `lower.rs:5361`; the
`dialect-table.ts` generation header and its faithfulness test; the absence of
any op `switch` in `packages/*/src`.

VERIFIED by delegated sweep, spot-checked by me on the entries I cite: the Tier
A/B/C/D inventory, arm counts, catch-all counts, and consumer mapping in section
A. I independently confirmed the five full replays' file:line, the two catch-all
swallow counts, and the three duplicate dialectal leg selectors.

VERIFIED by reading `docs/review-log.md`: every row and line number in section
B, and the quoted passages in sections C, D and E.

CORRECTED during drafting, recorded because the errors are instructive: I first
listed `apply/plan_precondition.rs` and `render/declarative.rs` as op-stream
interpreters. Both are false. The first walks `&[PlanStep]`; the second uses the
separate `DiffOp` type. Two of the brief's own framings inherit the same error.

NOT VERIFIED, and flagged as such:

- **Nothing was compiled or executed.** This is a docs-only change; no `cargo`
  or `pnpm` command was run, by instruction. Every claim is from reading source
  and the log.
- **That one `SchemaModel` can actually carry the union of `ColumnSnapshot` and
  `FieldDescriptor` facets without loss.** Section C argues it from the two
  types' field lists and vocabularies. It is not proven, and
  `pluggable-backends.md:339-342` correctly calls it UNVERIFIED. Step 3's
  byte-for-byte gate is what would prove or refute it, and it is placed there
  deliberately.
- **The interpreter count is a floor, not a ceiling.** It comes from grepping
  `Op::` across `crates/*/src` with `cfg(test)` excluded. A walker that reaches
  ops without naming a variant (through a helper, or over a `serde_json::Value`)
  would be missed. The Tier C and D counts in particular were not individually
  read by me.
- **Whether `state_at(N)` is cheap enough** to evaluate per step on a large
  schema. Never measured. If it is not, decision 8 needs incremental effects
  rather than a refold, which is an implementation detail but not a free one.
- **The MySQL expected-state consumers.** Six `fold_ops` call sites in
  `apply/backend/mysql/mod.rs` were counted but not read. They are the last
  consumer moved in step 4 and their requirements are unmeasured.
- **The node host's four state advances** (`node/src/lower.rs:438,1019,1399,1592`)
  were inventoried but not read. They consume `fold_ops_onto` for rollback and
  inverse recovery, so step 4's final move touches them and this proposal has no
  measurement of what they need.
