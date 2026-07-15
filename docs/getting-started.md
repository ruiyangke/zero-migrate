# Getting started

This guide takes you from a source checkout to your first validated and applied
zero-migrate migration. The live example uses PostgreSQL. MySQL and SQLite
differences are covered at the end.

zero-migrate is currently pre-release: `zero-migrate` and
`zero-migrate-engine` are not published to npm yet. For now, use this repository
checkout.

## Before you begin

You need:

- Node.js 22
- pnpm 10
- stable Rust and the build tools required by your operating system
- PostgreSQL for the live walkthrough

Keep these current limits in mind:

- Migration files run as ordinary JavaScript. They are **not sandboxed**. Run
  only code you trust. Untrusted or generated source must be evaluated in an
  external sandbox with no secrets or database access, then deployed through a
  reviewed Rust/custom-host workflow.
- JavaScript and CLI apply currently execute **schema changes only**. Do not use
  this path for `insert`, `update`, `delete`, or `backfill` migrations.
- The Node API can apply to PostgreSQL and MySQL. It can validate for SQLite, but
  SQLite apply currently requires a Rust host.
- The CLI is best suited to create-first migrations. Later files that change an
  existing table need the Node API and an ownership registry.

## 1. Prepare the checkout

From the repository root:

```bash
pnpm install --frozen-lockfile
pnpm build

cd crates/zero-migrate-node
npm install
npm run build
cd ../..
```

Point zero-migrate at the `.node` file produced by that build. For example, on
Linux x64:

```bash
export ZERO_MIGRATE_ADDON_PATH="$PWD/crates/zero-migrate-node/zero-migrate-node.linux-x64-gnu.node"
```

Use the filename generated for your operating system and CPU architecture.

The source-checkout CLI lives in the engine workspace. Run the rest of this
walkthrough from there:

```bash
cd sdks/engine
pnpm exec tsx dist/cli-bin.js --help
```

The full `pnpm exec tsx dist/cli-bin.js` prefix appears below so every command
can be copied as written.

## 2. Create a migration

Create the migrations directory and a timestamped file:

```bash
pnpm exec tsx dist/cli-bin.js new create_users --dir ./migrations
```

Open the generated file and replace its contents:

```ts
import { now, table, t } from "zero-migrate";

export const name = "create_users";

export default {
  up() {
    table("users").create({
      columns: {
        id: t.id({ prefix: "user" }),
        email: t.text().notNull(),
        display_name: t.text(),
        state: t.text().notNull().default("invited"),
        created_at: t.timestamp().notNull().default(now()),
      },
    });

    table("users").index("users_email_uq").add({
      on: ["email"],
      unique: true,
    });
  },
};
```

A migration module exports either a named `up()` function or a default object
with an `up()` method. Keep all migration calls synchronous inside that method.

The most important authoring rules are:

- Columns are nullable unless you call `.notNull()`.
- A `t.id({ prefix })` prefix is at most four characters, starts with a
  lowercase letter, uses only lowercase letters, digits, or underscores, and
  cannot be the reserved prefix `usr`.
- Build defaults with helpers such as `now()` instead of SQL strings.
- A selector such as `.column("name")` does nothing until you call an action
  such as `.add(...)`, `.alter(...)`, or `.drop()`.
- Keep migration output deterministic. Do not branch on the clock, random
  values, environment variables, network responses, or mutable global state.

Here is another complete, portable create-first migration:

```ts
import { now, table, t } from "zero-migrate";

export const name = "create_projects";

export default {
  up() {
    table("projects").create({
      columns: {
        id: t.id({ prefix: "proj" }),
        name: t.text().notNull(),
        archived: t.boolean().notNull().default(false),
        created_at: t.timestamp().notNull().default(now()),
      },
    });

    table("projects").index("projects_name_idx").add({
      on: ["name"],
    });
  },
};
```

You do not need to add this second example to the walkthrough directory. It is
included to show that migrations remain ordinary typed TypeScript modules.

## 3. Preview what will change

Preview all files in filename order:

```bash
pnpm exec tsx dist/cli-bin.js preview --dir ./migrations
```

For machine-readable output:

```bash
pnpm exec tsx dist/cli-bin.js preview --dir ./migrations --json
```

Preview is offline; it does not connect to a database. Check the migration name,
operation order, column options, defaults, indexes, and any database-specific
branches.

## 4. Validate before connecting

Run the offline plan check:

```bash
pnpm exec tsx dist/cli-bin.js plan \
  --dir ./migrations \
  --owner-app app_demo \
  --schema app_demo
```

The command exits non-zero when a migration is invalid, unsupported, or attempts
to modify an object owned by another application. It is a useful CI check, but
it does not inspect your live schema, test database permissions, or guarantee
that apply will succeed.

The CLI plan command currently validates for PostgreSQL. Use the Node `plan()`
API with `dialect: "mysql"` or `dialect: "sqlite"` for those targets.

## 5. Prepare PostgreSQL

Create the project schema before the first apply:

```sql
CREATE SCHEMA IF NOT EXISTS app_demo;
```

Use a dedicated, least-privilege migration account in production. Provision
that account and its grants outside this walkthrough; the application-facing
CLI has no provisioning command.

Set the connection URL without placing a production password in shell history:

```bash
export DATABASE_URL="postgres://user:password@127.0.0.1:5432/example"
```

In a real deployment, inject this value from your secret manager.

## 6. Apply the migration

> **Schema changes only:** the current JavaScript/CLI path does not execute
> `insert`, `update`, `delete`, or `backfill` operations. A data-only migration
> can appear successful without changing rows, and a mixed migration can apply
> its schema changes while skipping its data changes.

Apply the directory:

```bash
pnpm exec tsx dist/cli-bin.js apply \
  --dir ./migrations \
  --database-url "$DATABASE_URL" \
  --schema app_demo \
  --owner-app app_demo
```

The CLI applies files in lexicographic filename order and reports which
migrations were applied, skipped, or recovered. It calls apply once per file,
but a file can still contain several database changes that commit separately.
Neither one file nor the whole directory is guaranteed to be an all-or-nothing
transaction. Inspect the schema and history before retrying a partial failure.

Destructive changes require explicit approval. The CLI does not currently offer
an approval flag, so use the Node API for a reviewed destructive migration.

## 7. Inspect status

```bash
pnpm exec tsx dist/cli-bin.js status \
  --database-url "$DATABASE_URL" \
  --schema app_demo \
  --owner-app app_demo \
  --json
```

Status currently reads the PostgreSQL migration journal, but the public Node/CLI
command does not compare it with the files in `./migrations`. A blank pending
list therefore does not prove that every local file was applied.

PostgreSQL journal history is available through the Node `history()` API. See
[Node API](node-api.md#history) for its return type and the `bigint` JSON
handling example.

## 8. Use the Node API

Applications and deployment tools can validate and apply an imported migration
directly:

```ts
import { apply, plan } from "zero-migrate-engine";
import * as migration from "./migrations/20260715090000_create_users.js";

const report = plan({
  migration,
  ownerApp: "app_demo",
  dialect: "postgres",
  nameFallback: "create_users",
});

if (!report.ok) {
  throw new Error(report.error ?? "migration validation failed");
}

const result = await apply({
  migration,
  ownerApp: "app_demo",
  projectSchema: "app_demo",
  driver: {
    kind: "postgres",
    url: process.env.DATABASE_URL!,
  },
  approved: false,
  appliedBy: "deploy",
  nameFallback: "create_users",
});

console.log(result);
```

As with the CLI, importing the module executes ordinary JavaScript and apply is
currently DDL-only.

## 9. Change an existing table

A later migration can add a column:

```ts
import { table, t } from "zero-migrate";

export const name = "add_user_timezone";

export default {
  up() {
    table("users")
      .column("timezone")
      .add({ type: t.text().notNull().default("UTC") });
  },
};
```

When a migration touches a table created by an earlier file, the host must
provide the trusted ownership registry:

```typescript
import { apply } from "zero-migrate-engine";
import * as migration from "./migrations/20260715100000_add_user_timezone.js";

await apply({
  migration,
  ownerApp: "app_demo",
  projectSchema: "app_demo",
  registry: {
    users: "app_demo",
  },
  driver: {
    kind: "postgres",
    url: process.env.DATABASE_URL!,
  },
  appliedBy: "deploy",
  nameFallback: "add_user_timezone",
});
```

The migration's own ownership claim is not trusted. Build this registry from
your platform's authoritative application-to-table mapping. The current CLI has
no registry option, so use the Node API for this workflow.

## MySQL

Use MySQL 8 and set the database name as the project schema:

```bash
export DATABASE_URL="mysql://user:password@127.0.0.1:3306/app_demo"

pnpm exec tsx dist/cli-bin.js apply \
  --dir ./migrations \
  --database-url "$DATABASE_URL" \
  --schema app_demo \
  --owner-app app_demo
```

Before apply, validate with the Node API and `dialect: "mysql"`. MySQL DDL
auto-commits, so a failed deployment may require checking both the live schema
and the migration journal before retrying. MariaDB is not a supported target.

Public Node `status()` and `history()` are currently PostgreSQL-only; do not use
them for MySQL.

## SQLite

The Node API can validate for SQLite:

```typescript
import { plan } from "zero-migrate-engine";
import * as migration from "./migrations/20260715090000_create_users.js";

const report = plan({
  migration,
  ownerApp: "app_demo",
  dialect: "sqlite",
});

if (!report.ok) {
  throw new Error(report.error ?? "SQLite validation failed");
}
```

The public Node API and CLI do not apply to SQLite yet. Use a Rust host when you
need SQLite execution; see [Rust API](embedding.md).

## Before production

- Run only trusted migration modules.
- Validate for the exact target dialect.
- Review preview output.
- Use a pre-provisioned schema or database and least-privilege credentials.
- Supply a complete ownership registry for previously created tables.
- Require an independent approval decision for destructive changes.
- Do not put data migrations through the current JavaScript apply path.
- Test against a disposable copy of the target database.
- Back up data and define a forward-fix or recovery procedure.
- Preserve the migration journal and monitor failed or incomplete deployments.

## Next

- [Writing migrations](writing-migrations.md)
- [CLI reference](cli.md)
- [Node API](node-api.md)
- [Database targets](dialects.md)
- [Operating migrations](operations.md)
- [Troubleshooting](troubleshooting.md)
- [Documentation home](README.md)
