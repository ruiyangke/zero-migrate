# CLI reference

The `zero-migrate` command creates migration files, previews and validates them,
applies ordered schema and data changes to PostgreSQL or MySQL, resolves staged
PostgreSQL column renames, and reconciles migration status.

[Documentation home](README.md) · [Getting started](getting-started.md) ·
[Writing migrations](writing-migrations.md) · [Node API](node-api.md) ·
[Troubleshooting](troubleshooting.md)

> **Complete ordered apply:** the CLI executes DDL, insert, update, delete, and
> backfill steps on PostgreSQL and MySQL 8 in authored order. Pending deletes
> and backfills require the explicit `--approve` flag after operator review.
> Approval is preflighted across each complete file plan before its first
> authored step.

> **Trusted modules only:** the CLI imports and executes migration JavaScript or
> TypeScript directly in its host process, with no sandbox. Top-level module code
> and `up()` can read environment variables and files, use the network, or perform
> any other action allowed to that process. Never point the CLI at untrusted or
> generated source. A platform that accepts such source must isolate it outside
> the deployment process and use a reviewed Rust/custom-host workflow.

## Run from this checkout

`zero-migrate` and `zero-migrate-cli` are not published to npm yet. Do not
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
zero-migrate plan [--dir <dir>] [--dialect <name>] [--registry <file>] [--owner-app <app>] [--schema <schema>] [--json]
zero-migrate preview [--dir <dir>] [--json]
zero-migrate apply [--dir <dir>] --database-url <url> --policy-ceiling <file> [--registry <file>] [--owner-app <app>] [--schema <schema>] [--approve]
zero-migrate status [--dir <dir>] --database-url <url> --policy-ceiling <file> [--registry <file>] [--owner-app <app>] [--schema <schema>] [--json]
zero-migrate history --database-url <url> [--owner-app <app>] [--schema <schema>] [--json]
zero-migrate resolve-pending <pending-version> (--apply | --abort) --approve --database-url <url> [--owner-app <app>] [--schema <schema>]
zero-migrate --version
```

There are no short flags. For flags that take a value, both `--flag value` and
`--flag=value` work. Boolean flags such as `--approve` and `--json` must be
passed without a value. Unknown flags fail.

Use `--dir` for every command that reads or creates migration files. The CLI
rejects a positional directory after `plan`, `preview`, `apply`, or `status`.
`resolve-pending` takes a pending version instead of a migration directory.

| Command | Database | Purpose |
| --- | --- | --- |
| `new` | None | Create a timestamped TypeScript migration |
| `preview` | None | Print the generated migration changes |
| `plan` | None | Validate migrations for PostgreSQL, MySQL, or SQLite |
| `apply` | PostgreSQL or MySQL | Apply complete migrations in filename and authored-step order |
| `status` | PostgreSQL or MySQL | Reconcile the migration directory with journal state |
| `history` | PostgreSQL | Print the append-only migration audit trail |
| `resolve-pending` | PostgreSQL | Complete or abort one outstanding online column rename |

There is no CLI command for rollback, rendered SQL, SQLite apply, or a full
database-backed dry run.

## Flags and environment

| Flag | Commands | Meaning |
| --- | --- | --- |
| `--dir <dir>` | `new`, `plan`, `preview`, `apply`, `status` | Migration directory; default `./migrations` |
| `--database-url <url>` | `apply`, `status`, `history`, `resolve-pending` | PostgreSQL or MySQL connection URL; `history` and rename resolution require PostgreSQL |
| `--dialect <name>` | `plan` | Validation target: `postgres`, `mysql`, or `sqlite`; default `postgres` |
| `--registry <file>` | `plan`, `apply`, `status` | Trusted JSON map of existing table names to owner application IDs |
| `--policy-ceiling <file>` | `apply`, `status` | Required operator-controlled table-shape policy ceiling in TOML |
| `--owner-app <app>` | `plan`, `apply`, `status`, `history`, `resolve-pending` | Deploying application ID; default `app_cli` |
| `--schema <schema>` | `plan`, `apply`, `status`, `history`, `resolve-pending` | Project schema/database; default `public` |
| `--approve` | `apply`, `resolve-pending` | Approve the exact reviewed destructive work |
| `--apply` | `resolve-pending` | Keep the destination column and drop the source column |
| `--abort` | `resolve-pending` | Keep the source column and drop the destination column |
| `--json` | `plan`, `preview`, `status`, `history` | Machine-readable output |
| `--help` | all | Print help and exit 0 |
| `--version` | all | Print the zero-migrate version and exit 0 |

On the offline `plan` command, `--schema` sets the project confinement boundary
used to check explicit schema references. Pass the same value to plan, apply, and
status.

| Environment variable | Used when the flag is absent | Default |
| --- | --- | --- |
| `DATABASE_URL` | `--database-url` | none |
| `ZERO_MIGRATE_OWNER_APP` | `--owner-app` | `app_cli` |
| `ZERO_MIGRATE_SCHEMA` | `--schema` | `public` |
| `ZERO_MIGRATE_ADDON_PATH` | Required pre-release runtime path | none in a source checkout; set it during setup |

An explicit flag wins over its environment fallback. Prefer a secret manager or
injected environment variable to putting production credentials in shell
history.

`--policy-ceiling` has no environment fallback or embedded default. The CLI
reads the file and passes its exact TOML bytes to both apply and plan-aware
status. Use the same file for both commands. If the platform injects no columns,
the file can be the explicit no-inject document:

```toml
policy_version = 1
```

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
control. Async `up()` functions and returned promises are rejected. `plan`
invokes `up()` exactly once and validates the same operation list it displays. A
`down()` export is not used by the public CLI, which has no rollback command.

The displayed migration name comes from the named `name` export,
`default.name`, the filename without its extension, or finally `migration`.
That name is durable identity. Keep it unique within the project and never
rename it after apply. The timestamped filename fallback is stable as long as
the file itself is not renamed.

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

Preview opens no database and does not print rendered SQL. Its operation order
is the order apply uses, including inserts, updates, deletes, and backfills.

## `plan`

```bash
zero-migrate plan \
  --dir ./migrations \
  --owner-app app_demo \
  --schema app_demo \
  --dialect postgres
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

This is a fast, database-free check of the generated changes, operation forms
for the selected dialect, project-schema confinement, and ownership against the
supplied registry. It does not inspect the target database, render SQL, or prove
that apply will succeed. Runtime approval, cursor, lock, and database conditions
are checked during apply.

Pass `--dialect postgres`, `--dialect mysql`, or `--dialect sqlite` for every
target you deploy. PostgreSQL is the default when `--dialect` is omitted.

### Ownership registry

Without `--registry`, the CLI uses an empty table-owner registry. A create-first
module can create a table and then add its columns or indexes in the same
module. A later module that changes that existing table normally fails with an
`<unregistered>` ownership error.

For follow-up migrations, create a JSON file from your platform's authoritative
table ownership data:

```json
{
  "users": "app_demo",
  "orders": "app_orders"
}
```

Then pass it to every related command:

```bash
zero-migrate plan \
  --dir ./migrations \
  --dialect postgres \
  --owner-app app_demo \
  --schema app_demo \
  --registry ./table-owners.json
```

Do not generate this file from the migration being checked. The registry is the
independent source used to prevent one application from changing another
application's tables.

## `apply`

PostgreSQL:

```bash
zero-migrate apply \
  --dir ./migrations \
  --database-url "$DATABASE_URL" \
  --policy-ceiling ./policy.toml \
  --registry ./table-owners.json \
  --schema app_demo \
  --owner-app app_demo
```

MySQL:

```bash
zero-migrate apply \
  --dir ./migrations \
  --database-url "$MYSQL_URL" \
  --policy-ceiling ./policy.toml \
  --registry ./table-owners.json \
  --schema app_demo \
  --owner-app app_demo
```

The MySQL migration account must be able to read Performance Schema transaction
state. Enable the `transaction` instrument and
`events_transactions_current` consumer. Apply and status fail before migration
work if zero-migrate cannot verify that its dedicated session is idle.

For a reviewed delete or backfill, add approval explicitly:

```bash
zero-migrate apply \
  --dir ./migrations \
  --database-url "$DATABASE_URL" \
  --policy-ceiling ./policy.toml \
  --schema app_demo \
  --owner-app app_demo \
  --approve
```

`--approve` is a non-interactive operator decision for the exact source being
run. It does not weaken validation, ownership, cursor, or database checks.
An unchanged completed delete or backfill skips on a repeat run without
`--approve`; an interrupted backfill still requires `--approve` before it
resumes. Approval is preflighted across the complete plan for each file before
its first authored step executes. A later unapproved delete or backfill cannot
leave an earlier step from that same plan committed.

The PostgreSQL project schema or MySQL project database must already exist. The
connection also needs permission to create and use the journal namespace
`<schema>_migrations`.

The CLI applies files in filename order and prints one outcome per file:

```text
apply 20260715153045_create_users: {"applied":["mig_..."],"skipped":[],"recovered":[],"pendingContracts":[]}
```

Every outcome also includes `pendingContracts`. It is empty unless PostgreSQL
has an outstanding online column rename. See `resolve-pending` below for the
complete workflow.

Each file is a separate apply call. If file three fails, files one and two stay
committed. Always check the final exit code rather than treating partial output
as directory-wide success.

A single file can also produce several database changes that commit separately.
If a later change in that file fails, earlier changes from the same file can
remain committed. Inspect the database and migration history before retrying.
This partial state can follow a runtime database error after execution begins;
the whole-plan approval preflight itself runs before authored steps.

Current CLI defaults are:

| Setting | Value |
| --- | --- |
| ownership registry | `{}` unless `--registry` is supplied |
| table-shape policy | none; `--policy-ceiling` is required |
| destructive approval | `false` |
| PostgreSQL migrator role | none |
| audit actor | `host` for apply; `cli` for rename resolution |

Use the Node API when you need a PostgreSQL migrator role or a custom audit
actor.

Important apply behavior:

- DDL, insert, update, delete, and backfill steps execute in authored order;
- inserts and updates run without destructive approval, while pending deletes
  and backfills require `--approve`;
- every step has a stable journal identity. Unchanged completed work is skipped,
  while edited applied content stops with checksum drift;
- every MySQL insert, update, delete, and backfill target must use InnoDB and
  have no user triggers;
- PostgreSQL backfills reject pre-existing enabled user triggers; the managed
  online rename workflow remains supported;
- a backfill cursor must be the table's complete, non-null, single-column primary
  key with a supported orderable type. The backfill commits bounded batches and
  resumes after its last committed cursor within a fixed terminal boundary
  captured before the first batch. Rows inserted after capture are not
  guaranteed to be included and need a later migration;
- apply reads the current target catalog before preparing work, so checks that
  depend on existing tables, columns, and indexes use the current database
  shape. This is not a complete structural-drift check or database-backed dry
  run;
- no platform-managed columns, indexes, or primary key are added automatically;
- the whole directory is not one transaction or one lock interval.

Test migrations against a disposable database before production use.

## `resolve-pending`

A PostgreSQL column rename is completed across multiple deployments. Author it
with the ordinary JavaScript API:

```ts
table("users").column("display_name").rename({
  to: "full_name",
  type: t.text(),
});
```

For PostgreSQL validation, this rename must be the only operation in the
migration that targets `users`. Operations on different tables may remain in
the same file. Move every other schema or data operation on `users` into a later
migration, and apply it only after the rename is resolved.

The live source column must exist, the destination must not exist, and the
declared `type` must match the source column's current PostgreSQL type. The table
must have `id` as its complete, non-null, single-column primary key with a
supported orderable cursor type. It must have no pre-existing enabled user
triggers, and row-level policy must allow every selected backfill row to be
updated.

Supported PostgreSQL `id` cursor families are small integers, integers, big
integers, numeric or decimal, text or character strings, dates, timestamps, and
UUIDs. Floating-point, JSON, binary, and geometric types are not supported
backfill cursors.

The destination is nullable but otherwise keeps the source's exact live
PostgreSQL type, including modifiers. Equivalent built-in spellings such as
`timestamptz` and `timestamp with time zone`, or `decimal(20,4)` and
`numeric(20,4)`, are accepted. A modifier change is refused during resolution.
`NOT NULL`, defaults, unique or primary-key rules, indexes, comments, and
dependent objects do not transfer to it. Review those semantics and schedule
separate follow-up migrations after resolution. Do not use this workflow to
rename the `id` primary key. Dependencies on the source can block resolution,
so audit them before rollout.

Run the initial apply with approval because it includes a bounded backfill:

```bash
zero-migrate apply \
  --dir ./migrations \
  --database-url "$DATABASE_URL" \
  --policy-ceiling ./policy.toml \
  --registry ./table-owners.json \
  --schema app_demo \
  --owner-app app_demo \
  --approve
```

Its result includes the outstanding rename and its stable resolution key:

```text
apply 20260716120000_rename_users_display_name: {"applied":["mig_..."],"skipped":[],"recovered":[],"pendingContracts":[{"table":"users","fromColumn":"display_name","toColumn":"full_name","pendingVersion":"mig_..."}]}
```

At this point both columns coexist. A write through either name keeps their
values aligned; if one statement supplies different values for both, the
destination value wins. Avoid writing both names in one statement. Deploy the
application version that uses `full_name`, wait for every application instance
and other database consumer to stop using `display_name`, and verify the
rollout. Other migration changes to `users` remain blocked until you resolve
this obligation.

After the application cutover, complete the rename:

```bash
zero-migrate resolve-pending "mig_..." \
  --apply \
  --approve \
  --database-url "$DATABASE_URL" \
  --schema app_demo \
  --owner-app app_demo
```

`--apply` keeps `full_name` and drops `display_name`. If the rollout must be
reversed, move the application back to `display_name` first, then abort the
rename:

```bash
zero-migrate resolve-pending "mig_..." \
  --abort \
  --approve \
  --database-url "$DATABASE_URL" \
  --schema app_demo \
  --owner-app app_demo
```

`--abort` keeps `display_name` and drops `full_name`. Exactly one of `--apply`
and `--abort` is required. Both actions drop a column and therefore require
`--approve`. Use the same `--owner-app` and `--schema` that opened the pending
rename. This command accepts PostgreSQL URLs only.

On success, the command prints an `ApplyOutcome` whose `pendingContracts` no
longer contains that version. Run `status --json` to confirm the table is no
longer blocked.

If the initial apply is interrupted, rerun the unchanged file with the same
identity and `--approve`. Completed work skips, and the backfill resumes from
its saved cursor. If the pending rename was already opened, apply returns the
same obligation again without resolving it.

Resolution cleanup is all-or-nothing. If `resolve-pending` fails, both columns
and the managed rename trigger remain intact, the pending obligation remains,
and the table stays blocked. Correct the reported cause, then retry the same
action and pending version.

After either action succeeds, the original rename is terminal. Replaying the
exact migration file does not open another obligation. Apply stays applied and
abort stays aborted. To try the rename again after abort, create a new migration
with a new exported name. Resolving the settled version again reports that it is
not pending.

## `status`

```bash
zero-migrate status \
  --dir ./migrations \
  --database-url "$DATABASE_URL" \
  --policy-ceiling ./policy.toml \
  --registry ./table-owners.json \
  --schema app_demo \
  --owner-app app_demo
```

Text mode prints `status: ` followed by a compact object. `--json` prints:

```json
{
  "currentVersion": "mig_...",
  "applied": ["mig_..."],
  "pending": [],
  "aborted": [],
  "rolledBack": [],
  "pendingContracts": [],
  "blocked": [],
  "unexpectedJournal": [],
  "plans": [
    {
      "version": "mig_...",
      "name": "create_users",
      "state": "applied",
      "steps": [
        {
          "version": "mig_...",
          "name": "create_table_users",
          "kind": "ddl",
          "state": "applied"
        },
        {
          "version": "mig_...",
          "name": "insert users",
          "kind": "dml",
          "state": "applied"
        }
      ],
      "missingDependencies": []
    }
  ]
}
```

Status is supported for PostgreSQL and MySQL. It loads the ordered migration
directory and reconciles every schema, insert, update, delete, and backfill step
with the journal. Migration states are `applied`, `aborted`, `pending`,
`partial`, `drifted`, `blocked`, or `unknownDependency`; step states are
`pending`, `inflight`, `applied`, `aborted`, or `drifted`. Top-level `applied`,
`pending`, and `aborted` values are logical migration IDs, while
`plans[].steps[].version` values are the journaled step IDs. Saved backfill
progress without a final completion event reports an `inflight` step in a
`partial` plan.

The complete status reply also includes:

- `pendingContracts`: `{ table, pendingVersion, orphaned }` entries for
  outstanding PostgreSQL online renames. `orphaned` means the migration that
  opened the obligation is missing from the supplied directory.
- `blocked`: `{ blocked, dependency, pendingVersion }` entries for plans waiting
  on a dependency's outstanding rename.
- `aborted`: terminal logical plan IDs whose online rename was explicitly
  aborted. They are not included in `applied` or `pending`.
- `unexpectedJournal`: `{ version, state, journalChecksum, journalKind? }`
  entries for completed or inflight identities absent from the migration
  directory. Investigate an incomplete directory or changed identity before
  applying.

Plan states are `applied`, `aborted`, `pending`, `partial`, `drifted`, `blocked`,
or `unknownDependency`. Step kinds are `ddl`, `dml`, `backfill`,
`onlineExpand`, `onlineContract`, or `sqliteRebuild`. Step states are `pending`,
`inflight`, `applied`, `aborted`, or `drifted`. Unexpected journal state is
`applied` or `inflight`; when present, `journalKind` is `apply`, `baseline`,
`squash`, or `repeatable`.

`currentVersion` is the last fully applied supplied plan in dependency and input
order.
`applied` lists fully applied supplied plan IDs, `aborted` lists terminal aborted
plan IDs, and `pending` lists supplied plan IDs in neither terminal list.
`rolledBack` lists versions whose latest event is a rollback. An expanded but
unresolved rename normally appears as a `partial` plan with applied
`onlineExpand` steps and pending `onlineContract` steps. After abort, the plan
and its deferred `onlineContract` steps report `aborted`; completed expansion
steps remain `applied`. `orphaned` is evaluated relative to the migration
directory supplied to status.

An aborted plan does not satisfy `dependsOn`. A dependent supplied plan remains
`blocked`, and apply refuses to run it. Author a new replacement migration and
update the dependency to its new identity before continuing.

Use the same `--owner-app`, `--schema`, `--policy-ceiling`, migration names, and
source used for apply. Changing identity inputs or editing an applied migration
can make status report a different plan or checksum drift.

On a fresh database, status may create the journal schema and tables before
reporting the discovered migrations as pending. It is therefore not a strictly
read-only probe.

Use `zero-migrate history --database-url <url>` (PostgreSQL only) or the Node
`history()` function for full PostgreSQL journal events.

## Exit codes

| Result | Exit code |
| --- | --- |
| `help` or `--help`, or `--version` | 0 |
| successful `new`, `preview`, `apply`, `status`, `history`, or `resolve-pending` | 0 |
| every `plan` result is valid | 0 |
| any validation, import, runtime, configuration, or database error | 1 |

Failures are written as `zero-migrate: <message>` on standard error. An unknown
command also prints usage.

## Practical limitations

- PostgreSQL and MySQL apply execute schema changes and all structured data
  operations; SQLite apply is available only through the Rust API.
- PostgreSQL and MySQL status reconcile the supplied migration directory;
  PostgreSQL history still requires the Node API.
- Online column rename and `resolve-pending` are PostgreSQL-only. In the rename
  migration, no other operation may target that table. Operations on different
  tables are allowed. Later same-table work remains blocked until completion or
  abort.
- Plan is a fast structural check for the selected dialect, not a live plan.
- Apply and status read the target catalog before preparing live-dependent work;
  they do not perform a complete structural-drift check.
- `--approve` approves reviewed destructive changes and backfills for the run;
  migrator role and audit actor are not configurable.
- Migration names are durable identity. Unchanged completed steps skip, while
  changes to applied content stop with checksum drift.
- Rollback, rendered SQL, and a full database-backed dry run are absent.

## Troubleshooting

| Symptom | Action |
| --- | --- |
| Required runtime cannot load | Repeat the source setup for this OS/architecture, then set the absolute `ZERO_MIGRATE_ADDON_PATH` shown in Getting started |
| `Unknown file extension ".ts"` | Start Node with a TypeScript loader, or compile migrations to JavaScript |
| `no migrations found` | Pass `--dir`, keep files at its top level, and use a supported extension |
| `<unregistered>` ownership error | Pass the authoritative JSON mapping with `--registry` |
| Destructive change or backfill is refused | Review the exact migration, then repeat `apply` with `--approve` |
| Plan passes but apply fails | Plan is offline and does not inspect the target or run every apply-time check |
| PostgreSQL rename validation reports another operation on the table | Keep the rename as that table's only operation; move same-table schema and data work to a later migration and apply it after resolution |
| Data step is skipped | Run `status --dir ...`; an unchanged applied step skips by design, while edited content reports checksum drift |
| MySQL data step is refused | Use an InnoDB target without user triggers; zero-migrate refuses data migrations whose transactional side effects cannot be proven |
| Backfill cursor is refused | Use an exact ordered, non-null primary or unique candidate-key tuple with compatible comparison semantics and choose `guardUpdates` or an approved named `externalInvariant`; otherwise use a maintenance-window one-shot, rebuild/temporary surrogate, or create a stable unique cursor first |
| MySQL history is needed | `zero-migrate history` and the public history API are PostgreSQL-only; use plan-aware MySQL `status` for current migration state |
| Project schema/database is missing | Create it first and grant access to it and its journal namespace |
| Reapplying an edited migration reports drift | Restore the applied source and add a new uniquely named migration for the change |
| A table is blocked by a pending rename | Finish the application cutover and run `resolve-pending <version> --apply --approve`, or return the application to the source column and use `--abort --approve` |

See [Troubleshooting](troubleshooting.md) for longer diagnostic flows.

## Next

- [Getting started](getting-started.md)
- [Writing migrations](writing-migrations.md)
- [Node API](node-api.md)
- [Operating migrations](operations.md)
- [Dialect support](dialects.md)
