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
  - **Postgres** — applied through a driver-neutral session seam (`host-pg`) fed
    by the host `pg` npm driver via the `zero-migrate-node` napi bridge. No native
    Rust Postgres driver is shipped in this standalone.
  - **SQLite** — an in-process, hardened, extension-free `rusqlite` connection
    (bundled amalgamation) with a table-rebuild path for unsupported ALTERs.
  - **MySQL** — applied through the host `mysql2` npm driver via the same napi
    bridge (Node-side, no embedded V8).
- **Security first.** A confined migrator role, a parse-time deny-list over the
  real PG grammar, an immutable journal, a plan/apply gate, advisory-lock
  serialization, and a two-phase apply/recovery flow.
- **Node-native, V8-FREE by construction.** The engine ships **no embedded V8**.
  The guard / IR / render / SQLite apply / journal core builds with zero
  heavyweight dependencies. Authoring, MySQL, and Postgres all execute in the
  **Node process** (the `@zeroship/migrate` host-recorder evals the DSL into an
  op-IR envelope; the `zero-migrate-node` napi addon LOWERs it in Rust — stamping
  `owner_app` and folding the authoritative checksum — then applies it over the
  `pg` / `mysql2` npm drivers). There is no `v8` crate anywhere in the build graph
  or dev-dependencies.

## Workspace layout

```
crates/
├── zero-migrate/         The migration engine (guard, IR, render, apply, journal).
│                         V8-FREE — no embedded V8, no `v8` dependency.
├── zero-migrate-schema/  Shared schema-authority core: DDL builders, diff
│                         classifier, live introspection, sentinel codec.
└── zero-migrate-node/    Node/Bun N-API addon: host-driven pg/mysql2 apply over
                          the driver-neutral session seam. Its own workspace.
sdks/
├── migrate/              The `op.*` authoring DSL + the Node host facade
│                         (`@zeroship/migrate/host`: host-recorder → napi apply).
└── db/                   A decoupled, self-contained subset of the `@zeroship/db`
                          type-builder (TypeBuilder + FieldDef) the migrate
                          `db-lexicon` bridge consumes. See the follow-up note below.
docs/
└── reference/            Reference documentation.
```

## Build profiles

The engine crate carries feature flags that control which apply backends are
compiled. **No profile pulls V8** — authoring/MySQL/PG execution all run on Node
via the napi bridge.

| Profile | Command | What it links |
| --- | --- | --- |
| **Default (host-pg + SQLite + CLI)** | `cargo build -p zero-migrate` | Guard + IR + render + SQLite apply + journal + the driver-neutral PG seam + the standalone CLI. No native driver, no V8. |
| **Library core (host-driven PG)** | `cargo build -p zero-migrate --no-default-features --features host-pg` | The above minus the CLI. This is what the `zero-migrate-node` napi addon links. |
| **Lean core (SQLite only)** | `cargo build -p zero-migrate --no-default-features` | Guard + IR + render + SQLite apply + journal, PG seam omitted. |

The napi addon is built separately (it is its own excluded workspace):

```bash
cd crates/zero-migrate-node && napi build --platform --release
```

## Testing

```bash
# The V8-free Rust core (guard / IR / render / SQLite apply / journal) + schema core.
cargo test -p zero-migrate-schema --lib
cargo test -p zero-migrate --lib

# The V8-free integration suites (SQLite + host-pg seam). Postgres-backed tests
# need a reachable Postgres; the standalone ships no native PG driver, so those
# suites are `native-pg`-gated (permanently off here) and compile to empty.
cargo test -p zero-migrate

# The Node-native authoring → IR → apply path. Build the SDKs + the napi addon,
# then run the host authoring test (offline arm always; the apply arm uses a
# reachable Postgres at postgres://postgres:...@localhost:5440/zero_migrate_test
# and auto-skips if unreachable).
pnpm install
pnpm build                                   # @zeroship/db → @zeroship/migrate
(cd crates/zero-migrate-node && napi build --platform --release)
pnpm --filter @zeroship/migrate test         # DSL + IR + drift suites
pnpm --filter @zeroship/migrate test:host    # authoring → apply over the napi bridge
```

## Node-native authoring path

Authoring, MySQL, and Postgres execution all run in the Node process — there is no
embedded V8. The flow (`@zeroship/migrate/host`):

1. the pure-JS **host recorder** (`src/host-recorder.ts`) evals a migration's
   `up()` (the `table()` / `t.*` DSL) and drains it into a
   `{ ir_version, name, ops }` op-IR envelope. It computes NO checksum and stamps
   NO `owner_app` — those are Rust-owned provenance/integrity fields;
2. the **`zero-migrate-node` napi addon** `applyIr` LOWERs the envelope in Rust
   (stamps `owner_app`, folds the authoritative `Checksum::of_ir` and the confined
   system-column shape), then drives the engine's `executor::apply` over the host
   `pg` / `mysql2` npm driver via the `hostDriver` session seam.

`plan()` (DB-free structural + confinement pre-check via the addon's `loadVerify`)
and `status()` / `history()` (journal reads over the host driver) round out the
facade.

## Follow-up: `@zeroship/db` decoupling

The migrate authoring DSL's `db-lexicon` bridge (`fromDb` / `colTypeFromDbField` —
the "lift a live `@zeroship/db` schema field into a migration column" convenience)
imports `TypeBuilder` + `FieldDef` from `@zeroship/db`. The core `t.*` / `table()`
authoring surface lives in `@zeroship/migrate` itself and does NOT need it; the
bridge is the only consumer.

`sdks/db` here is a **decoupled, self-contained subset** of that type-builder — a
real `TypeBuilder` (`.required()` / `.optional()` / `.unique()` / `.toFieldDef()`)
and the `FieldDef` union the bridge maps, enough to build and run the `db-lexicon`
tests. It is NOT the full platform `@zeroship/db` (query / CRUD / aggregation /
generated `env.db` typing). For a fully shippable npm package the bridge should
either vendor the real `@zeroship/db` type surface or be made lazy/optional so
`@zeroship/migrate` carries no hard dependency on it.

## License

Apache-2.0.
