# zero-migrate — security model

Migrations are privileged, arbitrary schema changes authored by **untrusted**
creators — and, increasingly, by a prompt-injectable AI agent acting on their
behalf. A migration that can drop another tenant's tables, read the server
filesystem, open a network socket, or escalate to superuser is a
platform-ending event. `zero-migrate` therefore treats every migration as
hostile input and defends in depth: no single control is load-bearing on its
own, and each layer fails **closed**.

This document is the map of those layers, grounded in the code that implements
them.

---

## The layers, top to bottom

```
  authored migration (.ts)  ← untrusted creator / AI
        │
        ▼
  ┌──────────────────────────────────────────────────────────────┐
  │ 0. Closed authoring surface (no raw expression SQL)           │  sdks/migrate
  ├──────────────────────────────────────────────────────────────┤
  │ 1. Fail-closed load gate  (ir_version → validate → ownership) │  zero-migrate-ir
  │ 2. Policy validation      (SealedProfile ceiling ⊓ draft)     │  zero-migrate::model::profile
  │ 3. The guard              (pg_query deny-list / classify)     │  zero-migrate-guard
  │ 4. The plan/apply gate    (destructive ⇒ Approval::Approved)  │  zero-migrate::apply
  │ 5. The least-priv role    (migrator SET ROLE, DB rejects too) │  zero-migrate::apply::role
  │ 6. Journal immutability    (append-only, migrator cannot forge)│  zero-migrate::apply
  └──────────────────────────────────────────────────────────────┘
        │
        ▼
  the database
```

Layers 1–3 run **out of band** at deploy time — plain synchronous logic, no
tokio/compio, exhaustively unit-testable without a database. Layers 4–6 run on
the apply path, so a control that slips past parse is still refused by the
database itself.

---

## 0. The closed authoring surface

The first defense is that a migration **cannot express** a raw SQL expression at
all. Every transform and predicate is a node of the closed `Expr` AST built in
JS and serialized as data — never parsed from text (see
[`op-dsl.md`](./op-dsl.md), property A). The structural validator downstream can
therefore be a pure allow-list walk, and the content checksum can be canonical.

The one deliberate whole-**statement** escape, `raw({ sql, reason })`, is
capability-gated (below) and unreachable from a confined creator migration by
construction. There is no raw *expression* escape on any dialect.

---

## 1. The fail-closed load gate

Before any lowering or apply, an authored IR document passes an ordered gate.
The policy-free half lives in `zero-migrate-ir` (`load.rs` / `validate.rs`); the
engine's `model::load::load_ir_document` threads the policy-aware pieces. The
order is deliberate and each step fails closed:

1. **Deserialize.** The closed AST and the constrained numeric domain reject a
   malformed document or a lossy scalar here — an unknown `Expr` node tag or an
   out-of-range numeric is refused at `serde` boundary, not later.
2. **`ir_version` fail-closed** (`MigrationIr::check_ir_version`) — a document
   declaring a **future** `ir_version` this engine cannot interpret is rejected
   **before** any checksum or lower. Never optimistically apply an envelope shape
   the engine does not fully understand.
3. **Structural validation** (`validate_ir_scoped`) — the authoritative allow-list
   walk over every op and every `Expr` slot, threaded with the active
   `SchemaScope`: a **Confined** cross-schema op is refused here, fail-closed,
   before lower (`CROSS_SCHEMA`). Portability violations (`EXPR_NOT_PORTABLE`,
   `DIALECT_UNSUPPORTED`) are caught here too, against the resolved target
   dialect.
4. **Ownership** (`enforce_ir_ownership`) — the check is **not** against the
   artifact's *claimed* owner (a spoofable field). It is against the deploying
   app id plus a `{ live table → owning app }` project registry. An op that
   touches a table owned by a **different** app is refused, and an **unknown**
   owner fails closed — so a partial-union deploy cannot mass-drop another
   tenant's tables.
5. **Advisory checksum-hint compare** — if the artifact carries a checksum hint,
   it is recomputed and compared, then **dropped** (the hint never folds into the
   authoritative checksum). If the hint domain is not fully computable, the load
   fails rather than comparing against a partial domain.

Only after all five pass does the engine **server-stamp** `owner_app` (a spoofed
or absent artifact value is discarded) and fold the authoritative `Checksum`. The
identity of the migration is engine-owned provenance, never author-supplied.

---

## 2. Policy validation — the operator ceiling ⊓ author draft

What a migration is *allowed* to do is governed by a `PolicyProfile`
(`crates/zero-migrate/src/model/profile.rs`). A profile carries capability flags
(`schema`, `role`, `grant`, `rls`, `partition`, `policy`, `function`, `raw_sql`,
`raw_view_body`, `materialized_view`, …), operational limits, data-security
config, and the injected-system-column shape. Three named postures exist:
`PolicyProfile::confined()` (the creator path — the default), `platform()`, and
the `Trusted` posture.

The load-bearing composition is **`meet_ceiling_draft`**: an operator ceiling and
an author-submitted draft are combined by set intersection / boolean-AND /
ordered minimum, and a draft that tries to **exceed** the ceiling is **rejected**
(never silently clamped up). Obligation knobs meet by unioning *upward*, so a
ceiling requirement cannot be removed by the draft. This is monotonic
tightening: the effective policy is always `ceiling ⊓ draft`, so a creator draft
can only narrow, never widen, what the operator permitted.

The result is a **`SealedProfile`** — a sealed, MAC-authenticated value produced
only through `SealedProfile::mint` (the public `seal_effective_profile` seam,
which validates the MAC key). A privileged profile presented **without** a valid
token fails closed to Confined. Because the privileged constructors and the seal
are token-gated, an external embedder cannot flip the engine into a privileged
posture by constructing a struct.

The per-op vendor gate follows from this: a Postgres-vendor op (a `raw` DDL, a
`CREATE FUNCTION`, an RLS policy, a raw view body) is checked against the
profile's `VendorCapabilities`; a confined migration that reaches for one is
refused `VENDOR_OP_DENIED`.

---

## 3. The guard — `zero-migrate-guard` (line 1)

The `zero-migrate-guard` crate is the security heart, extracted so it owns the
**only C dependency** on the non-SQLite path: `pg_query`/libpg_query — the *real
Postgres parser*, chosen precisely so the deny-list sees exactly what Postgres
would execute and cannot be evaded by exotic syntax a pure-Rust parser would
misparse. It is line 1; it does not depend on the engine.

Every statement is parsed and checked against a hard **deny-list**
(`guard/denylist.rs`), including dangerous constructs nested inside `DO $$…$$`
blocks and function bodies (the body walk). **Unparseable input is denied.** The
deny-list refuses, with stable rule ids surfaced on `GuardError::Denied`:

- **RCE / library loading** — `COPY … PROGRAM` (`copy_program_rce`), `COPY …
  FROM/TO 'file'` (`copy_file_access`), `LOAD` (`load_library`), untrusted PL
  languages (`untrusted_language`), `SECURITY DEFINER` functions.
- **Privilege escalation** — `ALTER SYSTEM`, role/privilege management
  (`CREATE/ALTER/DROP ROLE`, `GRANT`/`REVOKE`), granting a privileged role,
  changing object ownership to a privileged role, `SET ROLE` /
  `session_authorization` / `search_path` (`forbidden_set_param`), the superuser
  role (denied in **all** profiles including Platform).
- **File / network reach** — file-access functions, network functions, foreign
  data wrapper management, `set_config`, name-resolver / object-address
  functions.
- **Cross-tenant** — cross-schema references outside the confined scope, access
  to platform schemas (`control`, `auth`, `billing`), system-catalog access.

Alongside the deny-list, `analyze` / `classify` (`analysis/`) **classify** each
statement: its `DdlKind`, its `DataSecurityClass` (whether it is destructive —
`DROP` / `TRUNCATE` / a lossy type change), the schemas it references, the
relations it touches, and the ownership it needs. The guard **denies** the
RCE / escalation / cross-tenant / file / network classes outright; it only
**flags** data loss — the decision on a destructive op belongs to the apply gate
(layer 4), because a `DROP` is sometimes exactly what the operator intends.

Under the `Trusted` posture the deny-list, cross-schema, and body walks are
skipped by design (the public dbmate-like CLI stance); `Trusted` is
`#[non_exhaustive]` and constructed only through a token-gated in-crate seam, so
a creator can never reach it.

---

## 4. The plan/apply gate

`engine.plan(...)` runs the guard over every migration's `up` and produces a
read-only preview: a denial lands in the plan's denied set, a destructive op sets
`requires_approval`. `engine.apply(...)` then enforces the gate before touching
the database:

- A **denied** plan is refused outright.
- A **destructive** plan (a `DROP`/`TRUNCATE`/lossy-type-change `up`, or any
  rollback — a `down` is inherently destructive) requires `Approval::Approved`.
  Absent approval, only a non-destructive batch runs.

Layered on top is `ApprovalScope` (`crates/zero-migrate/src/approval.rs`): a
fail-closed answer to "*which* destructive ops did the operator individually
review?" A destructive op runs iff `Approval::Approved` **and** the scope admits
its version id. An empty scope authorizes nothing destructive even under
`Approved`; there is no "unrecognized scope ⇒ allow" arm. Approving one
destructive change never silently green-lights an unreviewed one.

The gate is not the last word: the executor **independently re-runs** the guard
and re-applies the migrator role, so the same checks hold even if a caller
constructs a plan by hand.

---

## 5. The least-privilege migrator role (line 2)

Even if a dangerous statement somehow slipped past parse, the **database itself**
rejects it. `apply::role` provisions a deterministic per-project `migrator_
<project>_<hash>` role and applies each migration under `SET ROLE` for it (with
`RESET ROLE` on exit). The role is `NOLOGIN` + `NOSUPERUSER`, so privilege checks
run as an unprivileged principal — a `SET ROLE` to a `NOSUPERUSER` role means the
DB enforces least privilege even when the connecting principal is an admin.

The grant set is exactly what a migration needs and nothing more: `CREATE ROLE`,
`ALTER SYSTEM`, and `CREATE DATABASE` are denied by attribute; the migrator gets
`USAGE` (resolution only, never `CREATE`) on the extension schema(s) so it can
reference shared extension types but cannot stage objects there. Deny-by-absence:
the role has only what it is explicitly granted.

On **SQLite** the peer of the migrator role is the `prepare`-time **authorizer**
(plus statically-registered `vec0`/FTS5 with `load_extension` locked down): the
in-process connection rejects the same disallowed operations at prepare time.

---

## 6. Journal immutability

The append-only journal (the per-project `schema_migrations` table, in a
dedicated meta schema derived as `<project_schema>_migrations`) records what has
been applied and its checksum, and drives drift/tamper detection. Its integrity
matters because a migration's `up` runs **as the migrator role** — so if the
migrator could write the journal, it could forge history.

It cannot. The journal schema is **off the migrator's path**: the migrator gets
neither `USAGE` on the meta schema nor `INSERT`/`UPDATE`/`DELETE` on the journal
table. The engine writes journal rows as the **admin role**, outside the `SET
ROLE` window. So a migration cannot insert a completed row for work it did not
do, nor delete/rewrite an existing row to hide a change. Drift and tamper
detection then compare the live schema and the recorded checksums against the
migration set on every apply.

---

## Configurable-but-safe: sentinels and the reserved namespace

Two brand strings are engine-configurable knobs rather than hard-coded — but
neither is a security downgrade:

- **Encryption / mask sentinel prefixes** — a `SentinelPrefix`
  (`schema::mask_codec`) defaulting to `zero-migrate:enc:` / `zero-migrate:mask:`.
  A host that must interoperate with a legacy writer in the same schema injects
  that writer's prefix (for example the legacy `zsenc:`), so the persisted
  encrypted/masked-column format stays one agreed contract per schema. The
  standalone default carries this project's own brand so no stranger's `pg_dump`
  carries a foreign one.
- **Reserved SQL prefix `__zero_migrate`** — reserved for the engine's own
  internal objects (e.g. the SQLite rebuild temp table `users__zero_migrate_
  rebuild`). Reserving the namespace prevents an authored object name from
  colliding with an engine-synthesized one.

---

## What is deliberately *not* defended here

The guard runs at deploy time, not on the request hot path — it is an offline,
synchronous gate, not a runtime WAF. Runtime tenant isolation of *queries* (as
opposed to *migrations*) is the host's concern, outside this engine. And the
engine trusts its own `SqlSession` driver to faithfully execute the SQL it is
handed; a driver author's obligations (session pinning, transaction visibility,
faithful `exec_text` coercion) are covered by the conformance kit in
[`driver-authors.md`](./driver-authors.md).

---

## See also

- [`op-dsl.md`](./op-dsl.md) — the closed authoring surface (layer 0).
- [`architecture.md`](./architecture.md) — the crate structure and the two lines
  of defense in context.
- [`embedding.md`](./embedding.md) — how a host selects a profile and threads
  per-apply identity.
- [`driver-authors.md`](./driver-authors.md) — the `SqlSession` seam the engine
  trusts.
