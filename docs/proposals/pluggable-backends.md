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
| **core looks vendors up BY DIALECT, from inside core** | ~55 call sites resolve `renderer(dialect)` within `render/` and `schema/` (dml 24, schema/query 21, lower 7, value_format 2, existence_probe 1). Core depends on the backend registry while backends depend on core: a CYCLE. An extraction spike compiled only by stubbing that arm with `panic!`. |
| **the "neutral" plan vocabulary carries vendor names** | `render/step.rs:51,53` — `RenameStep::PgExpandContract` and `RenameStep::SqliteRebuild`, matched at 203/204/234, with `step.rs:8` importing `SqliteRebuild` from the declarative renderer. `apply/backend/mod.rs:751` takes `spec: &SqliteRebuildSpec`. **The would-be CONTRACT crate carries SQLite types.** |
| **there are FIVE per-dialect stacks, not one** | `DmlRenderer` (26 methods), `DdlEmitter` (6, inside `declarative.rs`), `schema::query::SchemaRenderer` (10), `MigrationBackend` (41), `CrossDeployObligations` (8). Only the first is guarded by the one-dialect test. |
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

The four existing enums are removed in this order: `DialectScope` and
`ApplyDialect` are internal and go first; `Dialect` in `ir/validate.rs` folds
into `SqlDialect`; `SqlDialect` becomes a deprecated alias for `DialectId`
constants during migration and is deleted last.

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
   contain SQLite. **NOW SIZED** (see the DDL census above): 103 production
   emission sites in core, 57 of them in `declarative.rs`, and the destination is
   not a void — `render/backends/` already owns view and trigger DDL, and a
   private six-method `DdlEmitter` with three vendor impls already exists inside
   `declarative.rs`.
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
4. Invert the ~55 core sites that look a vendor up by dialect.
5. De-vendor the plan vocabulary and the `MigrationBackend` signatures.
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

**One guard extraction silently kills:** `backend_modules_name_one_dialect.rs`
reads the backend modules via `include_str!` at paths extraction deletes. It must
be repointed across the crate boundary, never removed — deleting it retires the
one-dialect rule at the exact moment the crate split makes it matter most.

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
