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

These are the concrete barriers, each verified against `main` at `01385061`.

| blocker | where | why it blocks |
|---|---|---|
| four closed dialect enums | `ir/dialect.rs:21`, `ir/validate.rs:347`, `render/step.rs:12`, `node/verbs.rs:28` | a plugin cannot add a variant to a crate it does not own |
| `DialectSet(u8)` | `model/support.rs:40` | hard cap of eight backends, three bits used |
| spelling separated from execution | `render/` vs `apply/backend/` | `apply/backend/` references `crate::render` 137 times; extracting a backend crate would leave its SQL behind |
| `Capability` is private | `render/renderer.rs:16` | 25 predicates exist but a plugin cannot answer or extend them |
| vendor fields on shared structs | `ColumnSnapshot.sqlite_rowid`, three `mysql_*` fields | a new backend has nowhere to record its equivalent |
| dialect names in the wire format | `Op::Dialectal`, `ir.rs:3385` | named legs `pg` / `sqlite` / `mysql` |

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
              |   #[cfg(feature = "pg")]      register(pg)        |
              |   #[cfg(feature = "mysql")]   register(mysql)     |
              |   knows WHICH backends exist, nothing about them  |
              +------------------------+-------------------------+
                                       | selects at compile time
     +--------------+--------------+---+----------+--------------+
     v              v                          v                v
 +---------+   +---------+              +----------+   +-------------+
 |   -pg   |   | -mysql  |              | -sqlite  |   |  -duckdb    |
 |         |   |         |              |          |   |             |
 | render  |   | render  |              | render   |   | render      |
 | introsp |   | introsp |              | introsp  |   | introsp     |
 | execute |   | execute |              | execute  |   | execute     |
 +----+----+   +----+----+              +-----+----+   +------+------+
      |             |                         |               |
      +-------------+------------+------------+---------------+
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

`DialectSet(u8)` becomes a set over `DialectId`. The eight-backend cap
disappears with it.

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
machinery. It moves into `zero-migrate-pg`. The seam it moves behind ALREADY
EXISTS: `apply/executor.rs:1118` calls
`guard::guard_for(&cfg.guard_config().for_dialect(backend.dialect()))`, and the
crate already ships `PgGuard`, `SqliteDescriptorGuard` and a MySQL posture that
rejects raw SQL outright (`GuardError::MysqlRawSqlRejected`). Three dialects,
three postures, one dispatch point. This decision moves the implementations into
the crates that own them; it does not invent a mechanism.

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
`zero-migrate-pg` and core keeps only the verdict.

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
   A directory move, not a crate boundary. This is the roughly 280 dialect
   decision points in `render/` and the bulk of the work.
4. **Extract the crates.**
   Mechanical once step 3 is done, because the coupling is already gone.

Doing 4 before 3 is the trap: crates that still reach into core for their own
SQL are worse than one crate.

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
