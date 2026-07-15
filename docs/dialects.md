# Choosing a database target

zero-migrate targets PostgreSQL, SQLite, and MySQL 8. This guide helps you
choose a target, stay inside the portable feature set, and understand which
deployment paths can execute each kind of migration.

MariaDB is not a supported target. Do not assume that MySQL 8 compatibility
also covers MariaDB.

## Start with two questions

For every migration, ask:

1. **Does the feature work on the target database?**
2. **Can my chosen host execute it?**

These are separate. For example, the migration API can describe and validate
an update for PostgreSQL, but the public Node API and CLI do not execute
structured data operations. Always check both compatibility and execution.

## Target overview

| Target | Best fit | Main limitations |
| --- | --- | --- |
| PostgreSQL | Full platform feature set, rich indexes, native types, partitions, RLS, and administration | Advanced operations need explicit capabilities; public Node/CLI does not run structured data steps |
| SQLite | Embedded/local databases and the broadest supported backfill path | No public Node/CLI apply, no native partitions, sequences, comments, or PostgreSQL administration |
| MySQL 8 | Portable application schema DDL through Node or Rust | No column rename, expression/partial indexes, comments, partitions, or structured data execution |

Choose PostgreSQL when you need the broadest migration surface. Choose SQLite
when the database lives in-process and you can use the Rust API. Choose
MySQL 8 when its portable schema subset is enough and your migration does not
depend on unsupported data execution.

## Execution paths

This table is the practical deployment boundary:

| Execution path | Schema operations | Insert/update/delete | Batched backfill |
| --- | --- | --- | --- |
| Public Node/CLI, PostgreSQL | Yes, for supported non-privileged operations | **No** | **No** |
| Public Node/CLI, MySQL 8 | Yes, for supported operations | **No** | **No** |
| Public Node/CLI, SQLite | No apply driver | No | No |
| PostgreSQL Rust API | Yes | Yes | No current backfill runner |
| SQLite Rust API | Yes | Yes | Yes |
| MySQL 8 Rust API | Yes | No | No |

The public Node/CLI path can load and validate structured data operations, but
it does not execute them. Do not interpret a successful apply or journal entry
as proof that an `insert`, `update`, `delete`, or `backfill` ran.

Privileged PostgreSQL capabilities are another host boundary. The public
Node/CLI host cannot provide the required capability ceiling, so schemas,
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

Even within this baseline, make sure your execution path supports the operation
category. A portable data description is not executable through public
Node/CLI apply.

## Tables and columns

| Feature | PostgreSQL | SQLite | MySQL 8 |
| --- | --- | --- | --- |
| Create/drop table | Yes | Yes | Yes |
| Rename table | Yes | Yes | Yes |
| Add/drop column | Yes | Yes | Yes |
| Rename column | Yes | Yes | No |
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
representative copy.

MySQL 8 does not currently support column rename through zero-migrate. Use an
expand-and-contract change instead: add the new column, move data through a
supported data execution path, update the application, then drop the old
column in a later migration.

Primary keys must be part of the initial table definition. Adding a column with
`.primaryKey()` later does not create a primary-key constraint on any target.

### Features inside `table(...).create({...})`

| Create-time feature | PostgreSQL | SQLite | MySQL 8 |
| --- | --- | --- | --- |
| Columns and primary key | Yes | Yes | Yes |
| Column-level unique | Yes | Yes | Yes |
| Table-level `uniques` | Yes | No | Yes |
| Table-level simple foreign key to `id` | Yes | No | Yes |
| Table-level composite/non-`id` foreign key | Yes | No | No |
| Table-level `checks` | Yes | No | No |
| Exclusion constraints | Yes | No | No |
| Plain btree indexes | Yes | Yes | Yes |
| Expression or partial indexes | Yes | Yes | No |
| Native partitioning | Yes | No | No |

For a three-target unique key, create a named unique btree index instead of
using the table-level `uniques` option:

```javascript
table("accounts").create({
  columns: {
    id: t.id(),
    email: t.text().notNull(),
  },
  indexes: [
    { name: "accounts_email_uq", on: ["email"], unique: true },
  ],
});
```

For portable foreign keys, a follow-up named one-column foreign key to `id` has
the widest support. Validate the complete migration on SQLite rather than
assuming that a foreign key accepted in another position will also work inside
the create call.

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
| Composite or non-`id` foreign key | Yes | No | No |
| Deferrable foreign key | Yes | No | No |
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
| Batched backfill | Yes | Yes | Yes |
| Insert with `onConflict` | Yes | No | No |

This table means the migration can be described and validated. Execution still
depends on the [execution path](#execution-paths):

- Public Node/CLI: none of these structured data operations run.
- PostgreSQL Rust API: insert, update, and delete run; backfill does not.
- SQLite Rust API: insert, update, delete, and backfill run.
- MySQL 8 Rust API: structured data operations do not run.

If a schema change needs a data move, do not bundle the two steps until you
have chosen an executor that supports both. For Node/CLI deployments, run data
changes through a separate, explicitly managed application job or use an
appropriate Rust host.

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
- `now`, generated UUIDs, and `concatWs` with a literal separator;
- `splitPart` with a one-character ASCII delimiter and a part from 1 through 8.

An expression may still be invalid in a particular location. Aggregates belong
in view projections or `having`. Defaults cannot reference columns. Generated
columns, checks, domains, and index expressions must not use volatile values or
aggregates.

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
itself permission by importing an API or targeting PostgreSQL. The public
Node/CLI host cannot currently supply this policy ceiling, so these operations
require a reviewed Rust/custom host.

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

The expression works on all targets, but the data step still needs PostgreSQL
or SQLite embedding to execute. Public Node/CLI and MySQL 8 execution will not
run it.

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
