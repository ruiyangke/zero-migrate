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
  **Node process** (the `zero-migrate` recorder evals the DSL into an op-IR
  envelope; the `zero-migrate-engine` host loads the `zero-migrate-node` napi
  addon, which LOWERs it in Rust — stamping `owner_app` and folding the
  authoritative checksum — then applies it over the `pg` / `mysql2` npm drivers).
  There is no `v8` crate anywhere in the build graph or dev-dependencies.

## Workspace layout

```
crates/
├── zero-migrate/         The migration engine (render, apply, journal, and the
│                         `schema` module: DDL builders, diff classifier, sentinel
│                         codec, schema-shape descriptors). V8-FREE — no embedded
│                         V8, no `v8` dependency.
├── zero-migrate-ir/      Leaf wire contract: MigrationIr, the closed Op/Expr AST,
│                         the SqlDialect target enum, the structural validator.
├── zero-migrate-guard/   The pg_query(libpg_query)-backed SQL security layer:
│                         parse-time deny-list, classification, advisories.
└── zero-migrate-node/    Node/Bun N-API addon: host-driven pg/mysql2 apply over
                          the driver-neutral session seam. Its own workspace.
sdks/
├── migrate/              The `zero-migrate` npm package: the `op.*` authoring DSL —
│                         builders, types, and the pure-JS recorder (exposed to the
│                         engine via the `./internal/recorder` subpath). ZERO native
│                         code, ZERO runtime deps. Carries the inlined minimal db
│                         type-builder (`src/db-types.ts` — `TypeBuilder` + `FieldDef`,
│                         exported as `dbType`) the `db-lexicon` bridge consumes, so
│                         it has no external db dependency.
└── engine/               The `zero-migrate-engine` npm package: the Node host runtime
                          (recorder → napi apply). Loads the `zero-migrate-node` addon,
                          ships the `pg` / `mysql2` driver adapters as
                          optionalDependencies, and exposes `apply` / `plan` / `status`
                          / `history` / `validate`. Depends on `zero-migrate`.
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

The napi addon is a workspace member (kept out of `default-members`, so a bare
`cargo build`/`cargo test` skips it); the loadable `.node` is built separately:

```bash
cd crates/zero-migrate-node && napi build --platform --release
```

## Testing

```bash
# The V8-free Rust core (IR, guard, and the engine: schema / render / SQLite
# apply / journal).
cargo test -p zero-migrate-ir --lib
cargo test -p zero-migrate-guard --lib
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
pnpm build                                   # builds the zero-migrate package
(cd crates/zero-migrate-node && napi build --platform --release)
pnpm --filter zero-migrate test              # DSL + IR + drift suites
pnpm --filter zero-migrate test:host         # authoring → apply over the napi bridge
```

## Node-native authoring path

Authoring, MySQL, and Postgres execution all run in the Node process — there is no
embedded V8. The flow (`zero-migrate-engine`):

1. the pure-JS **recorder** (`zero-migrate/internal/recorder`, from the DSL package)
   evals a migration's `up()` (the `table()` / `t.*` DSL) and drains it into a
   `{ ir_version, name, ops }` op-IR envelope. It computes NO checksum and stamps
   NO `owner_app` — those are Rust-owned provenance/integrity fields;
2. the **`zero-migrate-node` napi addon** `applyIr` LOWERs the envelope in Rust
   (stamps `owner_app`, folds the authoritative `Checksum::of_ir` and the confined
   system-column shape), then drives the engine's `executor::apply` over the host
   `pg` / `mysql2` npm driver via the `hostDriver` session seam.

`plan()` / `validate()` (DB-free structural + confinement pre-check via the addon's
`loadVerify`) and `status()` / `history()` (journal reads over the host driver) round
out the `zero-migrate-engine` facade.

## The inlined db type-builder (`fromDb` bridge)

The authoring DSL's `db-lexicon` bridge (`fromDb` / `colTypeFromDbField` — the
"lift a live db schema field into a migration column" convenience) reduces a db
field into a migration `ColumnDef` on the identical `ColType` path a hand-written
migration column takes. It needs a `TypeBuilder` (`.required()` / `.optional()` /
`.unique()` / `.toFieldDef()`) and the `FieldDef` union it maps.

That minimal type-builder is **inlined** into the `zero-migrate` package
(`sdks/migrate/src/db-types.ts`) and exported as `dbType` (the `t.*` factory
lexicon), `DbTypeBuilder`, and the `FieldDef` / `TypeName` types — so a caller can
`fromDb(dbType.ref("users"))` with no external db dependency. It is a real
implementation, not a stub: it carries the exact `type` discriminants + facet
fields (`encrypted` / `refTarget` / `vectorDims` / `required` / `unique`) the
bridge maps. It is NOT a full ORM surface (query / CRUD / aggregation / generated
`env.db` typing) — only the FK/column-type bridge inputs the migrate engine needs.

## License

Apache-2.0.
