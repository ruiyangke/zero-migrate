# Writing migrations

Use the `zero-migrate` package to describe schema changes in ordinary
JavaScript. TypeScript is optional: the API and module shape are the same, while
TypeScript adds autocomplete and earlier feedback.

This guide starts with a complete migration, then covers tables, columns,
indexes, constraints, views, data changes, expressions, target-specific
features, and safe rollout.

> **Important data-migration limitation:** the public Node API and CLI do not
> execute structured `insert`, `update`, `delete`, or `backfill` steps on
> PostgreSQL or MySQL. They can load and validate those steps, so a successful
> preview or validation is not proof that the data changed. Use a supported
> Rust backend for data migrations: PostgreSQL supports one-shot data
> operations, SQLite supports one-shot operations and backfills, and MySQL data
> execution is not currently available.

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

- `name` gives the migration a stable label in previews and history.
- `up()` contains the ordered changes.
- `table("accounts")` selects the object to change.
- `t` builds column definitions.
- String values such as `"invited"` are data, never SQL fragments.

Migration discovery is filename-based and lexicographic. Use sortable timestamp
prefixes and never rename or edit a migration after it has been applied to a
shared environment.

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
2. Add schema operations to `up()`.
3. Preview the operations and review their order.
4. Validate for the intended target database.
5. Review destructive changes and target-specific capabilities.
6. Apply with the Node/CLI path for supported schema work, or use the Rust API
   when the migration contains supported data operations or needs SQLite apply.
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
    id: t.uuid().notNull().default(genRandomUuid()),
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

Supported values include strings, booleans, null, finite numbers, byte arrays,
and compatible JSON values. For values that JavaScript cannot represent exactly,
use:

```javascript
import { byteValue, decimal } from "zero-migrate";

const exactAmount = decimal("9007199254740993");
const signature = byteValue(new Uint8Array([1, 2, 3, 4]));
```

Use `now()` and `genRandomUuid()` when the database should choose the value at
apply time. JavaScript `bigint` values are not accepted. A string default is
always a string literal; it is never interpreted as SQL.

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
to `rename` describes the column after the rename. Type changes with a custom
`using` expression are not supported on any target.

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

- Multi-row inserts require the same keys in every row.
- `insert` does not support `INSERT ... SELECT`.
- `onConflict` is PostgreSQL-only.
- `update` without `where` updates the whole table.
- `delete` always requires `where`.
- Backfill defaults are cursor `id`, batch size `1000`, and name
  `backfill_<table>`.
- A backfill cursor must be stable and orderable, and cannot be one of the
  columns being assigned.

Most importantly, choose an execution path that actually runs the data step.
The public Node API and CLI currently do not execute any of these four
structured operations. PostgreSQL embedding supports insert/update/delete;
SQLite embedding supports insert/update/delete/backfill; MySQL data execution
is not available.

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

Top-level helpers include `lit`, `now`, `genRandomUuid`, `concatWs`,
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
```

Enum and domain declarations work across all three targets, although their
physical representation differs. Domain checks use the supplied `value`
expression and cannot refer to other columns.

Standalone sequences and `nextval` defaults are PostgreSQL-only. Sequence
integer options must be JavaScript safe integers; increment cannot be zero and
cache must be positive.

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
targeting PostgreSQL does not grant them. The public Node API and CLI cannot
currently supply the required policy ceiling, so these operations are not
available end to end through that host; use a trusted Rust/custom host.
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
- Use `genRandomUuid()` instead of calling a random UUID function.
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

Drops, unrestricted updates, deletes, and other destructive changes should go
through the host's approval flow. A successful type check or preview is not
approval to destroy data.

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
| Validation succeeds but data is unchanged after Node/CLI apply | Structured data steps are not executed by the public Node/CLI path |
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
- Verify the chosen apply path executes every operation category, especially
  data changes and backfills.
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
