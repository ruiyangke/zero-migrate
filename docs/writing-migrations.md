# Writing migrations

Use the `zero-migrate` package to describe schema changes in ordinary
JavaScript. TypeScript is optional: the API and module shape are the same, while
TypeScript adds autocomplete and earlier feedback.

This guide starts with a complete migration, then covers tables, columns,
indexes, constraints, views, data changes, expressions, target-specific
features, and safe rollout.

> **Data migrations execute end to end:** PostgreSQL and MySQL Node/CLI apply run
> structured `insert`, `update`, `delete`, and `backfill` steps. SQLite runs all
> four through its Rust backend. Schema and data steps stay in the
> order written in `up()`. Deletes and backfills that still need to run require
> explicit approval, checked across the whole plan before any authored step
> executes.

## Your first migration

Create a file such as `migrations/20260715120000_create_accounts.js`:

```ts
import { now, table, t } from "zero-migrate";

export const name = "create_accounts";

export default {
  up() {
    table("accounts").create({
      columns: {
        id: t.id({ prefix: "acct" }),
        email: t.text().notNull(),
        display_name: t.text(),
        state: t.text().notNull().default("invited"),
        created_at: t.timestamp().notNull().default(now()),
      },
      indexes: [
        { name: "accounts_email_uq", on: ["email"], unique: true },
      ],
    });
  },
};
```

The examples in this guide are marked `ts` so editors can type-check them, but
they use JavaScript syntax unless a section explicitly discusses TypeScript.

The important parts are:

- `name` is the migration's stable identity as well as its label in previews and
  history. It must be unique within the project.
- `up()` contains the ordered changes.
- `table("accounts")` selects the object to change.
- `t` builds column definitions.
- String values such as `"invited"` are data, never SQL fragments.

Migration discovery is filename-based and lexicographic. Use sortable timestamp
prefixes. Keep every exported migration name unique and stable, and never rename
or edit a migration after it has been applied to a shared environment.

## The authoring rules

Keep these rules in mind for every migration:

1. Put operation calls directly and synchronously inside `up()`.
2. Do not make `up()` async, start timers, fetch remote data, or read changing
   external state.
3. Give indexes, constraints, triggers, and policies stable names.
4. Use the structured expression helpers instead of SQL strings.
5. Preview and validate for every database target you deploy.

> **Run migration modules as trusted code.** The public Node API and CLI import
> JavaScript/TypeScript modules without a sandbox. Top-level code and `up()` can
> access the process environment, filesystem, network, and child processes with
> the host application's authority. If you accept generated or untrusted
> migration source, evaluate it in a separate external sandbox with no secrets
> or production authority, then use a reviewed Rust/custom-host workflow for
> deployment.

The package accepts a default object, as above, or a named `up` function:

```javascript
export const name = "add_account_status";

export function up() {
  // migration operations
}
```

Although a `down()` property is accepted by the JavaScript/TypeScript module
shape, the current host does not run or save it, and the public Node API has no
rollback command. Treat migrations as forward-only: back up before destructive
work and prepare a new forward-fix migration when needed.

## The end-to-end workflow

A normal workflow is:

1. Scaffold or create a timestamped migration file.
2. Add schema and data operations to `up()` in the order they must run.
3. Preview the operations and review their order.
4. Validate for the intended target database.
5. Review destructive changes and target-specific capabilities.
6. Apply through Node/CLI on PostgreSQL or MySQL, or through the Rust API on
   SQLite. Supply approval for delete or backfill steps.
7. Check migration status and application behavior.

The CLI can scaffold a TypeScript file:

```bash
zero-migrate new add_account_status --dir ./migrations
```

Packages are not currently published to npm; use the source-checkout setup in
[Getting started](getting-started.md).

Use these guides for the host side:

- [Getting started](getting-started.md) for setup and a first apply.
- [CLI reference](cli.md) for preview, plan, apply, and status commands.
- [Node API](node-api.md) for programmatic validation and apply.
- [Operating migrations](operations.md) for deployment and recovery.

## Tables and schemas

`table(name, options?)` returns a reusable handle. Supplying `schema` sets the
default schema for operations made through that handle:

```ts
const auditEvents = table("events", { schema: "app_data" });

auditEvents.create({
  columns: {
    id: t.id(),
    kind: t.text().notNull(),
  },
});

auditEvents.index("events_kind_idx").add({ on: ["kind"] });
```

An explicit schema does not grant permission to leave the project schema. The
apply policy still decides which schema the migration may change.

Common table operations are:

| Goal | API |
| --- | --- |
| Create a table | `table(name).create({...})` |
| Drop a table | `table(name).drop({ ifExists?, cascade? })` |
| Rename a table | `table(name).rename({ to, ifExists? })` |
| Add runtime metadata | `table(name).setOptions({...})` |
| Add a PostgreSQL comment | `table(name).comment(text)` |
| Insert, update, delete, or backfill data | `table(name).insert/update/delete/backfill` |

`setOptions` manages platform metadata rather than arbitrary SQL options. Its
fields are `softDelete`, `versioning`, and `strictness`, where strictness is
`"strict"`, `"lenient"`, or `"off"`.

## Column types

Build every column with the immutable `t` helpers:

| Factory | Use |
| --- | --- |
| `t.id({ prefix? })` | UUID primary key with a generated value |
| `t.text({ caseSensitive? })` | Text |
| `t.textArray()` | Text array |
| `t.numeric({ precision?, scale? })` | Exact decimal number |
| `t.char({ length })` | Fixed-length text |
| `t.smallInt()`, `t.int()`, `t.bigInt()` | Integers |
| `t.real()`, `t.double()` | Floating-point numbers |
| `t.boolean()` | Boolean |
| `t.timestamp()`, `t.date()` | Timestamp or calendar date |
| `t.uuid()` | UUID |
| `t.bytes()` | Binary data |
| `t.json()` | JSON |
| `t.inet()` | IP address or network |
| `t.ref("accounts")` | Reference-shaped identifier for another table |
| `t.vector({ dimensions, metric? })` | Vector data |
| `t.geoPoint()` | Geographic point |
| `t.enum(nameOrHandle)` | Declared enum |
| `t.domain(nameOrHandle)` | Declared domain |
| `t.encrypted({ of })` | Application-encrypted storage |

Columns are nullable unless you call `.notNull()`. Modifiers return new
definitions, so a base definition can be reused safely:

```ts
const money = t.numeric({ precision: 12, scale: 2 }).notNull();

table("invoices").create({
  columns: {
    id: t.bigInt().notNull().primaryKey().autoIncrement(),
    subtotal: money,
    tax: money.default(0),
    total: t.numeric({ precision: 12, scale: 2 })
      .generated((col) => col("subtotal").add(col("tax"))),
    labels: t.textArray().default([]),
    metadata: t.json().default({ source: "signup", revision: 1 }),
  },
});
```

Available modifiers include:

- `.notNull()`
- `.default(value)`
- `.primaryKey()`
- `.unique()`
- `.generated(expression, { virtual? })`
- `.identity({ always? })` and `.autoIncrement()`
- `.mask({ kind, classification? })`

Primary-key intent belongs on the initial table definition. Calling
`.primaryKey()` on a later added column does not add a primary-key constraint.
Create the primary key with the table or use a deliberate follow-up database
design.

`t.id({ prefix })` prefixes must start with a lowercase letter, contain only
lowercase letters, digits, and underscores, and be no more than four
characters. `usr` is reserved.

Generated columns cannot also have a default or identity. PostgreSQL supports
stored generated columns; SQLite and MySQL also support virtual generated
columns. Identity is limited to integer columns, with additional target
restrictions described in [Dialect support](dialects.md).

Masking and encryption declarations carry platform security metadata. They do
not replace database permissions, application key management, or access
control.

## Defaults and values

Use JavaScript literals or the package's value constructors:

```ts
table("jobs").create({
  columns: {
    id: t.uuid().notNull().default(uuidV4()),
    attempts: t.int().notNull().default(0),
    queued_at: t.timestamp().notNull().default(now()),
    tags: t.textArray().notNull().default([]),
    metadata: t.json().notNull().default({ priority: 2, source: "api" }),
    label: t.text().default((expr) =>
      expr.case({
        branches: [{ when: true, then: "new" }],
        else: "unknown",
      }),
    ),
  },
});
```

Supported scalar values include strings, booleans, null, finite non-integer
numbers, JavaScript-safe integers, and byte arrays. Column defaults also accept
compatible JSON values. For values that JavaScript cannot represent exactly,
use:

```javascript
import { byteValue, decimal } from "zero-migrate";

const exactAmount = decimal("9007199254740993");
const signature = byteValue(new Uint8Array([1, 2, 3, 4]));
```

`byteValue(new Uint8Array(...))` preserves every byte, including zero and
non-UTF-8 values. The string form, such as `byteValue("AQID")`, must be
well-formed base64 and is decoded into database bytes; the base64 text itself is
not stored. You can also pass a `Uint8Array` directly wherever a scalar value is
accepted, including compatible column defaults and backfill assignments.

Use `now()`, `uuidV4()`, and (on PostgreSQL 18+) `uuidV7()` when the database
should choose the value at apply time. `genRandomUuid()` remains as a deprecated
source alias for `uuidV4()` and records the same exact expression. JavaScript
`bigint` values are not accepted. A string default is always a string literal;
it is never interpreted as SQL.

PostgreSQL sequences can supply integer defaults through
`nextval("sequence_name")`. Sequence defaults are not portable to SQLite or
MySQL.

Defaults cannot refer to another column or use aggregates. For computed values
based on other columns, use a generated column or a data migration.

## Creating a table

`create` requires `columns` and accepts optional table-level features:

| Option | Purpose |
| --- | --- |
| `primaryKey` | Explicit list of primary-key columns |
| `uniques` | Named unique constraints |
| `checks` | Named check constraints |
| `foreignKeys` | Named foreign keys |
| `exclusions` | PostgreSQL exclusion constraints |
| `indexes` | Named indexes created with the table |
| `partitionBy` | Range, list, or hash partitioning |
| `options` | Platform runtime metadata |
| `ifNotExists` | Skip creation if the table already exists |
| `schema` | Override the handle's schema for this call |

```ts
table("memberships").create({
  columns: {
    account_id: t.uuid().notNull(),
    organization_id: t.uuid().notNull(),
    role: t.text().notNull().default("member"),
  },
  primaryKey: ["account_id", "organization_id"],
  uniques: [
    {
      name: "memberships_org_account_uq",
      columns: ["organization_id", "account_id"],
    },
  ],
  checks: [
    {
      name: "memberships_role_nonempty",
      expr: (col) => col("role").ne(""),
    },
  ],
  indexes: [
    { name: "memberships_role_idx", on: ["role"] },
  ],
});
```

Some table-level features are target-specific. If the same migration must run
on all three databases, prefer a named unique index over `uniques`, and review
foreign keys and checks against the [compatibility guide](dialects.md).

## Changing columns

Select a named column, then call one terminal operation:

```ts
const profiles = table("profiles");

profiles.column("bio").add({ type: t.text() });
profiles.column("bio").setNotNull();
profiles.column("bio").setDefault("");
profiles.column("legacy_note").drop({ ifExists: true });
```

Available column operations are:

- `add({ type, ifNotExists?, schema? })`
- `drop({ ifExists?, schema? })`
- `rename({ to, type, schema? })`
- `setType({ to, schema? })`
- `setNotNull()` and `dropNotNull()`
- `setDefault(value)` and `dropDefault()`
- `comment(textOrNull)` on PostgreSQL

Create a fresh `.column(name)` selector for each operation. A selector does
nothing until its terminal method is called, and one selector object cannot be
reused for a second terminal.

Column rename works on PostgreSQL and SQLite, but not MySQL. The `type` passed
to `rename` describes the unchanged column type. A rename cannot also change
type, and custom `using` expressions are not supported on any target.

### PostgreSQL online rename workflow

On PostgreSQL, `.rename(...)` is intentionally completed across multiple
deployments. A typical migration is:

```ts
export const name = "rename_profiles_bio";

export function up() {
  table("profiles").column("bio").rename({
    to: "biography",
    type: t.text(),
  });
}
```

On PostgreSQL, this rename must be the only operation in the migration that
targets `profiles`. This includes other schema changes, data changes, and a
second rename on the same table, whether they appear before or after this call.
Operations targeting different tables may remain in the migration. Put every
same-table follow-up in a later migration and apply it only after this rename is
resolved.

This isolation rule is PostgreSQL-only. SQLite performs the rename as one table
rebuild and may keep same-table operations in authored order. MySQL column
rename remains unsupported.

The `type` must describe the live source column's current PostgreSQL type. A
rename cannot also change the type, and the destination column must not already
exist. The live table must use `id` as its complete, non-null, single-column
primary key, with a supported orderable cursor type. It must have no
pre-existing enabled user triggers, and row-level policy must allow every
selected backfill row to be updated.

Supported PostgreSQL `id` cursor families are small integers, integers, big
integers, numeric or decimal, text or character strings, dates, timestamps, and
UUIDs. Floating-point, JSON, binary, and geometric types are not supported
backfill cursors.

The destination is nullable but otherwise keeps the source's exact live
PostgreSQL type. Type modifiers such as `numeric(10,2)` precision and scale or
`varchar(128)` length are preserved and checked again during resolution. A
modifier change, such as `numeric(10,2)` to `numeric(10,1)`, is refused.
Equivalent PostgreSQL spellings such as `timestamptz` and `timestamp with time
zone`, `decimal` and `numeric`, or `varchar` and `character varying` are accepted
without discarding their modifiers.
Schema-qualified enum and domain types are supported too, including names that
require PostgreSQL quoting; the rename preserves the exact live type.

`NOT NULL`, defaults, unique or primary-key rules, indexes, comments, and
dependent objects do not transfer. Review those semantics before rollout and
add them in separate follow-up migrations after resolution. Do not use this
workflow to rename the `id` primary key. Dependencies on the source can block
resolution, so audit them before rollout.

The first approved apply prepares the destination, copies existing values in
bounded batches, and returns a `pendingContracts` entry. The source and
destination columns then coexist while you deploy application code that uses
the destination. A write through either name keeps both values aligned; if one
statement supplies different values for both, the destination wins. Avoid
writing both names in one statement. Other migration changes to that table
remain blocked during this window.

After every application instance and database consumer has stopped using the
source column, resolve the returned `pendingVersion`. Applying the resolution
keeps the destination and drops the source. Aborting keeps the source and drops
the destination, so move the application back to the source before choosing
abort. The initial backfill and either resolution require explicit approval.

Keep the migration name, source, owner, project schema, and registry unchanged
throughout the workflow. An interrupted initial apply can be retried: completed
work skips and the backfill resumes. A pending rename is returned again on
repeat apply and is never completed implicitly.

Resolution cleanup is all-or-nothing. If it fails, both columns and the managed
rename trigger remain intact, the pending contract stays outstanding, and the
table remains blocked. Correct the cause and retry the same action.

After apply or abort resolution succeeds, the original migration identity is
terminal. Replaying that exact migration never opens another pending contract.
If you aborted and later want to try the rename again, author a new migration
with a new exported name. An aborted plan does not satisfy `dependsOn`, so any
dependent plan must point to the replacement migration identity.

Follow the complete commands in [CLI reference](cli.md#resolve-pending), or use
[`apply()` and `resolvePending()`](node-api.md#postgresql-online-column-rename)
from Node.

## Constraints

Named selectors make constraint changes easy to review:

```ts
const orders = table("orders");

orders.foreignKey("orders_account_fk").add({
  columns: ["account_id"],
  references: { table: "accounts", columns: ["id"] },
  onDelete: "cascade",
});

orders.unique("orders_external_id_uq").add({
  columns: ["external_id"],
});

orders.check("orders_total_nonnegative").add({
  expr: (col) => col("total_cents").ge(0),
});

orders.constraint("old_orders_rule").drop({ ifExists: true });
```

Foreign-key actions are `cascade`, `restrict`, `setNull`, `setDefault`, and
`noAction`. Deferrable constraints, `notValid` adoption, explicit validation,
standalone checks, exclusion constraints, and composite/non-`id` foreign keys
are PostgreSQL features.

A one-column foreign key to `id` and a unique constraint can be added on
PostgreSQL, SQLite, and MySQL. SQLite has additional restrictions when those
constraints are embedded directly in `table(...).create({...})`, so validate the
complete migration for SQLite.

## Indexes

Use a stable, descriptive name. Index elements can be column names, configured
column objects, or expression callbacks:

```ts
const messages = table("messages");

messages.index("messages_sent_at_idx").add({
  on: [{ column: "sent_at", order: "desc" }],
});

messages.index("messages_lower_email_idx").add({
  on: [{ expr: (col) => col("email").lower() }],
  where: (col) => col("deleted_at").isNull(),
});

messages.index("messages_sent_at_idx").drop({ ifExists: true });
```

`btree` indexes work on all targets. Expression and partial indexes work on
PostgreSQL and SQLite, but not MySQL. PostgreSQL additionally supports
`brin`, `gin`, `gist`, `ivfflat`, and `hnsw`, plus `include` columns,
storage parameters, operator classes, collations, `only`, and
`nullsNotDistinct`.

Current unsupported index options:

- Do not select `hash`, `spgist`, or `fts5` through this API.
- Do not rely on per-element `nulls`.
- Expression elements do not support per-element ordering, operator class,
  collation, or null ordering.
- Concurrent index drop is not supported.

Use a plain or unique named btree index for the broadest portability.

## Data changes

The DSL can describe insert, update, delete, and batched backfill operations:

```ts
const plans = table("plans");

plans.insert({
  rows: [
    { id: "free", price_cents: 0 },
    { id: "pro", price_cents: 2900 },
  ],
});

plans.insert({
  rows: { id: "pro", price_cents: 2900 },
  onConflict: {
    columns: ["id"],
    doUpdate: { price_cents: 2900 },
  },
});

plans.update({
  set: {
    label: (col) => col("label").trim(),
    price_cents: (col) => col("price_cents").coalesce(0),
  },
  where: (col) => col("active").isTrue(),
});

table("expired_sessions").delete({
  where: (col) => col("expires_at").lt("2026-01-01T00:00:00Z"),
  limit: 500,
});

table("users").backfill({
  name: "backfill_user_names",
  cursorColumn: "id",
  batchSize: 500,
  set: {
    first_name: (col) => col("full_name").splitPart(" ", 1),
  },
  where: (col) => col("first_name").isNull(),
});
```

Behavior to know:

- Schema and data operations run in authored order. A mixed migration does not
  drop its data steps, and a data-only migration performs real work.
- Multi-row inserts require the same keys in every row.
- `insert` does not support `INSERT ... SELECT`.
- `onConflict` uses an exact conflict target on PostgreSQL and SQLite. MySQL 8
  supports a non-empty `doUpdate` through its native duplicate-key clause. On
  MySQL, the target must exactly match every full column of one primary or unique
  index, all target columns must be in the inserted row, and `doUpdate` cannot
  assign them. Prefix and functional indexes do not prove a target. A collision
  on a different unique key fails. Targeted do-nothing is rejected on MySQL
  because the dialect has no exact native form.
- `update` without `where` updates the whole table.
- MySQL evaluates a multi-column `set` list in sequence, unlike PostgreSQL and
  SQLite. To keep one migration portable, zero-migrate rejects a MySQL
  `update`, `backfill`, or `onConflict.doUpdate` when one assigned value reads
  another column assigned by the same operation. Reading the column being
  assigned, such as `counter: (col) => col("counter").add(1)`, is supported.
- `delete` always requires `where`.
- Pending deletes and backfills require explicit operator approval. Inserts and
  updates do not, although an unrestricted update still deserves careful
  review. An unchanged completed delete or backfill skips on repeat apply
  without renewed approval; an interrupted backfill still needs approval to
  resume. Apply preflights every pending approval-gated step before the first
  authored step, so a later unapproved delete or backfill cannot follow an
  already-committed insert or update from the same plan.
- Every MySQL insert, update, delete, and backfill target must use InnoDB. Other
  storage engines are rejected before the mutation runs because they cannot
  provide atomic journaling. MySQL also refuses these structured data operations
  when the target has a user trigger, because it cannot prove that the trigger's
  side effects stay consistent with the migration journal.
- Backfill defaults are cursor `id`, batch size `1000`, and name
  `backfill_<table>`.
- On every target, a backfill cursor must be the table's complete, non-null,
  single-column primary key. A unique-only key or one column from a composite
  primary key is not sufficient. The backfill cannot assign the cursor.
- PostgreSQL and MySQL also require a supported orderable cursor type. A MySQL
  cursor cannot be a generated column or be automatically updated.
- SQLite additionally requires declared `INTEGER` or `TEXT` affinity. Existing
  cursor values must all use the matching SQLite storage class, and text cursors
  must be valid UTF-8. Embedded NUL characters are supported. Other or mixed
  cursor storage classes are rejected before that backfill changes rows.
- PostgreSQL and SQLite backfills reject target tables with pre-existing enabled
  user triggers. The managed PostgreSQL online rename workflow remains
  supported. A row-level policy that suppresses a selected update
  rolls the batch back without advancing progress.
- Before its first batch, a backfill captures a fixed terminal cursor. Each
  batch saves the last committed cursor, and a retry resumes after that cursor
  without chasing rows beyond the original boundary. This is a bounded cursor
  range, not a snapshot. Rows inserted after the backfill starts are not
  guaranteed to be included and should be handled by a later migration.
- Keep every paging primary-key value unchanged from the first batch through
  completion. The migration itself is rejected if it assigns the cursor, but
  your application and other database clients must follow the same rule while
  the backfill runs. Moving an unprocessed key behind the saved cursor can skip
  that row; moving a processed key ahead of it can process that row again.
- Every data step has a stable journal identity and carries the checksum of the
  complete migration, including bound values. An unchanged step is skipped on
  repeat apply; editing an applied migration fails with checksum drift.

## Expressions

Expression callbacks receive a callable column accessor. Chain methods compose
without SQL strings:

```ts
table("orders").update({
  set: {
    normalized_code: (col) => col("code").trim().upper(),
    display_total: (col) => col("subtotal").add(col("tax")).round(2),
    band: (col) =>
      col.case({
        branches: [
          { when: col("total").ge(10_000), then: "large" },
          { when: col("total").ge(1_000), then: "medium" },
        ],
        else: "small",
      }),
  },
  where: (col) =>
    col("state")
      .in(["open", "pending"])
      .and(col("deleted_at").isNull()),
});
```

The common expression vocabulary includes:

| Category | Methods |
| --- | --- |
| Comparison | `eq`, `ne`, `lt`, `le`, `gt`, `ge` |
| Boolean | `and`, `or`, `not` |
| Arithmetic | `add`, `sub`, `mul`, `div` |
| Null and booleans | `isNull`, `isNotNull`, `isTrue`, `isFalse` |
| Predicates | `between`, `like`, `in`, `notIn`, `distinctFrom` |
| Text | `concat`, `lower`, `upper`, `trim`, `length`, `substr`, `replace` |
| Numbers | `abs`, `mod`, `round`, `floor`, `ceil` |
| Null handling | `coalesce`, `nullif` |
| Date/string helpers | `extract`, `splitPart` |
| Aggregates | `count`, `sum`, `avg`, `min`, `max` |

Top-level helpers include `lit`, `now`, `uuidV4`, `uuidV7`, `concatWs`,
`countStar`, `interval`, `currentSetting`, and `currentUser`. Several are
PostgreSQL-only; see [Expression compatibility](dialects.md#expressions).

Use `.isNull()` and `.isNotNull()` instead of equality with null. Aggregates
belong in view projections or `having`, not in defaults, checks, generated
columns, index expressions, assignments, or ordinary predicates.

`splitPart(delimiter, part)` is portable when the delimiter is one ASCII
character and the part is from 1 through 8. PostgreSQL permits broader literal
delimiters and larger part numbers.

There is no raw expression or SQL-fragment interpolation. If an expression is
not supported, restructure it or use an explicit structured target branch.

## Views

The structured view builder supports projections, joins, filtering, grouping,
ordering, and limits:

```ts
view("active_account_totals").create({
  columns: ["account_id", "total_cents"],
  as: (q) =>
    q
      .from({ name: "orders", alias: "o" })
      .select([
        "account_id",
        (col) => col("o", "total_cents").sum(),
      ])
      .where((col) => col("o", "active").isTrue())
      .groupBy(["account_id"])
      .having((col) => col("o", "total_cents").sum().gt(0))
      .orderBy(["account_id"]),
});
```

Use `col("alias", "column")` for qualified references in joins. Plain
structured views work on PostgreSQL, SQLite, and MySQL.

Materialized views are PostgreSQL-only and require an operator-granted
capability. Raw view bodies also require a capability on every target and must
be exactly one read-only `SELECT`. Prefer the structured builder.

## Enums, domains, and sequences

Enums and domains provide reusable logical types:

```javascript
import { domain, enumType, sequence, table, t } from "zero-migrate";

export const name = "create_account_types";

export function up() {
  const accountState = enumType("account_state").create({
    values: ["invited", "active", "disabled"],
  });

  domain("positive_cents").create({
    as: t.bigInt(),
    check: (value) => value.ge(0),
    notNull: true,
  });

  table("accounts").create({
    columns: {
      state: t.enum(accountState).notNull(),
      balance: t.domain("positive_cents"),
    },
  });

  sequence("invoice_number_seq").create({
    as: t.bigInt(),
    start: 1000,
    increment: 1,
  });
}
```

Enum and domain declarations work across all three targets, although their
physical representation differs. Domain checks use the supplied `value`
expression and cannot refer to other columns.

Standalone sequences and `nextval` defaults are PostgreSQL-only. Sequence
integer options must be JavaScript safe integers; increment cannot be zero and
cache must be positive.

Like every operation terminal, `.create()` belongs inside the synchronous
`up()` function. Top-level terminals are rejected so every migration contains
only the changes authored in its own `up()` function.

## Partitions

PostgreSQL supports native range, list, and hash partitioning:

```javascript
import { table, t } from "zero-migrate";

table("events").create({
  columns: {
    id: t.uuid().notNull(),
    occurred_at: t.timestamp().notNull(),
  },
  primaryKey: ["id", "occurred_at"],
  partitionBy: { range: ["occurred_at"] },
});

table("events").partition("events_2026").create({
  from: ["2026-01-01T00:00:00Z"],
  to: ["2027-01-01T00:00:00Z"],
});

table("events").partition("events_rest").create({ default: true });
```

For SQLite or MySQL, `whenUnsupported: "collapse"` can explicitly choose one
ordinary unpartitioned table instead. Collapse is not automatic. Parent and
children must be described together, partition keys must be non-null, unique
keys must include the partition key, and the complete set of bounds must be
valid. Use collapse only when losing physical partitioning is acceptable.

Partition attach is a privileged PostgreSQL operation. Detach is PostgreSQL-only.

## Triggers

Trigger syntax differs by target. PostgreSQL executes a named function:

```javascript
table("audit_events").trigger("audit_events_guard").create({
  timing: "before",
  events: ["update", "delete"],
  forEach: "row",
  execute: "audit_events_guard_fn",
});
```

SQLite and MySQL use a structured body:

```javascript
table("audit_events").trigger("audit_events_append_only").create({
  timing: "before",
  events: ["update"],
  forEach: "row",
  body: (body) => [
    body.raise({ level: "abort", message: "audit_events is append-only" }),
  ],
});
```

Body helpers include `raise`, `insert`, `update`, `delete`, and `select`.
MySQL requires exactly one event. SQLite supports more trigger combinations,
including multiple events and conditional bodies. Dropping a trigger works on
all targets.

MySQL trigger creation is supported, but a table with a user trigger cannot be
the target of a structured `insert`, `update`, `delete`, or `backfill`. Plan
those data changes before adding the trigger, or remove and redesign the trigger
in a reviewed migration. zero-migrate will not guess whether trigger side effects
are safe to journal.

## Target-specific branches

Use `dialect()` when a meaningful implementation differs by database.

For a value or expression, provide named values and optionally a portable
default:

```ts
table("audit_entries").insert({
  rows: {
    actor_name: dialect({
      default: "system",
      pg: currentUser(),
    }),
    created_at: now(),
  },
});
```

For whole operations, provide functions:

```ts
dialect({
  default: () => {
    table("documents").index("documents_title_idx").add({
      on: ["title"],
    });
  },
  pg: () => {
    table("documents").index("documents_embedding_hnsw_idx").add({
      on: ["embedding"],
      using: "hnsw",
    });
  },
});
```

Available names are `pg`, `sqlite`, `mysql`, and `default`. If an operation has
neither a matching leg nor a default, that operation is skipped on the target.
An empty function documents an intentional no-op. Do not use a no-op when it
would remove a business-critical invariant.

Target branches do not bypass schema ownership, destructive approval, or
privileged-operation policy.

## Reusing application field definitions

If your application uses the bundled `dbType` field builders, `fromDb` converts
a storage-backed field into a migration column:

```ts
import { dbType as dbT, fromDb, table } from "zero-migrate";

export default {
  up() {
    const accountEmail = dbT.string().required().unique();
    const avatarBytes = dbT.bytes().optional();

    table("account_profiles").create({
      columns: {
        email: fromDb(accountEmail),
        avatar: fromDb(avatarBytes),
      },
    });
  },
};
```

Required and unique facets are preserved. Composite application shapes such as
objects, unions, literals, and arrays do not map to one database column; choose
an explicit migration type for them.

## Comments and PostgreSQL administration

Comments on tables, columns, indexes, constraints, views, types, sequences, and
functions are PostgreSQL-only. Pass `null` to remove a comment:

```javascript
import { comment, table } from "zero-migrate";

table("accounts").comment("Customer login accounts");
table("accounts").column("email").comment("Normalized login address");

comment(
  { kind: "function", schema: "app_data", name: "audit_change" },
  "Writes one audit event",
);
```

The package also supports privileged PostgreSQL administration:

- schemas and extensions;
- roles and search paths;
- grants, revokes, and `dropOwnedBy`;
- row-level security and policies;
- SQL and PL/pgSQL functions;
- materialized views;
- partition attachment;
- whole-statement `raw({ sql, reason })`.

These operations require explicit capabilities from the apply policy. Merely
targeting PostgreSQL does not grant them. The Node `policyCeiling` option is for
trusted table-shape policy and the CLI has no policy option; neither path grants
these privileged capabilities. Use a trusted Rust/custom host.
See [Security model](security-model.md) and
[Policy configuration](policy.md).

## The raw-statement boundary

`raw` is a last resort for one complete PostgreSQL statement:

```javascript
import { raw } from "zero-migrate";

raw({
  sql: "ALTER TABLE app_data.accounts SET (fillfactor = 80)",
  reason: "No structured table-storage option is available",
});
```

It requires a non-empty reason and the raw-SQL capability. It has no parameter
binding API and cannot be embedded inside an expression. The public Node API
and CLI cannot grant its required capability. Prefer structured operations
because they receive stronger portability and safety checks.

## Deterministic migrations

Migration files should produce the same plan every time they are loaded:

- Use `now()` instead of `Date.now()`.
- Use `uuidV4()` or supported `uuidV7()` instead of calling a random UUID function.
- Do not read environment variables, files, network responses, or the live
  clock to decide which operations to add.
- Keep database values inside structured expressions.

`lintDeterminism` can flag common accidental runtime values:

```ts
const findings = lintDeterminism(`
  table("events").insert({ rows: { created_at: Date.now() } });
`);

for (const finding of findings) {
  console.warn(finding.accessor, finding.suggested_fix);
}
```

The scan is advisory. It does not sandbox migration code or prevent side
effects. Preview and review the actual migration before apply.

## Safe guards and destructive changes

Use `ifNotExists` and `ifExists` where repeating a create or drop is genuinely
safe. A guard only tolerates presence or absence; it does not prove that an
existing object has the definition you expected.

Common guarded operations include tables, columns, constraints, indexes,
partitions, views, enums, domains, sequences, and triggers.

Drops, unrestricted updates, deletes, and other destructive changes need careful
review. Delete and backfill steps are always approval-gated. A successful type
check or preview is not approval to destroy or rewrite data.

## TypeScript, when you want it

Most users should rely on inference. For wrappers and shared helpers, the most
useful public types are:

```typescript
import type {
  ColumnDef,
  ExprFn,
  Migration,
  Row,
  TableHandle,
} from "zero-migrate";
```

`Migration` describes the module body, `ColumnDef` describes a `t.*` result,
`ExprFn` is an expression callback, and `Row` is useful for data-operation
helpers. The runtime API remains ordinary JavaScript.

## Common problems

| Symptom | What to check |
| --- | --- |
| An operation appears to do nothing | Make sure a selector ends with `add`, `drop`, `create`, or another terminal |
| A migration behaves differently between runs | Remove clock, randomness, environment, filesystem, and network reads |
| A delete or backfill is refused | Review the exact migration, then use Node `approved: true` or CLI `--approve` |
| A backfill cursor is rejected | Use the table's complete, non-null, single-column primary key; SQLite also requires `INTEGER` or `TEXT` affinity with matching stored values |
| A MySQL data step is rejected | Use InnoDB and remove or redesign user triggers on the target before applying structured data migrations |
| A feature fails only on one database | Check [Dialect support](dialects.md) and validate for that target |
| A schema operation is denied | Check project schema ownership and required capabilities |
| A default is treated as text | Strings are literals; use a structured helper rather than SQL text |
| Null comparison is rejected | Use `isNull()` or `isNotNull()` |
| A generated/index/check expression is rejected | Remove volatile functions, aggregates, and target-only helpers |
| A rollback body is ignored | Authored `down()` and public rollback are not supported |

See [Troubleshooting](troubleshooting.md) for setup, validation, driver, policy,
and recovery errors.

## Pre-apply checklist

- Use a unique timestamped filename and stable exported `name`.
- Keep `up()` synchronous and deterministic.
- Preview the exact operation order.
- Validate against every database target you deploy.
- Confirm delete/backfill approval and test the table's complete, non-null,
  single-column primary key as the backfill cursor on representative data.
- Plan a later migration for rows written after a backfill captures its terminal
  cursor.
- Name constraints, indexes, triggers, and policies.
- Review operations without a `where` clause.
- Confirm destructive approval, ownership, and privileged capabilities.
- Back up data before drops or irreversible type changes.
- Treat `dialect()` no-op legs and partition collapse as deliberate product
  decisions.
- Apply to a disposable environment before production.

## Next

- [Dialect support](dialects.md)
- [Getting started](getting-started.md)
- [Core concepts](concepts.md)
- [CLI reference](cli.md)
- [Node API](node-api.md)
- [Operating migrations](operations.md)
- [Security model](security-model.md)
