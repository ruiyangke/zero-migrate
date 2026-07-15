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
| `zero-migrate-engine` | Preview, validate, plan, apply, inspect status/history, and run the CLI |

A migration module is ordinary TypeScript:

```ts
import { now, table, t } from "zero-migrate";

export const name = "create_projects";

export default {
  up() {
    table("projects").create({
      columns: {
        id: t.id({ prefix: "proj" }),
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

The CLI supplies a small set of options for local and create-first workflows. A
Node host can provide the complete public JavaScript option set:

```ts
import { apply } from "zero-migrate-engine";
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
They check the migration document, selected dialect, and supplied table
ownership without opening a database.

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

The public Node API uses a confined built-in policy. Custom policy composition
is available to Rust hosts for planning and host decisions, but arbitrary custom
policy cannot yet be passed to the public apply API.

Destructive work needs explicit operator approval. Node exposes a coarse
`approved` boolean; the CLI does not expose approval. Review and approve the
exact migration content, not only its filename.

## Apply and history

From a user's perspective, apply:

1. validates the migration and trusted host inputs;
2. checks policy and approval;
3. acquires the project lock;
4. checks previously applied migration identities and checksums;
5. executes pending supported work;
6. records the result in append-only history;
7. releases the lock and database session.

A set of migration files is not one global transaction. If a later migration
fails, earlier completed migrations remain applied.

PostgreSQL and SQLite can make supported transactional schema work and its
history event atomic. MySQL DDL auto-commits, so interrupted deployments use a
separate recovery flow.

## Database support

| Target | JavaScript apply | Rust apply | Important behavior |
| --- | --- | --- | --- |
| PostgreSQL | Yes | Yes | Broadest feature set; supports transactional and explicitly non-transactional work |
| MySQL 8 | Yes | Yes | Supported DDL subset; DDL auto-commits |
| SQLite | No | Yes | In-process Rust backend; some table changes require rebuilds |

There is no MariaDB compatibility promise. Treat the MySQL target as MySQL 8.

The same migration can target all three only when every operation and expression
is supported everywhere. Use `dialect()` for explicit, reviewed differences.
See [Dialect support](dialects.md).

## Current JavaScript boundaries

- The JavaScript packages are not published to npm yet; use the documented
  source-checkout workflow.
- JavaScript apply currently executes DDL only. It can validate and preview
  `insert`, `update`, `delete`, and `backfill`, but it does not execute them.
- A mixed migration can therefore apply schema changes while omitting data
  changes; keep data operations out of Node/CLI apply workflows.
- JavaScript apply supports PostgreSQL and MySQL 8, not SQLite.
- CLI plan currently targets PostgreSQL.
- The CLI cannot supply an ownership registry, so later changes to an existing
  table generally require the Node API or a Rust host.
- JavaScript status reads journal state but does not discover pending files.
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
