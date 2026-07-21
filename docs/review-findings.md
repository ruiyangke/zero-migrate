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

- [ ] **4. `CreateView` source tables bypass the ownership gate.** `op_target_table`
  returns `None` for `CreateView` (`ir/load.rs:232`), and a non-materialized view
  needs no capability, so its `FROM`/`JOIN` tables never reach
  `enforce_ir_ownership`. A confined creator can author a view SELECTing another
  app's tables in the same permitted schema — a read-only cross-tenant disclosure
  path the ownership model otherwise closes. Impact depends on runtime SQL grants.

- [ ] **5. `DeclaredOnly` non-default gate defined and documented but never
  enforced.** `forbids_nondefault_on_enforced_path` (`policy knob.rs:182`) is
  invoked only by its own unit tests; no loader/composer/sealer calls it. Latent
  today (no builtin knob is `DeclaredOnly`), but the registry is consumer-
  extensible, so a consumer registering a `DeclaredOnly` knob and trusting the
  documented "is rejected" guarantee gets silent policy degradation.

- [ ] **6. Vector metric has a silent lossy `_ => Cosine` fallback.** A typo'd or
  out-of-set metric coerces to Cosine (`query.rs:1852`, mirrored in the live
  `vector_opclass`) — the wrong pgvector opclass / SQLite distance function with
  no build or apply error. The closed-enum guarantee is lost on the String-carrying
  descriptor path. Reject the unknown metric at validate instead.

- [ ] **7. SQLite numeric-literal column stores as `REAL` (lossy) despite docs
  promising exact decimal text.** `docs/dialects.md` promises exact-decimal-text
  storage, but the `numeric`-typed *literal* column path maps to SQLite `REAL`
  (`declarative.rs:1261`), coercing through a binary float. The typed `t.numeric()`
  path is correct (an override rescues it); the trap is the numeric-literal column,
  a narrow authoring surface that also produces phantom snapshot↔introspection drift.

- [ ] **8. `apply` is O(n²) with per-file connect + advisory-lock cycles.** The CLI
  loops per migration file (`cli.ts:862`), re-authoring the growing prior set each
  iteration (`index.ts:166`) and opening/closing a fresh session + re-taking the
  advisory lock per file (`index.ts:182`). Beyond wasted work, the lock is released
  between files, widening the concurrent-interleave window and leaving earlier
  migrations committed on a mid-set failure.

- [ ] **9. `ZERO_MIGRATE_POLICY` silently collapses multi-layer policy to one
  layer.** The env branch wraps a single string and takes precedence over the whole
  config-file layer array (`config.ts:261`), dropping narrowing layers. Since later
  layers may only narrow, a stray single-valued env var silently *widens* effective
  policy versus committed config, with no warning.

- [ ] **10. MySQL/PG TLS pinning, host allowlist, and per-verb timeout are dead
  from the CLI.** `MysqlSessionOptions` (`driver-mysql2.ts:24`) advertises these as
  first-class controls, but `openSession` (`index.ts:82`) passes no opts, so the
  `ssl:{ca}` branch is never taken and `runVerb` always gets `undefined` timeout;
  `openPgSession` has no TLS param at all. Transport TLS is still reachable via the
  connection URL, but CA-pinning and per-verb timeout have no equivalent.

## Docs / consistency (low effort, high signal)

- [ ] **11. README + docs say SQLite apply is "Rust only / Not yet", but it ships
  from Node/CLI with tests.** Commit `a13fa25` added `applyIrSqlite`/`statusIrSqlite`
  and CLI routing; `README.md:86` and `docs/README.md:78` still tell users to build
  an unneeded Rust host. Most user-misleading divergence in the headline matrix.

- [ ] **12. Conceptual docs teach a removed command surface.** `concepts.md:44`
  shows `zero-migrate preview` and the onboarding path uses `resolve-pending`, but
  the redesigned CLI accepts only `new|lint|plan|apply|status|history|resolve`. A
  day-one user copying these gets "unknown command".

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

- [ ] **15. Regenerate the hr preview fixture.** `tests/fixtures/hr/migrations.json`
  still holds pre-audit column types. SQLite-only (where string and text both render
  `TEXT`), so `hr_sqlite` is unaffected, but it drifts from the edited `.ts`.
