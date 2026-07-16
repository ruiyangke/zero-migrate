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
- PostgreSQL and MySQL Node/CLI apply execute DDL, insert, update, delete, and
  backfill steps in authored order. Pending delete and backfill steps require
  explicit approval. SQLite apply remains Rust-only and supports the same data
  operations.
- The Node API can apply to PostgreSQL and MySQL. It can validate for SQLite, but
  SQLite apply currently requires a Rust host.
- Later files that change an existing table need an ownership registry. Pass it
  with CLI `--registry` or the Node API `registry` option.

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

    table("users").insert({
      rows: {
        email: "first@example.com",
        display_name: "First user",
      },
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
  such as `.add(...)`, `.setType(...)`, or `.drop()`.
- Keep migration output deterministic. Do not branch on the clock, random
  values, environment variables, network responses, or mutable global state.
- Keep the exported migration name unique within the project and never change it
  after apply. The name is part of the migration's durable identity.

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
  --dialect postgres \
  --owner-app app_demo \
  --schema app_demo
```

The command exits non-zero when a migration is invalid, unsupported, or attempts
to modify an object owned by another application. It is a useful CI check, but
it does not inspect your live schema, test database permissions, or guarantee
that apply will succeed.

Repeat the command with `--dialect mysql` or `--dialect sqlite` when you deploy
to those targets. Plan remains offline and does not connect to that database.

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

> **Authored order is execution order:** the table creation, index, and insert in
> this walkthrough run in exactly that sequence. Data-only migrations run too;
> data operations are not removed from a mixed plan.

Apply the directory:

```bash
pnpm exec tsx dist/cli-bin.js apply \
  --dir ./migrations \
  --database-url "$DATABASE_URL" \
  --schema app_demo \
  --owner-app app_demo
```

The CLI applies files in lexicographic filename order and reports which
migrations were applied, skipped, or recovered, plus any outstanding
PostgreSQL online renames in `pendingContracts`. It calls apply once per file,
but a file can still contain several database changes that commit separately.
Neither one file nor the whole directory is guaranteed to be an all-or-nothing
transaction. Inspect the schema and history before retrying a partial failure.

Pending deletes and backfills require explicit approval. After reviewing the
exact migration and its recovery plan, add `--approve` to the CLI command.
Without it, apply refuses before any authored step in that plan runs. The Node
equivalent is `approved: true`. On a repeat apply, an unchanged completed delete or
backfill skips without renewed approval. An interrupted backfill still needs
approval before it resumes. Apply checks every pending approval-gated step in
the plan before executing its first authored step, so a later unapproved delete
or backfill cannot follow an already-committed earlier step from that plan.

A backfill pages by the table's complete, non-null, single-column primary key,
using a supported orderable type. Before the first batch it captures a fixed
terminal cursor. Each batch saves the last committed cursor, so retrying resumes
within that original range instead of starting over or chasing later rows. Rows
inserted after the backfill starts are not guaranteed to be included and need a
later migration. PostgreSQL rejects a backfill target with a pre-existing
enabled user trigger; the managed online rename workflow remains supported.
Completion is recorded in the normal migration journal.
Editing an applied migration, including its bound data values or backfill
transform, stops with checksum drift.

## 7. Inspect status

```bash
pnpm exec tsx dist/cli-bin.js status \
  --dir ./migrations \
  --database-url "$DATABASE_URL" \
  --schema app_demo \
  --owner-app app_demo \
  --json
```

Status loads the migration directory and reconciles each complete plan with the
PostgreSQL or MySQL journal. Mixed migrations include their DDL, DML, and
backfill steps. Once a backfill has saved progress but has not written its final
completion event, its step is `inflight` and its plan is `partial` rather than
fully applied.

An expanded but unresolved PostgreSQL rename is also expected to appear as a
`partial` plan, with its pending obligation in `pendingContracts`. This is the
key used by `resolve-pending` later in the guide.

After an abort, status places the terminal plan ID in top-level `aborted`. The
plan and its deferred `onlineContract` steps report `aborted`; the ID is not in
`applied` or `pending`. A plan whose `dependsOn` points to this aborted identity
remains blocked.

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
  projectSchema: "app_demo",
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

As with the CLI, importing the module executes ordinary JavaScript. PostgreSQL
and MySQL apply preserve every schema and data step in authored order.

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
your platform's authoritative application-to-table mapping. With the CLI, save
the same mapping as JSON and pass it with `--registry ./table-owners.json` to
`plan`, `apply`, and `status`.

## 10. Rename a PostgreSQL column online

PostgreSQL column renames use a staged workflow so the application can move to
the new name before the old name is removed. Create another migration:

```bash
pnpm exec tsx dist/cli-bin.js new rename_user_display_name --dir ./migrations
```

```ts
import { table, t } from "zero-migrate";

export const name = "rename_user_display_name";

export default {
  up() {
    table("users").column("display_name").rename({
      to: "full_name",
      type: t.text(),
    });
  },
};
```

On PostgreSQL, keep this rename as the only operation in the migration that
targets `users`. Operations on different tables may remain in the same file.
Move every other `users` schema or data change into a later migration and apply
it only after the rename is resolved.

The source column must exist, the destination must not exist, and `type` must
match the source column's live PostgreSQL type. The walkthrough's `users.id`
column is already the required complete, non-null, single-column primary key
with a supported cursor type. The table must have no pre-existing enabled user
triggers, and row-level policy must allow the selected backfill rows to be
updated.

The destination is nullable but otherwise keeps the source's exact live
PostgreSQL type, including modifiers. Equivalent built-in PostgreSQL aliases are
accepted, but a modifier change is refused during resolution. A rename does not
transfer `NOT NULL`, defaults, unique or primary-key rules, indexes, comments,
or dependent objects. Review those properties and add them in separate
follow-up migrations after resolution. Do not use this workflow to rename the
`id` primary key. Dependencies on the source can block resolution, so audit
them before rollout.

Create the trusted ownership registry:

```json
{
  "users": "app_demo"
}
```

Save that map as `table-owners.json`. Preview and validate the directory with
the same owner, schema, and registry you will use for apply:

```bash
pnpm exec tsx dist/cli-bin.js preview --dir ./migrations

pnpm exec tsx dist/cli-bin.js plan \
  --dir ./migrations \
  --dialect postgres \
  --registry ./table-owners.json \
  --schema app_demo \
  --owner-app app_demo
```

Then start the rename with approval because it includes a bounded backfill:

```bash
pnpm exec tsx dist/cli-bin.js apply \
  --dir ./migrations \
  --database-url "$DATABASE_URL" \
  --registry ./table-owners.json \
  --schema app_demo \
  --owner-app app_demo \
  --approve
```

The apply result now includes:

```json
{
  "pendingContracts": [
    {
      "table": "users",
      "fromColumn": "display_name",
      "toColumn": "full_name",
      "pendingVersion": "mig_..."
    }
  ]
}
```

Both columns coexist after this call. A write through either name keeps their
values aligned; if one statement supplies different values for both, the
destination value wins. Avoid writing both names in one statement. Deploy
application code that uses `full_name`, wait for all application instances and
other database consumers to stop using `display_name`, and verify the
application cutover. Other migration changes to `users` are blocked until you
resolve the rename.

Complete the rename with the returned `pendingVersion`:

```bash
pnpm exec tsx dist/cli-bin.js resolve-pending "mig_..." \
  --apply \
  --approve \
  --database-url "$DATABASE_URL" \
  --schema app_demo \
  --owner-app app_demo
```

`--apply` keeps `full_name` and drops `display_name`. To abandon the rename,
move the application back to `display_name` first and run the same command with
`--abort`; that keeps `display_name` and drops `full_name`. Both choices require
approval.

If the initial apply is interrupted, rerun the unchanged migration with the
same identity and `--approve`. Completed work skips, the backfill resumes, and
an already-open pending rename is returned again without being resolved. Use
`status --json` whenever you need to recover the pending version.

Rename cleanup is all-or-nothing. If resolution fails, both columns and the
managed rename trigger remain intact, the pending version remains valid, and
the table stays blocked. Correct the cause and retry the same action.

Once apply or abort resolution succeeds, replaying this exact migration never
opens another pending rename. To try again after abort, create a new migration
file with a new exported name.

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
and the migration journal before retrying. Structured insert, update, delete,
and backfill targets must use InnoDB and have no user triggers. MariaDB is not a
supported target. The migration account must also be able to read Performance
Schema transaction state. Enable the `transaction` instrument and
`events_transactions_current` consumer so zero-migrate can verify that its
dedicated session is idle before apply or status.

Node and CLI status support MySQL when supplied with the migration set. Public
`history()` remains PostgreSQL-only.

## SQLite

The Node API can validate for SQLite:

```typescript
import { plan } from "zero-migrate-engine";
import * as migration from "./migrations/20260715090000_create_users.js";

const report = plan({
  migration,
  ownerApp: "app_demo",
  projectSchema: "public",
  dialect: "sqlite",
});

if (!report.ok) {
  throw new Error(report.error ?? "SQLite validation failed");
}
```

The public Node API and CLI do not apply to SQLite yet. Use a Rust host when you
need SQLite execution; see [Rust API](embedding.md). SQLite Rust apply
coordinates zero-migrate processes that use the same application database and
refuses unsafe application or journal settings. SQLite backfills require a
complete, non-null, single-column `INTEGER` or `TEXT` primary-key cursor whose
live values use the matching storage class.

## Before production

- Run only trusted migration modules.
- Validate for the exact target dialect.
- Review preview output.
- Use a pre-provisioned schema or database and least-privilege credentials.
- Supply a complete ownership registry for previously created tables.
- Require an independent approval decision for destructive changes.
- Confirm delete/backfill approval and use the table's complete, non-null,
  single-column primary key as the cursor. Plan a later migration for rows
  written after the backfill starts.
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
