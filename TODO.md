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
- [x] Fail-closed validate rule: reject a `t.text()` column used in a MySQL
  primary key / unique / index. Shipped for the case validation can see - the
  column declared in the SAME migration as the key - and verified against live
  MySQL 8.4 through the host `apply` path: `createIndex`, a table-level `unique`,
  and a `createTable` inline index are all refused with "MySQL refuses a key over
  a TEXT or BLOB column with no prefix length" plus the `t.string({ length })`
  suggestion.
- [ ] Close the residual half: a key over a `t.text()` column an EARLIER migration
  created is still not refused, because validation is offline and reads only the
  migration in front of it. Measured live: it reaches the server and fails
  mid-deploy with MySQL `ERROR 1170`. The information needed to close it exists at
  lower time, where the apply path already carries a live catalog snapshot, so the
  gate belongs there rather than in `validate`. That is a new gate with its own
  failure modes (preview lowers with an empty snapshot and must not refuse what it
  cannot see) and wants its own decision.
- [ ] Case-collation parity: `caseSensitive` should pin an explicit collation on
  MySQL (default is case-insensitive there; `caseSensitive: true` is currently
  ignored), so string equality/uniqueness matches Postgres/SQLite.

## Highest leverage (unblock adoption beyond the niche)

- [ ] Rendered-SQL preview / dry-run. **Partly shipped — re-checked 2026-08-13.**
  `lint --explain --dialect <name>` DOES render the per-dialect SQL from the IR
  (`CREATE TABLE "public"."departments" (… CHECK (…))`, `ALTER TABLE … ADD COLUMN
  …`), so the claim that these verbs return "never the SQL that will run" is no
  longer true; the capability exists under a different verb than this item
  imagined. `docs/writing-migrations.md` used to point at a `--sql` flag that never
  existed and now points here.
  Still open, verified absent: a `--sql` render on `plan`/`preview` (`plan --sql`
  answers `unknown flag --sql`), a Node `renderSql()`, and any database-backed
  simulation. Scope this as "surface the existing renderer on more verbs", not as
  "build a renderer".
  Every serious peer shows SQL (Flyway `check`, Alembic `sqlmigrate`, Atlas
  lint/dry-run). Trust and DX gap.

- [ ] Drift detection in Node/CLI. Structural drift is currently Rust-only. Expose
  a `status --drift` / Node `drift()` that compares the live catalog to the
  expected post-apply shape at the latest applied revision (Atlas's headline
  feature). At minimum, gate `apply` when the live DB diverges.
  **Re-checked 2026-08-13, still accurate**, with one distinction worth keeping so
  the scope is not misread: `status --drift` answers `unknown flag`, and the addon
  exposes no `drift()` — only `drifted` as a status STATE. That state is CHECKSUM
  drift (an applied migration whose file changed), which apply already gates and
  aborts on. STRUCTURAL drift — `diff_snapshots` over the live catalog — is the
  unexposed half, and it has no production caller inside the engine either. So this
  is "expose an existing Rust capability", not "the engine cannot detect drift".

- [ ] Close the Node/Rust capability asymmetry. Users repeatedly hit "supported,
  but not from your host":
  - [x] SQLite apply from Node/CLI. Shipped: `apply --database-url sqlite:<path>`
    creates the table and lands the seeded row, verified by reading the resulting
    file back. `docs/getting-started.md` and `docs/cli.md` both already said so.
  - [ ] History for MySQL and SQLite (currently PostgreSQL-only). Re-checked, still
    true: both refuse with "history supports only PostgreSQL".
  - [ ] Full custom policy from Node (currently table-shape ceiling only). NOT
    re-checked.
  - [ ] Migrator-role config from the CLI (currently Node/Rust only). Re-checked,
    still true: no `--migrator-role` flag on any CLI command.

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

- [x] Rollback posture, documented explicitly. The "no public rollback" half of this
  item was stale: `zero-migrate-cli` exports a `rollback` verb, and it unwinds real
  schema - verified against live PostgreSQL, a created table went from present to
  absent. `docs/operations.md` said the opposite in two places and now describes the
  verb, its refuse-shaped defaults (`target` with no default, `approved`,
  `backupAcknowledged`, the complete-set requirement), and keeps the roll-forward
  plus backup preference ahead of it. An authored `down()` is still refused at build
  time, because the inverse is synthesised from the recorded ops.
- [x] Measure and document what a reconstructed `down` does to DATA. Measured against
  live PostgreSQL and written into the operations guide: unwinding an additive
  migration keeps surviving rows; unwinding a destructive one is REFUSED as
  irreversible with a roll-forward recommendation; and `force` +
  `backupAcknowledged` skips the irreversible migration and reports it in
  `skippedIrreversible` rather than fabricating a reverse. The guess this item was
  filed with - that a rollback would hand back an empty column or table as if it
  were a restore - was wrong, and the engine is safer than the guess.

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
