# Choosing a database target

zero-migrate targets PostgreSQL, SQLite, and MySQL 8. This guide helps you
choose a target, stay inside the portable feature set, and understand which
deployment paths can execute each kind of migration.

MariaDB is not a supported target. Do not assume that MySQL 8 compatibility
also covers MariaDB.

**For the authoritative operation/feature compatibility tables, see the
[generated support matrix](support-matrix.md).** It is generated directly from
the engine's capability model and cannot drift without failing the Rust test
suite.

## Start with two questions

For every migration, ask:

1. **Does the feature work on the target database?**
2. **Can my chosen host execute it?**

These are separate. For example, the migration API can describe and validate
an update for every target, while SQLite apply is available only through the
Rust API. Always check both compatibility and execution.

## Target overview

| Target | Best fit | Main limitations |
| --- | --- | --- |
| PostgreSQL | Full platform feature set, rich indexes, native types, partitions, RLS, administration, and complete schema/data execution | Advanced operations need explicit capabilities |
| SQLite | Embedded/local databases applied through a Rust host | No public Node/CLI apply, no native partitions, sequences, comments, or PostgreSQL administration; backfill cursor components require supported `INTEGER` or `TEXT` semantics |
| MySQL 8 | Portable application schema and data migrations through Node or Rust | No column rename, expression/partial indexes, comments, or partitions; data migrations require InnoDB and refuse targets with user triggers |

Choose PostgreSQL when you need the broadest migration surface. Choose SQLite
when you can use the Rust API with the database file. Choose
MySQL 8 when its portable schema subset is enough.

## Execution paths

This table is the practical deployment boundary:

| Execution path | Schema operations | Insert/update/delete | Batched backfill |
| --- | --- | --- | --- |
| Public Node/CLI, PostgreSQL | Yes, for supported non-privileged operations | Yes | Yes, with an exact ordered primary/unique candidate-key cursor tuple and explicit stability |
| Public Node/CLI, MySQL 8 | Yes, for supported operations | Yes, on trigger-free InnoDB tables | Yes, on InnoDB with an exact ordered primary/unique candidate-key cursor tuple and explicit stability |
| Public Node/CLI, SQLite | No apply driver | No | No |
| PostgreSQL Rust API | Yes | Yes | Yes, with an exact ordered primary/unique candidate-key cursor tuple and explicit stability |
| SQLite Rust API | Yes | Yes | Yes, with a supported exact ordered primary/unique candidate-key cursor tuple and explicit stability |
| MySQL 8 Rust API | Yes | Yes, on trigger-free InnoDB tables | Yes, on InnoDB with an exact ordered primary/unique candidate-key cursor tuple and explicit stability |

Supported schema and data steps execute in authored order. Pending deletes and
backfills require operator approval: `approved: true` in Node or `--approve` in
the CLI. Apply preflights every pending approval-gated step before any authored
step starts, so a later unapproved delete or backfill cannot follow an earlier
step from the same plan. Matching completed steps skip without renewed approval.
Backfills capture a fixed terminal cursor before the first batch, record progress
after every bounded batch, and resume only within that original cursor range.

Privileged PostgreSQL capabilities are another host boundary. The public
Node/CLI host cannot provide the required capability charter, so schemas,
extensions, roles, grants, RLS policies, functions, raw statements,
materialized views, and partition attachment require a Rust/custom
host.

See [Node API](node-api.md), [Operating migrations](operations.md), and
[Rust API](embedding.md) before choosing a production apply path.

## The portable baseline

For the best chance of running the same schema migration on all three targets:

- Create ordinary tables with explicit columns and a create-time primary key.
- Use plain or unique named btree indexes.
- Add simple one-column foreign keys that reference `id`.
- Use stored generated columns only.
- Use ordinary literal or structured defaults; avoid sequence defaults.
- Create plain structured views.
- Use enum and domain declarations without comments.
- Keep expressions inside the common vocabulary listed below.
- Avoid raw statements, comments, partitions, trigger reuse, and database
  administration.
- Validate the complete migration independently for each target.

Even within this baseline, make sure your execution path supports the selected
database. SQLite migrations need a Rust host.

## Tables and columns

| Feature | PostgreSQL | SQLite | MySQL 8 |
| --- | --- | --- | --- |
| Create/drop table | Yes | Yes | Yes |
| Rename table | Yes | Yes | Yes |
| Add/drop column | Yes | Yes | Yes |
| Rename column | Yes, staged online workflow | Yes, through Rust apply | No |
| Change base type | Yes | Yes | Yes |
| Change type with custom `using` | No | No | No |
| Set/drop nullability | Yes | Yes | Yes |
| Set/drop ordinary default | Yes | Yes | Yes |
| Stored generated column | Yes | Yes | Yes |
| Virtual generated column | No | Yes | Yes |
| Auto-incrementing sole integer primary key | Yes | Yes | Yes |
| Identity outside that shape | Yes | No | No |
| Sequence-backed default | Yes | No | No |

SQLite may rebuild a table for supported changes that it cannot perform in
place. Plan extra time and disk space for large tables, and test the change on a
representative copy. Its column rename is one rebuild, so same-table operations
may stay in authored order within the migration.

MySQL 8 does not currently support column rename through zero-migrate. Use an
expand-and-contract change instead: add the new column, backfill it, update the
application, then drop the old column in a later migration.

PostgreSQL `.column(source).rename({ to, type })` uses the built-in online
workflow. The source must exist, the destination must not exist, and `type` must
match the source's live PostgreSQL type. The table must have a complete,
non-null, single-column `id` primary key with a supported orderable type, and
the initial backfill requires approval. The table must have no pre-existing
enabled user triggers, and row-level policy must allow every selected row to be
updated.

On PostgreSQL, the rename must be the only operation in the migration that
targets that table. Other operations may target different tables. Put every
same-table schema or data change in a later migration and apply it only after
the rename is resolved. This restriction does not apply to SQLite's one-rebuild
rename.

The initial apply returns `pendingContracts` while the source and destination
coexist. Move every application instance and database consumer to the
destination, then resolve the returned `pendingVersion`. Apply resolution keeps
the destination and drops the source; abort keeps the source and drops the
destination. Both resolution choices require approval, and other migration
changes to the table remain blocked until one succeeds. See the
[operational workflow](operations.md#postgresql-online-column-rename).

Resolution cleanup is all-or-nothing. If it fails, both columns and the managed
rename trigger remain intact and the pending obligation remains valid for a
retry of the same action. Once apply or abort succeeds, exact migration replay
is terminal and cannot open another obligation. To retry the rename after an
abort, author a new migration with a new exported name. An aborted plan does not
satisfy `dependsOn`.

During coexistence, a write through either column name keeps the values aligned;
if both receive different values in one statement, the destination wins. The
destination is nullable but otherwise keeps the source's exact live PostgreSQL
type and modifiers. Equivalent built-in spellings such as `timestamptz` and
`timestamp with time zone`, `decimal` and `numeric`, or `varchar` and `character
varying` compare as aliases without dropping modifiers. Modifier drift is
refused during resolution. Schema-qualified enum and domain types retain their
exact live identity, including quoted names. `NOT NULL`, defaults, unique or
primary-key rules, indexes, comments, and dependent objects do not transfer.
Recreate required semantics in follow-up migrations after resolution, and do
not use this workflow to rename the `id` primary key. Dependencies on the source
can block resolution, so audit them before rollout.

Adding a column with `.primaryKey()` later does not create a primary-key
constraint on any target. Once all data and dependency prerequisites have been
staged separately, `table(name).primaryKey().add()`, `.replace()`, and `.drop()`
perform the explicit final constraint change on all three targets. Replace and
drop require an exact ordered `expectedColumns` precondition; their optional
`dropIdentityFrom` tuple is the only supported generation transition. Apply
also refuses to strand an inbound foreign key without an exact alternate unique
key.

After preserving explicit integer IDs during an import, call
`table(name).column(column).synchronizeIdentity({ writesQuiesced: "…" })`.
PostgreSQL monotonically reconciles the column's owned identity/serial sequence,
including non-unit and descending increments; cycling sequences are rejected
because they cannot satisfy the no-backward contract. MySQL advances only an
`AUTO_INCREMENT` column and pins `NO_AUTO_VALUE_ON_ZERO` so a structured import
cannot silently replace an explicit legacy zero. SQLite validates an ordinary
integer rowid as a no-op and monotonically reconciles `sqlite_sequence` only for
`AUTOINCREMENT`. The required `writesQuiesced` name is coordination metadata
shown in preview and status; the engine cannot prove the external invariant.

### Features inside `table(...).create({...})`

| Create-time feature | PostgreSQL | SQLite | MySQL 8 |
| --- | --- | --- | --- |
| Columns and primary key | Yes | Yes | Yes |
| Column-level unique | Yes | Yes | Yes |
| Table-level `uniques` | Yes | No | Yes |
| Table-level simple foreign key to `id` | Yes | Yes | Yes |
| Table-level composite/non-`id` foreign key | Yes | Yes | Yes |
| Table-level `checks` | Yes | No | No |
| Exclusion constraints | Yes | No | No |
| Plain btree indexes | Yes | Yes | Yes |
| Expression or partial indexes | Yes | Yes | No |
| Native partitioning | Yes | No | No |

For a three-target unique key, create a named unique btree index instead of
using the table-level `uniques` option:

```javascript
import { table, t, uuidV4 } from "zero-migrate";

table("accounts").create({
  columns: {
    id: t.uuid().primaryKey().default(uuidV4()),
    // `email` is uniquely indexed, so it is a bounded `t.string` (VARCHAR) — a
    // MySQL index needs a bounded/prefix type, never unbounded `t.text()`.
    email: t.string({ length: 254 }).notNull(),
  },
  indexes: [
    { name: "accounts_email_uq", on: ["email"], unique: true },
  ],
});
```

Table-level foreign keys are portable across all three targets, including
composite keys and references to non-`id` columns. Local and referenced column
tuples must be nonempty, have the same arity, and preserve their intended
positional order. Validate the complete migration for every target.

### Strings: `t.string` vs `t.text`

Choose by intent: `t.string({ length })` for a **bounded** value you index,
filter, or key on, and `t.text()` for **unbounded** prose. The distinction
matters because MySQL treats the two very differently.

| Author | PostgreSQL | MySQL 8 | SQLite |
| --- | --- | --- | --- |
| `t.string({ length: n })` | `varchar(n)` | `VARCHAR(n)` | `TEXT` |
| `t.text()` | `text` | `TEXT` | `TEXT` |

`t.string({ length })` renders a portable `VARCHAR(N)` that is fully indexable on
every target; `length` defaults to 255 when omitted. Reach for it for
identifiers, slugs, emails, status values, and any column that appears in a
primary key or unique index — MySQL cannot index an unbounded `TEXT` column
without a prefix length.

`t.text()` renders an unbounded `TEXT` on every target, so a long value stores
identically on PostgreSQL, MySQL, and SQLite. Use it for prose, descriptions,
and other free text you do not index.

**Case sensitivity is portable.** String comparison is case-SENSITIVE by default
on every target — the same `WHERE email = 'Foo'` matches the same rows on
PostgreSQL, MySQL, and SQLite. On MySQL this is pinned with an explicit
`utf8mb4_bin` collation, overriding the server default (which is otherwise
case-insensitive). For a case-insensitive column, author `t.text({ caseSensitive:
false })`, which renders `citext`/`COLLATE NOCASE`/`utf8mb4_0900_ai_ci`
respectively.

> **MySQL note:** because `t.text()` is an unbounded `TEXT` on MySQL 8, it cannot
> be a primary key, unique, or index member there (MySQL rejects a `TEXT` key
> without a prefix length). Use `t.string({ length })` for any column you key or
> index. A `t.text()` column placed in a key currently surfaces this as MySQL's
> apply-time error rather than an earlier validation error.

## Indexes

| Feature | PostgreSQL | SQLite | MySQL 8 |
| --- | --- | --- | --- |
| Plain/unique btree index | Yes | Yes | Yes |
| Drop index | Yes | Yes | Yes |
| Expression index | Yes | Yes | No |
| Partial `where` index | Yes | Yes | No |
| Included columns | Yes | No | No |
| Storage parameters | Yes | No | No |
| Operator class or explicit collation | Yes | No | No |
| `nullsNotDistinct` | Yes, PostgreSQL 15+ | No | No |
| `brin`, `gin`, `gist`, `ivfflat`, `hnsw` | Yes | No | No |
| Index comments | Yes | No | No |

Use `btree` for portable migrations. Through the current API:

- `hash`, `spgist`, and `fts5` are unsupported.
- Per-element `nulls` is unsupported.
- Expression elements cannot carry their own order, operator class, collation,
  or null ordering.
- Concurrent index drop is unsupported.

PostgreSQL vector index methods require the matching database extension and
operator setup. Provision those prerequisites before apply.

## Constraints

| Feature | PostgreSQL | SQLite | MySQL 8 |
| --- | --- | --- | --- |
| Add unique constraint | Yes | Yes | Yes |
| Add one-column foreign key to `id` | Yes | Yes | Yes |
| Composite or non-`id` foreign key | Yes | Yes | Yes |
| Deferrable foreign key | Yes | Yes | No |
| Add standalone check | Yes | No | No |
| Exclusion constraint | Yes | No | No |
| Drop constraint | Yes | Yes | Yes |
| Validate an adopted constraint | Yes | No | No |
| Constraint comment | Yes | No | No |

If a check is a business-critical invariant, do not replace it with an empty
SQLite or MySQL branch. Either enforce the invariant with a portable schema
design, enforce it safely in another layer, or choose PostgreSQL as the only
target.

## Data operations

The authoring API supports these descriptions:

| Feature | PostgreSQL | SQLite | MySQL 8 |
| --- | --- | --- | --- |
| Insert literal rows | Yes | Yes | Yes |
| Update | Yes | Yes | Yes |
| Delete with predicate | Yes | Yes | Yes |
| Batched backfill | Ordered primary/unique candidate-key tuple | Ordered primary/unique tuple with supported `INTEGER`/`TEXT` components | Ordered primary/unique candidate-key tuple |
| Insert with non-empty `onConflict.doUpdate` | Yes, exact target | Yes, exact target | Yes, with guarded target matching |
| Insert with `onConflict` do-nothing | Yes, exact target | Yes, exact target | No exact native form |

PostgreSQL and MySQL execute all four operations through the public Node API,
CLI, or Rust API. SQLite executes all four through the Rust API. One-shot data
statements keep values separate from statement structure; structured backfill
expressions use dialect-safe literal encoding.

SQLite has no native fixed-precision decimal storage. zero-migrate stores
`t.numeric(...)` values as exact decimal text on SQLite, so `decimal("...")`
keeps the authored digits without passing through a JavaScript or SQLite
floating-point number. Text equality is representation-sensitive: `1`, `1.0`,
and `01.0` remain different stored values, and ordering is lexical. SQLite
arithmetic and numeric casts still coerce the text to SQLite numbers and are not
arbitrary-precision operations. Use PostgreSQL or MySQL when database-side
fixed-precision arithmetic or numeric ordering is required.

Pending `delete` and `backfill` steps require explicit approval. A backfill's
declared `cursorColumns` must exactly match, in order, a non-null primary or
unique candidate-key tuple whose comparison semantics the target can preserve;
one column from a composite key is not sufficient. PostgreSQL and MySQL require
supported orderable component types. SQLite additionally requires supported
declared `INTEGER` or `TEXT` affinity and matching live storage classes for each
component. Text components must contain valid UTF-8; embedded NUL characters
are supported. A `WITHOUT ROWID` table is supported when its candidate key
meets the same rules. The backfill must not assign any cursor component.

Every backfill also declares `cursorStability`. `guardUpdates` installs a
zero-migrate-owned persistent guard until durable completion; apply refuses
trigger interactions it cannot prove safe. `externalInvariant` records a named
application or maintenance invariant and requires explicit destructive
approval. The bounded cohort does not cover concurrent inserts by itself:
establish a write invariant that makes new rows fail the filter before capture,
or run a final catch-up while writes are stopped.

Every MySQL structured insert, update, delete, and backfill requires an InnoDB
target table without user triggers. Apply refuses before changing target rows if
the storage engine or trigger condition is unsafe. SQLite Rust apply coordinates
zero-migrate processes for the same application database and rejects backfills
on tables with user triggers. PostgreSQL backfills also require no pre-existing
enabled user triggers; the managed online rename workflow remains supported. A
PostgreSQL row policy that suppresses an update causes the batch to
roll back without advancing progress.

SQLite refuses to migrate when it cannot establish crash-safe settings for both
the application and journal databases. This uses DELETE rollback-journal mode
for both files and `synchronous=FULL` on the migration connection. Opening an
application database that uses WAL changes its persistent journal mode, so treat
SQLite apply as an operational storage-mode decision.

Before the first batch, every backend captures a fixed terminal cursor. Retries
resume after the last committed cursor and stop at that original boundary. Rows
inserted after capture are not guaranteed to be processed and need a later
migration. Integer and decimal cursor values remain exact across the JavaScript
boundary. `byteValue` preserves exact binary data on every execution backend;
its string form is decoded from well-formed base64 rather than stored as text.
Binary values work in inserts, updates, backfill assignments, conflict updates,
and compatible column defaults.

Schema and data steps can stay in one migration: they execute in authored
order, receive stable journal identities, and appear together in plan-aware
status. Saved backfill progress without a final completion event appears as an
`inflight` step in a `partial` plan.

An interrupted MySQL schema step is different from a resumable backfill. MySQL
may have auto-committed the DDL before completion history was written, so
zero-migrate preserves the inflight marker and does not replay the statement.
Inspect the live schema before normal apply continues. A Rust host resolves the
marker with `MysqlBackend::recover_inflight_ddl` and the exact reviewed
`Migration`. Choose `MarkAppliedAfterVerification` only after verifying the
complete new shape, or `ClearForRetryAfterRollback` only after restoring and
verifying the complete old shape.

PostgreSQL and SQLite use the exact columns in `onConflict.columns`. MySQL 8
cannot name a particular unique constraint in its duplicate-key syntax. For
`doUpdate`, zero-migrate first proves that the target is every full column of one
primary or unique index, then compares the incoming target values with the
existing row and updates only on a match. Prefix and functional indexes are not
accepted as proof. Every target column must be present in the inserted row, and
`doUpdate` cannot assign a target column on MySQL. A collision on another MySQL
unique key, including a nullable-target non-match, fails the statement instead
of updating the wrong row. MySQL `doNothing` is rejected because a duplicate-key
no-op fires update triggers, while `INSERT IGNORE` can suppress unrelated data
errors.

## Views, enums, domains, and sequences

| Feature | PostgreSQL | SQLite | MySQL 8 |
| --- | --- | --- | --- |
| Plain structured view | Yes | Yes | Yes |
| Raw read-only view body | Capability required | Capability required | Capability required |
| Materialized view | Capability required | No | No |
| Create/drop enum | Yes | Yes | Yes |
| Create/drop domain | Yes | Yes | Yes |
| Enum/domain comment | Yes | No | No |
| Standalone sequence | Yes | No | No |
| Sequence comment | Yes | No | No |

PostgreSQL creates native named enums and domains. SQLite and MySQL 8 preserve
their logical restrictions using target-appropriate storage. Do not rely on
identical physical types or database-native operators across targets.

Raw view bodies must contain exactly one read-only `SELECT`. They are
capability-gated on every target, and the public Node/CLI host cannot grant that
capability. Prefer the structured view builder.

## Expressions

The following expression features are suitable for all three targets:

- literals and column references;
- equality, ordering, boolean logic, and arithmetic;
- `isNull`, `isNotNull`, `isTrue`, and `isFalse`;
- `between`, `like`, `in`, `notIn`, and `distinctFrom`;
- casts to text, integer, real, boolean, bytes, or UUID;
- `lower`, `upper`, `trim`, `length`, `abs`, `coalesce`, `nullif`,
  `mod`, `round`, `floor`, `ceil`, `substr`, and `replace`;
- searched `CASE`;
- `extract` for year, month, day, hour, minute, and day-of-week;
- `count`, `sum`, `avg`, `min`, `max`, and `countStar`;
- `now`, capability-gated exact RFC 9562 UUIDv4 generation with `uuidV4()`,
  and `concatWs` with a literal separator;
- `splitPart` with a one-character ASCII delimiter and a part from 1 through 8.

An expression may still be invalid in a particular location. Aggregates belong
in view projections or `having`. Defaults cannot reference columns. Generated
columns, checks, domains, and index expressions must not use volatile values or
aggregates.

Database UUID generation is capability-gated at apply: `uuidV4()` requires
PostgreSQL 13 or newer, or MySQL 8.0.13 or newer with InnoDB and both global and
session `binlog_format` set to `ROW`. SQLite uses the engine's exact synthesized
expression and needs no server-version probe. `uuidV7()` additionally requires
PostgreSQL 18 or newer.

Target-specific expressions:

| Expression | PostgreSQL | SQLite | MySQL 8 |
| --- | --- | --- | --- |
| `regex` | Yes | No | Yes |
| `columnSize` | Yes | No | No |
| `currentSetting`, `currentUser` | Yes | No | No |
| `interval` | Yes | No | No |
| Extended date extraction | Yes | No | No |
| `stringAgg`, `arrayAgg`, `boolAnd`, `boolOr` | Yes | No | No |
| `concatWs` with computed separator | Yes | No | Yes |
| Wider `splitPart` delimiter or part above 8 | Yes | No | No |
| `uuidV7()` database generation | PostgreSQL 18+ | No | No |

There is no raw expression escape. Use a supported structured expression or
write explicit target branches.

## Partitions

Native range, list, and hash partitioning is PostgreSQL-only.

SQLite and MySQL 8 can accept an explicit
`whenUnsupported: "collapse"` design, which creates one ordinary table instead
of physical partitions. Collapse changes performance and maintenance behavior,
so use it only when that difference is acceptable.

For collapse:

- describe the parent and all children together;
- make every partition key non-null;
- include every partition key in primary and unique keys;
- provide valid, non-overlapping, complete bounds;
- provide a default child for range and list layouts;
- cover every residue for a hash layout.

Partition attachment is a privileged PostgreSQL operation. Partition detach is
also PostgreSQL-only.

## Triggers

Triggers need separate target implementations:

| Form | PostgreSQL | SQLite | MySQL 8 |
| --- | --- | --- | --- |
| Execute a named trigger function | Yes | No | No |
| Structured trigger body | No | Yes | Yes |
| Multiple events in one body trigger | No | Yes | No |
| Conditional body | No | Yes | No |
| Statement-level body | No | No | No |
| Drop trigger | Yes | Yes | Yes |

MySQL 8 requires exactly one event and a row-level body. PostgreSQL requires a
separately declared named function. Use `dialect()` to make the different
implementations explicit.

MySQL trigger DDL is supported, but structured insert, update, delete, and
backfill operations refuse a target that already has a user trigger. Apply the
data change before adding the trigger, or redesign the rollout explicitly.

## PostgreSQL capabilities

These PostgreSQL-only features require an explicit capability:

| Feature | Capability |
| --- | --- |
| Create/drop schema | `schema` |
| Create/drop extension | `extension` |
| Create/change/drop role | `role` |
| Grant/revoke | `grant` |
| Attach partition | `partition` |
| Row-level security | `rls` |
| Create/drop policy | `policy` |
| Create/drop function | `function` |
| Whole raw statement | `rawSql` |
| Materialized view | `materializedView` |
| Raw view body | `rawViewBody` |

Capabilities must come from trusted host policy. A migration cannot grant
itself permission by importing an API or targeting PostgreSQL. The Node
`policy` stack and CLI's repeatable `--policy` files are limited
to table-shape policy bounded by the trusted root entry. These operations require
a reviewed Rust/custom host.

## Using `dialect()`

Use target branches when the product behavior is intentionally different.

For expressions:

```javascript
table("audit_entries").insert({
  rows: {
    actor: dialect({
      default: "system",
      pg: currentUser(),
    }),
  },
});
```

For whole operations:

```javascript
dialect({
  pg: () => {
    table("documents").index("documents_embedding_hnsw_idx").add({
      on: ["embedding"],
      using: "hnsw",
    });
  },
  sqlite: () => {
    table("documents").index("documents_title_idx").add({
      on: ["title"],
    });
  },
  mysql: () => {
    // Intentionally no equivalent index.
  },
});
```

The matching target branch wins; otherwise `default` is used. An operation
without either is skipped. Empty branches are useful documentation, but they
also mean the feature or invariant is absent on that target.

Each selected branch still follows normal ownership, capability, and
destructive-change policy.

## Portability patterns

### Prefer a unique index

A named unique btree index is more portable than a table-level unique
descriptor:

```javascript
table("accounts").index("accounts_email_uq").add({
  on: ["email"],
  unique: true,
});
```

### Branch only for an optional PostgreSQL feature

```javascript
dialect({
  pg: () => {
    table("orders").check("orders_total_nonnegative").add({
      expr: (col) => col("total_cents").ge(0),
    });
  },
  sqlite: () => {},
  mysql: () => {},
});
```

This is appropriate only if the missing check is acceptable off PostgreSQL.

### Use the common expression range

```javascript
table("users").update({
  set: {
    first_name: (col) => col("full_name").splitPart(" ", 1),
    normalized_email: (col) => col("email").trim().lower(),
  },
  where: (col) => col("normalized_email").isNull(),
});
```

The expression and data step work on all targets. Use the public Node API or CLI
for PostgreSQL and MySQL 8, or the Rust API for any of the three targets.

### Use expand-and-contract for incompatible DDL

When a target cannot perform a direct change:

1. Add a compatible new column or table.
2. Deploy code that can read both shapes.
3. Move data with a supported, separately monitored execution path.
4. Switch writes and reads to the new shape.
5. Remove the old shape in a later migration.

This is the preferred MySQL 8 approach for column rename and a safer strategy
for large SQLite table rebuilds.

## Target review checklist

Before apply:

- Confirm the intended target is PostgreSQL, SQLite, or MySQL 8.
- Validate the full migration for that exact target.
- For a PostgreSQL rename, isolate same-table work, then plan the application
  cutover and explicit apply or abort resolution before starting the approved
  backfill.
- Check the execution-path table, especially for data changes and backfills.
- Use a plain named btree index unless a target-specific index is intentional.
- Review checks, foreign keys, generated columns, identity, and sequences.
- Treat every `dialect()` no-op as a conscious loss of behavior.
- Treat partition collapse as a physical-design decision, not a fallback.
- Provision required PostgreSQL extensions and types.
- Supply privileged capabilities only through a trusted Rust/custom host.
- Test SQLite rebuilds and MySQL 8 DDL recovery on representative data.
- Apply to a disposable database before production.

## Next

- [Writing migrations](writing-migrations.md)
- [Getting started](getting-started.md)
- [Node API](node-api.md)
- [Operating migrations](operations.md)
- [Security model](security-model.md)
- [Troubleshooting](troubleshooting.md)
- [Documentation home](README.md)
