# Security model

A database migration can create code, change permissions, rewrite data, or
delete an entire schema. zero-migrate treats the requested database changes as
untrusted input and keeps database authority in the trusted host and database.

The public Node API and CLI execute migration modules as ordinary JavaScript.
They do not sandbox imports, top-level code, or `up()`. A module can access the
host's environment, files, network, and any imported Node API. Run only trusted
module code directly. Evaluate untrusted/generated source in an external sandbox
with no secrets or authority, then move only a reviewed migration plan into a
Rust/custom-host deployment workflow.

This guide explains what the platform protects, what the operator must provide,
and where the public JavaScript workflow currently stops.

## Trust roles

| Role | Trusted responsibilities |
| --- | --- |
| Migration author | Describes the requested change; executable module code must be trusted or externally sandboxed |
| Host | Authenticates the app, supplies ownership, schema, policy, approval, and credentials |
| Operator | Provisions least privilege, protects policy/journal/approval state, and handles incidents |
| Database | Enforces the final privileges and transaction rules |

The same person can fill all roles in a small project. The separation matters
when migrations come from customers, plugins, generated code, or AI.

## Defense layers

```text
typed JavaScript operations
        ▼
structured migration preview
        ▼
target + ownership + schema checks
        ▼
policy + SQL safety guard
        ▼
operator approval
        ▼
least-privilege database identity
        ▼
append-only journal + checksum history
```

No layer replaces another. Policy permission does not create a database grant;
approval does not override a safety denial; a database role does not verify
migration identity.

## Structured migration data

After trusted/sandboxed JavaScript evaluation, the API represents tables,
columns, constraints, expressions, views, and data operations as typed values.
Unknown operations and malformed values are rejected rather than interpreted as
SQL.

Strings and other data values stay separate from SQL structure. Insert, update,
and delete values are passed as database parameters. Schema defaults and
structured backfill expressions use dialect-safe literal encoding. There is no
raw expression builder.

`byteValue(new Uint8Array(...))` preserves exact binary bytes. Its string form
accepts well-formed base64 and decodes it into bytes; it does not store the
base64 spelling as text.

There are two privileged text surfaces:

- PostgreSQL-only `raw({ sql, reason })` for a whole statement;
- a raw view body constrained to one read-only `SELECT`.

Both require policy permission and pass the PostgreSQL SQL safety parser. Prefer
structured operations whenever possible.

## Identity and ownership

The migration module does not choose its authoritative owner or checksum. The
trusted host supplies `ownerApp`, and zero-migrate computes the checksum from
the complete validated migration, including bound data values. The owner and a
unique, stable migration name form durable plan identity. Renaming or editing
applied content is detected instead of silently becoming new work.

For existing tables, the host supplies a trusted table-to-owner registry:

```ts
const registry = {
  accounts: "app_identity",
  orders: "app_orders",
};
```

A migration that targets another app's table, or an existing table whose owner
cannot be proven, fails closed.

The project schema/database is also host-controlled. It must exist before
JavaScript apply.

## Policy

Policy can limit raw SQL, schema access, role/grant operations, extensions,
functions, partitions, RLS, destructive changes, and operator-owned table
shape.

An untrusted project policy can narrow a trusted charter but cannot widen it.
Hard safety rules still win even when a capability is granted.

Custom policy can drive Rust planning and host decisions. JavaScript database
verbs require an ordered table-shape `policy` array: the first document
is the trusted root/bound and later documents may only narrow it. The CLI accepts
the same stack through repeatable `--policy` flags. There is no confined
no-injection fallback: hosts that want author-owned shape must supply an explicit
no-inject root policy. A general end-to-end custom executor policy is not exposed
yet. See [Policy model](policy.md).

## Approval

Pending destructive changes and backfills require an approval decision supplied
by the trusted operator path. Do not accept approval from migration input or
bind it only to a filename.

The approval gate applies to pending execution. A matching completed delete or
backfill is an idempotent skip and does not require renewed approval. An
interrupted backfill still requires approval to resume. Under the project lock,
apply reconciles journal state and preflights all pending approval-gated steps in
the complete plan before any authored step executes. A later unapproved delete
or backfill therefore cannot leave an earlier step from that plan committed.

A production approval should include:

- the exact migration identity and checksum;
- the target project and database;
- the reviewed destructive actions;
- the approver and time;
- an expiry or deployment scope where appropriate.

The Node API exposes a coarse `approved` boolean, and the CLI exposes
`--approve` for a reviewed non-interactive run. Rust hosts can use
`ApprovalScope` to approve selected versions only.

For a PostgreSQL online rename, approval is checked twice: once for the initial
backfill and again for the selected resolution. Apply resolution drops the
source column; abort drops the destination column. Bind each decision to the
returned `pendingVersion` and the verified application state.

## PostgreSQL protection

PostgreSQL has the strongest SQL text guard. Policy-gated statements are parsed
before execution and checked for dangerous file, program, privilege, session,
and cross-schema behavior.

Use a dedicated, non-login migrator role with only the project-schema
permissions required by approved migrations. The Rust `ExecutorConfig` does not
select this role unless the host configures it; the public CLI cannot configure
one.

Keep the migration journal schema inaccessible to the migrator role.

PostgreSQL rejects a backfill target with a pre-existing enabled user trigger.
Row-level policy must also allow every selected row to be updated; a suppressed
update rolls the batch back without advancing progress.

A PostgreSQL online column rename requires the live source type to match the
declared type and requires `id` as the complete, non-null, single-column primary
key with a supported orderable type. Use the same trusted owner and project
schema for resolution. The returned `pendingVersion` identifies an obligation;
it is not authorization. The approved initial apply leaves the source and
destination coexisting while applications move to the destination. Other
migration changes to the table are blocked until an approved apply or abort
resolution succeeds. This prevents a later schema change from racing an
unresolved application transition.

The rename must also be the only operation in that PostgreSQL migration that
targets the table. Operations on different tables may remain. Put every other
same-table schema or data operation in a later migration and apply it only after
resolution.

During coexistence, a write through either name keeps values aligned; if both
receive different values in one statement, the destination wins. The
destination is nullable but otherwise keeps the source's exact live PostgreSQL
type and modifiers. Equivalent built-in aliases are accepted, while modifier
drift is refused during resolution. Review the loss or replacement of defaults,
constraints, indexes, comments, and dependent objects before approving removal
of the source. Dependencies on the source can block resolution and must be
audited before rollout.

Resolution cleanup is all-or-nothing. If it fails, both columns and the managed
rename trigger remain intact, the pending obligation stays outstanding, and the
table remains blocked. Correct the cause and retry the same resolution action;
do not infer a different action from the failure.

## MySQL protection

The MySQL path uses structured, generated DDL and parameterized data statements.
PostgreSQL whole-statement raw SQL is not supported.

MySQL does not switch to a separate role during apply. The connecting account's
grants are the database security boundary, so use a dedicated account limited
to the target database and protected journal database.

The account must also be able to read Performance Schema transaction state.
Enable the `transaction` instrument and `events_transactions_current` consumer.
Apply and status fail before migration work when zero-migrate cannot verify that
its dedicated session is idle.

MySQL DDL auto-commits. zero-migrate records started/completed recovery state,
but the schema change and journal completion cannot be one transaction. Every
insert, update, delete, and backfill target must use InnoDB. Backfills also
require an exact ordered, non-null primary or unique candidate-key tuple with
supported comparison semantics and an explicit cursor-stability mode. MySQL refuses structured data migrations when the
target has user triggers because it cannot prove that trigger side effects stay
transactionally consistent with the migration journal.

Apply temporarily enables autocommit, foreign-key checks, and unique checks,
then restores the connection's inherited values. If a schema step is interrupted,
zero-migrate preserves its inflight marker and refuses to replay the potentially
committed DDL. An operator must inspect and repair the live state before apply can
continue.

Before the first batch, a backfill captures a fixed terminal cursor. Each
committed batch advances saved progress, and retries stop at that original
boundary rather than chasing later rows.

## SQLite protection

SQLite apply is available through Node, the CLI, and Rust. It uses separate
application and journal files, disables extension loading, enables defensive
settings, and restricts migration statements with a database authorizer.

Atomic commits across the two files require DELETE rollback-journal mode and
`synchronous=FULL` on the migration connection. Opening an application database
that uses WAL changes its persistent journal mode. SQLite backfills reject target
tables with user triggers, validate the complete cursor domain before mutation,
and bind saved cursor values instead of treating them as SQL text.

SQLite apply coordinates zero-migrate processes that target the same application
database, so their migration plans cannot interleave. This does not coordinate
other migration tools or arbitrary writers.

SQLite refuses to migrate when it cannot establish crash-safe settings for both
the application and journal databases. A SQLite backfill additionally requires
an exact ordered, non-null primary or unique candidate-key tuple with supported
declared `INTEGER` or `TEXT` affinity. Every live cursor value must use the
matching storage class.

## Journal and integrity

Migration history is append-only. Every schema, data, and backfill step has a
stable journal identity. Events identify the step, complete migration checksum,
actor, time, and outcome. Recovery markers and backfill progress are kept
separately from durable completion history.

During apply:

- a reused identity with a different checksum fails;
- a versioned/repeatable kind mismatch fails;
- an independently stored manifest can verify the expected migration set in
  Rust hosts.

Do not give migration credentials permission to update, delete, or truncate the
journal. Do not “repair” history manually after a failure.

Append-only is enforced, not only advised. On PostgreSQL a trigger on
`schema_migrations` refuses `UPDATE`, `DELETE` and `TRUNCATE` — including from
the role that owns the table — with `migration journal is append-only (no
UPDATE/DELETE)`. Withholding those grants is defence in depth on top of that, so
a credential over-granted by mistake still cannot rewrite history. Inserting a
malformed event is separately rejected by the `schema_migrations_event_shape`
check constraint; that is a well-formedness rule and not an authenticity one, so
it is the independently stored manifest above, not the constraint, that
establishes the expected migration set.

Structural schema drift is separate from checksum history. Rust hosts can
capture and compare PostgreSQL or SQLite structural snapshots; it is not
automatically run on every JavaScript apply. MySQL provides a limited catalog
view of tables, columns, and ordered indexes for preparing live-dependent work,
not a complete structural-drift comparison.

## Failure and recovery

Static validation, policy, guard, and approval failures happen before migration
SQL changes the application schema or data. Journal initialization and locking
may occur earlier. Once execution begins, migrations commit one by one. If a
later migration fails, earlier completed migrations remain applied.

Backfills commit bounded batches. If one is interrupted, preserve its migration
name, source, cursor, and journal state, then rerun the approved migration so it
resumes after the last committed cursor and stops at its previously captured
terminal cursor. Rows inserted after capture are not guaranteed to be included;
handle them with a later migration.

An interrupted PostgreSQL online rename follows the same retry rule. Keep its
module and trusted identity inputs unchanged. Completed work skips, backfill
progress resumes, and an already-open `pendingVersion` remains outstanding
until explicitly resolved. Before apply resolution, verify that every
application instance and database consumer has stopped using the source. Before
abort resolution, move them back to the source. Never infer either choice from
the mere presence of a pending contract.

After either resolution succeeds, replaying the exact migration cannot reopen
the rename. An aborted plan is terminal, appears in status `aborted`, and does
not satisfy `dependsOn`. Author a new migration with a new exported name, then
update dependent work to its new identity, if the rename should be attempted
again.

For non-transactional PostgreSQL work and MySQL DDL:

1. preserve the database and journal state;
2. inspect the started/completed recovery record;
3. verify whether the schema change took effect;
4. use the supported PostgreSQL recovery path; for a MySQL inflight marker,
   either restore and verify the complete pre-migration shape and then delete
   that version's row from the mutable `schema_migrations_inflight` side-table,
   which is the only route the CLI and the Node SDK can reach, or call
   `MysqlBackend::recover_inflight_ddl` from a Rust host that embeds the crate
   with the exact reviewed migration, operator identity, and reason, which adds
   a marker-identity check and an immutable audit row over the direct delete;
5. treat the shape verification as your own step, because neither MySQL repair
   inspects the database: recovery records your assertion about the shape
   rather than verifying it;
6. never invent a completion event in the append-only, trigger-guarded
   `schema_migrations` table just to clear the incident.

Deleting an inflight marker needs no privilege the migration account lacks: a
successful apply issues the same statement on the same mutable side-table. That
table is not the append-only event history, and the two are not interchangeable.
See
[Interrupted MySQL or non-transactional work](operations.md#interrupted-mysql-or-non-transactional-work)
for the checklist and the exact statement.

There is no rollback command in the CLI and no rollback function across the Node
addon boundary. The Rust API does provide one: `zero_migrate::rollback` selects
and gates the whole unwind before any `down` runs - approval, target resolution,
checksum agreement, reversibility, the guard over the `down` SQL, dependency
coherence and reverse-topological order - and holds the project advisory lock
throughout.

Driving `MigrationBackend::rollback_one_transactional` per migration instead does
NONE of that. It is the leaf `rollback` calls, not a substitute for it: it runs
one `down`, journals it, and enforces no ordering and no refusals.

Prefer a forward migration and keep tested backups regardless. A rollback that
runs correctly still cannot return data a `down` dropped.

## Current JavaScript boundaries

- Node/CLI apply supports complete ordered schema and data migrations on
  PostgreSQL, MySQL, and SQLite.
- Pending deletes and backfills require Node `approved: true` or CLI `--approve`;
  approval is preflighted across the complete plan before execution, and
  backfills also require the table's complete, non-null, single-column primary
  key as their cursor.
- Node `plan`/`validate` are offline checks and do not inspect the live database.
- CLI plan, apply, and status accept a trusted ownership registry through
  `--registry <file>` for later changes to existing tables.
- The CLI cannot configure a PostgreSQL migrator role or custom audit actor.
- Node status is plan-aware on PostgreSQL and MySQL when given the ordered
  migration set; the CLI supplies its migration directory automatically.
- Node history remains PostgreSQL-only.
- Node `apply()` returns outstanding PostgreSQL online renames in
  `pendingContracts`; Node `resolvePending()` and CLI `resolve` complete
  or abort one obligation with explicit approval. The rename must be the only
  operation targeting its table in that PostgreSQL migration.
- Node `apply()` accepts executable modules only. Platforms accepting untrusted
  source need an external sandbox plus a reviewed Rust/custom-host workflow.

These are product boundaries, not permissions to bypass the host. Use a Rust
integration when the public JavaScript surface does not provide a required
control.

## What zero-migrate does not protect

zero-migrate cannot protect against:

- a compromised trusted host that supplies the wrong owner, policy, approval,
  or credentials;
- a database administrator acting outside the engine;
- incorrect application-level tenant filtering or query authorization;
- missing backups, disaster recovery, secret storage, or deployment controls;
- a custom database session that changes the SQL or connection semantics.

Keep the host and database credentials inside the trusted computing base.

## Production checklist

- Authenticate `ownerApp` independently of the migration.
- Maintain a complete trusted ownership registry.
- Pre-create the project schema/database.
- Use least-privilege credentials.
- Keep journal storage outside migration authority.
- Validate the exact target dialect.
- Review the structured migration preview.
- Bind destructive and backfill approval to immutable content.
- Use stable unique migration names. Backfills must use an exact ordered,
  non-null primary or unique candidate-key tuple with compatible comparison
  semantics and an explicit cursor-stability mode.
- Before cohort capture, make concurrent inserts fail the filter or arrange a
  final catch-up while writes are stopped.
- Require trigger-free InnoDB targets for MySQL structured data migrations.
- Enable MySQL transaction tracking and grant the migration account access to
  the required Performance Schema transaction state.
- Verify SQLite application and journal database safety before rollout.
- Store verified manifests independently when using them.
- Test transactional and non-transactional recovery.
- For each PostgreSQL online rename, verify the `id` cursor, retain the pending
  version, keep the rename as its table's only operation, complete the
  application cutover, and resolve it before scheduling another migration on
  that table.
- Run explicit structural drift checks when required.
- Maintain and test backups.
- Prefer forward fixes over low-level rollback.

## Next

- [Getting started](getting-started.md)
- [Node API](node-api.md)
- [Policy model](policy.md)
- [Operating migrations](operations.md)
- [Rust API](embedding.md)
- [Documentation home](README.md)
