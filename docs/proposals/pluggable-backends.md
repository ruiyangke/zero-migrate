# Pluggable backends proposal

Status: Draft
Date: 2026-08-17

This proposal defines the final-state architecture for supporting many database
backends in zero-migrate, where adding or removing one is a crate plus a feature
flag rather than an edit to the core.

The central design rule is simple:

> A backend owns its own SQL. The core owns none.

Today the core owns most of it. The SQL spelling for all three dialects lives in
`crates/zero-migrate/src/render/`, while execution lives in
`crates/zero-migrate/src/apply/backend/`. Those are two halves of one vendor,
kept in two places, and the seam between them is not the seam a plugin needs.

## Proposed decisions

1. A backend is a CRATE. It owns its SQL rendering, its catalog introspection,
   and its execution, together.
2. The dialect boundary is crossed in exactly TWO directions: a neutral
   `ChangeSet` goes down into `render`, and a vendor catalog comes up through
   `introspect` as a neutral `SchemaModel`. Nothing else in the core knows a
   dialect exists.
3. Dialect identity becomes an opaque `DialectId`, not a closed enum. The four
   dialect enums and the `u8` dialect bitset are replaced.
4. Capability questions are answered by a `BackendDescriptor`, not by matching
   on a dialect. The existing 25-predicate `Capability` matrix is promoted from
   `pub(crate)` to public vocabulary.
5. Backend selection is COMPILE TIME, by cargo feature. There is no runtime
   plugin loading and no `dyn` dispatch on the rendering path.
6. Vendor-specific facts live in a side table keyed by `(table, column)`, never
   as fields on the shared model.
7. `Op::Dialectal`'s existing `pg` / `sqlite` / `mysql` legs are FROZEN
   permanently. A new `DialectId`-keyed variant is added alongside them.
8. A backend is defined by the conformance suite it passes, not by the trait it
   implements. `zero-migrate-conformance` is the contract.
9. The two authoring lanes (declarative descriptors, versioned IR) are NOT
   merged. They converge on one fold and one renderer, and stay two lanes.
10. `MigrationBackend` is not redesigned first. It is the last thing touched,
    because it is not where the defects are.

## Goals

- Adding a backend requires: one new crate, one feature flag, zero edits to
  `zero-migrate-core` or `zero-migrate-ir`.
- Removing a backend requires: turning off a feature. The build stays green.
- A backend author can tell whether they are done, mechanically, by running the
  conformance suite.
- Core code cannot silently acquire dialect knowledge, because there is no
  dialect type in scope to match on.

## Non-goals

- Runtime loading of backends from shared libraries. Rust has no stable ABI, and
  a migration engine does not need to discover a driver at runtime.
- Supporting every backend equally. A backend declares what it cannot do and is
  refused cleanly for those ops; it does not silently approximate them.
- Merging the declarative and versioned authoring lanes.
- A universal SQL dialect. The core emits no SQL at all.

## What blocks this today, measured

Originally verified against `main` at `01385061`. **RE-MEASURED since, and two rows
have closed.** The status column is the current answer; the original claim is kept
so the record shows what moved rather than quietly rewriting itself.

| blocker | where | status |
|---|---|---|
| closed dialect enums | `ir/dialect.rs`, `ir/validate.rs`, `render/step.rs` | **THREE, not four.** `node/verbs.rs` no longer declares one. The rest still block a plugin from adding a variant to a crate it does not own. |
| `DialectSet(u8)` | `ir/dialect.rs:162` | **CLOSED.** Now `DialectSet(Cow<'static, [DialectId]>)`. The fourth-backend cap is gone. |
| spelling separated from execution | `render/` vs `apply/backend/` | **UNCHANGED, still exactly 137** `crate::render` references from `apply/backend/`. |
| `Capability` is private | `zero-migrate-ir/src/backend.rs:44` | **CLOSED.** `pub enum Capability`, promoted to public vocabulary alongside `CapabilitySet(u64)` and `BackendDescriptor`. |
| vendor fields on shared structs | `model/snapshot.rs:136,174,197,215` | **UNCHANGED.** `sqlite_rowid` plus three `mysql_*` fields, exactly as originally counted. |
| dialect names in the wire format | `Op::Dialectal` | **UNCHANGED BY DESIGN.** Decision 7 freezes the `pg`/`sqlite`/`mysql` legs permanently; the `DialectId`-keyed variant is additive. |

### Blockers this proposal did not know about, all measured since

| blocker | evidence |
|---|---|
| **CORRECTED: core looks vendors up BY DIALECT, from inside core — but it is TWO registries in different states, and 42 lookups, not ~55 call sites** | The cycle is real: core depends on the backend registry while backends depend on core, and an extraction spike compiled only by stubbing that arm with `panic!`. The SIZE and the SHAPE were both wrong. Measured at `30ca3b06`: a raw `grep -rn 'renderer('` over `src/` returns **65** occurrences, of which **42 are production lookups**. The other 23 are 2 registry definitions, 5 grep false positives (3 doc lines in `render/renderer.rs`; the test fn names `dispatch_returns_expected_dml_renderer` and `dispatch_returns_expected_schema_renderer`, both of which contain the search string), and 16 calls inside test modules (13 in `schema/query.rs`'s `schema_renderer_tests`, which spans 417–522, plus 3 in `backends/mod.rs`'s own unit test). The four numbers reconcile exactly: 42 + 2 + 5 + 16 = 65. **The 42 split across TWO registries whose extraction states are not comparable.** (1) `render::backends::renderer -> &dyn DmlRenderer`, **33** lookups (`dml` 24, `lower` 7, `value_format` 2) — its vendors are ALREADY extracted, one module per dialect, and the crate move is the `git mv` that module's header describes. (2) `schema::query::renderer -> &dyn SchemaRenderer`, **9** lookups (`schema/query.rs` 8, `existence_probe` 1) — its vendors are **not extracted at all**: the trait, the three unit structs, the three impls, the three statics and the dispatch match all live in `schema/query.rs` **103–415**, in the same 6194-line file as 8 of its 9 consumers. For that half, inversion is not the next step; **extraction is**, and there is nothing to invert until the vendors have somewhere to be. |
| **the 42 lookups are not 42 decisions, and the blocking unit is the LOOKUP, not the call site** | They sit in **31 distinct host functions** (`dml` 19, `schema/query` 5, `lower` 5, `value_format` 1, `existence_probe` 1), most of them one-line forwarders — `render::dml` is largely a second dispatch layer over the first. **Every one of the 42 already has the dialect in scope**, as an explicit `dialect: SqlDialect` parameter, as `ctx.dialect`, or as `self.dialect` on `IrAuthor`. Not one site has to DISCOVER a dialect, so no site needs a new plumbing path; the inversion is a signature change at each host, not a data-flow problem. Only **3 of the 31 hosts are `pub`** — `dml::placeholder`, `schema::query::def_to_column_type_for_dialect`, `schema::query::build_create_table_with_fks_for_dialect_scoped_statements` — and that asymmetry is the whole public-API cost. `schema::query` is a `pub mod` and `SchemaRenderer` is already `pub`, so pushing a `&dyn SchemaRenderer` down adds NO surface. `render::renderer` is `pub(crate)`, so pushing a `&dyn DmlRenderer` into `pub fn dml::placeholder` would force the would-be `zero-migrate-backend` contract to become public API of the facade. |
| **one of the 42 was not a vendor decision at all, and deleting it removed ZERO lookups** | Classified by the spelling/semantics rule, **41 of the 42 are SPELLING**. The one exception was `DmlRenderer::validate_view_materialized`, whose three impls were byte-identical modulo their own `DIALECT` const: each read `DIALECT.supports(Capability::MaterializedView)` and built the CORE error `IrLowerError::ViewUnsupported`. That is a vendor being asked about ITSELF, from data core already holds — the capability matrix has lived in `zero_migrate_ir::backend` since it was promoted, and `DialectSupports` reads it with no backend dependency. It is now a plain dialect-parameterized fn in `render::lower`; `DmlRenderer` went 26 methods to 25. **The lesson is the negative result.** Removing it deleted two `renderer(dialect)` CALLS and zero `renderer(dialect)` LOOKUPS: both sites bind the renderer on the next line for sibling spelling methods, so `render::lower` still holds seven. Counting call sites overstates the cycle; only the lookups are cycle edges. Verified byte-identical: `--lib` 1232 / `authoring_surface` 143 / `dialect_matrix` 60 / `fold_offline` 37, all unchanged, with the control (an unconditional refusal in the moved fn) reddening 11 across three of those four binaries — so the green is load-bearing rather than blind. |
| **the "neutral" plan vocabulary carries vendor names** | `render/step.rs:51,53` — `RenameStep::PgExpandContract` and `RenameStep::SqliteRebuild`, matched at 203/204/234, with `step.rs:8` importing `SqliteRebuild` from the declarative renderer. `apply/backend/mod.rs:751` takes `spec: &SqliteRebuildSpec`. **The would-be CONTRACT crate carries SQLite types.** |
| **there are FIVE per-dialect stacks, not one** | `DmlRenderer` (25 methods, was 26 before the capability tautology below left it), `DdlEmitter` (6, inside `declarative.rs`), `schema::query::SchemaRenderer` (**7**, was 10, then 8), `MigrationBackend` (41), `CrossDeployObligations` (8). **UPDATED:** the first TWO now have their vendors in their own modules (`src/render/backends/` and `src/schema/backends/`) and both are guarded by the one-dialect test, which reads all six files. The remaining three are not extracted and not guarded. `SchemaRenderer`'s drop from 8 to 7 is `canonical_type` leaving: PostgreSQL's arm was the identity and the other two delegated to core folds, so it was a drift COMPARATOR rather than a spelling and became the dialect-parameterized `schema::query::canonical_type_for_dialect`. |
| **CORRECTED: `render/backends/` holds VIEW and TRIGGER DDL, but no TABLE/COLUMN/INDEX DDL** | The original row said "contains ZERO DDL", from `grep -c 'CREATE TABLE\|ALTER TABLE\|ADD COLUMN\|CREATE INDEX'` returning 0 in all four files. That count is right and the conclusion drawn from it is wrong: **the keyword list omitted VIEW and TRIGGER.** `backends/sqlite.rs:234` emits `DROP VIEW IF EXISTS {qname}`; `backends/mysql.rs` emits `CREATE TRIGGER` (:393), `DROP TRIGGER` (:275) and `DROP TRIGGER IF EXISTS` (:408). So the destination is **not** a void, and the DDL half of step 3 has a **precedent inside its own target directory** rather than no home at all. What is genuinely absent is table/column/index DDL. |
| **the DDL contract already exists — privately, in the wrong module** | `declarative.rs:9442` declares `trait DdlEmitter` (NOT `pub`) with six methods — `add_column`, `create_index`, `drop_table_up`, `rename_table`, `drop_column_up`, `drop_index_up` — and three impls: `PgEmitter` (:9508), `SqliteEmitter` (:9731), `MysqlEmitter` (:9875). Every reference to it outside `declarative.rs` is a DOC COMMENT (`lower.rs:16`, `fold.rs:4398`, one test comment); **no code outside that module uses it.** So "moving DDL means designing a DDL backend contract" overstates the work: a six-method contract with three vendor impls is already written and already self-contained. It is missing `CREATE TABLE`, which is emitted outside the trait. |
| **the fold is dialect-aware throughout, not at five SQLite sites** | This proposal places the fold in core with "NO dialect knowledge". That is categorically false, not five sites off. `render/fold.rs` **production** code (lines 1-5798) carries **27 `SqlDialect::` occurrences over 26 lines** — 12 `Postgres`, 8 `Sqlite`, 7 `Mysql` — and **7 vendor-named production functions**: `reusable_postgres_primary_index` (919), `sqlite_integer_storage_for_rowid` (958), `sqlite_folded_rowid_generation` (969), `restamp_mysql_physical_types` (3403), `renders_the_same_mysql_type` (3442), `apply_fold_sqlite_rowid_metadata` (3448), `pg_type_data_type` (3983). It also calls per-vendor `declarative::` helpers for **all three** vendors: `sqlite_create_is_without_rowid` ×3 (988, 1091, 3472), `sqlite_inline_primary_key_is_desc` ×2 (989, 3473), and `stamp_mysql_physical_type` ×2 — so the earlier "reads SQLite DDL text" heading named the wrong scope as well as the wrong size. **Two measurement traps here, both of which produced wrong numbers first.** (1) A raw grep reports **59** occurrences / **54** lines; 32 of those occurrences are in the test module and are not refactor work — occurrences and lines are different numbers and were once conflated. (2) The first `#[cfg(test)]` in the file is at **line 93, sitting on a `use`**, not on the test module, which starts at **5799**. Truncating the file at the first `#[cfg(test)]` measures 92 lines and reports ZERO vendor-named functions. |
| **line 1 exists only for PostgreSQL** | `guard_for` maps BOTH `Sqlite` and `Mysql` to `SqliteDescriptorGuard`, whose `check` returns the EMPTY outcome by design — those engines are descriptor-only and their whole enforcement is line 2. The architecture diagram's uniform per-backend shape does not hold for the guard. |

There is one existing asset worth keeping: 99 `cfg(pg_seam)` gates already
establish compile-time seam gating as a pattern in this codebase. This proposal
generalizes that pattern rather than introducing a new one.

## The pipeline

```
  AUTHOR
  +----------------------------------------------------------+
  |  TS DSL    |    descriptors    |    raw SQL (AI author)   |
  +-------------------------------+--------------------------+
                                  |  IR envelope (Op[])
                                  v
  VALIDATE                                        refuse before anything runs
  +----------------------------------------------------------+
  |  wire contract + shape        (neutral)                   |
  |  capability check             (asks BackendDescriptor)    |
  +-------------------------------+--------------------------+
                                  v
  FOLD   <=== THE ONE INTERPRETER OF WHAT AN OP MEANS
  +----------------------------------------------------------+
  |  ops --> desired SchemaModel                              |
  |      --> Effect log (per step: adds / removes / changes)  |
  +-------------------------------+--------------------------+
                                  v
  DIFF                                    live SchemaModel ---+
  +----------------------------------------------------------+|
  |  desired  vs  live   -->  ChangeSet                       ||
  +-------------------------------+--------------------------+|
                                  v                           |
  PLAN                                                        |
  +----------------------------------------------------------+|
  |  steps + preconditions                                    ||
  |  state_at(N) from Effect log --> plan preflight           ||
  |  refuse the WHOLE plan, before step 0 commits             ||
  +-------------------------------+--------------------------+|
                                  |                           |
  ================================|===========================|=========
   DIALECT BOUNDARY               |                           |
   crossed in exactly two places  v                           |
  ================================|===========================|=========
                                  |                           |
  RENDER  (backend crate)         |            INTROSPECT  (backend crate)
  +-----------------------------+ |            +----------------------------+
  | render(ChangeSet, Descriptor)|<+            | vendor catalog             |
  |   --> statements             |              |   --> live SchemaModel ----+
  +--------------+---------------+              +-------------^--------------+
                 v                                            |
  GUARD                                                       |
  +----------------------------------------------------------+|
  |  parse + deny-list + schema confinement                   ||
  |  a denial aborts EVERY step, nothing commits              ||
  +-------------------------------+--------------------------+|
                                  v                           |
  EXECUTE  (backend crate)                                    |
  +----------------------------------------------------------+|
  |  lock --> journal --> txn --> apply --> release           ||
  +-------------------------------+--------------------------+|
                                  v                           |
  VERIFY ------------------------------------------------------+
     introspect back, compare against desired, record drift
```

## The architecture

```
              +--------------------------------------------------+
              |              zero-migrate (facade)                |
              |   #[cfg(feature = "postgres")] register(postgres) |
              |   #[cfg(feature = "mysql")]   register(mysql)     |
              |   knows WHICH backends exist, nothing about them  |
              +------------------------+-------------------------+
                                       | selects at compile time
       +-------------+-------------+---+---------+
       v             v             v             v
 +-----------+ +-----------+ +-----------+ +-----------+
 | -postgres | |  -mysql   | |  -sqlite  | |  -duckdb  |
 |           | |           | |           | |           |
 |  render   | |  render   | |  render   | |  render   |
 |  introsp  | |  introsp  | |  introsp  | |  introsp  |
 |  execute  | |  execute  | |  execute  | |  execute  |
 +-----+-----+ +-----+-----+ +-----+-----+ +-----+-----+
       |             |             |             |
       +-------------+------+------+-------------+
                            | implements
                            v
              +--------------------------------------------------+
              |             zero-migrate-backend                 |
              |   trait Backend                                  |
              |     introspect()          -> SchemaModel   (up)  |
              |     render(ChangeSet)     -> statements   (down) |
              |     execute(statements)   -> applied             |
              |   BackendDescriptor: capabilities + limits       |
              |   the CONTRACT only. no instances, no dialects.  |
              +------------------------+-------------------------+
                                       | uses
                                       v
              +--------------------------------------------------+
              |               zero-migrate-core                  |
              |   fold | effects | model | diff | plan           |
              |   guard | journal | lock | drift                 |
              |   NO dialect knowledge. NO SQL spelling.         |
              +------------------------+-------------------------+
                                       | uses
                                       v
              +--------------------------------------------------+
              |                zero-migrate-ir                   |
              |   Op | Expr | Precondition | Checksum            |
              |   DialectId  (opaque id, NOT a closed enum)      |
              +--------------------------------------------------+

              +--------------------------------------------------+
              |            zero-migrate-conformance              |
              |   the definition of "this is a backend".         |
              |   CI runs it once per enabled backend, plus      |
              |   differential: same ops -> all backends ->      |
              |   compare resulting semantics.                   |
              +--------------------------------------------------+
```

## `DialectId`

> **STATUS: SHIPPED.** Measured at `6ef41290`. This whole section reads as future
> tense for code that already exists, in `851066d9`, `1b19e647` and `0417c340`.
> `DialectId` is at `zero-migrate-ir/src/dialect.rs:89` with exactly the shape below,
> plus `is_well_formed()` — which this section's own validity rule requires and the
> code block omits. `BackendDescriptor` is at `backend.rs:224` with exactly the four
> proposed fields. `Capability` is promoted, same 25 predicates, with a re-export
> shim at `render/renderer.rs:62` so in-crate uses needed no edit.
>
> **What actually remains of step 2 is ~40 sites, not the 108 the match census
> suggests** — see the correction at the end of this section. The 108 is step 3 and
> step 4's size, not step 2's.

`DialectId` is an opaque, cheaply copyable identity with a stable string name.
It is NOT an enum, and core code cannot exhaustively match it.

```rust
#[derive(Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub struct DialectId(&'static str);

impl DialectId {
    pub const fn new(name: &'static str) -> Self { Self(name) }
    pub const fn as_str(self) -> &'static str { self.0 }
}
```

Each backend crate declares its own:

```rust
pub const POSTGRES: DialectId = DialectId::new("postgres");
```

`DialectSet(u8)` becomes a set over `DialectId`. The cap disappears with it.

**Correction, measured.** An earlier draft of this document called that a "hard
cap of EIGHT backends, three bits used", reasoning from the `u8`'s width. That is
wrong, and wrong in the generous direction. `DialectSet` names exactly three bits
(`POSTGRES 0b001`, `SQLITE 0b010`, `MYSQL 0b100`), and both of its entry points -
`from_bools(postgres, sqlite, mysql)` and `contains(dialect: Dialect)` - are keyed
to the closed three-variant `Dialect` enum. The five spare bits are unreachable
because nothing can name them. The real limit is THREE, and a fourth backend does
not "work until the ninth"; it cannot be expressed at all.

The error shape is worth keeping: a type's WIDTH was reported as the system's
LIMIT without checking what could actually name a slot. The same mistake produced
the "one dispatch point" claim in the guard section above.

### Representation: a static string, decided

`DialectId` wraps `&'static str` and not an interned integer. It is the simplest
thing that works, it gives `Debug`, serialization and error messages for free,
and it needs no central name table, which is the whole point: a backend crate
declares its own id without asking anything to register a number for it.
Interning to a `u16` is a later optimization, and only if dialect comparison
ever appears in a profile. It should not - comparisons happen per rendered
statement, not per row.

Equality, ordering and hashing are by CONTENT (`str` semantics), not by pointer,
so two crates spelling `"postgres"` are the same dialect. That is the desired
behaviour and it is also the risk below.

### What the string gives up, and the rule that covers it

A closed enum made identity unique BY CONSTRUCTION. Strings do not: nothing
structurally stops two backends from both claiming `"postgres"`, or one claiming
`"postgresql"` while the dialect table says `"postgres"`. A silent collision
would be worse than the enum ever was, because two backends would quietly share
capability rows and dialect-table entries.

So the id carries a validity rule, enforced at registration rather than trusted:

- lowercase ASCII, `[a-z][a-z0-9_]*`, no aliases and no display names
- the facade REFUSES to build a registry containing a duplicate id, and this is
  a hard error naming both crates, never a last-one-wins
- the conformance suite asserts that a backend's declared id matches the id its
  dialect-table rows are filed under

The registry check is cheap and runs once. Skipping it trades a compile-time
guarantee for nothing.

### SHIPPED — two of the three clauses. The third is not missing, it is NOT YET EXPRESSIBLE.

`BackendRegistry` exists (`zero-migrate-ir/src/backend.rs:407`), built fallibly with
**no `insert`** — deliberately, because a registry that could grow after validation
would let a duplicate in behind the check. `RegistryError` carries both demanded
arms: `MalformedId` (enforcing `[a-z][a-z0-9_]*` via `DialectId::is_well_formed`) and
`DuplicateId`, which **names both registrants** rather than last-one-wins.
`zero-migrate-ir/tests/backend_registry.rs` proves it with a nine-backend registry, a
duplicate refusal, a malformed-id refusal, a prefix-collision over-refusal control,
and a positive control that the shipping registry builds.

**The third clause — "the conformance suite asserts that a backend's declared id
matches the id its dialect-table rows are filed under" — has no target.**
`model/dialect_table.rs` files rows as three STRUCT FIELDS (`postgres`, `sqlite`,
`mysql` on `DispositionRow`), dispatched by a closed `Dialect` match. There is no
id-keyed row to compare a declared id against. Both in-crate facades
(`render/backends/mod.rs:205`, `schema/backends/mod.rs:114`) dispatch on `SqlDialect`,
not `DialectId`, so neither can host the assertion until the table is re-keyed. That
is step-3 work, and this document should stop presenting all three clauses as one
deliverable.

### TWO LIVE ALIAS HAZARDS THE RULE ALREADY FORBIDS

**1. Two wire-spelling parsers in one crate, and only one goes through the registry.**
`zero-migrate-node/src/verbs.rs:59` resolves via `BackendRegistry::shipping()`.
`zero-migrate-node/src/api.rs:56 parse_dialect` matches **hardcoded string literals**
`"postgres" | "sqlite" | "mysql"`. That is exactly the `"postgresql"`-vs-`"postgres"`
divergence this section exists to prevent, sitting unenforced about 500 lines from
the parser that does it correctly. Routing it through the registry is one function.

**2. `pg` → `postgres` is a live alias in the generated pipeline.**
`packages/zero-migrate/scripts/gen-dialect-table.mjs` reads sidecar keys
`pg`/`sqlite`/`mysql` and emits Rust fields `postgres`/`sqlite`/`mysql`. The rule above
says "no aliases and no display names"; the generator has one.

The four existing enums are removed in this order: `DialectScope` and
`ApplyDialect` are internal and go first; `Dialect` in `ir/validate.rs` folds
into `SqlDialect`; `SqlDialect` becomes a deprecated alias for `DialectId`
constants during migration and is deleted last.

### CORRECTION, measured at `6ef41290`: this ordering is stale on every clause.

**Neither `DialectScope` nor `ApplyDialect` was removed. Both were RESHAPED to carry
a `DialectId`, and both are finished.** `DialectScope::PgOnly` became
`Only(DialectId)` (`step.rs:19`), keeping `pg_only()` as a constructor; its one
exhaustive match is over `Portable`/`Only`, which is not a vendor axis and never
needs to change. `ApplyDialect` now carries a `DialectId` per variant and its
`parse` resolves the wire spelling **through `BackendRegistry::shipping()`**. Its
own doc records that the variants stay deliberately, because `bridge.rs` selects a
concrete backend TYPE per arm and that dispatch must remain exhaustive until backend
crates exist.

Neither is "internal" either: `DialectScope` is re-exported at
`zero-migrate/src/lib.rs:367` and `ApplyDialect` at `zero-migrate-node/src/lib.rs:60`.

**The deprecated-alias step is UNNECESSARY and should not be done.** 0.1.0 was never
published, so there is no semver obligation to alias through — and the tree has
already chosen a better mechanism. `SqlDialect::id()` and `Dialect::id()` are `const`
and documented as **one-way ON PURPOSE**: *"an id does NOT convert back to a variant,
because that direction is exactly what a fourth backend cannot satisfy."* That is why
adding `DialectId` broke nothing. A `#[deprecated]` alias would add ~797 warning sites
and buy nothing; `SqlDialect` instead shrinks to a dispatch key and is deleted when
the last exhaustive match moves into a backend module.

**So the only live item in this sequence is `Dialect` → `SqlDialect`, and it is the
highest-leverage move left.** Measured: 8 of the 72 production `SqlDialect` exhaustive
matches are pure `SqlDialect` → `validate::Dialect` transliteration with identical
three-arm bodies (`lower.rs` 877, 950, 3336, 3385, 3842, 6768, 9503 and
`sql_preview.rs:412`). Folding deletes those 8 outright plus `Dialect`'s own 31, a net
**−39 production exhaustive matches** for a mechanical rename. Both enums are already
`{Postgres, Sqlite, Mysql}` with identical `.id()` bridges, and `Dialect::as_str()` is
already *defined as* `self.id().as_str()`.

### The 108 is not step 2's size

Vendor-keyed exhaustive matches, production: `SqlDialect` 72, `Dialect` 31,
`ApplyDialect` 5 — **108**, plus **156 boolean dialect gates**
(`matches!(.., SqlDialect::X)`, `== SqlDialect::X`). Every one stops compiling the
moment a fourth backend exists, because `DialectId` cannot be exhaustively matched.

**But that is step 3 and step 4's size, not step 2's.** Those sites are dialect
SPELLING and GATING, which this document already assigns to per-backend modules.
What remains of step 2 proper is roughly 40 sites: the `Dialect` fold, deleting
`DialectSet::contains(Dialect)` (**zero callers** — the last closed-enum tie on the
type, free to remove), and routing one parser through the registry (below).

## `BackendDescriptor` and capability

Core never asks "which dialect is this". It asks "can you do this".

```rust
pub struct BackendDescriptor {
    pub id: DialectId,
    pub display_name: &'static str,
    pub capabilities: CapabilitySet,
    pub limits: Limits,
}

pub trait Backend {
    fn descriptor(&self) -> &BackendDescriptor;

    // UP: vendor catalog -> neutral model
    async fn introspect(&self, scope: &Scope) -> Result<SchemaModel, BackendError>;

    // DOWN: neutral change set -> vendor statements
    fn render(&self, change: &ChangeSet) -> Result<Vec<Statement>, RenderError>;

    // execution
    async fn execute(&self, plan: &ExecutionPlan) -> Result<Applied, BackendError>;
}
```

The current `MigrationBackend` has 40 methods, 30 of them required. Most are
execution mechanics (lock, journal, session, contracts) that belong in a shared
`ExecutionHost` the backend composes rather than reimplements, and several are
one vendor's concept in everyone's interface (`rebuild_one` is SQLite's 12-step
rebuild, `column_type_change_blockers` is a `pg_depend` walk). The final-state
trait is small because the union-of-vendors methods become either capability
answers or backend-internal detail.

`Capability` is promoted from `render/renderer.rs` unchanged in spirit. A
capability is a QUESTION CORE ASKS, never a vendor name. Adding a capability is
a core change and should be rare; adding a backend is not a core change at all.

## The guard

The SQL security guard is `pg_query`-backed, which makes it PostgreSQL-specific
machinery. It moves into `zero-migrate-postgres`. The seam it moves behind ALREADY
EXISTS: `apply/executor.rs:1118` calls
`guard::guard_for(&cfg.guard_config().for_dialect(backend.dialect()))`, and the
crate already ships `PgGuard`, `SqliteDescriptorGuard` and a MySQL posture that
rejects raw SQL outright (`GuardError::MysqlRawSqlRejected`, at
`guard/mod.rs:1223` and `:1308`). This decision moves the implementations into
the crates that own them; it does not invent a mechanism.

**Correction, measured.** An earlier draft of this section said "three dialects,
three postures, ONE dispatch point". The posture count is right; the dispatch
count was not. There are TWO call sites, `executor.rs:1118` AND
`executor.rs:1453`, and step 3 must move both. The error is worth recording
because of its shape: "one dispatch point" was the first grep hit reported as a
count. A count belongs in this document only after it has been grepped for.

But the guard is a SECURITY boundary, so what moves and what stays are not the
same question.

**Stays in core, in a neutral `zero-migrate-guard` contract crate:**

- the `Guard` trait and the statement-classification vocabulary
- the PROPERTIES every guard must enforce: no cross-schema reference, no
  file/network access, no privilege escalation, deny-by-default on a statement
  the guard cannot parse
- the enforcement that a guard RAN. Core calls it unconditionally, before any
  `up` reaches a server, and a backend cannot opt out.

**Moves to the backend crate:**

- the parser and the deny-list implementation. `libpg_query` moves with
  `PgGuard`, which is a concrete win: a SQLite-only or DuckDB-only build stops
  carrying a C dependency it never uses. The guard crate's own manifest already
  calls itself "the ONLY owner of that C dep on the non-SQLite path", so the
  dependency is already understood to be vendor-scoped.
- the dialect's posture on raw SQL. MySQL rejecting raw SQL outright is a
  legitimate posture, not a missing guard, and it should be declared as such
  rather than read as absence.

**The rule that keeps this from weakening security:** a backend does not get to
be trusted about its own guard. NO GUARD MEANS NO SHIP - a backend without one
fails conformance and cannot be registered. Conformance runs a corpus of
known-hostile statements against every backend's guard and requires denial;
this is the same "a declaration must be proven honest rather than trusted" rule
`backend-conformance.md` applies to capabilities.

**Two more `pg_query` users sit in core and must move with it.**
`apply/precondition.rs` is already documented as the Postgres precondition
implementation and is reached through the backend seam, so it moves as-is.
`apply/plan_precondition.rs` is harder: it holds a PostgreSQL parser with no
dialect gate of its own, protected only by a check about 5,000 lines away in
`render/lower.rs`. See `single-fold-and-effects.md`, which argues that a real
effect model retires that parser entirely rather than relocating it - the fact
it recovers by parsing rendered SQL (whether a view is `CREATE OR REPLACE`) is
already a named field on the op, `Op::CreateView.replace`. Retiring beats
moving. If the effect model does not land, the parser moves to
`zero-migrate-postgres` and core keeps only the verdict.

## Vendor facts

`ColumnSnapshot` today carries `sqlite_rowid` and three `mysql_*` fields, and its
hand-written `PartialEq` exclusion list has already blocked a fix. In the final
state the shared model is neutral and vendor facts live beside it:

```rust
pub struct SchemaModel {
    pub tables: BTreeMap<String, Table>,
    pub vendor: VendorFacts,   // keyed by (table, column) -> opaque per-backend blob
}
```

Equality is DERIVED on the neutral model. "What counts as equal for this
purpose" becomes an explicit per-consumer comparator, not one hand-maintained
`eq` every consumer silently inherits.

## Wire-format constraint

`Checksum::of_ir` folds each op's RFC 8785 (JCS) bytes, and JCS sorts and emits
object keys. Field names are therefore INSIDE every deployed migration's
identity checksum.

Consequences, and they are not negotiable:

- `Op::Dialectal { default, pg, sqlite, mysql }` keeps those legs FOREVER.
  Renaming or restructuring them changes the checksum of every migration that
  uses one, and breaks drift/tamper detection against deployed journals.
- A new variant, keyed by `DialectId`, is added alongside. Adding an
  `Option` field with `skip_serializing_if` is additive and checksum-neutral,
  because an absent field contributes no bytes.
- The binding constraint here is DEPLOYED JOURNALS, not the npm package. A
  pre-publication argument does not license breaking it.

## Implementation sequence

The order matters more than the destination. Each step is independently
valuable and leaves the tree green.

1. **Conformance suite, against the three existing backends.**
   Defines "a backend is done" and is the safety net every later step needs.
   Independent of everything else. See `backend-conformance.md`.
2. **`DialectId` plus public `BackendDescriptor`.**
   The existing enums become thin wrappers, so nothing breaks yet. Delete
   `DialectSet(u8)`'s cap. Promote `Capability`.
3. **Move spelling into per-backend modules, inside the current crate.**
   A directory move, not a crate boundary. **Move by MODULE, not by trait, into
   `render/backends/<vendor>/` DIRECTORIES** — see the correction below.
4. **Extract the crates.**
   **NOT mechanical. Six prerequisites, listed below.**

Doing 4 before 3 is the trap: crates that still reach into core for their own
SQL are worse than one crate. **Measured, that trap is worse than stated: an
extraction can compile happily around vendor code that stayed in core, so
extraction-first ships a FALSE GREEN rather than an obvious failure.**

### CORRECTION: "roughly 280 dialect decision points" does not measure spelling

That number counts how often code **names a vendor**. It is dominated by
provenance (a `dialect:` field in an error), own-dialect arguments to core
helpers, and capability self-queries. **It is not a measure of how much SQL
spelling there is, and sequencing by it is wrong.** Measured per file:

- `renderer.rs`: **0 of 42** production literals were spelling. 18 own-dialect
  helper arguments, 14 provenance, 7 capability self-tautologies, 3 registry.
  That file was a DESTINATION, not work.
- `dml.rs`: **36 of 53** code literals WERE spelling (68%). Of 221 raw matches,
  168 were in the test module.
- `declarative.rs`: 96 executable literals, but the vendor knowledge lives in
  **71 vendor-NAMED FUNCTIONS**, which a literal census cannot see at all.

**Census each file before moving it.** A refutation of one file is not a
refutation of the file set, and the headline number answers neither question.

#### Whole-file census, measured at `7ca23cdc`

Production means "outside every `#[cfg(test)] mod`". Every row was checked two
ways: production + test must equal a raw `grep -o 'SqlDialect::' | wc -l`, and no
`#[test]` attribute may fall outside a detected test module.

| file | lines | **production** | of which PG / SQLite / MySQL | test-module |
|---|---|---|---|---|
| `render/lower.rs` | 16,996 | **111** (107 lines) | 40 / 32 / 39 | 156 |
| `render/declarative.rs` | 11,773 | **103** (101 lines) | 32 / 35 / 36 | 35 |
| `render/fold.rs` | 10,099 | **27** (26 lines) | 12 / 8 / 7 | 32 |
| `schema/query.rs` | 6,112 | **25** (22 lines) | 8 / 8 / 9 | 60 |
| `render/dml.rs` (step 3 DONE) | 4,620 | **23** (23 lines) | 7 / 6 / 10 | 176 |

Two things fall out of this that change sequencing. **The test modules hold most
of the raw matches** — `dml.rs` is 176 of 199 and `query.rs` 60 of 85 — so any
census that greps a whole file overstates the work by multiples. And **density,
not file size, is what matters**: `lower.rs` is 44% larger than `declarative.rs`
and carries only 8 more production literals, so `declarative.rs` is the denser
target despite being the smaller file.

#### The DDL half of step 3, sized

Same discipline, different pattern: string literals that **begin** with a DDL
keyword (`CREATE TABLE`, `ALTER TABLE`, `CREATE INDEX`, `DROP TABLE`, `DROP INDEX`,
`CREATE VIEW`, `DROP VIEW`, `CREATE TRIGGER`, `DROP TRIGGER`), counted outside test
modules, measured at `7255bd3c`.

| zone | production DDL emission sites |
|---|---|
| `render/backends/` — the step-3 destination | **4** (view + trigger, all three vendors) |
| `apply/backend/<vendor>/` — already correctly partitioned | **51** |
| **core — the actual step-3 work** | **103** |

Of the 103 in core, **`render/declarative.rs` holds 57 (55%)**. `render/lower.rs`
holds **2** — despite being the largest file in the tree at 16,996 lines and
carrying the most dialect literals. **Size and dialect-literal density do not
predict DDL emission**, so the DDL half must be sequenced by this census and not by
either of the other two.

Four files are EXCLUDED because the instrument refused them rather than guessing
(`guard_vendor_lower_tests.rs`, `support_matrix.rs`, `fold_projection_equality.rs`,
`differential_corpus.rs` — each has `#[test]` outside any detected test module).
They are named here rather than silently dropped; the 103 is a floor.

**Two rounds of this measurement were wrong before it settled, both overstating.**
A raw keyword grep across `src/` gave 315 core sites; excluding test modules cut it
to 85, because toy fixtures like `"CREATE TABLE a()"` in test code counted as
emission — `plan/manifest.rs` alone contributed 28 fixtures and **zero** real sites.
Requiring the literal to BEGIN with the keyword then corrected the other direction's
error: most remaining `declarative.rs` hits were ERROR MESSAGES that merely mention
DDL (`"SQLite primary-key rebuild of '{table}' could not parse its stored CREATE
TABLE body"`). Both mistakes inflated the apparent work, and both looked plausible.

#### The census instrument failed twice before it was believed, both times silently

Recorded because the failures are re-runnable by anyone who tries this again with
the obvious method, and both moved the number without emitting any error.

1. **"Production is everything before the first `#[cfg(test)]`" is wrong.** In
   `fold.rs` the first one is at line **93, sitting on a `use`**; truncating there
   measures 92 of 10,099 lines and reports ZERO vendor-named functions. In
   `declarative.rs` there are **eleven** such attributes — ten scattered test
   modules from 1971 to 11486 **and one on a function** (`fk_definition_pg`, 5292).
   Test code is interleaved with production code; there is no single boundary.
2. **Brace-depth counting is wrong**, because a per-line regex cannot lex Rust's
   multi-line raw strings (`r#"...{...}..."#`). The depth desynchronised and closed
   `lower.rs`'s test module 3,400 lines early, handing **62 of its 98 `#[test]`
   functions to the production count** — inflating `lower.rs` from 111 to 189. A
   patch to strip raw strings then made `query.rs` worse (105 stranded).

What works is closing a block by **indentation** — under `rustfmt` a block opened
at indent N closes at a line of exactly N spaces then `}` — which is safe here
only because `cargo fmt --all -- --check` is already a gate. The check that made
both failures visible is the cheap one: **assert no `#[test]` attribute lands
outside a detected test module.** Neither failure was found by inspection; both
were found by that assertion, and the first count in each case looked plausible.

### CORRECTION: step 4's premise is false today

*"Mechanical once step 3 is done, because the coupling is already gone"* was
tested by extracting `zero-migrate-sqlite` (12,187 lines moved; both crates
compiled) and then running, from inside the extracted crate:

```text
test extracted_sqlite_trigger_render_reaches_the_postgres_renderer ... ok
```

with the extracted crate's trigger output containing `<<PG_RENDERER_WAS_HERE>>`.
**If `-postgres` were a crate, `-sqlite` would need it at runtime to quote a
trigger identifier.**

Ordered prerequisites before step 4 is a `git mv` plus a `Cargo.toml`:

1. Finish step 3's DDL half. Extraction CANNOT REVEAL this coupling — the spike's
   crate left 47 SQLite-named items in core, including a 155-line `SqliteEmitter`
   and a 128-line `SqliteSchemaRenderer`. A `zero-migrate-sqlite` that does not
   contain SQLite. **NOW SIZED, AND IT IS NOT "MOVE THREE IMPLS".** 103 production
   emission sites in core, 57 in `declarative.rs`. Of those 57, measured against
   real block boundaries (`^impl` to the next column-0 `}`):

   | block | sites |
   |---|---|
   | `impl DeclarativeAuthor` (5991-9463) | **33** |
   | `impl DdlEmitter for PgEmitter` (9551-9676) | 8 |
   | `impl DdlEmitter for SqliteEmitter` (9774-9906) | 8 |
   | `impl DdlEmitter for MysqlEmitter` (9918-10004) | 7 |
   | elsewhere | 1 |

   **CORRECTION: the numbers above were produced by a BLIND INSTRUMENT.** They
   came from matching string literals that begin with a two-word DDL prefix
   (`CREATE TABLE`, `ALTER TABLE`, …). That pattern cannot see a literal whose
   keyword pair is split by an interpolation — **`"CREATE {unique}INDEX …"` is
   invisible to it** — and its keyword list omitted `RENAME TABLE` and
   `COMMENT ON COLUMN` entirely. Seven real emission sites were missed. This is
   the THIRD wrong DDL number this document has carried, and the third time the
   cause was a keyword list rather than a boundary: the same failure produced the
   "`render/backends/` contains ZERO DDL" blocker above.

   Use a **verb-anchored** pattern instead — a literal beginning with
   `CREATE|ALTER|DROP|RENAME|COMMENT|TRUNCATE`, interpolation tolerated anywhere
   after — and subtract ALTER-clause fragments (`"SET NOT NULL"`,
   `"DROP NOT NULL"`), which a verb anchor cannot distinguish from statements.
   Measured that way at `069d419a`, after `CREATE TABLE` moved into the contract:

   | block | sites |
   |---|---|
   | `impl DeclarativeAuthor` | **23** |
   | the three `DdlEmitter` impls | **31** (PG 10, SQLite 10, MySQL 11) |

   **The contract now carries 57%**, not the 40% first reported.

   ### The 33 were never one problem — five classes, and only 12 want a contract

   Measured by reading every site and tracing its gate:

   | class | sites | what it actually needs |
   |---|---|---|
   | **A. already covered** | 6 | nothing — call `drop_table_up`, which existed |
   | **B. genuine three-way statement** | 12 | the contract |
   | **C. statement identical, identifiers differ** | 3 | one helper, not a method |
   | **D. PostgreSQL-only, already gated** | 11 | a file |
   | **E. SQLite rebuild, no analogue** | 3 | a file, plus a public-API decision |

   Class A is done: six sites spelling `DROP TABLE` for a create-table `down` were
   byte-identical to a method that already existed. Class B is a third done
   (`CREATE TABLE` landed). **So prerequisite 1 is roughly a third the size this
   document claimed, and "contract-design question" is true of only 12 of the 33.**

   #### RE-MEASURED at `06b5aea8`: the contract work is DONE, and the census SCOPE is wrong

   Class-by-class at HEAD, using this document's own verb-anchored instrument:

   ```
     A. already covered        0   CONFIRMED done
     B. genuine three-way      0   NOT 12, NOT the corrected 9
     C. one helper             3   consolidated, CONFIRMED
     D. PostgreSQL-only       10   six of them are the out-of-scope partitions
     E. SQLite rebuild         2
     FK                        6   a DECISION, not a refactor
   ```

   **Class B is ZERO.** Four sites still carry a three-arm `match self.dialect`
   (`declarative.rs` 8339, 8572, 9169, 9192) and **none has three REACHABLE arms**:
   `SQLITE_CAPABILITIES` grants neither `AlterTableAddConstraint` nor
   `AlterTableDropConstraint`, so the SQLite arm is unreachable in every one. Three
   arms is not three dialects — the same reachability error this document already
   corrected once, still present in the corrected number.

   Class C also collapsed one site more than recorded: `alter_column_default_stmt`
   (`declarative.rs:8514`), which is not mentioned anywhere above.

   **But the census SCOPE is the real problem, and it under-counts by roughly 1,100
   lines.** Prerequisite 1 scopes itself to `render/declarative.rs`. Two vendor
   bodies live in core outside that file:

   - **`render/vendor.rs` — 814 lines, 26 verb-anchored DDL sites, 100% PostgreSQL,
     and ZERO `SqlDialect::` literals.** It is PostgreSQL by construction rather than
     by gate, so every dialect-match census is blind to it by design.
   - **`render/lower.rs:9681-9977` — ~297 lines of SQLite trigger spelling.**

   The second is not a new discovery; **the codebase already recorded it**.
   `render/backends/sqlite.rs:262-267` says so directly: the SQLite trigger spelling
   "still lives in `render::lower::render_sqlite_trigger_op` … This delegation is a
   POINTER to work that `lower.rs`'s own step-3 pass has to finish, not a boundary
   that is done." The same note puts PostgreSQL in the same position via
   `render::vendor`, and observes that only MySQL's trigger spelling actually lives
   in its backend module.

   That is the third time in this project a conclusion was already written down in a
   comment near the code before anyone measured it. Grep the tree's own confessions
   before trusting a census.

   #### CORRECTION: Class B was 12 by a REACHABILITY assumption, and it is 9

   The class table above was built by reading each site's `match self.dialect` and
   counting its arms. THREE ARMS IS NOT THREE DIALECTS. Re-measured site by site,
   nine of the twelve are not what the row says:

   | site | census said | measured |
   |---|---|---|
   | `lower_add_constraint` (2) | B — three-way | **C** — `ADD`/`DROP CONSTRAINT` is the identical keyword string on all three; only the two identifiers vary |
   | `lower_drop_constraint` (1) | B — three-way | **C** — same, and it held the SAME `match` as the add path, VERBATIM including comments |
   | `render_add_fk` (4) | B — three-way | **two-way**; the SQLite arm is DEAD |
   | `lower_drop_fk` (2) | B — three-way | **two-way**; the SQLite arm is already `unreachable!()` in the source |

   The three Class-C sites are now one `constraint_refs` + one
   `drop_constraint_stmt`, exactly as the Class C row prescribes.

   The six FK sites are NOT the contract's, and the reason is already written down
   elsewhere in this tree: `DeclarativeAuthor::qualified`'s header records a
   CONTROLLED measurement at `7ca23cdc` (assert-not-Postgres ⇒ 45 failures, the
   instrument fires; assert-Postgres ⇒ 3372 pass) proving no non-PostgreSQL dialect
   reaches it, and it names these very sites as the SQLite legs that would land
   there "if it were not for a capability gate several frames up"
   (`AlterTableAddConstraint` / `AlterTableDropConstraint` are both false for
   SQLite). `render_add_fk`'s SQLite `up` is not merely dead, it is INCOHERENT: the
   table reference is unqualified `sqlite_ident`, but `fk_clause` routes SQLite to
   `PgEmitter::fk_clause`, so the `REFERENCES` target comes back schema-qualified.

   So a `DdlEmitter::add_fk` / `drop_fk_up` pair grows the trait 7 → 9 with BOTH
   new methods answerable on `SqliteEmitter` only by `unreachable!()` — the same
   species as the all-33 contract this document rejected two paragraphs down, and
   the first break in the invariant that every one of the seven existing methods is
   genuinely answered by all three impls. **This is a decision, not a refactor**, and
   it belongs beside the two below rather than inside a routing change:

   3. **Does a `DdlEmitter` method get to be `unreachable!()` on an impl?** If yes,
      the six FK sites move behind the contract and step 4 gets six fewer dialect
      matches in core. If no, they stay as explicit `match self.dialect` routing in
      core, like `fk_clause` already is. Answering it also settles whether
      `render_add_fk`'s dead SQLite `down` should become `unreachable!()` to match
      `lower_drop_fk` — today it emits `"schema"."table"`, which on SQLite does not
      error, it SILENTLY no-ops.

   A contract covering all 33 was considered and REJECTED: it grows the trait to
   ~18 methods of which 11 could only be answered by `unreachable!()` on two of
   three impls, and it makes step 4 *harder* — `zero-migrate-mysql` would have to
   depend on `PartitionBounds` and `SqliteRebuild` to compile a trait it never
   uses. A contract whose implementors mostly panic is a dialect match with
   ceremony.

   ### The two long poles are DECISIONS, and they do not block on the contract

   Classes D and E are pure relocation. Neither needs design work; each needs one
   decision, and both can be taken in parallel with Class B:

   1. **The four partition renderers gate on a raw
      `matches!(self.dialect, SqlDialect::Postgres)` in core.** Moving them to
      `backends/postgres.rs` needs either a new `Capability::DeclarativePartitioning`
      — and `Capability`'s own doc says "keep this enum CLOSED… adding a capability
      is a core change and should be rare" — or leaving raw dialect matches in
      core, which contradicts `backend.rs`'s opening line, "Core never asks 'which
      dialect is this'."
   2. **Three `pub` vendor-named types force the Class E question:**
      `render::declarative::SqliteRebuild`, `render::plan::SqliteRebuildSpec`,
      `render::plan::SqliteSequencePolicy`. They are the ONLY vendor-named public
      items under `render/`. Step 4 either moves them into `zero-migrate-sqlite`,
      breaking every `zero_migrate::render::…` path that names them, or leaves a
      SQLite-shaped type in core's public API permanently.

      **RESOLVED, and TWO of this paragraph's claims were FALSE.**

      "The ONLY vendor-named public items under `render/`" is wrong by a wide
      margin: there are **29**, of which this names 5. The rest are 15 variants
      across three `pub` error enums and 9 `pub` vendor-named functions, two of them
      (`sqlite_canonical_type`, `dsl_to_pg_data_type`) re-exported at the CRATE ROOT.
      And `render/` is not even the worst site — `apply/` carries 11 vendor-named
      public types against `render/`'s 3. `plan/` is genuinely clean.

      "Breaking every `zero_migrate::render::…` path" was also the wrong worry.
      0.1.0 was never published; the entire external cost is the in-repo
      `zero-migrate-node` crate, which uses 6 `zero_migrate::render::` paths total
      and names none of these types.

      So the renames landed in one sweep at `9496fd2b`: `ExpandContract`,
      `TableRebuild`, `TableRebuildSpec`. **`SqliteSequencePolicy` KEEPS its vendor
      name** — measured, `TableRebuildSpec` is 9 fields of which 8 are ordinary
      rebuild vocabulary and exactly one, `sequence_policy`, genuinely models
      `sqlite_sequence` and the `AUTOINCREMENT` high-water mark. Renaming that one
      would be dishonest in the opposite direction.

      Two items deliberately survive and should not be "finished" by a later pass:
      `ops::status::PlanStatusStepKind::SqliteRebuild` and its operator-facing wire
      string `"sqliteRebuild"`. That is a third, distinct type — a journal-visible
      status kind — and bundling a wire-format change into a Rust rename would hide
      it. The string has zero consumers in `packages/`, so renaming it later stays
      free.

      **The general lesson this entry paid for:** the difficulty here rested entirely
      on a semver cost nobody was paying. A whole measurement pass proved the break
      was real, and every technical claim in it held up under an external-crate
      compile check — it was simply irrelevant. A cost that EXISTS and a cost that is
      PAID are different questions, and the second is cheaper to ask first.

   Both are cheap to move and expensive to move twice, so decide before moving.
2. ~~Stop `render_sqlite_trigger_op` resolving to the PostgreSQL renderer (6 sites,
   1 function).~~ **DONE.** Those six now say
   `quote_bare_ident_for_dialect(.., SQLITE_TRIGGER_DIALECT)` (20 uses of the const
   in `lower.rs`), the PG-pinned wrapper is deleted rather than merely bypassed,
   and `sqlite_trigger_quoting_reaches_postgres.rs` pins the count at **zero**
   across all of `src/` — a ratchet at its stop, not a claim in prose. Note the
   obvious proof of this LIED: the neuter that should have caught it stayed GREEN
   at the commit where the reach was live, because the chosen binary never renders
   a trigger. `sqlite_trigger_render_bytes.rs` exists to be an instrument that can
   see the path.
3. Fold or explicitly separate `schema::query::SchemaRenderer`. It is LIVE —
   5,555 calls in one SQLite run, reached from the apply backends, every
   live-database binary and the real CLI — and it is a fully public path, so
   deleting it is a semver break.

   **CORRECTION at `06b5aea8`: the QUESTION IS ANSWERED and the SEMVER DIFFICULTY IS
   MOOT.** The fold was considered and explicitly REJECTED, with the reason recorded
   in `schema/backends/mod.rs:56-64`: `current_timestamp_expr` and `synth_now` cannot
   merge because SQLite and MySQL agree while PostgreSQL does not (`NOW()` vs
   `now()`). Lines 9-15 of that same file already map each module to its future
   crate. So "fold or separate" resolved to SEPARATE, and the vendors are extracted
   under the one-dialect rule with a test enforcing it.

   And the semver clause no longer bites: 0.1.0 was never published, and
   `SchemaRenderer` has **zero consumers outside `src/schema/`** — not even
   `zero-migrate-node`. What actually remains is physical, not decisional: the trait
   still lives at `schema/query.rs:117` inside a 5,972-line core file, and
   `zero-migrate-backend` does not exist as a crate yet.
4. **SPLIT — this is two steps, not one, and step 3 above is a prerequisite for
   half of it.** The 42 core lookups are 33 `DmlRenderer` and 9 `SchemaRenderer`,
   and only the first half is invertible today. (4a) Push `&dyn DmlRenderer` into
   the 25 host functions in `dml`, `lower` and `value_format` that already take the
   dialect. (4b) The 9 `SchemaRenderer` lookups cannot be inverted before its
   vendors leave `schema/query.rs`, because 8 of the 9 are in that same file: for
   them, extraction IS the step and inversion is a consequence. See the corrected
   blocker row for the decomposition and for the one lookup class that is deleted
   rather than inverted.
   **(4b) IS DONE, and it landed at 8 lookups rather than 9.** The three
   `SchemaRenderer` vendors now live in `src/schema/backends/{postgres,sqlite,mysql}.rs`
   under the same one-dialect rule and the same test as the DML vendors, with the
   dispatch in `schema::backends` re-exported as `schema::query::renderer` so no call
   site moved. The ninth lookup was not inverted but DELETED: `existence_probe`'s only
   use of the registry was `canonical_type`, a drift comparator that belonged in core
   all along, so that file now resolves no renderer at all.

   **BOTH HALVES ARE NOW DONE. Measured at `06b5aea8`.**

   **(4b) complete** at `664474db`, tripwired at `1b39c493`. The "inversion proper"
   this paragraph used to list as remaining went 8 point-of-use lookups to **0**: six
   private emitters now take `backend: &'static dyn SchemaRenderer` in PLACE OF
   `dialect: SqlDialect`, and the two `pub` functions keep their `dialect` parameter
   and become the BOUNDARY where a dialect resolves into a backend. No context struct
   was needed — `SchemaRenderer` already answers `fn dialect()`, so the trait object
   IS the carrier. Zero caller churn outside the file.

   **(4a) complete** at `f1354ea7`: 33 lookups to **8**. Eleven private helpers in
   `dml.rs` had `dialect: SqlDialect` REPLACED by `&dyn DmlRenderer` rather than
   added alongside, so no function grew a parameter.

   **But the 8 are not all boundaries, and one of them is an EXTRACTION BLOCKER.**
   Measured: six are genuine `pub`/`pub(crate)` doors with real callers outside
   `render/`; `lower::render_table_ref` and `value_format::default_matches_uuid` are
   private leaves in their own files; `dml::placeholder` is `pub` with **ZERO callers
   anywhere**, i.e. dead public surface counted as a door. And
   `dml::render_in_list_elem_portable` is not a boundary at all but a **vendor to core
   to vendor CYCLE**: `backends/sqlite.rs:72` and `backends/mysql.rs:154` each pass
   their own `DIALECT` into a core helper that then resolves a renderer back into
   them. PostgreSQL is exempt — `backends/postgres.rs:94` uses a lookup-free
   `render_in_list_elem_pg`. After extraction that cycle makes `zero-migrate-sqlite`
   and `zero-migrate-mysql` depend on core resolving them.

   **Why it survived: (4a) has no tripwire and (4b) does.** The schema side's
   `schema_emitters_do_not_relookup_a_backend.rs` forbids exactly this shape and
   caught the analogous problem; the DML side had no equivalent guard, so the cycle
   went unnoticed through the very change that was counting these sites. A guard on
   one side of a symmetric pair is a guard on neither.
5. De-vendor the plan vocabulary and the `MigrationBackend` signatures.

   **PLAN VOCABULARY DONE** at `9496fd2b` — see the Class E note above.

   **THE SIGNATURES ARE ALREADY CLEAN, AND THAT IS THE FINDING.** Audited at
   `06b5aea8`: all 42 `MigrationBackend` methods, plus the associated type and
   supertraits — **zero vendor names** in any method name, parameter type or return
   type. The literal task in this line was done before anyone looked.

   **The leak is one level down, and it is the largest single item in this
   prerequisite.** `ExecutorConfig::pg: PgConfinement` (`conn.rs:185`, type at
   `conn.rs:37`) is reached by **27 of the 42 methods**, and the non-PostgreSQL
   backends read it constantly: `cfg.pg.` occurs 44 times under
   `apply/backend/mysql/` and 3 times under `apply/backend/sqlite/`. `meta_schema`,
   the journal namespace, is used by all three engines — a shared concept wearing a
   PostgreSQL hat, not the reverse.

   The field's own doc already admits it ("SQLite ignores the role, schema, and
   statement settings, but reuses `lock_timeout`"), and `conn.rs:423-433` wraps two
   of its fields in neutrally-named accessors — someone felt the name was wrong and
   papered over it rather than fixing it. **The test per field is whether a
   non-PostgreSQL backend reads it**; genuinely PG-only settings should keep a
   PostgreSQL name, because renaming those to sound neutral is the same error in the
   other direction.

   **The inverse defect, which is larger than the naming one and is a DECISION.**
   The trait's names are clean but its semantics are not: six methods are
   single-engine features on a three-engine trait, with two of three impls as
   refusal stubs — `rebuild_one` ("Rebuilds exist ONLY on the SQLite dialect"),
   `alter_column_type` ("Only MySQL needs this seam"), `baseline_one` (whose own doc
   warns "a trait impl existing is not the feature working"), plus `record_squash`,
   `synchronize_identity` and `alter_primary_key`. Whether a single-engine method
   belongs on a shared trait or behind a capability is **the same open question as
   the FK sites' `unreachable!()` decision above, one layer up.** Settle them
   together or they will be answered inconsistently.

   Two error variants are neutral concepts wearing vendor names and are worth their
   own small change rather than being bundled here:
   `BackfillError::SqliteBatchFailed` and `::SqlitePoisoned` (`capability.rs:103,
   :111`). Note the irony: `online()` returns `None` for SQLite, so these
   SQLite-named variants sit on the error type of a capability SQLite does not have.
6. **RECLASSIFIED, and it will never be "resolved".** `quote_ident_if_needed`'s
   bare-vs-quoted decision is gated on the PostgreSQL reserved-keyword list and is
   consumed by the SQLite drift comparator. That is a **deliberate canonical
   normal form**, not a defect: it builds and parses the `pg_get_constraintdef`
   shape, which the SQLite and MySQL comparators read ON PURPOSE, and
   re-dialecting it would break the round-trip. It now sits behind a named door
   (`dml::pg_canonical_ident`) precisely because a red-count neuter cannot tell it
   apart from an unrouted emission.
   **The extraction consequence stands and is the real prerequisite:** a shared
   PostgreSQL-shaped normal form that every backend reads needs a home all backend
   crates can reach. Deciding where that lives is step 4 work; changing the
   normal form is not.

   **ANSWERED at `06b5aea8`, by dependency fact rather than by argument.** The
   name-grep understates the readership, because the real consumer is one level in:
   `pg_canonical_ident` itself has exactly ONE production call, but
   `quote_ident_if_needed` has 13 across 5 modules, and `constraintdef_cols`
   (`declarative.rs:341-346`) calls it on every column.

   Following those to their post-extraction crates:

   ```
     apply/backend/sqlite/drift_sql.rs   -> zero-migrate-sqlite   DIRECT + transitive
     apply/backend/mysql/drift_sql.rs    -> zero-migrate-mysql    transitive
     render/{declarative,fold}.rs, apply/drift.rs, schema/query.rs -> core
   ```

   **Both non-PostgreSQL vendor crates read the PostgreSQL-shaped normal form.** So
   it must live where all three vendor crates can reach it — core, or the contract
   crate. Placing it in `zero-migrate-postgres` would make `-sqlite` and `-mysql`
   depend on `-postgres` at runtime, which is the exact failure the trigger-path
   spike already measured. No design work remains here, only placement.

**One guard extraction silently kills:** `backend_modules_name_one_dialect.rs`
reads the backend modules via `include_str!` at paths extraction deletes. It must
be repointed across the crate boundary, never removed — deleting it retires the
one-dialect rule at the exact moment the crate split makes it matter most.

**CORRECTION, measured at `06b5aea8`: this names the WRONG guard. The one above
fails LOUDLY; a different one fails silently.**

`backend_modules_name_one_dialect.rs` resolves its six `include_str!` paths at
COMPILE time. When `render/backends/postgres.rs` becomes
`zero-migrate-postgres/src/render.rs`, the path dangles and the test binary fails to
compile: `couldn't read ...: No such file or directory`. That is a hard error. The
danger is real but one step further on — the cheap way to get the build green is to
delete the test. A shim left at the old path does not produce a false green either,
because the assertion is `carriers.len() == 1` and a re-export stub has zero
carriers.

**The genuinely silent kill is `sqlite_trigger_quoting_reaches_postgres.rs`.** It
walks `PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("src")` at RUN time. After
extraction, `zero-migrate/src` simply contains fewer files — the vendor render and
schema modules and `apply/backend/{postgres,sqlite,mysql}/` have left. The walk
still succeeds, finds zero pinned calls in a smaller tree, and PASSES. Its
"and nowhere else in the crate acquired one" clause silently narrows from the whole
system to core, with no red anywhere. **Any test that scans a directory rather than
a named set has this property: extraction shrinks its universe and it reports
success.** The extraction brief must repoint that walk to iterate the workspace's
crates, not one manifest dir.

**The repoint has a real tension, so decide it deliberately.** `include_str!` across
a sibling directory preserves the compile-time rebuild dependency the guard's own
header calls load-bearing ("editing any of the six rebuilds this binary") but
hard-codes the layout. A runtime read keeps the layout flexible and LOSES that
rebuild dependency, after which the count can drift out from under the pin.
INFERRED, not measured: the durable form is one `tests/one_dialect.rs` per vendor
crate reading `../src/...` with `include_str!`, plus a workspace-level test
asserting all three exist — so neither property is traded away.

Step 3 shares a dependency with `single-fold-and-effects.md`. Both need dialect
knowledge to stop being smeared. Sequence them together or the same code is
rewritten twice.

## Required test matrix

- Conformance suite passes for every enabled backend, per step.
- Differential: identical op streams applied to every backend, resulting
  semantics compared. This is the only check that would have caught a defect
  that was wrong on PostgreSQL and MySQL while accidentally right on SQLite.
- Feature-flag matrix: each backend enabled alone, all enabled, none enabled.
  The build must be green in every configuration, and "none" must fail with a
  clear message rather than a link error.
- Checksum stability: a corpus of recorded migrations must produce
  byte-identical checksums before and after every step. This is the guard on the
  wire-format constraint and it is not optional.
- No core crate may name a dialect. Enforced by a test that greps
  `zero-migrate-core` for backend names and fails on a hit.

## Risks and open questions

- **The single fold may resist unification.** `TableSnapshot` carries catalog
  identity, the runtime descriptor is a wire contract. Whether one model can
  serve both without becoming a god-object is UNVERIFIED. A design spike should
  answer this before step 3 begins.
- **Step 3 touches the code that produced most of this session's defects.** That
  cuts both ways: highest risk, and the code most in need of the change. It is
  why step 1 is first.
- **Scope honesty.** If the project stays at three backends, steps 1 and 2 pay
  for themselves and steps 3 and 4 are priced for a world that may not arrive.
  Committing to dozens of backends is a product decision that should precede the
  engineering, not follow it.
