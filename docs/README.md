# zero-migrate documentation

**Write once, migrate everywhere:** author a typed TypeScript migration, validate
it for your target, review the preview, and apply it through Node, the CLI, or a
Rust host.

zero-migrate is pre-release. These guides distinguish what is available today
from the longer-term platform direction.

> Migration modules are ordinary JavaScript and are not sandboxed by the Node
> API or CLI. Run trusted modules only. Isolate untrusted or generated source
> outside the deployment process.

> On PostgreSQL and MySQL 8, Node and CLI execute schema changes, inserts,
> updates, deletes, and backfills in authored order. Pending deletes and
> backfills need explicit approval. Apply checks the complete plan before any
> authored step runs; matching completed steps skip on retry without renewed
> approval. SQLite supports all four data operations through its Rust backend.

## Choose your path

### Write a migration

1. [Getting started](getting-started.md)
2. [Writing migrations](writing-migrations.md)
3. [Choosing a database target](dialects.md)
4. [Core concepts](concepts.md)

### Run migrations from a terminal

1. [Getting started](getting-started.md)
2. [CLI reference](cli.md)
3. [Operating migrations](operations.md)
4. [Troubleshooting](troubleshooting.md)

### Run migrations from a Node application

1. [Node API](node-api.md)
2. [Operating migrations](operations.md)
3. [Policy model](policy.md)
4. [Troubleshooting](troubleshooting.md)

### Build a Rust host

1. [Rust API](embedding.md)
2. [Policy model](policy.md)
3. [Security model](security-model.md)
4. [How zero-migrate works](architecture.md)

## Guide map

| Guide | What it helps you do |
| --- | --- |
| [Getting started](getting-started.md) | Set up this pre-release and complete the first ordered schema/data migration |
| [Writing migrations](writing-migrations.md) | Use the TypeScript API for tables, columns, indexes, constraints, expressions, views, and data operations |
| [Choosing a database target](dialects.md) | Keep migrations portable and use target-specific features intentionally |
| [CLI reference](cli.md) | Create, preview, validate, apply, and inspect from a terminal |
| [Node API](node-api.md) | Call `plan`, `validate`, `apply`, `resolvePending`, `status`, and `history` from JavaScript |
| [Operating migrations](operations.md) | Plan deployments, approve destructive work, monitor history, recover, and roll forward |
| [Core concepts](concepts.md) | Understand identity, ownership, portability, policy, plans, and history |
| [Policy model](policy.md) | Configure the public policy types and host responsibilities |
| [Security model](security-model.md) | Understand trust boundaries, controls, and residual risks |
| [How zero-migrate works](architecture.md) | See the public workflow and supported execution paths |
| [Rust API](embedding.md) | Use the public Rust types and database backends |
| [Troubleshooting](troubleshooting.md) | Resolve common setup, authoring, validation, and database errors |

## Current capabilities

| Capability | Current state |
| --- | --- |
| TypeScript migration API | Available |
| Preview without a database | Available in the CLI and Node API |
| Offline target, schema-confinement, and ownership checks | Available in the CLI and Node API |
| Catalog-aware apply and status | PostgreSQL and MySQL read current tables, columns, and indexes before preparing live-dependent work |
| PostgreSQL schema and data apply | Node API, CLI, and Rust |
| PostgreSQL online column rename | Initial approved apply, application cutover, then explicit Node or CLI apply/abort resolution |
| MySQL 8 schema and data apply | Node API, CLI, and Rust; structured data targets must be trigger-free InnoDB |
| SQLite schema and data apply | Rust only, with cross-process migration coordination |
| Ordered data changes | Insert, update, delete, and backfill on every execution backend |
| Migration status | PostgreSQL and MySQL in Node; backend-specific support in Rust |
| Detailed history | PostgreSQL in Node and Rust |
| Pending migration calculation in Node | Available when `status()` receives the migration modules; CLI `status` loads its directory |
| High-level rollback | Not available; use reviewed roll-forward migrations |
| Database-backed dry run from Node | Not available |
| Trusted table-shape policy charter in Node | Required on `apply()` and plan-aware `status()`; CLI apply/status require `--policy` |
| Arbitrary custom executor policy in Node | Not exposed by the current public options |
| JavaScript package installation | Not published to npm; use the source-checkout setup |

Additional limits to plan around:

- The target PostgreSQL schema or MySQL database must exist before Node/CLI
  apply.
- CLI plan, apply, and status load a trusted JSON table-ownership registry with
  `--registry <file>`.
- CLI `plan` checks PostgreSQL by default; select MySQL or SQLite with
  `--dialect`.
- Node `plan()` and `validate()` are offline checks; they do not inspect a live
  database or guarantee apply will succeed.
- SQLite apply is not exposed by the Node API or CLI.
- MySQL support targets MySQL 8, not MariaDB.
- MySQL structured data migrations require an InnoDB target with no user
  triggers.
- Resumable backfills require an exact ordered, non-null primary/unique cursor
  tuple plus either a zero-migrate update guard or an explicitly approved named
  external invariant. Apply rejects trigger interactions it cannot prove safe.
  The managed PostgreSQL online rename workflow remains supported.
- A PostgreSQL online rename requires a matching live source type and `id` as
  the complete, non-null, single-column primary key, with no pre-existing
  enabled user triggers and no row policy that suppresses selected updates. Its
  source and destination coexist until an approved `resolvePending()` or
  `resolve-pending` action keeps one and drops the other. Other migrations on
  that table remain blocked. Cleanup is all-or-nothing, so a failed resolution
  leaves both columns and the managed rename trigger intact. Apply and abort are
  terminal for the original migration identity; retrying after abort requires a
  newly named migration.
- On PostgreSQL, the rename must be the only operation in its migration that
  targets that table. Operations on different tables may remain in the same
  migration. Put all same-table follow-up work in a later migration and apply it
  only after the rename is resolved.
- A PostgreSQL rename destination is nullable but keeps the source's exact live
  type, including modifiers. Review and recreate required defaults, constraints,
  indexes, comments, and dependent objects after resolution. Source dependencies
  can block resolution and must be audited before rollout.
- Backfills use typed tuple checkpoints and a fixed terminal tuple captured before
  the first batch. Later inserts are outside that bounded cohort: establish a
  write invariant that makes them fail the filter or run a final catch-up while
  writes are stopped. A completed cohort does not claim those inserts were
  covered.
- SQLite Rust apply coordinates zero-migrate processes for the same application
  database and refuses unsafe application or journal database settings.
- Migration names are stable identities. Keep each name unique within the
  project, and never rename or edit an applied migration.
- Status reports terminal online-rename aborts in top-level `aborted` and with
  `aborted` plan and contract-step states. Aborted plans do not satisfy
  `dependsOn`.
- Pending delete and backfill steps require `approved: true` in Node or
  `--approve` in the CLI after review. Matching completed steps skip without
  renewed approval.

## Terms used in these guides

| Term | Meaning |
| --- | --- |
| migration module | A JavaScript or TypeScript module with a synchronous `up()` function |
| preview | The structured database changes produced by a migration module |
| host | The trusted process that validates and applies migrations |
| owner | The application allowed to change a table |
| policy | Rules that admit, reject, or require approval for a change |
| approval | A trusted operator decision allowing reviewed destructive work |
| pending version | The stable key used to resolve an outstanding PostgreSQL online column rename |
| history | The append-only record of applied and rolled-back migration events |
| target | `postgres`, `mysql`, or `sqlite` |
