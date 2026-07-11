# zero-migrate

A portable, security-first, multi-dialect database migration engine.

`zero-migrate` authors and applies schema migrations from a structured,
no-raw-SQL operation IR (`op.*`). Migrations are expressed once and rendered
faithfully to multiple SQL dialects. Every applied statement passes a security
guard backed by the real Postgres parser, so a deny-list can never be evaded by
exotic syntax.

## Highlights

- **Structured `op.*` IR, no raw SQL.** Migrations are a closed, versioned
  operation AST (`createTable`, `addColumn`, `createIndex`, `dropTable`, …) with
  a frozen wire contract and a deterministic content checksum. The same IR
  renders to every supported dialect.
- **Multi-dialect apply.**
  - **Postgres** — a native, `io_uring`-based async client (`compio-postgres`),
    with an online + shadow-dry-run apply harness. Also runnable through a
    host-supplied, driver-neutral session seam (`host-pg`) with no native driver
    linked.
  - **SQLite** — an in-process, hardened, extension-free `rusqlite` connection
    (bundled amalgamation) with a table-rebuild path for unsupported ALTERs.
  - **MySQL** — applied through a host-supplied JS driver isolate (optional,
    behind `v8-host`).
- **Security first.** A confined migrator role, a parse-time deny-list over the
  real PG grammar, an immutable journal, a plan/apply gate, advisory-lock
  serialization, and a two-phase apply/recovery flow. The build-time recorder for
  untrusted authoring runs in a kernel sandbox (seccomp-bpf + Landlock, Linux).
- **Portable core, V8-free by construction.** The guard / IR / render /
  Postgres+SQLite apply / journal core builds with **zero** heavyweight
  dependencies and no V8. The JS authoring front-end (evaluate a migration or
  schema module to IR) and the live-MySQL driver are optional, behind a host
  seam that names no V8 type.

## Workspace layout

```
crates/
├── zero-migrate/         The migration engine (guard, IR, render, apply, journal).
├── zero-migrate-schema/  Shared schema-authority core: DDL builders, diff
│                         classifier, live introspection, sentinel codec.
├── zero-migrate-host/    In-Rust V8 host impl for the engine's authoring/driver
│                         seams, backed by the public `v8` crate.
├── zero-migrate-node/    Node/Bun N-API addon (host-driven pg/mysql2 apply over
│                         the driver-neutral session seam). Its own workspace.
└── compio-postgres/      Native compio/io_uring Postgres client.
sdks/
└── migrate/              The `op.*` authoring DSL (TypeScript).
docs/
└── reference/            Reference documentation.
```

## Build profiles

The engine crate carries feature flags that control which apply backends and the
JS front-end are compiled:

| Profile | Command | What it links |
| --- | --- | --- |
| **Core (V8-free, host-driven PG)** | `cargo build -p zero-migrate --no-default-features --features host-pg` | Guard + IR + render + SQLite apply + journal + the driver-neutral PG seam. No native driver, no V8. |
| **Native PG (V8-free)** | `cargo build -p zero-migrate --no-default-features --features native-pg` | The above + the native `compio-postgres` driver + PG introspection. |
| **Full (JS authoring + MySQL)** | `cargo build -p zero-migrate` (default) | The above + the V8-backed authoring front-end and live-MySQL backend, behind the host seam. Requires the JS SDK bundles. |

## Testing

```bash
# The V8-free core (guard / IR / render / SQLite apply / journal) + schema core.
cargo test -p zero-migrate-schema
cargo test -p zero-migrate --lib -- --test-threads=1

# Postgres-backed tests need a reachable Postgres. The default DSN is
#   host=localhost port=5440 user=postgres password=... dbname=zero_migrate_test
# Override with MIGRATE_TEST_DB.
```

## Status of the V8-host authoring front-end

The engine core (guard / IR / render / Postgres + SQLite apply / journal) and the
schema core are fully self-contained and build with no V8 and no external runtime
dependency.

The **JS authoring front-end** (evaluate a migration/schema module to IR) and the
**live-MySQL driver isolate** are wired through an engine-owned host seam
(`AuthoringHost` / `RecorderPlatform` / `JsDriverHost`) implemented in
`zero-migrate-host` against the public `v8` crate. The `AuthoringHost` (module-graph
evaluation + globals) and `RecorderPlatform` (V8 platform init) seams are
implemented; the `JsDriverHost` (mysql2-over-`node:net` driver isolate) is a
mini-runtime that is not yet ported to the standalone host. The authoring path
additionally consumes the built `op.*` / schema JS SDK bundles.

## License

Apache-2.0.
