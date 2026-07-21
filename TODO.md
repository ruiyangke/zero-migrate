# zero-migrate TODO

Actionable items from the competitive survey (2026), ordered by leverage. Each
item names the gap, why it matters against the current landscape, and rough scope.
Working notes; not staged.

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

- [ ] Rollback posture, documented explicitly. No public rollback; `down()` is
  parsed but never run. State the roll-forward plus backup stance plainly in the
  operations docs, and consider a reviewed reversal helper for the abort path.

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
