# zero-migrate documentation

**Write once, migrate everywhere:** author a typed TypeScript migration, validate
it for your target, review the preview, and apply it through Node, the CLI, or a
Rust host.

zero-migrate is pre-release. These guides distinguish what is available today
from the longer-term platform direction.

> Migration modules are ordinary JavaScript and are not sandboxed by the Node
> API or CLI. Run trusted modules only. Isolate untrusted or generated source
> outside the deployment process.

> The current Node API and CLI execute schema changes only. They do not execute
> inserts, updates, deletes, or backfills, even when those operations appear in a
> preview.

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
| [Getting started](getting-started.md) | Set up this pre-release and complete the first schema migration |
| [Writing migrations](writing-migrations.md) | Use the TypeScript API for tables, columns, indexes, constraints, expressions, views, and data operations |
| [Choosing a database target](dialects.md) | Keep migrations portable and use target-specific features intentionally |
| [CLI reference](cli.md) | Create, preview, validate, apply, and inspect from a terminal |
| [Node API](node-api.md) | Call `plan`, `validate`, `apply`, `status`, and `history` from JavaScript |
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
| Offline target and ownership checks | Available in the CLI and Node API |
| PostgreSQL schema apply | Node API, CLI, and Rust |
| MySQL 8 schema apply | Node API, CLI, and Rust |
| SQLite schema apply | Rust only |
| JavaScript data-change apply | Not available; Node and CLI omit insert, update, delete, and backfill operations |
| Migration status | PostgreSQL in Node; backend-specific support in Rust |
| Detailed history | PostgreSQL in Node and Rust |
| Pending migration calculation in Node | Not available; `status().pending` is currently empty |
| High-level rollback | Not available; use reviewed roll-forward migrations |
| Database-backed dry run from Node | Not available |
| Custom policy in Node | Not exposed by the current public Node options |
| JavaScript package installation | Not published to npm; use the source-checkout setup |

Additional limits to plan around:

- The target PostgreSQL schema or MySQL database must exist before Node/CLI
  apply.
- The CLI cannot load an external table-ownership registry. It is most useful
  for create-first, self-contained migration files. Use the Node API or Rust for
  later files that change already-owned tables.
- CLI `plan` checks PostgreSQL forms. Use Node `plan()` for MySQL or SQLite.
- Node `plan()` and `validate()` are offline checks; they do not inspect a live
  database or guarantee apply will succeed.
- SQLite apply is not exposed by the Node API or CLI.
- MySQL support targets MySQL 8, not MariaDB.
- Reapplying the same authored DDL is not an idempotency guarantee in this
  pre-release.

## Terms used in these guides

| Term | Meaning |
| --- | --- |
| migration module | A JavaScript or TypeScript module with a synchronous `up()` function |
| preview | The structured database changes produced by a migration module |
| host | The trusted process that validates and applies migrations |
| owner | The application allowed to change a table |
| policy | Rules that admit, reject, or require approval for a change |
| approval | A trusted operator decision allowing reviewed destructive work |
| history | The append-only record of applied and rolled-back migration events |
| target | `postgres`, `mysql`, or `sqlite` |
