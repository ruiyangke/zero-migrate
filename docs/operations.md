# Operating migrations

This guide is for people who review, deploy, observe, and recover zero-migrate
workloads. It focuses on the public JavaScript and CLI workflow. Additional Rust
capabilities are summarized only where they affect an operator's choice.

> **Trusted modules only:** the Node API and CLI execute migration modules as
> ordinary JavaScript, without a sandbox. Run only trusted modules in a
> deployment process. Evaluate untrusted or generated source in a separate
> environment with no secrets, filesystem/network authority, or database
> credentials.

> **Complete ordered apply:** the public Node API and CLI execute schema,
> `insert`, `update`, `delete`, and `backfill` steps on PostgreSQL and MySQL 8 in
> authored order. Pending deletes and backfills require explicit operator
> approval. Approval is preflighted across the complete plan before its first
> authored step; matching completed steps skip without renewed approval.

## Operational support matrix

### Public JavaScript API

| Capability | PostgreSQL | MySQL 8 | SQLite |
| --- | --- | --- | --- |
| Offline validation and plan | Yes | Yes | Yes |
| Schema and data apply with journal | Yes | Yes | No |
| Insert/update/delete/backfill apply | Yes | Trigger-free InnoDB targets | No |
| Destructive approval | Node API | Node API | No |
| CLI approval | `--approve` | `--approve` | No |
| Online column rename and explicit resolution | Yes | No | No |
| Plan-aware status | Yes | Yes | No |
| History | Yes | No | No |
| Reads the target catalog before apply/plan-aware status | Yes | Yes | No |
| Live schema simulation | No | No | No |

The CLI exposes status but not history. Its offline plan accepts
`--dialect postgres`, `--dialect mysql`, or `--dialect sqlite`, and
`--registry <file>` supplies the same trusted JSON ownership map to plan, apply,
and status. Use the Node API for production workflows that need a migrator role
or custom audit actor.

The MySQL target means MySQL 8. MariaDB is not a supported or tested target.

### Additional Rust API capabilities

Rust hosts can additionally apply SQLite migrations. The Rust API executes the
four structured data operations: insert, update, delete, and backfill. It also
reconciles a supplied migration set on PostgreSQL, SQLite, and MySQL and performs
explicit PostgreSQL/SQLite structural drift checks. MySQL exposes a limited
catalog snapshot of tables, columns, and ordered indexes for preparing
live-dependent work, but a complete MySQL structural-drift comparison is not
available today.

There is no high-level rollback workflow on any public path. PostgreSQL online
column rename is the supported staged schema-change workflow; do not treat
lower-level Rust reversal types as a general JavaScript rollback feature. See
[Rust API](embedding.md) for the public Rust surface.

## Know the deployment identities

Keep these values distinct:

- **migration name**: a unique, stable human-readable identity exported by the
  module;
- **owner application**: the trusted `ownerApp` deploying the migration;
- **project schema**: the SQL namespace owned by that application;
- **applied by**: the human or service identity written to history;
- **migration checksum**: the content identity used to detect changes.
- **pending version**: the stable key returned for an outstanding PostgreSQL
  online column rename.

The owner application and migration name determine durable plan identity. Do
not reuse or rename an applied name. Never derive authorization from a
migration's self-declared name. Supply
`ownerApp`, `projectSchema`, and `appliedBy` from trusted deployment metadata.

## Before deployment

### 1. Keep migration code deterministic

Migration `up()` functions should be synchronous, deterministic, and free of
external side effects. Do not read clocks, random values, files, mutable global
state, network services, or environment-dependent feature flags while describing
the migration.

Validation and planning may evaluate the module more than once. A deterministic
module produces the same reviewed change every time.

Use database-side expressions such as `now()`, `uuidV4()`, and supported
`uuidV7()` when the value should be chosen during execution.
`lintDeterminism(source)` can flag some common mistakes, but it is a review aid
rather than a security boundary.

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
- inserted values, update/delete predicates, backfill assignments, cursor, and
  batch size;
- unexpected raw or vendor-specific features.

Preview does not show final SQL and is not a database dry run.

### 3. Validate every intended target

The CLI can validate an explicit target directly:

```bash
zero-migrate plan \
  --dir ./migrations \
  --dialect mysql \
  --owner-app app_orders \
  --schema app_orders \
  --registry ./table-owners.json
```

The Node API exposes the same choice programmatically:

```ts
import { plan } from "zero-migrate-cli";

const report = plan({
  migration,
  ownerApp: "app_orders",
  projectSchema: "app_orders",
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
support, project-schema confinement, and the supplied ownership registry. They
do not inspect the live schema, render final SQL, acquire a project lock, or
predict runtime database errors.

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
- The CLI accepts the same trusted mapping through `--registry <file>` on plan,
  apply, and status.

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
SQLite Rust apply coordinates zero-migrate processes that target the same
application database. Do not run a different migration tool or uncoordinated
writer against that file during a migration.

### 6. Review and approve destructive work

Pending drops, truncation, lossy type changes, deletes, backfills, and other
destructive actions require an operator decision during apply.

The Node API exposes:

```ts
await apply({
  // migration, identity, registry, and driver...
  policyCeiling,
  approved: true,
});
```

The CLI uses the equivalent non-interactive flag:

```bash
zero-migrate apply --dir ./migrations --database-url "$DATABASE_URL" \
  --policy-ceiling ./policy.toml --approve
```

Bind approval to the exact reviewed content and checksum, not only a mutable
filename. Record who approved it, when, for which environment, and with which
backup or recovery plan.

On retry, apply first reconciles stable identities and checksums. An unchanged
completed delete or backfill skips without renewed approval. An interrupted
backfill is still pending work and requires approval before it resumes.

A PostgreSQL online rename also needs approval for its initial backfill. Its
later apply or abort resolution drops one of the coexisting columns, so that
separate action always needs approval too.

Approval is a whole-plan preflight. After acquiring the project lock and reading
current journal state, apply checks every pending approval-gated step before it
executes the first authored step. A later unapproved delete or backfill therefore
cannot leave an earlier insert, update, or schema step from that same plan
committed. This guarantee covers approval refusal, not every runtime failure.

The public Node API requires a trusted table-shape `policyCeiling`; CLI apply
and plan-aware status require the same policy through `--policy-ceiling`. A
platform may make additional policy decisions in a Rust host, but arbitrary
custom executor policy is not accepted by the public Node `apply()` options yet.

## Apply behavior

From an operator's perspective, apply:

1. validates the migration, target support, ownership, safety, and trusted host
   inputs;
2. acquires the project lock;
3. checks previously applied identities, checksums, and backfill progress;
4. preflights approval for every pending gated step in the plan;
5. visits each pending step in authored order, checks its database-specific
   preconditions, and executes it;
6. records completed work with a stable step identity and the complete
   migration checksum, including bound values;
7. releases the lock and closes the database session.

An approval, ownership, or validation failure before execution leaves the
application schema unchanged, although journal setup may already have occurred.
A database error during execution is different: earlier committed changes
remain applied, including changes earlier in the same JavaScript `apply()` call.

The CLI also applies each discovered file separately. Never assume that a
directory is one all-or-nothing transaction. A mixed migration may be `partial`
after interruption; plan-aware status shows the state of each schema, data, and
backfill step before retry.

## Database-specific execution

### PostgreSQL

Supported transactional schema work and ordinary insert, update, or delete work
can commit together with the corresponding journal event. Explicitly
non-transactional operations use recovery state instead. Backfills commit
bounded batches. They capture a fixed terminal cursor tuple before the first
batch and atomically save the last committed typed tuple after each batch. The
project lock prevents two zero-migrate deployments for the same project from
running at once. `guardUpdates` installs a durable managed trigger before cohort
capture; pre-existing trigger interactions or target shapes whose behavior
cannot be proved are rejected. `externalInvariant` records the explicitly
approved invariant name in preview, progress, and status. The managed online
rename workflow remains supported. If a row-level policy lets the backfill select a row but suppresses
its update, the whole batch rolls back and progress does not advance. Correct
that database rule before retrying.

### PostgreSQL online column rename

Use `.column(source).rename({ to, type })` when an application must move to a
new PostgreSQL column name without removing the source in the same deployment:

```ts
table("users").column("display_name").rename({
  to: "full_name",
  type: t.text(),
});
```

Before rollout, confirm every prerequisite:

- the source column exists and the destination column does not;
- the declared `type` matches the source column's live PostgreSQL type;
- the rename is the only operation in this migration that targets the table;
- `id` is the complete, non-null, single-column primary key and has a supported
  orderable cursor type;
- the table has no pre-existing enabled user triggers, and row-level policy
  allows every selected backfill row to be updated;
- the migration name, `ownerApp`, `projectSchema`, and ownership registry are
  final and will remain unchanged; and
- the initial apply is approved for its bounded backfill.

Operations on different tables may remain in the same migration. Move every
other schema or data operation on the renamed table into a later migration and
apply it only after the rename is resolved.

The approved initial `apply()` returns the outstanding obligation in
`pendingContracts`:

```ts
import { readFile } from "node:fs/promises";
import { apply } from "zero-migrate-cli";
import * as renameUsersDisplayName from "./migrations/20260716120000_rename_users_display_name.js";

const policyCeiling = await readFile("./policy.toml", "utf8");

const result = await apply({
  migration: renameUsersDisplayName,
  ownerApp: "app_demo",
  projectSchema: "app_demo",
  registry: { users: "app_demo" },
  driver: { kind: "postgres", url: process.env.DATABASE_URL! },
  policyCeiling,
  approved: true,
  appliedBy: "deploy:rename-start",
});

const pending = result.pendingContracts.find(
  (contract) => contract.table === "users",
);

if (!pending) {
  throw new Error("users rename is not pending");
}

console.log({
  table: pending.table,
  from: pending.fromColumn,
  to: pending.toColumn,
  version: pending.pendingVersion,
});
```

After this call, the source and destination coexist. A write through either
name keeps their values aligned; if one statement supplies different values for
both, the destination wins. Avoid writing both names in one statement. Roll out
application code that reads and writes the destination, wait for every old
application instance and database consumer to stop using the source, and verify
the application cutover. Until resolution, zero-migrate blocks other migration
changes to that table. Plan-aware status continues to expose the obligation even
if the apply output was not retained.

The destination is nullable but otherwise keeps the source's exact live
PostgreSQL type, including modifiers. Resolution accepts equivalent built-in
spellings, such as `timestamptz` and `timestamp with time zone`, without
discarding modifiers, but refuses a modifier change such as `numeric(10,2)` to
`numeric(10,1)`.

The rename does not transfer `NOT NULL`, defaults, unique or primary-key rules,
indexes, comments, or dependent objects. Review these semantics before starting,
put the required changes in separate follow-up migrations, and apply them only
after resolution. Do not use this workflow to rename the `id` primary key.
Dependencies on the source can block resolution, so audit them before starting
the rollout.

Complete a successful rollout from Node:

```ts
import { resolvePending } from "zero-migrate-cli";

await resolvePending({
  ownerApp: "app_demo",
  projectSchema: "app_demo",
  pendingVersion: pending.pendingVersion,
  action: "apply",
  driver: { kind: "postgres", url: process.env.DATABASE_URL! },
  approved: true,
  appliedBy: "deploy:rename-finish",
});
```

The equivalent CLI command is:

```bash
zero-migrate resolve-pending "$PENDING_VERSION" \
  --apply \
  --approve \
  --database-url "$DATABASE_URL" \
  --schema app_demo \
  --owner-app app_demo
```

Apply resolution keeps the destination and drops the source. To abandon the
rename, move the application back to the source first, then use
`action: "abort"` or CLI `--abort`; abort keeps the source and drops the
destination. Both choices require explicit approval.

Retry the unchanged initial migration after an interruption. Completed work
skips, the backfill resumes from its saved cursor, and an already-open pending
obligation is returned again without implicit resolution.

Resolution cleanup is all-or-nothing. If it fails, both columns and the managed
rename trigger remain intact, the pending obligation stays outstanding, and the
table remains blocked. Correct the reported cause, then retry the same action
with the same pending version.

After apply or abort succeeds, replaying the exact migration is a terminal
no-op and never opens another obligation. Apply remains applied and abort
remains aborted. To attempt the rename again after abort, author a new migration
with a new exported name. Resolving the settled version again reports that it is
not pending.

### MySQL 8

DDL auto-commits. A crash can therefore occur after the schema changes but
before completion is written to history. Insert, update, delete, and backfill
targets must use InnoDB so each data mutation can stay consistent with its
journal state. Structured data migrations fail closed on unrecognized user
triggers because their transactional side effects cannot be proven. A managed
cursor-update guard is installed and recovered through a journaled obligation
around cohort capture. Backfills capture a fixed terminal tuple, commit bounded
batches, and save a typed tuple checkpoint after each one. During apply,
zero-migrate enables autocommit, foreign-key checks,
unique checks, and `NO_AUTO_VALUE_ON_ZERO`, then restores the connection's
previous values. The SQL mode prevents a structured import containing an
explicit legacy zero identity from silently receiving a generated value.
Use a dedicated, idle database session. If the supplied MySQL session already
has an active transaction, zero-migrate stops before changing autocommit or
running migration SQL. The migration account needs read access to MySQL's
Performance Schema transaction tables, and the `transaction` instrument plus
`events_transactions_current` consumer must be enabled. Zero-migrate stops if it
cannot prove the session is idle.

An explicit primary-key add, replace, or drop, and an identity synchronization,
also require the MySQL `LOCK TABLES` privilege for the target table and
migration inflight table. Zero-migrate holds those locks while checking the
exact live preconditions and writing the started marker. A primary-key change
then performs the key swap and any declared `AUTO_INCREMENT` removal in one
`ALTER TABLE`; identity synchronization issues an `AUTO_INCREMENT` advance only
when the uncached live counter is behind `MAX(column) + increment`. Neither path
disables `foreign_key_checks`.

If an interrupted schema step leaves an inflight marker, automatic apply stops.
The marker is preserved and the schema statement is not replayed because MySQL
may already have committed some or all of it. A Rust host resolves it with
`MysqlBackend::recover_inflight_ddl`, supplying the exact reviewed `Migration`,
the operator identity, and a non-empty reason:

- after verifying that the complete new shape exists, choose
  `MysqlInflightResolution::MarkAppliedAfterVerification`;
- after restoring and verifying the complete old shape, choose
  `MysqlInflightResolution::ClearForRetryAfterRollback`, then run the normal
  apply again.

The recovery call locks the project, verifies the marker's version, name, and
checksum against the supplied migration, and records the decision in immutable
recovery history. It never reruns the ambiguous migration SQL. A marker mismatch
or missing audit context is rejected without changing the marker.

### SQLite

SQLite apply is available only through Rust. Supported transactional schema and
ordinary data work commit atomically with their journal event; backfills commit
bounded resumable batches. Every component of a proven primary/unique cursor
tuple must have declared `INTEGER` or `TEXT` affinity, and live values must use
the matching storage class. `TEXT` values must be valid UTF-8; embedded NUL
characters are handled as data. A managed update guard is persisted in the main
database through interruption. Unrecognized target triggers are rejected because
they can suppress rows or add side effects that progress cannot describe. Some
alterations require a table rebuild.

Apply coordinates zero-migrate processes for the same application database and
uses the configured lock timeout instead of waiting forever. For atomic commits
across the application and journal files, it changes both databases to SQLite's
DELETE rollback-journal mode and uses `synchronous=FULL` on the migration
connection. Opening a database that uses WAL therefore changes its persistent
journal mode. Plan this operational change before using SQLite apply.

On every target, the ordered cursor tuple must be an exact, complete, non-null
primary or unique candidate key, and the backfill must not assign any component.
The captured terminal tuple bounds one run. A retry resumes lexicographically
after the last committed typed tuple and stops at that original boundary. Rows
inserted later are not covered automatically: establish a write invariant that
makes them fail the filter, or run a final catch-up with writes stopped.

## Status, history, and drift

The journal is append-only history rather than a mutable checklist. It records
stable step identity, the complete migration checksum, actor, time, and outcome.

### JavaScript status

Pass the ordered migration modules to JavaScript `status()` for plan-aware
PostgreSQL or MySQL status. The CLI loads them from `--dir` automatically.
Status reconciles every schema, insert, update, delete, and backfill step and
reports applied, aborted, pending, partial, drifted, blocked, or
unknown-dependency migrations. A backfill that has saved progress without its
final completion event produces an `inflight` step and a `partial` plan. Use the
same names, owner, registry, and policy ceiling as apply. Backfill steps expose
their cursor-stability mode, including the approved external-invariant name.
Identity-synchronization steps retain the authored `writesQuiesced` assertion
for operator review.

The reply also reports `pendingContracts` for outstanding PostgreSQL online
renames, `blocked` plans that wait on one of those obligations, and
`unexpectedJournal` entries that are absent from the supplied migration set.
An orphaned pending contract means the migration that opened it is no longer in
that set. Restore the immutable migration source for diagnosis and resolve its
`pendingVersion` explicitly. Treat unexpected journal entries as an incomplete
set or changed identity until proven otherwise.

`currentVersion` is the last fully applied supplied plan in dependency and input
order. `applied` lists fully applied supplied plan IDs, `aborted` lists terminal
aborted plan IDs, and `pending` lists supplied plan IDs in neither terminal
list. `rolledBack` lists versions whose latest journal event is a rollback.

Plan states are `applied`, `aborted`, `pending`, `partial`, `drifted`, `blocked`,
and `unknownDependency`. Step kinds are `ddl`, `dml`, `backfill`,
`synchronizeIdentity`, `onlineExpand`, `onlineContract`, and `sqliteRebuild`;
step states are `pending`, `inflight`, `applied`, `aborted`, and `drifted`.
Unexpected journal entries use
state `applied` or `inflight`, with completed kinds `apply`, `baseline`,
`squash`, or `repeatable`. An expanded but unresolved rename normally appears
as a `partial` plan with applied `onlineExpand` steps and pending
`onlineContract` steps. After abort, the plan and its deferred contract steps
report `aborted`, while completed expansion steps remain `applied`.

An aborted plan does not satisfy `dependsOn`. A supplied dependent plan remains
`blocked`, and apply refuses it until you replace the aborted rename with a new
migration identity and update the dependency.

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
SQLite. It is not automatically checked by JavaScript plan or apply. MySQL reads
a limited catalog view of tables, columns, and ordered indexes before preparing
apply and status work, but that view is not a complete structural-drift check.

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
- apply with Node `approved: true`, CLI `--approve`, or the equivalent trusted
  Rust-host approval.

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
- do not delete the inflight marker or retry the DDL blindly;
- use a Rust host to call `MysqlBackend::recover_inflight_ddl` with the exact
  reviewed `Migration`, operator identity, and reason;
- choose `MarkAppliedAfterVerification` only after verifying the complete new
  shape, or `ClearForRetryAfterRollback` only after restoring and verifying the
  complete old shape;
- repeat normal apply only after that repair has resolved the inflight state.

### Interrupted backfill

- keep the migration name, source, ordered cursor tuple, and batch definition
  unchanged;
- inspect plan-aware status, the last committed typed tuple checkpoint, and the
  captured typed end tuple;
- correct the external cause without editing journal rows;
- rerun the same migration with approval so it resumes after the saved tuple;
- verify the final row set and completion event;
- use a later migration for rows inserted after this backfill began.

### Runtime database failure

- identify the last completed migration in history;
- remember that earlier files may already be committed;
- inspect database logs, locks, timeouts, and target-specific errors;
- choose a forward fix or restore;
- retry only after checking the failed operation's partial state.

## Production checklist

- [ ] Migration modules are trusted and deterministic
- [ ] Every intended dialect was validated
- [ ] Every data predicate, value, cursor, and batch size was reviewed
- [ ] Ownership registry comes from trusted metadata
- [ ] Project schema or database already exists
- [ ] Least-privilege migration credentials are configured
- [ ] Exact destructive content and every backfill were reviewed and approved
- [ ] Backup and restore were tested
- [ ] Migration history is protected from application writes
- [ ] Lock and statement timeouts are configured
- [ ] Every backfill uses the table's complete, non-null, single-column primary
      key, and application writes will not change those key values until the
      backfill completes
- [ ] SQLite backfills use a single-column `INTEGER` or `TEXT` primary key with
      consistently typed live values
- [ ] Rows arriving after a backfill starts are covered by a later migration
- [ ] MySQL data targets use InnoDB and have no user triggers
- [ ] SQLite application and journal databases pass the required safety checks
- [ ] MySQL DDL has an audited inflight repair procedure and is not blindly retried
- [ ] Every PostgreSQL rename is its table's only operation in that migration
- [ ] Every PostgreSQL online rename has completed its application cutover and
      explicit resolution before the deployment is closed
- [ ] Required defaults, constraints, indexes, comments, and dependent objects
      for a renamed destination are reviewed and recreated separately
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
