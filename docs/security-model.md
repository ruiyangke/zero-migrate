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

Strings used as values stay values. There is no raw expression builder.

There are two privileged text surfaces:

- PostgreSQL-only `raw({ sql, reason })` for a whole statement;
- a raw view body constrained to one read-only `SELECT`.

Both require policy permission and pass the PostgreSQL SQL safety parser. Prefer
structured operations whenever possible.

## Identity and ownership

The migration module does not choose its authoritative owner or checksum. The
trusted host supplies `ownerApp`, and zero-migrate computes the checksum from
the validated migration.

For existing tables, the host supplies a trusted table-to-owner registry:

```ts
const registry = {
  accounts: "app_identity",
  orders: "app_orders",
};
```

A migration that targets another app's table—or an existing table whose owner
cannot be proven—fails closed.

The project schema/database is also host-controlled. It must exist before
JavaScript apply.

## Policy

Policy can limit raw SQL, schema access, role/grant operations, extensions,
functions, partitions, RLS, destructive changes, and operator-owned table
shape.

An untrusted project policy can narrow a trusted ceiling but cannot widen it.
Hard safety rules still win even when a capability is granted.

Custom policy can drive Rust planning and host decisions. The public JavaScript
facade uses a confined, no-injection posture, and a general end-to-end custom
executor policy is not exposed yet. See [Policy model](policy.md).

## Approval

Destructive changes require an approval decision supplied by trusted host code.
Do not accept `approved: true` from migration input or bind approval only to a
filename.

A production approval should include:

- the exact migration identity and checksum;
- the target project and database;
- the reviewed destructive actions;
- the approver and time;
- an expiry or deployment scope where appropriate.

The Node API exposes a coarse `approved` boolean. Rust hosts can use
`ApprovalScope` to approve selected versions only.

## PostgreSQL protection

PostgreSQL has the strongest SQL text guard. Policy-gated statements are parsed
before execution and checked for dangerous file, program, privilege, session,
and cross-schema behavior.

Use a dedicated, non-login migrator role with only the project-schema
permissions required by approved migrations. The Rust `ExecutorConfig` does not
select this role unless the host configures it; the public CLI cannot configure
one.

Keep the migration journal schema inaccessible to the migrator role.

## MySQL protection

The MySQL path uses structured, generated DDL. PostgreSQL whole-statement raw SQL
is not supported.

MySQL does not switch to a separate role during apply. The connecting account's
grants are the database security boundary, so use a dedicated account limited
to the target database and protected journal database.

MySQL DDL auto-commits. zero-migrate records started/completed recovery state,
but the schema change and journal completion cannot be one transaction.

## SQLite protection

SQLite apply is available through Rust. It uses separate application and journal
files, disables extension loading, enables defensive settings, and restricts
migration statements with a database authorizer.

The in-process backend serializes operations inside one process. Coordinate
separate processes outside zero-migrate.

## Journal and integrity

Migration history is append-only. Events identify the migration, checksum,
actor, time, and outcome. Recovery markers are kept separately from durable
history.

During apply:

- a reused identity with a different checksum fails;
- a versioned/repeatable kind mismatch fails;
- an independently stored manifest can verify the expected migration set in
  Rust hosts.

Do not give migration credentials permission to update, delete, or truncate the
journal. Do not “repair” history manually after a failure.

Structural schema drift is separate from checksum history. Rust hosts can
capture and compare PostgreSQL or SQLite schema snapshots; it is not
automatically run on every JavaScript apply.

## Failure and recovery

Static validation, policy, guard, and approval failures happen before migration
SQL changes the application schema or data. Journal initialization and locking
may occur earlier. Once execution begins, migrations commit one by one. If a
later migration fails, earlier completed migrations remain applied.

For non-transactional PostgreSQL work and MySQL DDL:

1. preserve the database and journal state;
2. inspect the started/completed recovery record;
3. verify whether the schema change took effect;
4. recover through the engine or ship a reviewed forward fix;
5. never invent a completion event just to clear the incident.

There is no public high-level rollback workflow. Low-level Rust down operations
do not provide complete selection, approval, guard, or state validation. Prefer
a forward migration and keep tested backups.

## Current JavaScript boundaries

- Node/CLI apply supports PostgreSQL and MySQL DDL, not SQLite.
- Node/CLI does not execute authored `insert`, `update`, `delete`, or
  `backfill` steps.
- Node `plan`/`validate` are offline checks and do not inspect the live database.
- The CLI cannot provide an ownership registry for later alter-table files.
- The CLI cannot configure a PostgreSQL migrator role or approval.
- Node status/history are PostgreSQL-only in practice.
- Node status does not calculate pending files from a migration directory.
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
- Bind destructive approval to immutable content.
- Store verified manifests independently when using them.
- Test transactional and non-transactional recovery.
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
