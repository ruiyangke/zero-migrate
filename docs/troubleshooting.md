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
- JavaScript/CLI apply is currently DDL-only. Data operations can validate and
  preview without being executed.

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

Run the source-checkout CLI with the TypeScript loader from `sdks/engine`:

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

- you passed `--dir ./migrations`; a positional directory is ignored;
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
module state inside `up()`. Use database expression helpers such as `now()` and
`genRandomUuid()` when you need values at apply time.

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
existing ownership entry. The CLI has no registry option, so use the Node API
for ordinary create-then-alter workflows.

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

This is a known limitation of the current public JavaScript and CLI path.
`insert`, `update`, `delete`, and `backfill` operations can appear in preview and
pass validation, but they are not executed.

A mixed migration can apply its schema operations while skipping its data
operations. A data-only migration can report success without changing rows. Do
not use JavaScript apply for data migrations in this release.

### The project schema or database is missing

Provision it before apply. The Node host does not create the project schema or
database.

Confirm that the migration account can:

- connect to the target;
- use and modify only the project schema or MySQL database;
- create and use the migration journal;
- acquire the project migration lock;
- perform the required DDL.

Use a dedicated least-privilege account rather than the application owner or a
database administrator.

### Approval is required

Review the actual destructive change, then pass approval from trusted deployment
code:

```typescript
import { apply } from "zero-migrate-engine";
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
migration module. The CLI has no approval flag.

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
changes applied. PostgreSQL migration units are transactional, while MySQL DDL
auto-commits.

Stop automatic retries, record the files reported as completed, inspect the live
schema and journal, and use a new forward migration or the documented recovery
procedure. See [Operating migrations](operations.md#failure-playbook).

## Repeat runs and journal state

### Applying the same module again does not report `skipped`

Replaying the same JavaScript module is not yet a reliable idempotency contract
in this release. Do not use repeated CLI apply as an “ensure applied” loop.
Reconcile deployment state first and test repeat behavior on a disposable
database.

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

### Status shows no pending migrations

Public Node/CLI status currently reads PostgreSQL journal state without loading
the migration directory. It does not calculate pending files. A blank pending
list is therefore expected and is not proof that deployment is complete.

Compare your release manifest with journal history in the deployment platform.
Do not use public status or history with MySQL in this release.

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
- Preserve `BIGINT` and `DECIMAL` values as strings in surrounding application
  code.
- Do not use the current public Node `status()` or `history()` calls.

### SQLite

- Node and CLI can validate but cannot apply to SQLite.
- Apply requires the public Rust SQLite host.
- Non-transactional migrations are rejected.
- Coordinate migration execution if multiple processes can open the same file.

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
