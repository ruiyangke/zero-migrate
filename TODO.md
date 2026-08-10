# zero-migrate TODO

Actionable items from the competitive survey (2026), ordered by leverage. Each
item names the gap, why it matters against the current landscape, and rough scope.
Working notes; not staged.

## String types (in progress)

- [x] Bounded `t.string({ length })` -> `VARCHAR(N)` (Postgres/MySQL) / `TEXT`
  (SQLite), default length 255. Wires the previously-inert `ColType::String`
  variant to its documented intent; distinct from unbounded `t.text()`. Shipped
  in the engine, the TS SDK, and the docs.
- [x] Unbounded `t.text()` -> `TEXT` on MySQL (was `VARCHAR(191)`, silently
  capping values >191 chars). Shipped and verified against live MySQL 8.4 (a
  300-char value that `VARCHAR(191)`+STRICT rejected now stores in `TEXT`).
  Drift-safe via a MySQL-only `ddl_type_override` (base data_type stays `text`).
  Policy-injected system columns (`id`, `created_by`, `updated_by`) are now
  bounded `VARCHAR(255)` so they stay index-able MySQL keys.
- [ ] Fail-closed validate rule: reject a `t.text()` column used in a MySQL
  primary key / unique / index (today it renders `TEXT` and fails at apply with
  MySQL `ERROR 1170`). Deferred only because many existing test fixtures use
  text-in-key as scenarios for other checks and need updating alongside the rule.
- [ ] Case-collation parity: `caseSensitive` should pin an explicit collation on
  MySQL (default is case-insensitive there; `caseSensitive: true` is currently
  ignored), so string equality/uniqueness matches Postgres/SQLite.

## Highest leverage (unblock adoption beyond the niche)

- [ ] Rendered-SQL preview / dry-run. Today `plan`/`preview` return structured
  ops, never the SQL that will run, and there is no database-backed simulation.
  Every serious peer shows SQL (Flyway `check`, Alembic `sqlmigrate`, Atlas
  lint/dry-run). Add a `--sql` render to CLI `preview`/`plan` and a Node
  `renderSql()` that emits per-dialect statements from the IR. Trust and DX gap.

- [ ] Drift detection in Node/CLI. Structural drift is currently Rust-only. Expose
  a `status --drift` / Node `drift()` that compares the live catalog to the
  expected post-apply shape at the latest applied revision (Atlas's headline
  feature). At minimum, gate `apply` when the live DB diverges.

- [ ] Close the Node/Rust capability asymmetry. Users repeatedly hit "supported,
  but not from your host":
  - [ ] SQLite apply from Node/CLI (currently Rust-only).
  - [ ] History for MySQL and SQLite (currently PostgreSQL-only).
  - [ ] Full custom policy from Node (currently table-shape ceiling only).
  - [ ] Migrator-role config from the CLI (currently Node/Rust only).

## Strategic direction

- [ ] Declarative / desired-state mode, or an explicit non-goal. The market has
  converged on declarative plus versioned (Atlas, Drizzle, Prisma, Skeema).
  zero-migrate is imperative-only. Decide and document: either build a
  schema-diff/`generate` path from a desired-state definition, or state clearly
  why imperative-only is the deliberate bet. Do not leave this implicit.

- [ ] Broaden MySQL parity. "Write once" degrades fast on MySQL 8: no column
  rename, no composite/non-id FK, no standalone check, no partial/expression
  index, no partitioning. Prioritize column rename (expand-contract already exists
  in `render/expand_contract.rs`) and expression/partial indexes.

## Depth and safety polish

- [ ] General online table rebuild (beyond column rename). The online workflow is
  column-level, PostgreSQL-only, single-column-`id`-PK-only. Evaluate a shadow-copy
  path (gh-ost/Spirit/pt-osc style) for large ALTERs, the real zero-downtime
  workhorse, especially for MySQL.

- [ ] Backfill tail handling. The fixed terminal cursor does not chase rows
  inserted after capture (correct but surprising). Add loud docs and a
  post-backfill check that reports/counts rows beyond the captured boundary.

- [ ] Rollback posture, documented explicitly. No public rollback; an authored
  `down()` is now refused at build time rather than parsed and dropped. State the
  roll-forward plus backup stance plainly in the operations docs, and consider a
  reviewed reversal helper for the abort path.

## Ecosystem and maturity (npm track, in progress)

- [ ] Publish JS packages to npm (currently source-checkout only). Restructure,
  native multi-package distribution, and CLI work are done and verified; READMEs,
  licenses, the release workflow, and pack verification remain.
- [ ] CI/CD integrations (GitHub Action / GitLab component) for plan plus gate.
- [ ] MariaDB support decision (currently MySQL 8 only; documented non-goal?).
- [ ] Guidance and tooling for the unsandboxed-JS trust boundary in platform hosts.

## Notes

- Source: competitive survey vs Atlas v1.2, Flyway 12.11, Liquibase 5.0.3,
  Drizzle Kit v1.0, Prisma, Alembic, Bytebase, Sqitch, Skeema/gh-ost/Spirit.
- Strengths to protect while filling gaps: structured-IR authoring, embedded
  governance (ownership/policy/guard), and native expand-contract plus resumable
  backfills, the two problems the rest of the field punts to hand-rolled scripts.
