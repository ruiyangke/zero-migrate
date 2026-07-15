# Operating migrations

This guide is for people who review, deploy, observe, and recover zero-migrate
workloads. It focuses on the public JavaScript and CLI workflow. Additional Rust
capabilities are summarized only where they affect an operator's choice.

> **Trusted modules only:** the Node API and CLI execute migration modules as
> ordinary JavaScript, without a sandbox. Run only trusted modules in a
> deployment process. Evaluate untrusted or generated source in a separate
> environment with no secrets, filesystem/network authority, or database
> credentials.

> **DDL-only JavaScript apply:** the public Node and CLI apply paths do not
> execute `insert`, `update`, `delete`, or `backfill`. Those operations can still
> appear in preview and pass offline validation. A mixed migration can apply its
> schema changes while omitting its data changes, and a data-only migration can
> appear to succeed without changing data. Keep data work out of JavaScript
> apply workflows in this release.

## Operational support matrix

### Public JavaScript API

| Capability | PostgreSQL | MySQL 8 | SQLite |
| --- | --- | --- | --- |
| Offline validation and plan | Yes | Yes | Yes |
| DDL apply and journal | Yes | Yes | No |
| Insert/update/delete/backfill apply | No | No | No |
| Destructive approval | Node API | Node API | No |
| Status | Journal state only | No | No |
| History | Yes | No | No |
| Live schema simulation | No | No | No |

The CLI is narrower: its plan command targets PostgreSQL, it cannot supply an
ownership registry or destructive approval, and it exposes status but not
history. Use the Node API for production workflows that need those inputs.

The MySQL target means MySQL 8. MariaDB is not a supported or tested target.

### Additional Rust API capabilities

Rust hosts can additionally apply SQLite migrations, execute parameterized data
steps on PostgreSQL and SQLite, run SQLite backfills, reconcile a supplied
migration set, and perform explicit PostgreSQL/SQLite structural drift checks.
MySQL does not support those data or structural-drift paths today.

There is no high-level rollback workflow on any public path. Do not treat
lower-level Rust types as a ready-made JavaScript rollback or online-change
workflow. See [Rust API](embedding.md) for the public Rust surface.

## Know the deployment identities

Keep these values distinct:

- **migration name**: a stable human-readable label exported by the module;
- **owner application**: the trusted `ownerApp` deploying the migration;
- **project schema**: the SQL namespace owned by that application;
- **applied by**: the human or service identity written to history;
- **migration checksum**: the content identity used to detect changes.

Never derive authorization from a migration's self-declared name. Supply
`ownerApp`, `projectSchema`, and `appliedBy` from trusted deployment metadata.

## Before deployment

### 1. Keep migration code deterministic

Migration `up()` functions should be synchronous, deterministic, and free of
external side effects. Do not read clocks, random values, files, mutable global
state, network services, or environment-dependent feature flags while describing
the migration.

Validation and planning may evaluate the module more than once. A deterministic
module produces the same reviewed change every time.

Use database-side expressions such as `now()` and `genRandomUuid()` when the
value should be chosen during execution. `lintDeterminism(source)` can flag some
common mistakes, but it is a review aid rather than a security boundary.

### 2. Preview the migration

```bash
zero-migrate preview --dir ./migrations
```

The documentation uses `zero-migrate` as shorthand. Until the JavaScript
packages are published, use the source-checkout command prefix from
[Getting started](getting-started.md#1-prepare-the-checkout).

Review:

- operation order and object names;
- defaults, constraints, indexes, and destructive actions;
- database-specific `dialect()` branches;
- accidental data operations, which JavaScript apply will omit;
- unexpected raw or vendor-specific features.

Preview does not show final SQL and is not a database dry run.

### 3. Validate every intended target

The CLI plan command is PostgreSQL-oriented. Use the Node API for an explicit
target:

```ts
import { plan } from "zero-migrate-engine";

const report = plan({
  migration,
  ownerApp: "app_orders",
  dialect: "mysql",
  registry: {
    orders: "app_orders",
  },
});

if (!report.ok) {
  throw new Error(report.error ?? "migration validation failed");
}
```

JavaScript plan and validation are offline. They check document shape, dialect
support, and the supplied ownership registry. They do not inspect the live
schema, render final SQL, acquire a project lock, or predict runtime database
errors.

Run a staging apply against the same database family and major version as
production whenever a change can affect availability or data.

### 4. Build the ownership registry

The ownership registry maps table names to trusted application owners:

```ts
const registry = {
  users: "app_identity",
  orders: "app_orders",
};
```

It is table-to-owner, not application-to-schema.

- A migration that creates and then modifies a table can use an empty registry.
- A later migration that changes that existing table needs a matching entry.
- Unknown or mismatched ownership fails closed.
- The current CLI cannot provide this registry, so use Node or Rust for
  follow-up changes to existing tables.

Build the registry from trusted project metadata or a verified database catalog,
not from values declared inside the migration module.

### 5. Provision the target

Before apply:

1. create the project schema or database;
2. configure the connection URL through a secret manager;
3. grant the migration account only the required database privileges;
4. protect the migration history from application writes;
5. configure suitable lock and statement timeouts;
6. take a backup or snapshot before potentially lossy changes;
7. test restore and recovery procedures.

`projectSchema` confines migration work; it does not create the outer schema or
database.

For PostgreSQL, use a dedicated least-privilege migration role when possible and
keep migration history outside the application's writable namespace. For MySQL,
the connecting account's grants are the main database-side enforcement layer.
For SQLite Rust deployments, avoid concurrent migration processes unless your
Rust host provides its own cross-process coordination.

### 6. Review and approve destructive work

Drops, truncation, lossy type changes, and other destructive actions require an
operator decision during apply.

The Node API exposes:

```ts
await apply({
  // migration, identity, registry, and driver...
  approved: true,
});
```

The CLI has no approval flag. If a change needs approval, apply it through Node
or a Rust host.

Bind approval to the exact reviewed content and checksum, not only a mutable
filename. Record who approved it, when, for which environment, and with which
backup or recovery plan.

The public Node API uses the built-in confined policy. A platform may make
additional policy decisions in a Rust host, but arbitrary custom policy is not
accepted by the public Node `apply()` options yet.

## Apply behavior

From an operator's perspective, apply:

1. validates the migration and trusted host inputs;
2. checks target support, ownership, safety, and approval;
3. acquires the project lock;
4. checks previously applied identities and checksums;
5. executes each pending supported migration in order;
6. records completed work in append-only history;
7. releases the lock and closes the database session.

An approval, ownership, or validation failure before execution leaves the
application schema unchanged, although journal setup may already have occurred.
A database error during execution is different: earlier committed changes
remain applied, including changes earlier in the same JavaScript `apply()` call.

The CLI also applies each discovered file separately. Never assume that a
directory is one all-or-nothing transaction.

## Database-specific execution

### PostgreSQL

Supported transactional schema work can commit together with its history event.
Explicitly non-transactional operations use recovery state instead. The project
lock prevents two zero-migrate deployments for the same project from running at
once.

### MySQL 8

DDL auto-commits. A crash can therefore occur after the schema changes but
before completion is written to history. Use idempotent supported DDL, inspect
recovery state after interruption, and verify the live schema before retrying.

### SQLite

SQLite apply is available only through Rust. Supported transactional schema work
and its history event are atomic. Some alterations require a table rebuild, and
coordination is process-local unless the Rust host adds stronger locking.

## Status, history, and drift

The journal is append-only history rather than a mutable checklist. It records
migration identity, checksum, actor, time, and outcome.

### JavaScript status

JavaScript `status()` currently reads journal state without comparing it with a
migration directory. Its `pending` list is therefore not a pending-file report.
It supports PostgreSQL only.

### JavaScript history

JavaScript `history()` returns PostgreSQL events. MySQL and SQLite history are
not available through the public JavaScript API. The CLI has no history command.

On a fresh database, status or history may initialize the journal, so do not
assume the first call is physically read-only.

### Checksum drift

Apply compares known migration content with recorded history. If applied content
has changed, stop the deployment and investigate; do not edit history by hand.

### Structural drift

Live-schema drift is a separate explicit Rust workflow for PostgreSQL and
SQLite. It is not automatically checked by JavaScript plan or apply, and MySQL
does not currently support it.

## Rollback strategy

zero-migrate does not provide a public high-level rollback command. A
TypeScript `down()` function is not used by the public Node or CLI workflow.

Prefer this order:

1. deploy a reviewed forward-fix migration;
2. restore from a tested backup when data loss is irreversible;
3. use low-level Rust reversal capabilities only inside a trusted host that adds
   selection, state validation, safety checks, approval, and auditing.

Plan the forward fix and restore path before approving a destructive migration.

## Failure playbook

### Validation or ownership failure

- keep the database untouched;
- inspect the reported operation and target dialect;
- verify the ownership registry;
- preview the migration again;
- fix the migration or trusted inputs instead of bypassing the gate.

### Approval required

- identify the exact destructive content;
- review data-loss, lock, and availability implications;
- confirm a tested recovery path;
- record approval out of band;
- apply through Node or Rust with that approval.

### Checksum mismatch

- stop deployments;
- compare source control, the reviewed preview, and journal history;
- determine whether an applied migration was renamed or edited;
- restore the reviewed source or use an audited reconciliation process;
- never rewrite history simply to make the error disappear.

### Interrupted MySQL or non-transactional work

- leave the database and journal unchanged while investigating;
- inspect the recorded recovery state and live schema;
- determine whether the database change committed;
- retry only after confirming the operation is safe and idempotent;
- avoid manually marking completion unless an incident procedure verifies every
  required invariant.

### Runtime database failure

- identify the last completed migration in history;
- remember that earlier files may already be committed;
- inspect database logs, locks, timeouts, and target-specific errors;
- choose a forward fix or restore;
- retry only after checking the failed operation's partial state.

## Production checklist

- [ ] Migration modules are trusted and deterministic
- [ ] Every intended dialect was validated
- [ ] Preview contains no accidental data operations
- [ ] Ownership registry comes from trusted metadata
- [ ] Project schema or database already exists
- [ ] Least-privilege migration credentials are configured
- [ ] Exact destructive content was reviewed and approved
- [ ] Backup and restore were tested
- [ ] Migration history is protected from application writes
- [ ] Lock and statement timeouts are configured
- [ ] MySQL/non-transactional work is safe to retry
- [ ] Staging uses the production database family and major version
- [ ] Forward-fix and incident owners are assigned
- [ ] Logs capture migration name, checksum, actor, and failure class

## Next

- [Node API](node-api.md)
- [CLI reference](cli.md)
- [Policy model](policy.md)
- [Security model](security-model.md)
- [Rust API](embedding.md)
- [Troubleshooting](troubleshooting.md)
- [Documentation home](README.md)
