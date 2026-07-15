# zero-migrate

> **Write once. Migrate everywhere.**

Define a database migration once in TypeScript, then target PostgreSQL, MySQL,
or SQLite without maintaining separate sets of handwritten SQL.

zero-migrate gives application teams:

- a typed, JavaScript-first migration API;
- portable tables, columns, indexes, constraints, and expressions;
- explicit escape hatches for database-specific features;
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

> **Current JavaScript apply boundary:** Node and CLI apply schema changes only.
> Inserts, updates, deletes, and backfills can be authored and previewed, but are
> not executed by the current JavaScript apply path. See
> [Current capabilities](docs/README.md#current-capabilities).

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
| Node API / CLI schema apply | Yes | Yes | Not yet |
| Rust schema apply | Yes | Yes | Yes |
| Node API / CLI data changes | Not yet | Not yet | Not yet |
| Migration status | Node and Rust | Rust | Rust |
| Detailed append-only history | Node and Rust | Not yet | Not yet |

MariaDB is not a supported target. The MySQL path targets MySQL 8.

## JavaScript packages

| Package | Use it for |
| --- | --- |
| `zero-migrate` | Writing typed migration modules |
| `zero-migrate-engine` | Validating, applying schema changes, and reading status from Node or the CLI |

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

1. [Getting started](docs/getting-started.md) — set up the pre-release and apply
   your first schema migration.
2. [Writing migrations](docs/writing-migrations.md) — the complete TypeScript
   authoring guide.
3. [Choosing a database target](docs/dialects.md) — portability and
   database-specific features.
4. [CLI reference](docs/cli.md) or [Node API](docs/node-api.md) — choose how to
   run migrations.
5. [Operating migrations](docs/operations.md) — approvals, deployment, history,
   recovery, and safe roll-forward practice.
6. [Documentation home](docs/README.md) — all guides and current limitations.

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
