# zero-migrate — architecture

`zero-migrate` is a versioned database-migration engine for creator project
databases. Migrations are authored as a portable, closed **op DSL** (never raw
SQL strings on the trusted path), lowered to a canonical intermediate
representation (IR), security-checked with the real Postgres parser, and applied
transactionally against Postgres, MySQL, or SQLite.

The engine core is a plain Rust library: **no tokio, no compio/io_uring, no
embedded V8**. Live network execution (Postgres, MySQL) is delegated to a
host-supplied JavaScript driver over a small, dialect-neutral session seam;
SQLite runs in-process. The one native C dependency in the graph is a SQL
*parser* (`pg_query`/libpg_query), owned by a single crate — not a database
driver.

---

## The 4 Rust crates

```
                         zero-migrate-ir
                    (pure-data wire contract:
                     MigrationIr / Op / Expr / SelectAst,
                     validate / checksum / load gate,
                     typed-id, precondition vocab)
                     deps: serde, schemars, base64,
                           sha2, hex, thiserror, uuid
                     NO I/O · NO C · NO driver
                          ▲            ▲
                          │            │
         ┌────────────────┘            └───────────────┐
         │                                             │
  zero-migrate-guard                                zero-migrate
  (pg_query / libpg_query               (THE engine + the driver seam:
   SQL security: classify,               schema replay/diff/DDL, IR → script
   deny-list, advisories.                compile, policy validation, journal,
   The ONE C dep — a SQL                 executor, drift, role provisioning,
   PARSER, not a driver)                 3 backends, the SqlSession seam)
         ▲                                             ▲
         └──────────────────┬──────────────────────────┘
                            │
                     zero-migrate-node
              (napi cdylib: typed verb boundary,
               JS-driver → SqlSession adapter,
               #[napi] DTOs as the .d.ts source of truth)
```

| Crate | Role | Notable deps |
| --- | --- | --- |
| `zero-migrate-ir` | The **wire contract**: the `MigrationIr` document, the closed `Op` enum, the closed `Expr` AST + `SelectAst`, the constrained `IrScalar`, the precondition vocabulary, the typed-id machinery, the canonical `Checksum`, the structural (allow-list) validator, and the policy-free half of the fail-closed `.ir.json` load gate. A true leaf: I/O-free, C-free, driver-free, and it does **not** depend on the engine. | `serde`, `serde_json`, `schemars`, `base64`, `sha2`, `hex`, `thiserror`, `uuid` |
| `zero-migrate-guard` | The `pg_query`(libpg_query)-backed SQL security layer: parse every statement with the real Postgres parser, enforce the deny-list, cross-schema confinement, and operational advisories. Owns the **only C dependency** on the non-SQLite path. Depends on `zero-migrate-ir` only. | `pg_query`, `serde`, `serde_json`, `thiserror`, `zero-migrate-ir` |
| `zero-migrate` | **The engine.** Schema snapshot/replay/diff/DDL, IR → executable script compile, policy validation, the append-only journal, the transactional/two-phase executor, drift + tamper detection, least-privilege role provisioning, the three dialect backends, and the `driver::SqlSession` seam. This is the crate an embedder (a Rust host) depends on. | `zero-migrate-ir`, `zero-migrate-guard`, `rusqlite` (bundled SQLite), `serde`, … (**no** tokio, **no** compio in shipped deps) |
| `zero-migrate-node` | The napi **cdylib** (`crate-type = ["cdylib", "rlib"]`). It exposes the engine over N-API with a zero-tokio, zero-io_uring transport: `#[napi(object)]` DTOs in `wire.rs` are the single source of truth (TS imports the generated `.d.ts`), plus the JS-driver → `SqlSession` adapter and the typed verbs. Depends on `zero-migrate` (the only edge). | `napi`, `zero-migrate`, `pg_query`/`rusqlite` (transitively) |

The dependency graph is strictly acyclic: `ir → guard → zero-migrate → node`.
`zero-migrate-ir` sits at the bottom; the engine re-exports its modules under
their historical paths (`pub use zero_migrate_ir::{id, capability, expr, ir,
migration, policy, precondition, probe}`) and flattens the individual IR types
at the root (`pub use model::ir::{MigrationIr, Op, …}`), so downstream code
names `zero_migrate::MigrationIr`, `zero_migrate::Op`, etc. unchanged.

### tokio/compio-free core, one C dep

The shipped engine links **neither tokio nor compio**:

```
cargo tree -p zero-migrate -e normal | grep -E 'tokio|compio'   # → empty
```

`tokio` appears only transitively behind the blocking `postgres` crate used by
the **dev-only** test driver (a `[dev-dependencies]` entry that never ships). The
single C dependency in the whole graph is `pg_query` (libpg_query) in
`zero-migrate-guard` — a SQL **parser** chosen precisely so the security
deny-list sees exactly what Postgres would execute and cannot be bypassed by
exotic syntax a pure-Rust parser would misparse. SQLite's C library rides in via
`rusqlite`'s bundled build, which the engine drives in-process; it is not a
network driver.

---

## The 2 npm packages

```
zero-migrate            The authoring DSL — op.*, table() builders,
  (package: sdks/migrate) defineMigration types, and the pure-JS recorder.
                        ZERO native code, zero runtime deps. What a migration
                        file imports. Exposes the recorder to the host via a
                        documented "./internal/recorder" subpath (one consumer).
    ▲
    │ depends on (drains up() through ./internal/recorder)
zero-migrate-engine     The host runtime — loads the zero-migrate-node addon,
  (package: sdks/engine)  ships the pg / mysql2 driver adapters as
                        optionalDependencies, exposes apply/plan/status/
                        history/validate, and ships the ONE CLI
                        (bin: `zero-migrate`, cli.ts).
```

`zero-migrate` (npm) is the DSL a creator's migration file imports
(`import { op } from "zero-migrate"`). `zero-migrate-engine` (npm) is the host
that actually applies migrations: it loads the native addon and injects a
`pg`/`mysql2` driver. `pg` and `mysql2` are **optionalDependencies** — a host
that only targets SQLite (in-process rusqlite) needs neither installed.

> Cross-registry note: the flagship **Rust crate** `zero-migrate` is the
> *engine* (what embedders depend on); the flagship **npm package**
> `zero-migrate` is the *DSL* (what migration files import). Different audiences,
> different registries — each is "the main thing you touch" in its world.

---

## Runtime flow

```
  migration file                                (a creator's *.ts)
  import { op } from "zero-migrate"
        │
        │  export default defineMigration({ up(t){ op.createTable(...) } })
        ▼
  zero-migrate (npm, DSL)                        pure JS, no native code
    recorder drains up() → { ir_version, name, ops }  envelope
        │                                        (ir_version from the addon's
        │                                         irVersion(); NO owner_app,
        ▼                                         NO checksum yet)
  zero-migrate-engine (npm, host)                loads the addon, opens a
    opens a pinned pg / mysql2 session           ONE-connection host session
        │
        ▼
  zero-migrate-node (napi addon)                 typed verb boundary
    applyIr(hostDriver, request)                 LOWERs the envelope in Rust:
        │                                         stamps owner_app, folds the
        │                                         authoritative Checksum::of_ir
        ▼
  zero-migrate (Rust engine)                     guard → plan → gate → executor
    guard (line 1) · least-priv role (line 2)
    executor::apply<B: MigrationBackend>
        │
        │  every SqlSession verb crosses back to JS ────────┐
        ▼                                                   ▼
  PostgresBackend<S> / MysqlBackend<S>           driver::SqlSession  ⇄  JS driver
    ($N / pg_advisory_lock)  (? / GET_LOCK)      batch/exec/exec_text/         (pg /
                                                 query/query_one               mysql2)
                                                        │
                                                        ▼
                                                   the database
```

SQLite takes a shorter path: it never crosses the seam. `SqliteBackend` is an
in-process `rusqlite` actor that the engine drives directly (with a
`prepare`-time authorizer as the line-2 defense, plus statically-registered
`vec0` and FTS5 with `load_extension` locked down).

The engine is a synchronous, reactor-less library. Under the napi addon, each
async host-driven verb (`applyIr`, `status`, `history`) runs the engine on its
own worker thread via a reactor-less `futures::executor::block_on`; each
`SqlSession` verb parks on a `oneshot` channel that a JS `done(err, reply)`
callback fires — no `#[napi] async fn`, no `Promise::await`, no tokio runtime.

---

## The three backends + the `MigrationBackend` trait

The executor's apply/rollback **orchestration** (versioned vs repeatable
partitioning, the drift/tamper gate, squash/expand gates, pending ordering, the
first/second pass, rollback selection) is dialect-agnostic and lives once in
`apply::executor`. Everything dialect-coupled sits behind the
`MigrationBackend` trait — connection/session I/O (the project lock, GUC
snapshot/restore, `SET ROLE`/`RESET ROLE`, transaction control), the confined
per-migration apply, journal row I/O (as dialect-neutral owned structs, never a
driver row), non-txn idempotency validation, and drift schema introspection.

The trait is used through **static dispatch** (`<B: MigrationBackend>`), so
native `async fn` in trait is used directly — no `dyn`, no `async-trait`
allocation on the apply hot path.

| Backend | Dialect | Lock | Placeholders | Transport |
| --- | --- | --- | --- | --- |
| `PostgresBackend<S: SqlSession>` | Postgres | `pg_advisory_lock(hashtext($1))` | `$N` (numbered) | `driver::SqlSession` seam (npm `pg`) |
| `MysqlBackend<S: SqlSession>` | MySQL | `GET_LOCK(...)` | `?` (positional) | `driver::SqlSession` seam (npm `mysql2`) |
| `SqliteBackend` | SQLite | in-process `BEGIN IMMEDIATE` | rendered locally | in-process `rusqlite` (**not** the seam) |

Each backend owns *its* dialect's lock/journal/session SQL and placeholder style,
rendered **before** any SQL crosses the seam, so no dialect SQL ever lives in the
shared executor. `SqlSession` is an implementation detail of the two *network*
backends, not a bound on the `MigrationBackend` trait. The Postgres and MySQL
backend modules compile behind the `pg_seam` cfg (emitted by `build.rs` from the
`host-pg` feature); `SqliteBackend` is always present.

---

## Authoring model — closed op DSL, no raw SQL on the trusted path

Migrations are authored as an ordered list of `Op`s (the closed `Op` enum in
`zero-migrate-ir`). Every transform and predicate position carries the closed
`Expr` AST — constructed in JS, serialized as data, **never parsed from text**.
Views are expressed as `ViewQuery::Structured { SelectAst }` (the engine's own
`SelectAst`) or, capability-gated, `ViewQuery::Raw`. `Op::Insert` carries literal
rows; `INSERT ... SELECT` is deliberately **not** a feature. This closed surface
is what lets the structural validator be a pure allow-list walk and the checksum
be canonical.

Two authoring-time codec knobs are configurable rather than hard-coded brands:

- **Sentinel prefixes** — the persisted encryption/mask sentinel prefixes are a
  `SentinelPrefix` config value (defaults `zero-migrate:enc:` /
  `zero-migrate:mask:`). A host that must interoperate with a legacy writer in
  the same schema injects that writer's prefix (for example the legacy `zsenc:`);
  the standalone default carries this project's own brand so no stranger's
  `pg_dump` carries a foreign one.
- **Reserved SQL prefix** — `__zero_migrate` is reserved for the engine's own
  internal objects (e.g. SQLite rebuild temp tables like
  `users__zero_migrate_rebuild`).

---

## Security stance

Migrations are privileged, arbitrary schema changes authored by untrusted
creators (and potentially a prompt-injectable AI). Defense is in depth:

- **Line 1 — the guard** (`zero-migrate-guard`). Every statement is parsed with
  the real Postgres parser and checked against a hard deny-list; dangerous
  constructs nested inside `DO $$…$$` blocks and function bodies are inspected
  too. Unparseable input is denied. The guard *denies* RCE / privilege-escalation
  / cross-tenant / file / network, and only *flags* data loss
  (`DROP`/`TRUNCATE`/lossy type change) — the apply gate decides on destructive
  ops.
- **Line 2 — the least-privilege `migrator` role** (Postgres) / the `prepare`-time
  authorizer (SQLite). The database itself rejects the same ops even if SQL
  somehow slips past parse.

The guard runs out-of-band at deploy time, not on the request hot path, so it is
plain synchronous logic — no tokio/compio — and exhaustively unit-testable
without a database.

---

## Where to go next

- **Embedding + customizing the engine** (Rust host or Node host):
  [`embedding.md`](./embedding.md).
- **Writing a `SqlSession` driver** (the network-dialect seam):
  [`driver-authors.md`](./driver-authors.md).
