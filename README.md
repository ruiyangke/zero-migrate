# zero-migrate

> **Write once. Migrate everywhere.**

Define a database migration once in TypeScript, then target PostgreSQL, MySQL,
or SQLite without maintaining separate sets of handwritten SQL.

zero-migrate gives application teams:

- a typed, JavaScript-first migration API;
- portable tables, columns, indexes, constraints, and expressions;
- explicit escape hatches for database-specific features;
- staged PostgreSQL column renames with an explicit application cutover;
- validation before a database connection is opened;
- ownership and policy checks for platform-hosted migrations; and
- an append-only migration history.

Portability is deliberate, not magical. Common database features share one API;
vendor-only behavior is clearly marked and rejected on unsupported targets.

> **Pre-release:** the JavaScript packages are not published to npm yet. Use the
> source-checkout setup in [Getting started](docs/getting-started.md).

> **JavaScript security boundary:** migration modules run as ordinary JavaScript
> with the permissions of the Node process. The Node API and CLI are not a
> sandbox. Run trusted modules only. A platform that accepts untrusted or
> generated source must isolate it outside the deployment process and use a
> reviewed Rust/custom-host workflow.

> **Ordered schema and data apply:** on PostgreSQL and MySQL 8, the Node API and
> CLI execute schema changes, inserts, updates, deletes, and batched backfills in
> the order you authored them. Pending deletes and backfills require explicit
> approval. Approval is checked across the complete plan before any authored
> step runs, so a later unapproved data change cannot follow an already-committed
> earlier step from that plan. Matching completed steps skip on retry without
> renewed approval. SQLite executes the same operation categories through the
> Rust API.

## A portable migration

```ts
// migrations/20260715090000_create_orders.ts
import { now, table, t } from "zero-migrate";

export const name = "create_orders";

export default {
  up() {
    table("orders").create({
      columns: {
        id: t.id({ prefix: "ord" }),
        total: t.numeric({ precision: 12, scale: 2 }).notNull(),
        status: t.text().notNull().default("pending"),
        created_at: t.timestamp().notNull().default(now()),
      },
    });

    table("orders").index("orders_status_idx").add({
      on: ["status"],
    });

    table("orders").insert({
      rows: { total: 0, status: "pending" },
    });
  },
};
```

The same migration can be checked for PostgreSQL, MySQL 8, or SQLite. If you
choose a database-specific feature, you declare that choice in the migration so
other targets fail with a clear validation error.

## What you can use today

| Workflow | PostgreSQL | MySQL 8 | SQLite |
| --- | --- | --- | --- |
| TypeScript authoring and validation | Yes | Yes | Yes |
| Node API / CLI schema and data apply | Yes | Yes | Not yet |
| Rust schema and data apply | Yes | Yes | Yes |
| Ordered insert/update/delete/backfill | Yes; no enabled user triggers except those managed by an online rename | Yes, on InnoDB tables without user triggers | Rust only |
| Column rename workflow | Staged online flow through Node or CLI | Unsupported | One Rust table rebuild |
| Migration status | Node and Rust | Node and Rust | Rust |
| Detailed append-only history | Node and Rust | Not yet | Not yet |

MariaDB is not a supported target. The MySQL path targets MySQL 8.

Backfills capture a fixed terminal cursor before their first batch, save the
last committed cursor, and stop at that original boundary. Rows inserted after
the backfill starts are not guaranteed to be included; migrate them with a later
migration. On every target, the cursor must be the table's complete,
single-column primary key. Its values must remain unchanged for the entire
backfill: moving a key behind the saved cursor can miss a row, while moving a
processed key ahead can repeat it. SQLite additionally requires declared
`INTEGER` or `TEXT` affinity with consistently typed live values. SQLite Rust apply
coordinates zero-migrate processes that target the same application database
and refuses unsafe database or journal settings.

PostgreSQL column rename keeps the source and destination available while the
application moves to the new name. In that PostgreSQL migration, the rename
must be the only operation targeting its table. Operations on other tables may
remain in the same migration. Put same-table follow-up work in a later migration
and apply it only after resolution. The initial approved apply returns a
`pendingVersion`; after every application instance has moved, resolve it with
Node `resolvePending()` or CLI `resolve-pending`. Apply resolution keeps the
destination and drops the source. Abort keeps the source and drops the
destination. Cleanup is all-or-nothing: if it fails, both columns and the
managed rename trigger remain intact and the pending version stays valid. Apply
and abort are terminal for that migration identity. To try again after abort,
author a new migration with a new exported name. Status reports the old plan as
`aborted`, and it does not satisfy `dependsOn`. The destination is nullable but
keeps the source's exact live PostgreSQL type, including type modifiers.
Required constraints, defaults, indexes, comments, and dependent objects need
separate follow-up migrations. Dependencies on the source can block resolution
and must be audited before rollout. See the
[online rename workflow](docs/operations.md#postgresql-online-column-rename).

## JavaScript packages

| Package | Use it for |
| --- | --- |
| `zero-migrate` | Writing typed migration modules |
| `zero-migrate-engine` | Validating and applying ordered schema/data migrations, resolving PostgreSQL online renames, and reading status from Node or the CLI |

The package names are reserved by this workspace but are not published to npm
for this release.

## Why zero-migrate

- **One authoring experience.** Use the same TypeScript vocabulary across the
  supported databases.
- **Clear portability rules.** Validation catches unsupported target features
  before deployment.
- **Safer platform operation.** Ownership, policy, approval, database
  privileges, and migration history can be combined by a trusted host.
- **Reproducible review.** Preview the exact structured changes before apply and
  detect changes to previously reviewed migrations.
- **JavaScript first, Rust when needed.** Most users author and operate from
  TypeScript. Advanced hosts can use the documented public Rust types.

## Start here

1. [Getting started](docs/getting-started.md): set up the pre-release and apply
   your first schema and data migration.
2. [Writing migrations](docs/writing-migrations.md): the complete TypeScript
   authoring guide.
3. [Choosing a database target](docs/dialects.md): portability and
   database-specific features.
4. [CLI reference](docs/cli.md) or [Node API](docs/node-api.md): choose how to
   run migrations.
5. [Operating migrations](docs/operations.md): approvals, deployment, history,
   recovery, and safe roll-forward practice.
6. [Documentation home](docs/README.md): all guides and current limitations.

Rust hosts can continue with the [Rust API](docs/embedding.md), which documents
the public types and supported backend workflows without requiring knowledge of
the project internals.

## Project status

zero-migrate is pre-release. The Rust workspace is version `0.1.0` and the
JavaScript workspaces are version `0.0.0`. Expect API changes until the first
stable release, pin the exact revision you deploy, and review the documented
limitations before production use.

## License

Apache-2.0.
