# zero-migrate

A portable, security-first, multi-dialect database migration engine.

`zero-migrate` authors migrations as a closed, structured operation IR — **no
raw SQL** on the trusted path — and applies them faithfully across PostgreSQL,
MySQL, and SQLite. Every applied statement passes a security guard backed by the
*real* Postgres parser, so a deny-list can never be evaded by exotic syntax.

The engine core is a plain Rust library: **no tokio, no compio/io_uring, no
embedded V8**. Live network execution (Postgres, MySQL) is delegated to a
host-supplied JavaScript driver over a small session seam; SQLite runs
in-process. The one native C dependency in the graph is a SQL *parser*
(`pg_query`/libpg_query), owned by a single crate — not a database driver.

## Highlights

- **Structured op IR, no raw SQL.** Migrations are authored through a fluent,
  closed op surface (`table().column().add()`, `view()`, `t.*`, …) that records a
  versioned operation AST with a frozen wire contract and a deterministic content
  checksum. The same IR renders to every supported dialect. See
  [`docs/op-dsl.md`](docs/op-dsl.md).
- **Three backends behind one trait.**
  - **Postgres** — applied through the `driver::SqlSession` seam, fed by the host
    `pg` npm driver via the `zero-migrate-node` napi bridge.
  - **MySQL** — applied through the same seam, fed by the host `mysql2` npm
    driver.
  - **SQLite** — an in-process, hardened, extension-locked `rusqlite` connection
    (bundled amalgamation) with a table-rebuild path for unsupported ALTERs. It
    never crosses the seam.
- **Security first.** A closed authoring surface, a fail-closed load gate, an
  operator-ceiling ⊓ author-draft policy, a parse-time deny-list over the real PG
  grammar, a least-privilege migrator role, an immutable journal, a plan/apply
  gate, and advisory-lock serialization. See
  [`docs/security-model.md`](docs/security-model.md).
- **tokio/compio-free, V8-free core.** The shipped engine links neither tokio nor
  compio (`cargo tree -p zero-migrate -e normal | grep -E 'tokio|compio'` is
  empty); tokio appears only transitively behind the blocking `postgres` crate
  used by the **dev-only** test driver. There is no `v8` crate anywhere in the
  build graph.

## The 4 Rust crates

```
crates/
├── zero-migrate-ir/     Pure-data leaf: MigrationIr / the closed Op enum /
│                        the Expr AST + SelectAst / IrScalar / the typed-id +
│                        precondition vocab / the structural validator / the
│                        canonical checksum / the fail-closed load gate.
│                        NO I/O, NO C, NO driver. Deps: serde, serde_json,
│                        schemars, base64, hex, sha2, thiserror, uuid.
├── zero-migrate-guard/  The pg_query(libpg_query)-backed SQL security layer:
│                        parse every statement with the real Postgres parser,
│                        enforce the deny-list, classify destructive ops, run the
│                        cross-schema/advisory checks. The ONE C dependency —
│                        a SQL PARSER, not a driver. Depends on -ir only.
├── zero-migrate/        THE engine + the driver seam. Schema replay/diff/DDL,
│                        IR → script compile, policy validation, the append-only
│                        journal, the transactional executor, drift/tamper
│                        detection, least-privilege role provisioning, the three
│                        dialect backends, and `driver::{SqlSession, Bind, Value,
│                        Row, DbError}`. The crate an embedder depends on.
└── zero-migrate-node/   The napi cdylib (a full workspace member): #[napi(object)]
                         wire DTOs in wire.rs as the single source of truth (TS
                         imports the generated .d.ts), the JS-driver → SqlSession
                         adapter, and the typed verbs. Depends on the engine only.
```

The dependency graph is strictly acyclic: `ir → guard → zero-migrate → node`.

## The 2 npm packages

```
sdks/
├── migrate/   The `zero-migrate` npm package — the authoring DSL: the fluent
│              table()/t.*/view() surface, the Migration types, and the pure-JS
│              recorder (exposed to the host via the `./internal/recorder`
│              subpath). ZERO native code, zero runtime deps. What a migration
│              file imports.
└── engine/    The `zero-migrate-engine` npm package — the host runtime. Loads the
               zero-migrate-node addon, ships the `pg` / `mysql2` driver adapters
               as optionalDependencies, exposes apply / plan / status / history /
               validate, and ships the ONE CLI (bin: `zero-migrate`). Depends on
               `zero-migrate`.
```

> Cross-registry note: the flagship **Rust crate** `zero-migrate` is the *engine*
> (what embedders depend on); the flagship **npm package** `zero-migrate` is the
> *DSL* (what migration files import). Different audiences, different registries.

## The embedding model — the driver seam

The engine never opens a Postgres or MySQL socket itself. It issues its whole
apply as a strictly one-verb-at-a-time sequence over a small, dialect-neutral
seam — `zero_migrate::driver::SqlSession` — and a **host** supplies the concrete
driver. The seam's verbs are `batch` / `exec` / `exec_text` / `query` /
`query_one`; params are neutral `Bind`s (`exec_text` sends all-text,
server-inferred, for the PG concrete-OID `text → timestamptz` coercion); rows
expose `try_get` (no panicking `get`). The reference drivers ship in
`zero-migrate-engine` (`driver-pg.ts` over `pg`, `driver-mysql2.ts` over
`mysql2`). The three backends —
`PostgresBackend<S: SqlSession>` (`pg_advisory_lock`, `$N`),
`MysqlBackend<S: SqlSession>` (`GET_LOCK`, `?`), and `SqliteBackend`
(in-process rusqlite) — are unified by the `MigrationBackend` trait. Each backend
renders *its* dialect's lock/journal SQL before anything crosses the seam.

## Quickstart

**1. Write a migration** (the `zero-migrate` DSL — no raw SQL):

```ts
// migrations/20260712093000_create_orders.ts
import { table, t } from "zero-migrate";

export default {
  up() {
    table("orders").create({
      columns: {
        id: t.id(),
        total: t.numeric({ precision: 12, scale: 2 }).notNull().default(0),
        status: t.text().notNull().default("pending"),
      },
    });
  },
};
```

**2. Apply it** (the `zero-migrate-engine` host + CLI):

```bash
# DB-free structural + confinement + ownership verify (the fast pre-apply gate)
zero-migrate plan ./migrations

# apply the pending set in order over the host pg/mysql2 driver
zero-migrate apply ./migrations --database-url postgres://…

# reconcile against the live journal
zero-migrate status ./migrations --database-url postgres://…
```

Or drive the facade directly from a Node host:

```ts
import { apply } from "zero-migrate-engine";
import migration from "./migrations/20260712093000_create_orders.js";

await apply({
  migration,
  ownerApp: "app_1234",
  projectSchema: "app_1234",
  driver: { kind: "postgres", url: process.env.DATABASE_URL! },
});
```

## Build profiles

The engine crate carries feature flags controlling which apply backends compile.
**No profile pulls V8.**

| Profile | Command | What it links |
| --- | --- | --- |
| **Default (host-pg + SQLite)** | `cargo build -p zero-migrate` | Guard + IR + schema/compile + SQLite apply + journal + the `driver::SqlSession` PG/MySQL seam. |
| **Lean core (SQLite only)** | `cargo build -p zero-migrate --no-default-features` | The above with the network seam omitted. |

The `host-pg` feature lights the shared generic seam path via the internal
`pg_seam` cfg (emitted by `build.rs`); it is what the napi addon links. The napi
addon is a workspace member kept out of `default-members`, so a bare `cargo
build`/`cargo test` skips it; the loadable `.node` is built separately:

```bash
cd crates/zero-migrate-node && napi build --platform --release
```

## Testing

```bash
# The tokio/compio-free, V8-free Rust core.
cargo test -p zero-migrate-ir
cargo test -p zero-migrate-guard
cargo test -p zero-migrate           # SQLite + the driver-seam apply path

# The in-crate live-Postgres regression suite drives the SHIPPED generic PG apply
# path (PostgresBackend<S> / journal / drift / status) through the driver seam via
# a TEST-ONLY blocking-`postgres` SqlSession ([dev-dependency] only, never ships).
# It is gated on ZERO_MIGRATE_TEST_PG_URL: every live test skips when the var is
# unset; set it to a reachable DSN (e.g. a Postgres on :5440) to run — a set-but-
# unreachable DSN is a setup error (the connect panics), not a silent skip.

# The Node-native authoring → IR → apply path.
pnpm install
pnpm build                                            # builds the zero-migrate DSL package
(cd crates/zero-migrate-node && napi build --platform --release)
pnpm --filter zero-migrate test                       # DSL + IR + drift suites
pnpm --filter zero-migrate-engine test:host           # authoring → apply over the napi bridge
```

## Documentation

- [`docs/architecture.md`](docs/architecture.md) — the 4 crates, the 2 npm
  packages, the runtime flow, the three backends.
- [`docs/op-dsl.md`](docs/op-dsl.md) — the authoring surface: `table()`
  builders, `t.*`, views, the closed `Expr` AST, DML, `dialect()` legs,
  encrypted/masked columns.
- [`docs/security-model.md`](docs/security-model.md) — the defense-in-depth
  layering: the load gate, the guard, the policy seal, the plan/apply gate, the
  least-privilege role, journal immutability.
- [`docs/embedding.md`](docs/embedding.md) — embedding the engine from a Rust or
  Node host, the config/apply seams, and the CLI.
- [`docs/driver-authors.md`](docs/driver-authors.md) — writing a `SqlSession`
  driver, and the conformance kit.

## License

Apache-2.0.
