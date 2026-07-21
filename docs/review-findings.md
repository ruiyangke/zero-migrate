# Deep-review findings — remaining work

Tracks the outstanding items from the 2026 deep review (the multi-agent,
adversarially-verified audit). Ordered by severity, then by whether the fix is
correctness-critical. Each item names the gap, the evidence, and rough scope.
Update the status as items land.

## Done

- [x] **`t.text()` silently became `VARCHAR(191)` on MySQL** (was the #1 finding).
  A >191-char value that stored on PG/SQLite was rejected on MySQL. Fixed:
  `t.text()` renders unbounded `TEXT`; bounded `t.string({ length })` added for
  keyed columns; injected system columns bounded. Verified against live MySQL 8.4.
  Commits `864e3b7`, `ee50e05`, `23cc698`; examples/docs audited in `218b466`.

- [x] **Default and explicit case-sensitivity diverged on MySQL** (was High #1).
  MySQL's server-default collation made string comparison case-INSENSITIVE while
  PG/SQLite are case-SENSITIVE (`WHERE email = 'Foo'` matched `'foo'` on MySQL
  only). Fixed: every MySQL character column now pins an explicit collation —
  `utf8mb4_0900_as_cs` (case-sensitive default, matching PG/SQLite) or
  `utf8mb4_0900_ai_ci` (`caseSensitive: false`). Typed-ids keep `ascii_bin`;
  references match by type so FKs stay collation-compatible. Verified on live
  MySQL 8.4. Commit `68e0b20`; collation corrected from `utf8mb4_bin` to
  `utf8mb4_0900_as_cs` (NO PAD — trailing spaces stay significant, so a UNIQUE
  key treats `'bar'`/`'bar '` as distinct exactly like PG/SQLite; `utf8mb4_bin`
  is PAD SPACE and diverged) in a follow-up, re-verified on live MySQL 8.4.10.

## High severity (correctness / portability)

- [ ] **1. Deploy-scoped crash-recovery has two dead fault points and no test,
  while doc comments claim a test exists.** `DEPLOY_BEFORE_INPROCESS_ABORT` and
  `DEPLOY_SUCCESS_COMMITTED_STAMP_FAILS` (`fault.rs:122,135`) are commented
  "tripped by the deploy-recovery crash-fuzz test only", but a full-repo grep
  finds zero uses outside `fault.rs`. This is the most intricate crash-recovery
  path (committed-contract revert vs half-rename auto-abort) and is entirely
  unexercised. Data-integrity path — add the crash-fuzz test that arms them.

- [ ] **3. The MySQL engine is never tested against a live MySQL from Rust.**
  Every MySQL backend test asserts on a `RecordingSession` SQL-log mock; there is
  no `skip_if_no_mysql!` macro and no `mysql://` DSN in `crates/*/tests`. Crash
  recovery, online rename, and expand/contract have mock-only coverage, and
  MySQL 8's implicit-commit-on-DDL is exactly the class of bug a SQL-log mock
  cannot catch. **Partially unblocked:** `docker-compose.test.yml` now provides a
  live MySQL 8.4 and the TS host tests read `ZERO_MIGRATE_MYSQL_URL`; the gap is a
  Rust-side `skip_if_no_mysql!` harness mirroring `skip_if_no_pg!`.

## Medium severity

- [x] **4. `CreateView` source tables bypassed the ownership gate.** `op_target_table`
  returns `None` for `CreateView`, and a non-materialized view needs no capability,
  so its `FROM`/`JOIN` tables never reached `enforce_ir_ownership`. A confined creator
  could author a view SELECTing another app's tables in the same permitted schema — a
  read-only cross-tenant disclosure. Fixed: `collect_target_tables` now contributes a
  structured view's FROM table and every JOIN table as ownership-checkable targets, so
  a source table the deploying app does not own (or is unregistered) fails closed like
  any other target. The `ViewQuery::Raw` body is opaque and remains gated by
  `VendorCapability::RawViewBody`. Tests: view over own table allowed / over another
  app's table refused / JOIN smuggling another app's table refused. Full suite green
  (no legitimate view pattern regressed).

- [ ] **5. `DeclaredOnly` non-default gate defined and documented but never
  enforced.** `forbids_nondefault_on_enforced_path` (`policy knob.rs:182`) is
  invoked only by its own unit tests; no loader/composer/sealer calls it. Latent
  today (no builtin knob is `DeclaredOnly`), but the registry is consumer-
  extensible, so a consumer registering a `DeclaredOnly` knob and trusting the
  documented "is rejected" guarantee gets silent policy degradation.

- [x] **6. Vector metric has a silent lossy `_ => Cosine` fallback.** A typo'd or
  out-of-set metric coerced to Cosine (`query.rs`, `build_create_indexes`) — the
  wrong pgvector opclass / SQLite distance function with no build or apply error.
  Fixed: `build_create_indexes` now rejects a present-but-unknown `vectorMetric`
  with `QueryError::InvalidIdent` (a missing metric still defaults to cosine).
  The closed-enum guarantee now holds on the String-carrying descriptor path too,
  matching the IR path (`model::ir::VectorMetric`, deserialize-bounded). Tests:
  known values parse, absent defaults to cosine, `"manhatten"` is rejected.

- [x] **7. SQLite numeric-literal column stored as `REAL`/`NUMERIC` (lossy) despite
  docs promising exact decimal text.** Two paths lost precision: the declarative
  emitter mapped `numeric` → `REAL`, and the schema kernel mapped a numeric
  `t.literal()` → `NUMERIC` — both coerce a wide decimal through a binary float,
  and both diverged from the model's affinity (phantom snapshot↔introspection
  drift). Fixed: both now emit `TEXT` (exact decimal text, matching the
  `ColType::Decimal` SQLite override), and `sqlite_canonical_type` maps
  `numeric`/`decimal` → `text` affinity so the model and live introspection agree.
  Verified on live SQLite (`node:sqlite`): a wide decimal round-trips EXACT as
  TEXT but LOSES precision as REAL/NUMERIC, and the numeric-literal
  `CHECK (col = 3.14)` still passes against the TEXT column (SQLite comparison
  rule 2 applies TEXT affinity to the literal). MySQL (`DECIMAL(65,30)`) and
  PG (`numeric`) were already exact and are unchanged.

- [ ] **8. `apply` is O(n²) with per-file connect + advisory-lock cycles.** The CLI
  loops per migration file (`cli.ts:862`), re-authoring the growing prior set each
  iteration (`index.ts:166`) and opening/closing a fresh session + re-taking the
  advisory lock per file (`index.ts:182`). Beyond wasted work, the lock is released
  between files, widening the concurrent-interleave window and leaving earlier
  migrations committed on a mid-set failure.

- [x] **9. `ZERO_MIGRATE_POLICY` silently collapsed multi-layer policy to one
  layer.** The env branch wrapped a single string (`[environmentPolicy]`) and took
  precedence over the whole config-file layer array, dropping narrowing layers —
  a stray single-valued env var silently *widened* effective policy versus committed
  config, with no warning. Fixed: the env var now carries an ORDERED layer list
  delimited by the OS path separator (PATH-style), so it can express a full
  multi-layer policy; blank/whitespace layers are dropped (an empty env is treated
  as absent, not as a no-charter policy); and when the env policy overrides a
  config-file policy the resolver returns a warning (surfaced on stderr) naming the
  layer counts, so the override is no longer silent. Tests cover multi-layer
  parsing, blank handling, and the override warning.

- [x] **10. MySQL/PG TLS pinning, host allowlist, and per-verb timeout were dead
  from the CLI.** `MysqlSessionOptions` advertised these controls, but `openSession`
  passed no opts (so `ssl:{ca}` was never taken and `runVerb` always got `undefined`
  timeout) and `openPgSession` had no TLS param at all. Fixed end-to-end: added a
  `NetworkSecurityOptions` field to the postgres/mysql `DriverConfig`; `openSession`
  threads it to both drivers; `openPgSession` gained parity (TLS `ssl:{ca}`,
  pre-connect host allowlist, per-verb `query_timeout`); and the CLI now resolves
  the controls from `--tls-ca`/`--host-allowlist`/`--query-timeout` flags (flag >
  env: `ZERO_MIGRATE_TLS_CA`/`ZERO_MIGRATE_HOST_ALLOWLIST`/`ZERO_MIGRATE_QUERY_TIMEOUT_MS`)
  through `driverFor`. Tests: `driverFor` attaches security; `resolveNetworkSecurity`
  flag/env precedence, allowlist parsing, timeout validation, and CA-file pinning.

## Docs / consistency (low effort, high signal)

- [x] **11. README + docs said SQLite apply is "Rust only / Not yet", but it ships
  from Node/CLI with tests.** Commit `a13fa25` added `applyIrSqlite`/`statusIrSqlite`
  and CLI routing. Fixed repo-wide: the README + `docs/README.md` capability
  matrices now show SQLite Node/CLI apply, status, ordered DML/backfill, and rename
  rebuild as available; and the coherent "SQLite apply is Rust-only / not a Node or
  CLI target / not exposed" prose across dialects, getting-started, operations,
  troubleshooting, node-api, concepts, security-model, embedding, writing-migrations,
  and architecture was corrected to "through Node, the CLI, and Rust (bundled
  in-process backend, cross-process coordination)". Genuine SQLite limitations
  (no partitions/sequences/comments, table-rebuild rename, INTEGER/TEXT cursor
  affinity, PG-only history) were preserved. Doc-example tests green.

- [x] **12. Conceptual docs taught a removed command surface.** `concepts.md`
  showed `zero-migrate preview` and the onboarding path used `resolve-pending`, but
  the redesigned CLI accepts only `new|lint|plan|apply|status|history|resolve`. A
  day-one user copying these got "unknown command". Fixed repo-wide: `preview` →
  `lint --explain`; CLI `resolve-pending` → `resolve` with `--apply`/`--abort`
  flags → `--commit`/`--rollback`. The Node API `resolvePending({ action:
  "apply" | "abort" })` is unchanged and correct (verified: `cli.ts` maps
  `--commit`→`"apply"`, `--rollback`→`"abort"`), so those references were left as-is.

- [ ] **13. Structural drift is computed but never exposed.** `drift.rs` (~2.5k
  lines) implements `diff_snapshots`/`DriftReport`, but no Node/CLI surface consumes
  it; the "drifted" state in `status` is *checksum* drift, not structural. Atlas's
  headline feature is built but stranded.

## Follow-ups from the string-type work

- [ ] **14. Fail-closed validate rule for `t.text()` in a MySQL key.** Today a
  `t.text()` column placed in a PK/unique/index renders `TEXT` and fails at apply
  with MySQL `ERROR 1170`; a validate-time rejection would be clearer. Deferred:
  the rule fires before the FK/format validation passes (breaking their diagnostics)
  and several fixtures use text-in-key as scenarios for other checks; landing it
  cleanly needs reordering the check after those passes + fixture updates.

- [x] **15. Regenerate the hr preview fixture.** `tests/fixtures/hr/migrations.json`
  held pre-audit column types (all `text`). Regenerated from the current
  hr-system `.ts` migrations through the CLI's authoritative path (`discover()`
  order contract + `buildEnvelope`, the same single-source-of-truth emitter the CLI
  uses), so the six keyed columns now carry `{"string":{"length":N}}` (254/255/32)
  matching the `.ts`. Diff is exclusively the `text`→`string` conversions; `hr_sqlite`
  green.
