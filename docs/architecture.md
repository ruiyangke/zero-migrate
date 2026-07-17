# How zero-migrate works

zero-migrate separates writing a database change from deciding where and how it
runs. Authors write one typed JavaScript migration; the deployment host chooses
the database target, project identity, ownership information, credentials, and
approval.

## The migration journey

```text
TypeScript migration
        │ preview and validate
        ▼
reviewed migration document
        │ add trusted project and operator inputs
        ▼
PostgreSQL / MySQL 8 / SQLite
        │ apply supported work
        ▼
append-only migration history
```

This gives users three practical benefits:

- migration intent can be reviewed before deployment;
- unsupported database features fail clearly instead of being guessed;
- the deployment environment, not the migration file, controls authority.

## The JavaScript experience

Most users work with two packages:

| Package | Use it for |
| --- | --- |
| `zero-migrate` | Write migrations with `table`, `view`, `t`, expressions, and related helpers |
| `zero-migrate-cli` | Preview, validate, plan, apply, resolve PostgreSQL online renames, inspect status/history, and run the CLI |

A migration module is ordinary TypeScript:

```ts
import { ids, now, table, t } from "zero-migrate";

export const name = "create_projects";

export default {
  up() {
    table("projects").create({
      columns: {
        id: ids.typeId({ prefix: "proj" }).primaryKey(),
        name: t.text().notNull(),
        created_at: t.timestamp().notNull().default(now()),
      },
      indexes: [
        { name: "projects_name_uq", on: ["name"], unique: true },
      ],
    });
  },
};
```

Calling these helpers describes the change; it does not connect to a database.

Migration modules are still executable JavaScript. The Node API and CLI do not
sandbox them. Run trusted modules directly, or evaluate untrusted/generated
source in a separate no-secrets, no-authority sandbox and use a reviewed
Rust/custom-host workflow for deployment.

## What the deployment host controls

The migration file intentionally does not control:

- database URL or credentials;
- authenticated application identity;
- project schema or database;
- ownership of existing tables;
- operator policy;
- destructive-change approval;
- audit identity written to history.

The CLI accepts the project schema, owner, ownership registry, and approval for
initial and follow-up deployments. A Node host can additionally provide the
complete public JavaScript option set, including a migration role and audit
actor:

```ts
import { apply } from "zero-migrate-cli";
import * as migration from "./migrations/20260715090000_create_projects.js";

await apply({
  migration,
  ownerApp: "app_projects",
  projectSchema: "app_projects",
  registry: {
    projects: "app_projects",
  },
  driver: {
    kind: "postgres",
    url: process.env.DATABASE_URL!,
  },
  approved: false,
  appliedBy: "deploy:production",
});
```

See [Node API](node-api.md) for the exact JavaScript types.

## Preview, validation, and planning

The public JavaScript preview, `validate()`, and `plan()` workflows are offline.
They check the migration document, selected dialect, project-schema confinement,
and supplied table ownership without opening a database.

They are not a simulation of the live database. They do not render final SQL,
compare the live schema, or predict runtime locks and database errors.

Apply performs the additional deployment checks: project confinement, policy,
approval, migration history, locking, and target execution.

## Ownership and project confinement

`ownerApp` identifies the application deploying the migration.
`projectSchema` identifies the SQL namespace it owns. `registry` maps existing
tables to their trusted owners:

```ts
const registry = {
  users: "app_identity",
  orders: "app_orders",
};
```

A migration can create and then alter a table within one module. A later module
that alters an existing table needs a matching registry entry. Unknown or
mismatched ownership fails closed.

The project schema or database must exist before JavaScript apply. zero-migrate
does not create that outer namespace for you.

## Policy and approval

Policy controls sensitive capabilities such as destructive operations, raw SQL,
cross-schema access, roles, extensions, and optional platform-owned table
requirements.

The public Node API uses a confined default and optionally accepts a trusted
table-shape `policyCeiling`. Custom policy composition is available to Rust
hosts for planning and host decisions. Node `apply()` and `resolvePending()` use
their documented options and coarse approval boolean; neither accepts an
arbitrary custom executor policy.

Pending destructive work and backfills need explicit operator approval. Node
uses `approved: true`; the CLI uses `--approve`. Review and approve the exact
migration content, not only its filename.

## Apply and history

From a user's perspective, apply:

1. validates the migration and trusted host inputs;
2. reads the current target catalog for live-dependent table, column, and index
   checks;
3. checks policy;
4. acquires the project lock;
5. checks previously applied migration and step identities, backfill progress,
   and the complete migration checksum;
6. preflights approval for every pending gated step in the complete plan;
7. executes pending schema, insert, update, delete, and backfill steps in
   authored order;
8. records each completed step in append-only history;
9. returns any outstanding PostgreSQL online renames in `pendingContracts`;
10. releases the lock and database session.

The catalog read is not a complete structural-drift comparison or a
database-backed simulation. The database can still change or reject work during
execution.

A set of migration files is not one global transaction. If a later migration
fails, earlier completed migrations remain applied.

PostgreSQL and SQLite can make supported transactional schema or ordinary data
work and its history event atomic. MySQL ordinary data statements are
transactional, but MySQL DDL auto-commits, so interrupted schema deployments use
a separate recovery flow. Backfills commit bounded batches and save their
cursor so an interrupted run can resume within a fixed terminal boundary
captured before the first batch.

## PostgreSQL online rename lifecycle

```text
approved initial apply
        -> pendingContracts
        -> application cutover
        -> approved apply or abort resolution
        -> settled status
```

A PostgreSQL `.column(source).rename({ to, type })` separates database
preparation from application cutover. The source must exist, the destination
must not exist, and the declared type must match the source's live type. The
table also needs `id` as its complete, non-null, single-column primary key with
a supported orderable type, no pre-existing enabled user triggers, and row-level
policy that permits every selected backfill update.

The rename must be the only operation in that PostgreSQL migration that targets
the table. Operations on different tables may remain. Same-table schema and data
work belongs in a later migration that runs only after resolution.

The approved initial apply copies existing values and returns a
`pendingContracts` entry. The source and destination coexist while application
instances and other consumers move to the destination. Other migration changes
to that table are blocked during this window.

Writes through either name keep the values aligned; when both names receive
different values in one statement, the destination wins. The destination is
nullable but otherwise keeps the source's exact live PostgreSQL type, including
modifiers. Equivalent built-in aliases are accepted, while modifier drift is
refused during resolution. Defaults, constraints, indexes, comments, and
dependent objects need separate review and follow-up migrations after
resolution. Source dependencies can block resolution and must be audited before
rollout.

The operator then passes the returned `pendingVersion` to Node
`resolvePending()` or CLI `resolve-pending`. Apply resolution keeps the
destination and drops the source. Abort keeps the source and drops the
destination. Both require approval. A repeat initial apply skips completed work,
resumes interrupted backfill progress, and returns an already-open obligation
again without resolving it.

Resolution cleanup is all-or-nothing. A failure leaves both columns and the
managed rename trigger intact, keeps the obligation pending, and keeps the table
blocked. After apply or abort succeeds, the original migration identity is
terminal and exact replay cannot open a new obligation. Trying again after an
abort requires a new migration name. Status reports the terminal plan and its
deferred contract steps as `aborted`, and includes the plan ID in top-level
`aborted`. An aborted plan does not satisfy `dependsOn`; dependent plans remain
blocked until they reference a replacement migration.

## Database support

| Target | JavaScript apply | Rust apply | Important behavior |
| --- | --- | --- | --- |
| PostgreSQL | Yes, schema and data | Yes, schema and data | Broadest feature set; supports transactional and explicitly non-transactional work |
| MySQL 8 | Yes, schema and data | Yes, schema and data | Supported DDL subset; DDL auto-commits; data migrations require trigger-free InnoDB targets |
| SQLite | No | Yes, schema and data | Cross-process migration coordination; unsafe application/journal settings are refused; some table changes require rebuilds |

There is no MariaDB compatibility promise. Treat the MySQL target as MySQL 8.

The same migration can target all three only when every operation and expression
is supported everywhere. Use `dialect()` for explicit, reviewed differences.
See [Dialect support](dialects.md).

## Current JavaScript boundaries

- The JavaScript packages are not published to npm yet; use the documented
  source-checkout workflow.
- JavaScript apply executes supported DDL, `insert`, `update`, `delete`, and
  `backfill` steps in authored order on PostgreSQL and MySQL 8.
- Pending deletes and backfills require explicit approval. Approval is
  preflighted across the complete plan before any authored step executes.
- Backfills capture a fixed terminal cursor before the first batch, resume after
  the last committed cursor tuple, and do not chase later rows. `cursorColumns`
  must be the exact ordered, non-null tuple of a primary or unique candidate key
  with compatible comparison semantics. Authors must select either a managed
  `guardUpdates` cursor guard or an approved, named `externalInvariant`.
  Concurrent inserts require a write invariant that makes new rows miss the
  filter, or a final catch-up while writes are stopped.
- MySQL structured data migrations require trigger-free InnoDB targets.
- PostgreSQL backfills require no pre-existing enabled user triggers; the
  managed online rename workflow remains supported.
- PostgreSQL online rename requires an approved initial backfill and a later
  approved `resolvePending()` or CLI `resolve-pending` action. The rename must be
  its table's only operation in that migration, and later changes to the table
  remain blocked until resolution. Operations on other tables are allowed.
- JavaScript apply supports PostgreSQL and MySQL 8, not SQLite.
- CLI plan validates the explicitly selected PostgreSQL, MySQL, or SQLite
  dialect.
- CLI plan, apply, and status accept a trusted JSON ownership registry for later
  changes to existing tables.
- JavaScript apply and plan-aware status read the PostgreSQL or MySQL target
  catalog before preparing live-dependent work.
- JavaScript status is plan-aware on PostgreSQL and MySQL when supplied the
  ordered migration set; the CLI supplies the discovered directory.
- JavaScript history is currently PostgreSQL-only.
- Structural schema drift checks require an explicit Rust workflow.
- There is no public high-level rollback command; prefer a forward fix.

## Rust integrations

Rust hosts can access additional database backends and planning, drift,
reconciliation, policy, and approval capabilities. The user-facing public Rust
types are documented separately in [Rust API](embedding.md).

## Next

- [Getting started](getting-started.md)
- [Writing migrations](writing-migrations.md)
- [Node API](node-api.md)
- [Operating migrations](operations.md)
- [Rust API](embedding.md)
- [Security model](security-model.md)
- [Documentation home](README.md)
