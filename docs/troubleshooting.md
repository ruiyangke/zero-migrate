# Troubleshooting

Use this guide when a zero-migrate command or JavaScript API call fails. Start
with the visible symptom and avoid changing an already-applied migration while
you investigate.

## Start safely

Before retrying:

1. Save the complete error, command, and exit code.
2. Note the migration filename, target database, project schema, and owner app.
3. Check whether an earlier migration in the same deployment completed.
4. If apply may still be running, check the deployment process before starting
   another one.
5. Redact database URLs, credentials, identifiers, and row data from logs.

Remember two important boundaries:

- Migration modules execute as ordinary JavaScript. Do not run an untrusted or
  generated module in a process that has secrets or database access.
- JavaScript/CLI apply executes schema and data steps in authored order on
  PostgreSQL and MySQL. SQLite apply is Rust-only.

## Setup and command problems

### A package cannot be resolved

The JavaScript packages are not published to npm yet. Use a repository checkout
and complete [Prepare the checkout](getting-started.md#1-prepare-the-checkout).
Run `pnpm install --frozen-lockfile` and `pnpm build` from the repository root;
do not try to replace the workspace packages with `pnpm add`.

If `pg` or `mysql2` is missing, rerun the repository install. PostgreSQL uses
`pg` and MySQL uses `mysql2`.

### The zero-migrate runtime cannot load

Complete the source-checkout build in [Getting started](getting-started.md), then
check `ZERO_MIGRATE_ADDON_PATH`:

- it must be an absolute path;
- the file must exist;
- the filename must match your operating system and CPU architecture;
- the variable must be set before starting the CLI or Node process.

Rebuild after changing Node, Rust, the operating system, or CPU architecture.

### `Unknown file extension ".ts"`

Run the source-checkout CLI with the TypeScript loader from `packages/zero-migrate-cli`:

```bash
pnpm exec tsx dist/cli-bin.js preview --dir ./migrations
```

Alternatively, compile migrations to JavaScript and point `--dir` at the
compiled files.

### `zero-migrate: command not found`

The npm package and global executable are not published yet. From the engine
workspace, use:

```bash
pnpm exec tsx dist/cli-bin.js --help
```

## Migration discovery

### `no migrations found`

Check that:

- you passed `--dir ./migrations`; positional directories are rejected;
- files are directly inside that directory, because discovery is not recursive;
- filenames end in `.ts`, `.mts`, `.cts`, `.js`, `.mjs`, or `.cjs`;
- declaration files do not end in `.d.ts`;
- the path is correct relative to your current working directory.

Files run in lexicographic order. Use sortable timestamp or version prefixes.

### The module has no `up()`

Export one of these shapes:

```typescript
export function up() {
  // migration calls
}
```

```typescript
export default {
  up() {
    // migration calls
  },
};
```

Keep `up()` synchronous. The public authoring path does not use module-level
dependencies, supersession metadata, or a high-level `down()` workflow. Ship a
new forward migration when a deployed schema needs correction.

### The same module produces different previews

A migration may be evaluated more than once. Do not use `Date.now()`,
`Math.random()`, environment-dependent branches, network reads, or mutable
module state inside `up()`. Use database expression helpers such as `now()`,
`uuidV4()`, and supported `uuidV7()` when you need values at apply time.

Run preview repeatedly while investigating:

```bash
pnpm exec tsx dist/cli-bin.js preview --dir ./migrations --json
```

The output should be identical for the same source and package versions.

## Validation problems

### An operation is unsupported for the selected database

This usually means the migration uses a feature that is not portable to that
target. Check [Database targets](dialects.md), then:

- use a portable structured operation where possible;
- use `dialect(...)` when each database needs a genuinely different form;
- keep a target-specific migration when no equivalent behavior exists;
- do not replace an important constraint with an empty branch just to pass
  validation.

PostgreSQL-only whole-statement raw SQL is rejected by MySQL and SQLite. Raw view
bodies are a narrow, policy-controlled exception; prefer the structured view API.
MariaDB is not a supported target.

### `<unregistered>` or an ownership mismatch

The host needs an authoritative mapping of existing tables to their owner
applications:

```typescript
const registry = {
  accounts: "app_billing",
  invoices: "app_billing",
};
```

Pass the complete registry to Node `plan()`, `validate()`, and `apply()`. Do not
derive it from the migration itself.

An empty registry is enough when one migration creates a table and then changes
that table. A later, separate migration that changes the table needs its
existing ownership entry. With the CLI, save the mapping as JSON and pass
`--registry ./table-owners.json` to plan, apply, and status.

### Plan succeeds but apply fails

Offline plan checks the migration without connecting to a database. It does not
prove that:

- the project schema exists;
- the database account has the required permissions;
- no conflicting object already exists;
- a lock can be acquired;
- live data satisfies a new constraint;
- the requested change is approved by deployment policy.

Test against a disposable database configured like production before rollout.

### A change is outside the allowed schema or policy

Common causes include:

- an explicit schema outside `projectSchema`;
- a cross-schema reference;
- a table owned by another application;
- raw SQL without the required policy permission;
- a destructive change without approval;
- a database-specific feature not allowed by policy.

Prefer a structured migration within the project schema. Broadening database
permissions or platform policy is an operator decision and should be narrow,
reviewed, and tested.

## Apply problems

### Apply succeeds but row data is unchanged

Insert, update, delete, and backfill steps execute on PostgreSQL and MySQL. If
the expected rows did not change:

1. Run preview and confirm the data step is in the selected dialect branch.
2. Confirm the connection and `projectSchema` point to the intended database.
3. Review the update/delete predicate or backfill filter against the live rows.
4. Inspect the apply result and plan-aware status. An unchanged completed step
   is skipped on repeat runs.
5. Check database logs and constraints, then verify the committed rows directly.

On MySQL, the target table must use InnoDB. zero-migrate rejects other storage
engines before changing rows because the data operation and its journal event
must commit atomically. The target must also have no user triggers. zero-migrate
fails closed because it cannot prove that trigger side effects stay consistent
with the data operation and journal event.

PostgreSQL and SQLite backfills also reject target tables with pre-existing
enabled user triggers. The managed PostgreSQL online rename workflow remains
supported. A row-level policy that suppresses an update causes the
batch to roll back without advancing progress.

Do not edit an applied migration to force another run. Give the correction a
new, unique migration name.

### The project schema or database is missing

Provision it before apply. The Node host does not create the project schema or
database.

Confirm that the migration account can:

- connect to the target;
- use and modify only the project schema or MySQL database;
- create and use the migration journal;
- acquire the project migration lock;
- perform the required schema and data statements.

For MySQL, the account must also be able to read Performance Schema transaction
state. The `transaction` instrument and `events_transactions_current` consumer
must be enabled. Apply and status stop before migration work if zero-migrate
cannot verify that its dedicated session is idle.

Use a dedicated least-privilege account rather than the application owner or a
database administrator.

### Approval is required

Review the actual destructive change, then pass approval from trusted deployment
code:

```typescript
import { apply } from "zero-migrate-cli";
import * as migration from "./migrations/20260715120000_remove_legacy_field.js";

await apply({
  migration,
  ownerApp: "app_billing",
  projectSchema: "app_billing",
  registry: {
    invoices: "app_billing",
  },
  driver: {
    kind: "postgres",
    url: process.env.DATABASE_URL!,
  },
  approved: true,
  appliedBy: "deploy:release-2026-07-15",
});
```

`approved` must come from an operator or deployment control, not from the
migration module. For a reviewed CLI run, use:

```bash
zero-migrate apply --dir ./migrations --database-url "$DATABASE_URL" --approve
```

Pending deletes and backfills require approval even when no schema object is
dropped. An unchanged completed step skips before the approval check, so a
repeat run does not need renewed approval. An interrupted backfill still does.
Apply checks every pending gated step in the complete plan before executing its
first authored step. A later unapproved delete or backfill therefore cannot
leave an earlier insert, update, or schema step from that plan committed.

### A PostgreSQL online rename is refused

Check the complete preconditions before retrying:

- the source column exists and the destination column does not;
- `.rename({ type })` matches the source column's live PostgreSQL type;
- the rename is the only operation in this migration that targets its table;
- `id` is the complete, non-null, single-column primary key with a supported
  orderable cursor type;
- the table has no enabled user trigger that would make the backfill unsafe;
- row-level policy allows every selected row to be updated;
- the ownership registry proves that `ownerApp` owns the table; and
- the initial apply includes trusted approval for the bounded backfill.

Operations on different tables may remain in the migration. If the error names
another operation on the renamed table, move that schema or data operation into
a later migration and apply it only after resolution.

Do not change the migration name or source to work around a refusal. Correct the
live prerequisite or trusted input, then rerun the same reviewed migration.

Also confirm that the destination's final shape is acceptable. It is nullable
but otherwise keeps the source's exact live PostgreSQL type and modifiers.
Equivalent built-in aliases are accepted, but a modifier change such as
`numeric(10,2)` to `numeric(10,1)` is refused. Defaults, constraints, indexes,
comments, and dependent objects do not transfer. Do not use this workflow to
rename the `id` primary key. Dependencies on the source can block resolution;
audit them before rollout and inspect them after a resolution failure.

### A table is blocked by a pending rename

Run plan-aware status and find the table in `pendingContracts`:

```bash
zero-migrate status \
  --dir ./migrations \
  --database-url "$DATABASE_URL" \
  --registry ./table-owners.json \
  --schema app_demo \
  --owner-app app_demo \
  --json
```

You may author the later same-table migration, but do not apply it while this
obligation is pending. If the application cutover to the destination is
complete, keep the destination and drop the source:

```bash
zero-migrate resolve-pending "$PENDING_VERSION" \
  --apply --approve \
  --database-url "$DATABASE_URL" \
  --schema app_demo \
  --owner-app app_demo
```

If the rollout is being abandoned, first move all applications and consumers
back to the source, then use `--abort --approve`; abort keeps the source and
drops the destination. Use the same owner and project schema that opened the
obligation. If status reports `orphaned: true`, restore the immutable migration
source to the supplied set for diagnosis, but resolve the returned
`pendingVersion` explicitly rather than relying on repeat apply.

An interrupted initial apply is safe to retry unchanged with approval:
completed work skips and the backfill resumes. An open obligation is returned
again and is not resolved automatically. Resolution cleanup is all-or-nothing.
If it fails, both columns and the managed rename trigger remain intact, the
obligation stays pending, and the table remains blocked. Correct the cause and
retry the same action.

After apply or abort succeeds, replaying the exact migration does not reopen the
rename. An aborted rename remains terminal, so create a new migration with a new
exported name before trying it again. Resolving a settled version again reports
that it is no longer pending.

### `resolve-pending` or `resolvePending()` is refused

- Use a PostgreSQL URL. MySQL and SQLite have no pending rename resolver.
- Supply exactly one CLI action, `--apply` or `--abort`, and include
  `--approve`. Node uses `action: "apply" | "abort"` and `approved: true`.
- Copy the exact `pendingVersion` from `apply()` or plan-aware `status()`.
- Use the same database, `ownerApp`, and `projectSchema` that opened the
  obligation. A different owner cannot reproduce its identity.
- If the version is not found, run status against the intended project. It may
  already be resolved, belong to another project, or have been copied
  incorrectly.
- If cleanup fails, both columns and the managed rename trigger are still
  intact. Inspect dependencies and the live table, correct the external cause,
  and retry the same action.
- If the rename was successfully aborted, do not replay the old migration to
  try again. Author a replacement with a new exported name.

Do not switch from apply to abort merely because the first resolution attempt
failed. Choose based on which column the deployed application currently uses.

### A backfill cursor is rejected

On PostgreSQL and MySQL, use an exact ordered, non-null primary or unique
candidate-key tuple with supported comparison semantics. One column from a
composite key is not sufficient, and the backfill cannot assign any cursor
component. A MySQL cursor component cannot be generated or automatically
updated. Keep integer and decimal cursor values exact; the JavaScript host
carries them as text where needed rather than rounding them through `Number`.

On SQLite, use an exact ordered, non-null primary or unique candidate-key tuple
whose components have supported declared `INTEGER` or `TEXT` affinity. Every
existing cursor value must use the matching `integer` or `text` storage class.
A partial composite key, nullable legacy key, or unsupported/mixed storage class
is rejected before that backfill changes rows. `WITHOUT ROWID` is supported when
its candidate key meets these rules.

### A backfill did not include rows written while it was running

This is expected for a bounded backfill. Before its first batch, zero-migrate
captures a fixed terminal cursor. A retry resumes after the last committed
cursor and stops at that original boundary instead of chasing a growing table.
The cursor range is not a transaction-wide snapshot, so rows inserted after
capture are not guaranteed to be included even when their cursor sorts within
the range. Create a later migration for those rows.

### Lock timeout

Another deployment may already be migrating the same project, or application
traffic may be blocking the requested DDL.

1. Find the active deployment and database session.
2. Let the legitimate owner finish or fail.
3. Terminate a session only through your incident procedure.
4. Inspect migration status before retrying.

Increasing the timeout without understanding the owner can hide a duplicate
deployment.

### A later file fails after an earlier file succeeds

Applying a directory is not one transaction. Earlier files can remain applied
when a later file fails. A single file can also contain several database changes
that commit separately, so an error later in that file can leave earlier
changes applied. PostgreSQL ordinary steps are transactional, while MySQL DDL
auto-commits. Backfills commit one bounded batch at a time on both targets.

Missing approval is different: approval is preflighted across each complete
plan before its first authored step. Partial completion here means execution had
already begun and a runtime database error or interruption occurred.

Stop automatic retries, record the files reported as completed, inspect the live
schema and journal, and use a new forward migration or the documented recovery
procedure. See [Operating migrations](operations.md#failure-playbook).

## Repeat runs and journal state

### Applying the same module again does not report `skipped`

Every executable step has a stable identity derived from the owner, unique
migration name, and step order. An unchanged completed step reports `skipped`;
edited applied content fails with checksum drift.

If work does not skip, confirm that the deployment uses the same `ownerApp`,
exported migration name or filename fallback, operation order, and source. Do
not rename an applied file or reuse its name for a different migration.

### Checksum or migration drift

The journal contains the same migration identity with different content. Do not
edit the journal or rewrite the applied migration.

1. Retrieve the exact migration source and package versions used originally.
2. Compare them with the current deployment input.
3. Check for an edited file or nondeterministic module behavior.
4. Restore the reviewed, immutable source revision.
5. Ship the intended change as a new forward migration.

Database structure drift is a separate, explicit check. Public Node status does
not compare the live schema with your migration files.

### An incomplete migration is reported

Pause automated retries. This is especially important on MySQL, where DDL
auto-commits.

- Check whether the intended database object change exists.
- Compare the journal event with the current schema.
- Follow a reviewed recovery or forward-repair procedure.
- Do not add a fake completion event or delete journal rows.

For an interrupted MySQL schema step, zero-migrate keeps the inflight marker and
will not replay the possibly committed DDL. Repeating apply will fail closed
until a Rust host calls `MysqlBackend::recover_inflight_ddl` with the exact
reviewed migration. Use `MarkAppliedAfterVerification` only after verifying the
complete new shape. Use `ClearForRetryAfterRollback` only after restoring and
verifying the complete old shape. Both choices require an operator and reason,
verify marker identity, and append immutable recovery history; neither choice
reruns the DDL.

For a backfill, keep the source, name, cursor, and batch definition unchanged,
then rerun the same approved migration. It resumes after the last committed
cursor, keeps the original terminal boundary, and writes normal completion
history only after the final batch. Use a later migration for rows written after
the interrupted backfill began.

### Status shows no pending migrations

Node status calculates plan-aware state on PostgreSQL and MySQL when you pass
the ordered `migrations` set. The CLI loads that set from `--dir` automatically.
If `pending` is unexpectedly empty, confirm the intended directory, exported
names, `ownerApp`, `projectSchema`, registry, and policy ceiling match apply.

Inspect `plans` for each migration and its schema, data, and backfill step. A
mixed migration can be `partial`, and edited applied content is `drifted`.
Saved backfill progress without a completion event reports that step as
`inflight` and the plan as `partial`.

An explicitly aborted online rename appears in top-level `aborted`, not
`applied` or `pending`. Its plan and deferred `onlineContract` steps have state
`aborted`, while completed expansion steps stay `applied`. The original rename
cannot become pending again. A plan that `dependsOn` that aborted identity stays
`blocked`; point it to a newly authored replacement migration instead.

Also inspect `pendingContracts`, `blocked`, and `unexpectedJournal`.
`pendingContracts` is separate from the top-level plan `pending` list. An
expanded but unresolved rename normally has a `partial` plan with applied
`onlineExpand` steps and pending `onlineContract` steps. `orphaned` is relative
to the supplied migration set and usually means that set no longer contains the
migration that opened the rename.

### `Do not know how to serialize a BigInt`

PostgreSQL `history().events[].eventSeq` is a JavaScript `bigint`. Convert it to
a string during JSON serialization:

```typescript
const json = JSON.stringify(
  historyReply,
  (_key, value) => (typeof value === "bigint" ? value.toString() : value),
  2,
);
```

Do not convert sequence values to `Number`; large values can lose precision.

## Database-specific checks

### PostgreSQL

- Pre-create the project schema.
- Confirm the migration account can use that schema and acquire the project
  lock.
- Use Node `status()` and `history()` only after setting the same project schema
  used for apply.
- Prefer structured operations over raw SQL.

### MySQL

- Use MySQL 8; MariaDB is not supported.
- Treat the database name as the project schema.
- Remember that DDL auto-commits and may need recovery after a failure.
- Enable the Performance Schema `transaction` instrument and
  `events_transactions_current` consumer, and allow the migration account to
  read transaction state.
- Preserve `BIGINT` and `DECIMAL` values as strings in surrounding application
  code.
- Use plan-aware Node or CLI status with the same ordered migration set used for
  apply. Public history remains PostgreSQL-only.

### SQLite

- Node and CLI can validate but cannot apply to SQLite.
- Apply requires the public Rust SQLite host.
- Non-transactional migrations are rejected.
- zero-migrate processes targeting the same application database coordinate
  their complete migration plans across processes.
- Do not run another migration tool or an uncoordinated writer concurrently.
- SQLite refuses to migrate when it cannot establish crash-safe settings for
  both the application and journal databases. Close conflicting connections,
  confirm both files are writable, and do not override their safety settings
  during apply.
- SQLite backfills require a consistently typed, single-column `INTEGER` or
  `TEXT` primary key.

## Avoid these recovery shortcuts

- Do not edit or delete journal rows to make status look healthy.
- Do not mutate an applied migration.
- Do not retry while another apply may still be running.
- Do not grant broad database permissions to bypass a scoped denial.
- Do not log database URLs, secrets, or row data.
- Do not treat low-level reverse operations as a supported rollback workflow;
  zero-migrate does not currently provide high-level rollback orchestration.

## Getting help

Provide:

- the zero-migrate commit and package versions;
- operating system, CPU architecture, Node, pnpm, and database versions;
- the command or JavaScript API call and target database;
- the smallest trusted migration that reproduces the problem;
- redacted options and ownership registry keys;
- the complete error and exit code;
- whether any earlier migration completed;
- whether the problem reproduces on a new disposable database.

Never include credentials, tokens, production identifiers, or sensitive data.

## Next

- [Getting started](getting-started.md)
- [Writing migrations](writing-migrations.md)
- [CLI reference](cli.md)
- [Node API](node-api.md)
- [Operating migrations](operations.md)
- [Security model](security-model.md)
- [Documentation home](README.md)
