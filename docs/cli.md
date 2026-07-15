# CLI reference

The `zero-migrate` command creates migration files, previews and validates them,
applies schema changes to PostgreSQL or MySQL, and reads PostgreSQL journal
status.

[Documentation home](README.md) · [Getting started](getting-started.md) ·
[Writing migrations](writing-migrations.md) · [Node API](node-api.md) ·
[Troubleshooting](troubleshooting.md)

> **DDL-only apply:** the current CLI apply path executes schema/DDL migrations
> only. Authored inserts, updates, deletes, and backfills may appear in preview or
> pass the fast plan check, but they are not executed. A data-only migration can
> therefore report success without changing data. Do not use the CLI for data
> migrations or backfills in this release.

> **Trusted modules only:** the CLI imports and executes migration JavaScript or
> TypeScript directly in its host process, with no sandbox. Top-level module code
> and `up()` can read environment variables and files, use the network, or perform
> any other action allowed to that process. Never point the CLI at untrusted or
> generated source. A platform that accepts such source must isolate it outside
> the deployment process and use a reviewed Rust/custom-host workflow.

## Run from this checkout

`zero-migrate` and `zero-migrate-engine` are not published to npm yet. Do not
follow an `npm install` or `pnpm add` workflow for this release. Build and run the
repository checkout by following [Getting started](getting-started.md#1-prepare-the-checkout).

That guide establishes the TypeScript-aware command prefix and configures the
pre-release runtime. The examples below use `zero-migrate ...` for readability;
substitute the source-checkout prefix from the guide.

TypeScript migration files require `tsx` or another TypeScript loader. Compiled
JavaScript migration files can run with ordinary Node.js. Complete the source
setup before using commands other than `new`.

## Commands

```text
zero-migrate new <name> [--dir <dir>]
zero-migrate plan [--dir <dir>] [--owner-app <app>] [--schema <schema>] [--json]
zero-migrate preview [--dir <dir>] [--json]
zero-migrate apply [--dir <dir>] --database-url <url> [--owner-app <app>] [--schema <schema>]
zero-migrate status --database-url <url> [--owner-app <app>] [--schema <schema>] [--json]
```

There are no short flags. Both `--flag value` and `--flag=value` work. Unknown
flags fail.

Always use `--dir`. A positional directory after `plan`, `preview`, `apply`, or
`status` is currently ignored.

| Command | Database | Purpose |
| --- | --- | --- |
| `new` | None | Create a timestamped TypeScript migration |
| `preview` | None | Print the generated migration changes |
| `plan` | None | Run a fast PostgreSQL-oriented validation check |
| `apply` | PostgreSQL or MySQL | Apply DDL migrations in filename order |
| `status` | PostgreSQL | Read net journal state |

There is no CLI command for history, rollback, rendered SQL, SQLite apply, or a
full database-backed dry run.

## Flags and environment

| Flag | Commands | Meaning |
| --- | --- | --- |
| `--dir <dir>` | `new`, `plan`, `preview`, `apply` | Migration directory; default `./migrations` |
| `--database-url <url>` | `apply`, `status` | PostgreSQL or MySQL connection URL |
| `--owner-app <app>` | `plan`, `apply`, `status` | Deploying application ID; default `app_cli` |
| `--schema <schema>` | `plan`, `apply`, `status` | Project schema/database; default `public` |
| `--json` | `plan`, `preview`, `status` | Machine-readable output |
| `--help` | all | Print help and exit 0 |

Two accepted flags currently have no effect: `--schema` on `plan`, and
`--owner-app` on `status`.

| Environment variable | Used when the flag is absent | Default |
| --- | --- | --- |
| `DATABASE_URL` | `--database-url` | none |
| `ZERO_MIGRATE_OWNER_APP` | `--owner-app` | `app_cli` |
| `ZERO_MIGRATE_SCHEMA` | `--schema` | `public` |
| `ZERO_MIGRATE_ADDON_PATH` | Required pre-release runtime path | none in a source checkout; set it during setup |

An explicit flag wins over its environment fallback. Prefer a secret manager or
injected environment variable to putting production credentials in shell
history.

The URL scheme selects the database:

| URL scheme | Target |
| --- | --- |
| `postgres://`, `postgresql://` | PostgreSQL |
| `mysql://` | MySQL 8 |

SQLite URLs and `.sqlite`/`.db` paths are rejected by the CLI.
MariaDB and `mariadb://` are not supported targets. Use MySQL 8 with a
`mysql://` URL.

## Migration discovery

The CLI reads only the top level of `--dir`. It accepts:

```text
.ts  .mts  .cts  .js  .mjs  .cjs
```

It excludes `.d.ts` and sorts filenames lexicographically. Timestamp prefixes
therefore determine execution order.

Each module must export a synchronous named `up()` or `default.up()`:

```ts
export const name = "create_users";

export default {
  up() {
    // zero-migrate operations
  },
};
```

Importing the module runs its top-level code, and the CLI calls `up()` with the
full permissions of the CLI process. There is no in-process isolation. Keep
trusted modules deterministic and free of I/O, timers, randomness, and clock
reads so results are reproducible; this is authoring guidance, not a security
control. `up()` is not awaited, and `plan` currently invokes it twice. A
`down()` export is not used by the public CLI, which has no rollback command.

The displayed migration name comes from the named `name` export,
`default.name`, the filename without its extension, or finally `migration`.

## `new`

```bash
zero-migrate new create_users --dir ./migrations
```

Names must match `[A-Za-z0-9_]+`; use underscores instead of spaces or dashes.
The command creates the directory when needed and writes a UTC timestamped file:

```text
Creating migration: /project/migrations/20260715153045_create_users.ts
```

It refuses to overwrite the same timestamp/name. The scaffold contains an empty
synchronous `up()` and imports the public DSL from `zero-migrate`.

## `preview`

```bash
zero-migrate preview --dir ./migrations
```

Text output prints a summary and the generated changes for every file:

```text
preview create_users: ir_version=1 ops=2
[
  { "op": "createTable", ... },
  { "op": "createIndex", ... }
]
```

`--json` prints the complete structured preview:

```json
[
  {
    "ir_version": 1,
    "name": "create_users",
    "ops": []
  }
]
```

Preview opens no database and does not print rendered SQL. It can show data
operations that the current public apply path will not execute.

## `plan`

```bash
zero-migrate plan --dir ./migrations --owner-app app_demo
```

Text output gives one verdict per file:

```text
plan create_users: ok (2 ops)
```

An invalid file prints `ERROR`, followed by the first reason, and makes the
command exit 1. `--json` returns:

```json
[
  {
    "label": "create_users",
    "ok": true,
    "opCount": 2,
    "irVersion": 1
  }
]
```

This is a fast, database-free check of the generated changes, supported
PostgreSQL operation forms, and ownership against an empty table registry. It
does not inspect the target database, render SQL, account for the requested
schema, or prove that apply will succeed. It also does not warn that data
operations will be omitted by public apply.

CLI plan always checks the PostgreSQL dialect. Use the Node `plan()` API to check
MySQL or SQLite syntax.

### Ownership limitation

The CLI always uses an empty table-owner registry. A create-first module can
create a table and then add its columns or indexes in the same module. A later
module that changes that existing table normally fails with an `<unregistered>`
ownership error.

For follow-up schema migrations, use the Node API and pass a trusted registry:

```ts
registry: { users: "app_demo" }
```

## `apply`

PostgreSQL:

```bash
zero-migrate apply \
  --dir ./migrations \
  --database-url "$DATABASE_URL" \
  --schema app_demo \
  --owner-app app_demo
```

MySQL:

```bash
zero-migrate apply \
  --dir ./migrations \
  --database-url "$MYSQL_URL" \
  --schema app_demo \
  --owner-app app_demo
```

The PostgreSQL project schema or MySQL project database must already exist. The
connection also needs permission to create and use the journal namespace
`<schema>_migrations`.

The CLI applies files in filename order and prints one outcome per file:

```text
apply 20260715153045_create_users: {"applied":["mig_..."],"skipped":[],"recovered":[]}
```

Each file is a separate apply call. If file three fails, files one and two stay
committed. Always check the final exit code rather than treating partial output
as directory-wide success.

A single file can also produce several database changes that commit separately.
If a later change in that file fails, earlier changes from the same file can
remain committed. Inspect the database and migration history before retrying.

Current CLI defaults are:

| Setting | Value |
| --- | --- |
| ownership registry | `{}` |
| destructive approval | `false` |
| PostgreSQL migrator role | none |
| audit actor | `host` |

Use the Node API when you need a registry, destructive approval, a PostgreSQL
migrator role, or a custom audit actor.

Important apply boundaries:

- only DDL/schema migrations are executed; inserts, updates, deletes, and
  backfills are omitted;
- the target is not introspected before work is generated, so this path is best
  suited to create-first schema changes;
- no platform-managed columns, indexes, or primary key are added automatically;
- the CLI cannot approve destructive work;
- stable same-file IDs are not guaranteed across repeated DDL apply calls, so a
  second call may try the DDL again instead of returning `skipped`; and
- the whole directory is not one transaction or one lock interval.

Test migrations against a disposable database before production use.

## `status`

```bash
zero-migrate status --database-url "$DATABASE_URL" --schema app_demo
```

Text mode prints `status: ` followed by a compact object. `--json` prints:

```json
{
  "currentVersion": "mig_...",
  "applied": ["mig_..."],
  "pending": [],
  "rolledBack": []
}
```

Status is currently supported only for PostgreSQL. It reads net-applied and
rolled-back journal versions, but it does not compare the migration directory
with the journal, so `pending` is always empty.

On a fresh project, status may create the journal schema and tables before
returning an empty state. It is therefore not a strictly read-only probe.

Use the Node `history()` function for full PostgreSQL journal events; there is no
CLI history command.

## Exit codes

| Result | Exit code |
| --- | --- |
| `help` or `--help` | 0 |
| successful `new`, `preview`, `apply`, or `status` | 0 |
| every `plan` result is valid | 0 |
| any validation, import, runtime, configuration, or database error | 1 |

Failures are written as `zero-migrate: <message>` on standard error. An unknown
command also prints usage.

## Practical limitations

- Apply is DDL-only; data operations and backfills are not executed.
- PostgreSQL and MySQL apply are available; SQLite apply is not.
- Status is PostgreSQL-only and does not calculate pending files.
- Plan is a fast PostgreSQL-oriented structural check, not a live plan.
- Plan invokes `up()` twice, so authoring must be deterministic.
- Follow-up migrations need a registry that the CLI cannot supply.
- Apply is create-first and does not inspect the existing schema before
  preparing the database changes.
- Destructive approval, migrator role, and audit actor are not configurable.
- Repeating the same DDL file is not yet an idempotent-skip guarantee.
- Rollback, history, rendered SQL, and a full database-backed dry run are absent.

## Troubleshooting

| Symptom | Action |
| --- | --- |
| Required runtime cannot load | Repeat the source setup for this OS/architecture, then set the absolute `ZERO_MIGRATE_ADDON_PATH` shown in Getting started |
| `Unknown file extension ".ts"` | Start Node with a TypeScript loader, or compile migrations to JavaScript |
| `no migrations found` | Pass `--dir`, keep files at its top level, and use a supported extension |
| `<unregistered>` ownership error | Use Node `apply()` with the authoritative `{ table: ownerApp }` registry |
| Destructive change is refused | Review it, then use trusted Node code with `approved: true`; the CLI cannot approve |
| Plan passes but apply fails | Plan is offline and does not inspect the target or run every apply-time check |
| Data migration reports success but rows do not change | Public apply is DDL-only; move data separately and verify it explicitly |
| MySQL status fails | Use status only with PostgreSQL |
| Project schema/database is missing | Create it first and grant access to it and its journal namespace |
| Repeated DDL does not skip | Do not rely on repeat apply for idempotency in this release |

See [Troubleshooting](troubleshooting.md) for longer diagnostic flows.

## Next

- [Getting started](getting-started.md)
- [Writing migrations](writing-migrations.md)
- [Node API](node-api.md)
- [Operating migrations](operations.md)
- [Dialect support](dialects.md)
