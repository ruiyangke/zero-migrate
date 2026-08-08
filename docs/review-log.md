# Review log

A running record of the gradual review pass: what was found, what was decided,
and what needs Ruiyang's call. Newest section last.

Working notes; not staged. This file is for review, not for the changelog.

## Open questions for Ruiyang

### Q1 - The `II.x.y` spec references in `zero-migrate-policy` point at a document that is not in this repo

The policy crate carries roughly 150 comment references to numbered spec sections:
`II.3.2` (25 times), `II.7` (22), `II.2.7` (18), `II.6`, `II.2.1`, `II.4.4`,
`II.2.5`, and more, spread across `registry.rs`, `rule.rs`, `document.rs`,
`value_order.rs`, `compose.rs`, and the test suites. `zero-migrate-guard` uses the
same numbering.

Nothing under `docs/` defines that numbering, and I found no other file in the tree
that does. As it stands a reader cannot resolve any of them, which makes an
otherwise excellent set of comments unverifiable.

Three ways out, and I did not want to churn 150 comments on a guess:

1. The document exists outside the repo - add it under `docs/` and the references
   become genuinely useful.
2. The document is gone - rewrite the load-bearing references so each comment
   stands on its own, and drop the tags.
3. The numbering is meant as a stable internal vocabulary - say so once in the
   crate-level docs so a reader knows the tags are labels, not pointers.

My preference is (1) if the document still exists, otherwise (2). Tell me which and
I will do it. Until then I am leaving the tags alone.

### Q2 - MySQL gets the no-op guard at line 1 and has no authorizer at line 2

`guard_for` dispatches the per-engine first-line guard:

```rust
SqlDialect::Postgres => Box::new(PgGuard::from_config(cfg.clone())),
SqlDialect::Sqlite   => Box::new(SqliteDescriptorGuard::new()),
SqlDialect::Mysql    => Box::new(SqliteDescriptorGuard::new()),
```

`SqliteDescriptorGuard::check` returns `Ok(GuardOutcome::default())` unconditionally
- no string check, no denial.

For SQLite that is justified and documented: the descriptor emitter vets at the
author boundary (line 1) and `apply/backend/sqlite/authorizer.rs` vets per statement
at apply (line 2). MySQL has no authorizer - compare the two backend directories and
the file simply does not exist.

Two things make me read the MySQL arm as a catch-all rather than a decision. Neither
the `guard_for` doc comment nor the call-site comment in `apply/executor.rs:913-926`
mentions MySQL at all; both enumerate Postgres and SQLite and stop. And the crate
elsewhere goes out of its way to refuse MySQL raw SQL fail-closed:
`SqlGuard::check` returns `GuardError::MysqlRawSqlRejected`. So the direct path
refuses what the seam waves through.

I did not change this, because the fix depends on something only you can answer: can
a MySQL migration carry raw, author-supplied `up` SQL, or is every MySQL migration
IR-generated? If it is always IR-generated the current behaviour is merely
undocumented. If raw SQL can reach it, MySQL is running with neither line of
defense, and the arm should either fail closed like `SqlGuard::check` or gain a real
guard.

Making it fail closed is a one-line change but would break MySQL apply outright if
IR-generated SQL routes through the seam, which is exactly the kind of guess I did
not want to make on your behalf.

### Q3 - A quoted mixed-case schema is admitted as if it were the owned one

Under a scope owning `app1`, all of these are admitted:

```
SELECT * FROM "APP1".secrets    -> ALLOW
SELECT * FROM "App1".t          -> ALLOW
CREATE TABLE "APP1".t (x int)   -> ALLOW
```

In PostgreSQL `"APP1"` and `app1` are different schemas, so on the face of it this
reads as a confinement bypass. It is not that simple, which is why I stopped.

`SchemaScope` documents the case-insensitive match as deliberate: a case-variant
qualifier is admitted and then canonicalized to `project_schema` at render
(`IrAuthor::effective_schema`), "so gate and render never diverge". For an UNQUOTED
`APP1` that is not just safe but required, because PostgreSQL folds it to `app1`
before anyone sees it.

The gap is that the rationale does not separate the two cases, and the code cannot
either, because it folds a second time. By the time the guard sees a parse tree,
PostgreSQL has ALREADY folded unquoted names and preserved quoted ones - so the two
are perfectly distinguishable at that point:

- unquoted `APP1` arrives as `app1`  -> matches the owned schema, correctly admitted
- quoted `"APP1"` arrives as `APP1`  -> a genuinely different schema

`grants_cross_schema` runs the already-folded parse-tree name through
`normalize_pg_identifier` again, and that second fold is what erases the
distinction. A byte-exact comparison there would admit the unquoted form and refuse
the quoted one, which is exactly the desired split.

I did not make that change because the safety argument in the docs rests on the
render canonicalization, and I would want to confirm it covers every path that
reaches the guard - raw SQL is not re-rendered, so a raw body naming `"APP1".secrets`
would execute verbatim against a schema the policy never granted. That is a real
question about the raw-SQL paths rather than something to flip on my own.

### Q4 - The rollback API is exported but has no implementation

`lib.rs` exports `RollbackTarget`, `RollbackRequest`, `RollbackOptions`,
`RollbackOutcome`, `RollbackError`, and `RollbackEngineError`. `RollbackRequest` even
has a constructor. Nothing in the crate consumes one, and `MigrationEngine::rollback`
does not exist - the doc build says so, and `grep -n "fn rollback" engine.rs` returns
nothing.

The only reachable rollback is `MigrationBackend::rollback_one_transactional`, the
per-migration leaf that appends one `rolled_back` event. It performs none of the
selection-time gating the exported error variants name: `Irreversible`,
`NonTransactionalDown`, `KeptDependsOnRolledBack`, `ForceSkipDependencyConflict`,
`Guard`.

The concrete risk is a host that reads the public surface, builds a
`RollbackRequest`, finds nothing to hand it to, and drives the leaf per migration
instead. It then unwinds in whatever order it supplied, with no refusal for an
irreversible migration, no guard over the `down` SQL, and no reverse-topological
ordering - so a dependency can be torn down beneath a migration that stays applied.

`docs/architecture.md` is already honest ("There is no public high-level rollback
command; prefer a forward fix"). The code contradicts it by exporting the surface.

Your call, because both directions are public-API changes I should not make
unilaterally: remove the unused types (a breaking change, `refactor(migrate)!`), or
implement the orchestrator over the existing leaf. I have made the doc comments state
the situation plainly in the meantime, so nobody builds against a promise the crate
does not keep.

### Q5 - `deploy_envelopes` opens rename obligations it gives the caller no way to discharge

Traced the whole chain: `deploy_envelopes` -> `deploy_envelopes_locked` ->
`apply_applied_plan_with_touched_and_depends` -> `apply_plan_with_touched_and_depends`
-> `apply_plan_with_touched_and_depends_scoped(..., None)`. The `None` is deliberate
and the comment says so - that wrapper is "the routine (non-deploy-handler) wrapper".
The `_scoped` variant that takes a real `DeployRecoveryScope` has no in-crate caller
at all.

Meanwhile `journal.rs` documents a same-deploy recovery protocol in detail: each
EXPAND writes an `in_progress` marker atomically with its obligation, a later
same-deploy failure drives the shared abort over exactly that deploy's obligations,
and "on a process CRASH the NEXT same-app deploy reconciles it FIRST". None of that
runs for `deploy_envelopes`, because no marker is ever written.

The design intent is legible: an external control layer is meant to drive the scoped
variant, and `deploy_envelopes` is the crate's own convenience entry. Two things make
that uncomfortable anyway:

1. It is public API named `deploy`. A host reasonably assumes it deploys.
2. `AggregateOutcome` carries only `applied`, `skipped`, `recovered` - not
   `pending_contract`, not `opened_obligations`. So when envelope A opens a rename
   obligation and envelope B then fails, the caller is not told which obligation was
   opened. The table stays blocked by the apply-time interlock, and discharging it
   means digging `pending_version` out of the meta schema by hand.

Fail-closed, not corrupting - but a wedged table with no programmatic way out.

Your call, since both directions are public-API changes: thread a real
`DeployRecoveryScope` through `deploy_envelopes` and drive the abort on failure, or
keep the external-handler design and at minimum surface `opened_obligations` on
`AggregateOutcome` so a caller can act. Adding that field is itself breaking for
struct-literal construction, which is why I did not just do it.

The third option is to correct `journal.rs`, which currently reads as though the
recovery leg exists in this crate.

## Decisions made

### D1 - Fix the broken workspace build by leaving the width facets unset in the descriptor bridge

`crates/zero-migrate-node/src/bridge.rs` did not compile: `field_dto_to_engine`
built a `FieldDescriptor` without the `max_length` and `unbounded_text` fields
that the string-type redesign added (`23cc698`, `68e0b20`). `cargo build
--workspace` failed on `zero-migrate-node`, so `main` has been red since at least
2026-07-18.

The choice was between plumbing `maxLength` through the N-API DTO or setting both
fields to their inert values. I traced the path: `field_dto_to_engine` is reached
only from `gen_artifacts_from_descriptors`, which renders TypeScript types and
runtime JSON. `render/gen_types.rs` reads none of `max_length`, `char_len`, or
`unbounded_text` - they exist for DDL only. The adjacent `char_len` is already
hardcoded to `None` for the same reason.

So both fields stay unset, with a comment recording why. This is not lossy: the
descriptor path cannot emit DDL, so there is nothing for a width facet to change.

Worth your call later: the declarative descriptor path has no way to express
`t.string({ length })` at all. That is a real capability gap versus the IR path,
but it is a feature decision, not a build fix, so it is not folded in here.

### D2 - Leave the untracked `sdks/` directory alone

`sdks/migrate` is an untracked local stub whose own `package.json` describes it as
"Local dev stub to satisfy the vite-plugin file: link in this environment". Nothing
in this repository references it. It is not mine to delete and it does not belong
in the tree, so it stays untracked and uncommitted.

### D3 - Commit the loopback bind for the test database ports

`docker-compose.test.yml` had an uncommitted change narrowing the Postgres and
MySQL port publications from `5434:5432` / `3306:3306` to `127.0.0.1:5434:5432` /
`127.0.0.1:3306:3306`. Docker's published ports bypass the host firewall, so the
unqualified form exposed both test databases (postgres/postgres, root/root) to
every host on the network. The narrowed form is correct and is committed as found.

## Findings

### F1 - `main` failed all four CI gates, and had for weeks

The very first thing the review did was try to build. Nothing did. Four separate
pre-existing breaks, every one of them a CI gate:

1. **Build.** `crates/zero-migrate-node/src/bridge.rs` constructed a
   `FieldDescriptor` without the `max_length` and `unbounded_text` fields the
   string-type redesign added. `cargo build --workspace` failed outright. See D1.
2. **Clippy.** `crates/zero-migrate/src/schema/query.rs:431` used `3.14` as a test
   fixture, which trips `clippy::approx_constant` under `-D warnings`. The literal
   was never meant to be PI, so the fixture now uses `2.5`.
3. **Format.** Five files were unformatted: `zero-migrate-ir/src/load.rs`,
   `zero-migrate-policy/src/document.rs`, `render/lower.rs`, `schema/query.rs`,
   `tests/sql_preview.rs`.
4. **Live tests.** `docker-compose.test.yml` pinned `postgres:16` while CI runs
   `postgres:18` and every doc says PostgreSQL 18. The engine generates ids with
   core `uuidv7()`, a PostgreSQL 18 builtin, so `drift_id_facets_pg` died on
   "function uuidv7() does not exist". `CONTRIBUTING.md` also claimed 16.

The GitHub Actions history confirms it: the last five runs on `main` are all
`failure`, going back to 2026-07-18. Whatever landed after that was never
compiled by CI.

Worth deciding: CI is red and nobody is being told. A branch protection rule, or
even just a failing-run notification, would have caught the bridge break the day
it landed rather than three weeks later.

### F2 - `pg_declarative` could never have passed since `ab96f0a`

Both live tests in `crates/zero-migrate/tests/pg_declarative.rs` failed, and the
reason turned out to be two layers deep.

The surface failure was `CrossSchema`: every statement refused, even though it
targeted exactly the project schema. `ab96f0a` converted the tests from builtin
policies to authored charters and gave this one `confined_charter()`, whose grants
are scoped to the literal schema `app`. But each test isolates itself behind a
per-run schema named `proj_<pid>_<nanos>_<n>`, which those grants never cover.
Injection is scoped `"all"`, so it still fired - which is why the refused statement
carried all the system columns and looked correct.

Fixing the scope revealed the real problem: `RawCreateInInjectScope`. A declarative
deploy reaches the database as rendered DDL, and `gate_raw_create` refuses any raw
create wherever an inject rule covers the target, because (as the guard puts it)
injection cannot rewrite raw text - only the structured DSL may create an injected
table. So no charter that both injects over the project schema and is used for a
declarative apply can ever work.

The tell was already in the file: `guard_cfg` built its config from
`no_inject(&cfg.project_schema)` while `effective_policy()` returned the
inject-carrying `confined_charter()`. The guard and the executor were running under
two different charters. They now share one.

The tests still prove what their names claim - a declarative deploy against live
PostgreSQL, a zero-drift round trip, and an add-column diff - but they no longer
exercise policy injection, which that path cannot support by design.

### F3 - The guard panicked on any non-ASCII identifier (fixed)

`crates/zero-migrate-guard/src/guard/mod.rs` tested the `pg_` catalog prefix with
`relname[..3]` behind a `relname.len() >= 3` check. That is a byte slice behind a
byte-length check, so any identifier whose third byte fell inside a multi-byte
character aborted the process:

```
SELECT * FROM "abé"
-> panicked at guard/mod.rs:1790:
   end byte index 3 is not a char boundary; it is inside 'é' (bytes 2..4)
```

`"abé"` is four bytes, and `[..3]` splits the `é`. The panic fires before any
allow/deny decision, in a component whose entire contract is to fail closed - and
the apply path runs the guard over every pending migration, so an untrusted
migration author could take down the process meant to be vetting them. Fixed at
both sites with a byte-wise prefix test, plus a regression test covering Latin-1
and CJK identifiers in four statement positions.

### F4 - A MySQL constraint could smuggle an index the author never declared (fixed)

This one I confirmed by building the exploit, because the obvious reading was
wrong. Plain column names are fine: `escape_quote_ident` doubles backticks
correctly, and my first probe emitted a perfectly safe identifier.

The hole is only on the constraint path. Constraint bodies are built once in
PostgreSQL spelling so the desired snapshot round-trips byte-for-byte against
`pg_get_constraintdef`, and MySQL then re-spells them textually through
`mysql_requote_sql`. That rewriter tracked whether it was inside a `'`-string but
not whether it was inside a `"`-identifier, and it never escaped a backtick it
emitted into one.

Rendering a `UNIQUE` constraint over a column named ``a`), KEY `k2` (`id``:

```sql
-- before
CONSTRAINT `u1` UNIQUE (`a`), KEY `k2` (`id`)
-- after
CONSTRAINT `u1` UNIQUE (`a``), KEY ``k2`` (``id`)
```

The first form is not one identifier. It closes early and contributes a `KEY k2
(id)` index that appears nowhere in the migration: authored intent became SQL
structure. A column named `it's` was a milder version of the same fault - the
apostrophe flipped the string state, so the identifier's closing `"` survived into
MySQL DDL as a stray `"`.

Fixed by tracking identifier state separately from string state: inside a quoted
identifier an apostrophe is an ordinary character, `""` is one literal quote, and a
backtick is doubled. Regression test added.

### F5 - Two node-crate fixtures used a column type that no longer deserializes (fixed)

Once `zero-migrate-node` compiled again, its own tests ran for the first time in
weeks and two failed: `"type": "string"` no longer parses, because `ColType::String`
became a struct variant carrying a length. Same root cause as the build break - the
string redesign landed without sweeping its consumers. The fixtures model what the
pure-JS recorder emits, and `t.text()` records `"text"`, which is also what the
surviving assertion expects.

### F6 - The CLI accepted a following flag as a flag's value (fixed)

`takeVal` in `packages/zero-migrate-cli/src/cli.ts` only checked for the end of
argv, so a forgotten value was silently filled in by the next token:

```
zero-migrate new add_users --dir --json
-> writes ./--json/<timestamp>_add_users.ts, exits 0
```

Reporting success for a command the user did not ask for is the worst version of
this bug. It now refuses a `--`-prefixed token and names the inline form, which
still passes a literal dash-leading value when one is meant.

### F9 - `cargo doc` emits 199 warnings and CI never runs it

Chasing a comment that named a function I could not find turned up a whole class of
rot. `cargo doc --workspace --no-deps`:

- 93 unresolved intra-doc links - pointers that go nowhere
- 59 doc-visibility warnings
- 41 redundant explicit link targets

Several of the unresolved ones name functions that do not exist at all. rustdoc puts
it plainly for the one I chased: "the struct `MigrationEngine` has no field or
associated item named `abort_same_deploy_expands`". That comment also referenced a
shared `build_abort_steps`, equally absent. Both described a same-deploy rename
rollback flow this crate does not implement - the rollback is the caller's job, and
the durable half lives on the backend seam (`mark_deploy_recovery_committed_batch`,
`outstanding_deploy_recoveries`, both real and both implemented for Postgres, but with
no in-crate driver).

`.github/workflows/ci.yml` gates fmt, clippy, build, and test. It never builds docs,
so none of this was ever surfaced. It is the same failure shape as the `II.x.y` spec
references in Q1: a reference that cannot be resolved is worse than no reference,
because it reads as authoritative.

**Done.** All 93 resolved, and CI now runs `cargo doc --workspace --no-deps` with
`RUSTDOCFLAGS=-D rustdoc::broken_intra_doc_links`, so it cannot come back.

Two things worth knowing from doing it:

`ir-envelope.schema.json` is generated from IR doc comments. schemars folds them in as
`description` fields, so a doc-only edit in `zero-migrate-ir` rewrites a tracked wire
artifact and the schema test goes red. Regenerate with `UPDATE_SCHEMA=1` and check the
diff is descriptions only.

The last three were a genuine cross-crate case. `zero-migrate-ir` cannot link into
`zero-migrate`, which depends on it, and the `cfg_attr(doc)`/`cfg_attr(not(doc))` pair
written to work around that resolved in NEITHER build - both arms named `crate::`
paths for items in the other crate. They are plain text now. `Migration` was the
exception: it lives in the IR crate after all, so that one links.

I ran the sweep through Codex and rejected two of its edits. It twice tried to
"resolve" a cross-crate link by hardcoding a URL - first docs.rs for an unpublished
crate, then a GitHub permalink pinned to a commit SHA and a line number. Both would
rot faster than the broken link they replaced. It also reworded
`RollbackError::ApprovalRequired` to read as though a driver does refuse
`Approval::None`; the variant is never constructed.

## Test infrastructure the apply fixes needed and did not have

The inflight-marker tamper fix DOES now have a regression test
(`a_mismatched_inflight_marker_aborts_instead_of_replaying`, verified RED against the
pre-fix code): it turned out testable without new infrastructure, because
`pg_scenarios` already plants markers by hand.

The MySQL repeatables fix still has none, and the gaps below are why.

The blocker is the same in both cases, and it is missing infrastructure rather than
missing effort:

**No fault point in the crash window.** `crate::fault` names six boundaries
(`DML_AFTER_STMT_BEFORE_JOURNAL`, `BACKFILL_MID_BATCHES`, two deploy points, and so
on) but none between `record_started` and the `up`, or between the `up` and
`record_completed`. Those two windows are exactly where the inflight-marker bugs
live. Adding `NONTXN_AFTER_STARTED_BEFORE_UP` and `NONTXN_AFTER_UP_BEFORE_COMPLETED`
would make both testable.

**No recording backend.** Asserting that the executor passes the right
`had_inflight` needs a `MigrationBackend` stub that records its arguments. That trait
has 33 methods, so a stub is several hundred lines of boilerplate - worth building
once as shared test support, not worth inlining for a single assertion.

Also worth noting: the single existing non-transactional recovery test
(`pg_scenarios.rs`) plants a marker whose checksum MATCHES the supplied migration, so
the mismatch case was untestable by construction. That is why the tamper hole
survived - the test that looked like it covered recovery only ever exercised the
agreeing case.

There are no live-MySQL integration tests at all; the MySQL recovery paths are
covered only by render-level tests against a recording session.

## A note on running the host tests

`pnpm --filter zero-migrate-cli test:host` has six failing tests in a fresh
checkout, all of which need the native addon (`live plan`, the four `lint` cases,
and the offline SQL renderer). They fail because `crates/zero-migrate-node/*.node`
does not exist until you run `pnpm build` there, exactly as CONTRIBUTING describes.
I verified these are pre-existing by baselining them with my changes stashed: the
same six fail either way. Not a regression, but a rough first-run experience - the
suite could skip them with a clear message when the addon is absent, the way the
Rust live tests skip on an unset DSN.

### F7 - A rename could confer authority every other spelling denies (fixed)

`RenameStmt` is one parse node for `ALTER <anything> RENAME TO`. The gate reached a
verdict only for TABLE and COLUMN and fell through to `Ok` for everything else, and
role/database/schema renames carry their target in `subname`/`newname`, scalar slots
the cross-schema walk never visits. Probed against a charter owning only `app1`:

```
ALTER ROLE postgres RENAME TO pwned         -> ALLOW
ALTER DATABASE postgres RENAME TO pwned     -> ALLOW
ALTER SCHEMA control RENAME TO app_stolen   -> ALLOW
ALTER SCHEMA app1 RENAME TO control         -> ALLOW
DROP SCHEMA control CASCADE                 -> deny
ALTER ROLE postgres SUPERUSER               -> deny
```

The asymmetry is what makes it a bug rather than a decision. Each now routes back to
the rule that owns it.

### F8 - A grant with a hole in it reported as granted everywhere (fixed)

The worst one so far, because the guard spends the answer as trust.

`grant_region` asks whether a key is granted over the whole universe. The per-layer
visible region is granted-minus-masked-above, and `All` minus a real mask has no
glob representation, so the code fell back to the un-subtracted `All` with a comment
calling the widening "safe for the top test". It is the opposite: widening to `All`
IS the top answer. Verified through the operator TOML path, not the Rust API:

```
base: sql.raw = true  over "all"
over: sql.raw = false over ["secret"]

grants(secret.t)   = Bool(false)     the hole is real
grants(app_main.t) = Bool(true)
grant_is_top       = true            fail-open
```

Both consumers are in the guard: `sql.raw` at `Top` is the fully-trusted raw posture
admitting `SET search_path` and `CREATE FUNCTION`, and `schema.cross_schema` at
`Top` makes the schema scope `Unconfined`. An operator who granted broadly and then
carved out one schema got LESS confinement than one who carved out nothing.

Fixed by tracking exact-versus-widened and answering `Top` only from an exact
region. The detail that makes this precise rather than blunt: `All.difference
(Nothing)` is representable, so a widened result always means a real hole. The
brute-force compose oracle passes unchanged.

### F10 - Two long index names silently collapse into one index (confirmed against live PG 18)

Author-supplied identifiers are never length-capped. `cap_ident_name` exists and is
collision-safe (it appends 10 hex chars of a SHA-256 over the full name), but every
call site is an ENGINE-derived name. An authored `IrIndex.name` goes straight to
`quote_ident` uncapped, and `model/validate.rs` applies a 63-byte bound to exactly one
name kind (`validate_column_reference_constraint_name`).

Rendered offline, two index names differing only after byte 63 come out verbatim:

```
CREATE INDEX IF NOT EXISTS "idx_<60 a's>_alpha" ON "public"."t" ("c");
CREATE INDEX IF NOT EXISTS "idx_<60 a's>_beta"  ON "public"."t" ("c");
```

Run against the live PostgreSQL 18 in `docker-compose.test.yml`, the server says what
happens:

```
NOTICE: identifier "idx_..._alpha" will be truncated to "idx_...aaa"
NOTICE: identifier "idx_..._beta"  will be truncated to "idx_...aaa"
NOTICE: relation "idx_...aaa" already exists, skipping
CREATE INDEX
```

Both truncate to the same 63 bytes, so the second `CREATE INDEX IF NOT EXISTS` is a
silent no-op and reports success. The snapshot records two indexes, the catalog holds
one, and every later diff re-issues the same no-op create - permanent phantom drift
that no error ever surfaces.

MySQL is unaffected: it hard-errors with `ER_TOO_LONG_IDENT`, which is the
fail-closed behaviour PostgreSQL lacks.

**Fixed** for the index name, which is the one that actually reaches DDL, as a new
`validate_authored_index_name_lengths` pass in `validate_ir_scoped`. Refusing rather
than capping: `cap_ident_name` is collision-safe but every call site is an
engine-derived name, and silently renaming a name the author chose trades a visible
failure for an invisible one. Marked breaking - a migration authoring such a name is
now refused at validate instead of half-applying. No existing fixture used one, so
nothing else moved.

Still open: table, column, and constraint names are bounded only where
`validate_column_reference_constraint_name` already applies. They are less dangerous
(a truncated table name usually collides loudly rather than silently) but the same
class, and a single shared identifier-length rule across every author-supplied name
would be tidier than the two spot checks there are now.

### F11 - An untrusted draft can re-grant authority the charter denies (CONFIRMED, unfixed)

The most serious thing this review has turned up. `admit` is the sole untrusted-draft
ingress - the one trust boundary in the policy crate - and it can be walked past.

Charter: the root grants `sql.raw` over `"all"`, and a second layer denies it at
`secret`. The charter is correct on its own:

```
charter grants(secret.t) = Some(Bool(false))
```

Now admit an untrusted draft that simply re-grants `sql.raw` over `"all"`:

```
ADMITTED -> grants(secret.t) = Some(Bool(true))
```

The draft got back exactly the authority the operator's second layer took away.

**Cause.** `boundary.rs` walks the charter's grant rules, meets each scope with the
draft's granted scope, and checks ONE witness object per region - assuming the
charter's effective value is constant across that region. It is not, once a lower
layer has carved a hole in it. And the hole is invisible to that walk, because
`compose.rs`'s `layered_nondefault_grant_rules` drops rules whose value is at or below
default. Layer 2's `false @ secret` IS such a rule, so it never becomes a region
boundary, and the single witness lands somewhere the charter still says true.

**Why the oracle missed it.** `tests/compose_oracle.rs` is a brute-force proof of
exactly this invariant - its own module doc claims "the no-escalation invariant:
effective is a subset of charter for EVERY key/object". But it generates only one
rule per key per document, so a charter with a masked hole never appears in its
universe. The proof is real; its universe is too small.

**Fixed.** The covered-region arm now partitions on EVERY charter grant rule, so a
mask gets its own region and its own witness. The uncovered-region arm deliberately
keeps the grant-bearing subset: subtracting a mask there would treat its region as
charter-covered, and would make `All` minus a mask unrepresentable, turning a precise
`GrantExceedsCharter` into a fail-closed `UncoveredRegionNotRepresentable` that says
nothing about what the draft did wrong. I tried the single-set version first and hit
exactly that, which is what pointed at the two-set split.

Marked `fix(policy)!` because a charter/draft pair that was admitted before is now
refused - that is the point, but it is a behaviour change for anyone relying on it.

The regression test is in `tests/compose_oracle.rs` and is verified RED against the
pre-fix code.

**The oracle now reaches this shape too.** My first attempt at widening it did not:
adding a layered-charter sweep changed nothing, because the pattern pool held only
three globs (`app_*`, `app_* minus app_tmp_*`, `staging`) and none of them produces a
region whose witness falls outside a mask. The missing ingredient was a UNIVERSAL
scope - `witness_of(All)` is schema `a`, which every specific mask misses. Adding
`Pat::All` to the pool is what made the escalation reachable by brute force.

Worth remembering: the oracle was not merely too small, it was too small in one
specific dimension, and a sweep that looked like it covered layering still could not
express the bug. A negative result from a widened test is information - it told me the
widening was in the wrong direction.

### F12 - Admission was order-dependent and refused valid drafts (fixed)

Adding the universal scope immediately exposed a second, independent bug in the arm
the escalation fix had not touched:

```
base:  sql.raw = true over "all"
over:  sql.raw = true over ["app_*"]
draft: sql.raw = true over "all"      -> UncoveredRegionNotRepresentable
```

Nothing is escalated - the charter grants `sql.raw` everywhere and the draft asks for
exactly that. The uncovered-region arm subtracts each charter rule in layer order and
aborted on the first unrepresentable step. `All` minus `app_*` has no glob form; `All`
minus `All` empties the region at once. So admission depended on the order rules
happened to sit in the stack.

Fixed by deferring an unrepresentable subtraction and retrying until a pass makes no
progress, failing closed only if the region is still non-empty. This one was
fail-closed, so it refused valid policies rather than admitting invalid ones - the
safe direction, but still wrong, and the kind of thing an operator would experience as
the tool inexplicably rejecting a correct charter.

### F13 - A bare schema name escaped confinement in REINDEX and COMMENT (fixed)

The reported version of this was partly wrong, which the probe settled. Under a
charter owning only `app1`:

```
REINDEX SCHEMA control            -> ALLOW      (reported, confirmed)
REINDEX DATABASE postgres         -> ALLOW      (reported, confirmed)
COMMENT ON SCHEMA control IS 'x'  -> ALLOW      (reported, confirmed)
DROP SCHEMA control CASCADE       -> deny       UNDER CONFINED ONLY - see F15
CREATE SCHEMA control             -> deny
```

So `DROP SCHEMA` was already refused; the real gaps were REINDEX and COMMENT. Both
carry their target as a bare string rather than a relation or a qualified list, which
is the one slot shape the cross-schema walk does not visit, and both statement kinds
sat in the unconditionally-safe list.

REINDEX is the one that matters. Commenting on a foreign schema is a metadata write;
rebuilding every index in a schema you do not own takes an ACCESS EXCLUSIVE lock on
each of its tables, which is a cross-tenant outage. `REINDEX DATABASE`/`SYSTEM` reach
past schemas entirely and now join the other database-wide verbs.

### F14 - The body scan missed the privilege verbs the top level denies (partly fixed)

The token scan backstops PL/pgSQL text that never parses as top-level SQL. It had
needles for `alter system` / `create role` / `create user` / `drop role` but none for
the privilege verbs, so:

```
DO $$ BEGIN EXECUTE 'GRANT ALL ON app1.t ' || 'TO PUBLIC'; END $$   -> admitted
GRANT ALL ON app1.t TO PUBLIC                                      -> denied
```

`grant`, `revoke`, `security definer`, and `default privileges` are now in the list,
on identifier boundaries so `grant_total` does not trip them.

**Knowingly left open.** A scan sees only CONTIGUOUS text, so `'ALTER TABLE t OWNER '
|| 'TO postgres'` never contains `owner to` and is still admitted. The only needle
that would catch it is the bare word `owner`, which collides with ordinary column
names - `owner_app` runs through this engine's own schema - so it would reject
legitimate migrations wholesale. I judged the false-positive cost worse than the hole
and said so in the comment.

The real point: this whole layer is defeatable by splitting one more time
(`'OWN' || 'ER TO'`). It is worth keeping consistent, but it is not a boundary, and
runtime-constructed SQL is ultimately the migrator role's problem. If that matters,
the answer is a least-privilege migrator role, not a longer needle list.

### A pattern, not three incidents

Three of the guard bugs found here are the same shape: authority reachable through a
scalar slot the confinement walker does not visit.

- `RenameStmt` -> `subname` / `newname`
- `ReindexStmt` -> `name`
- `CommentStmt` -> a bare `String` node in `object`

`walk_schema_names` enumerates STRUCTURED name positions (`schemaname`, `newschema`,
`object`, `objname`, `objects`, `names`, `funcname`, qualified lists, RangeVar). Any
statement naming its target as a plain string is invisible to it BY CONSTRUCTION, and
if that kind also sits in the unconditionally-safe allowlist, it reaches any schema at
all. Finding them one at a time will keep working and will keep missing some, so I
have an audit running over every admitted node kind against its protobuf definition.

### F15 - A schema you cannot CREATE, you could still DROP (fixed) - and I got this wrong first

The worst finding of the review, and a correction to my own work.

In F13 I recorded `DROP SCHEMA control CASCADE -> deny` and wrote off the reported
hole as not real. That probe ran under a **Confined** charter only. Under the
Platform-shaped charter this engine's own operator fixture builds - `create_schema`
granted at `scope = "all"`, `cross_schema` scoped to the owned set - it is admitted:

```
CREATE SCHEMA control        -> CrossSchema
DROP SCHEMA control CASCADE  -> ALLOW  (destructive=true)
DROP SCHEMA control, app1 CASCADE -> ALLOW
```

**Cause.** `grants_drop_object` answers `OBJECT_SCHEMA` with `grants_global_bool
(KEY_SCHEMA_CREATE_SCHEMA)` - a GLOBAL query that never looks at which schema. The
create path uses `grants_namespace_bool(..., &schema_obj)`, i.e. at the target. Create
is object-scoped; drop was not. And the name is a bare single-part String in
`DropStmt.objects`, which `qualified_list_schema` skips for being under two parts, so
the cross-schema walk never caught it either.

**Impact** is destruction rather than reach: CASCADE removes every table, view,
sequence, function, and row in a schema the policy does not own. It is flagged
destructive, so approval would see it - but approval is about destructiveness, not
ownership, and an operator approving their own migration has no reason to expect it
touches another tenant.

**The lesson for me:** a single probe under one posture is not verification. Every
guard finding I checked earlier was probed under Confined, because that is the fixture
that was nearest to hand. The postures differ precisely in which grants are global,
which is exactly the axis these bugs live on. I have gone back and re-run the
previously "cleared" cases under the Platform shape too.

### F16 - Two globs that render alike sealed identically (fixed)

`write_seg` encoded `SegGlob::render`, and its doc comment justified that by render
being injective over the `(prefix, suffix, has_star)` triple. It is not, unless the
triple is canonical:

```
infix("a*", "b")  renders a**b, matches a*zb
infix("a", "*b")  renders a**b, matches az*b
```

`SegGlob::parse` refuses a second `*`, so the strict loader cannot produce these -
only the public `SegGlob::infix` can, which is why this is low severity and a plain
fix. The seal now encodes the flag and both pieces separately, so it rests on bytes
rather than on an invariant enforced in another module. Seals are in-memory, so
nothing was invalidated.

### F17 - Table-shape injection has never worked end to end (ISSUES.md issue 1)

A downstream user reported that a clean authored `createTable` is denied as
`RawCreateInInjectScope`. It reproduces on `main`, and it is ours, not a stale
consumer expectation.

`gate_raw_create` sees only the target name and the raw text, so it cannot see a
column list. It denies every `CREATE TABLE` into a schema any `[[inject]]` rule
covers, and it returns before the `schema.create_table` grant check, so no grant
can admit the statement. The engine hands the guard the same `EffectivePolicy` it
hands the shape resolver (`engine.rs:479` and `:486`, `node/lower.rs:209` and
`:225`), and `plan_declarative` at `engine.rs:747` overwrites the caller's guard
policy outright. So under any charter that injects over the project schema, no
table can be created, and there is no seam where a caller could pass a second,
inject-free charter instead.

Scope, stated precisely, because it is narrower than "no path anywhere". The gate
lives in the pg_query walker, so it binds the enforced PostgreSQL path only:
`GuardMode::Off` skips the walk, and SQLite and MySQL route to the descriptor
guard, which has no such gate. Within that path the gate runs after the
statement-kind and cross-schema checks and specifically before the create-table
grant. `confined_charter()` is also a test fixture rather than a shipped
constructor. None of that makes the feature work - `[[inject]]` is documented,
and on the normal PostgreSQL paths it cannot create a table - but the blast
radius is the enforced PostgreSQL guard, not every dialect.

The rule shipped in `de1d652` and was never wired: that commit touched the guard,
the policy crate, and two guard tests, and no engine call site. Across the whole
repo there is not one place, test or production, where a `GuardConfig` carrying an
inject successfully guards a create - every one pairs an inject charter with a
`no_inject` guard config. The comment at `namespace_authority.rs:331-337` claims
the intended flow guards over a policy that grants create in-scope; that was never
reachable, and the test beside it sidesteps by injecting on a different schema
than it creates in.

My earlier F2 resolution made both `pg_declarative` charters no-inject. That
removed the last test that could have caught this, which is why a user found it
before we did.

### F18 - A foreign key cannot see a target authored in an earlier migration (ISSUES.md issue 2)

Reproduced on `main` on all three dialects. `reference_is_format_bearing`
(`validate.rs:1606`) counts a plain `ColType::Uuid` as format-bearing even though
its `value_format` is `None`, so a uuid foreign key demands an authored contract
for its target. The authored map is filled only by `advance_logical_columns`, so a
consumer that skips lowering an already-applied file has no target contract and
the lower fails. The same shape in `text` lowers fine; only the uuid arm makes it
fail. It fails identically for a column-level `references`, so this is not
specific to table-level foreign keys.

Two structural gaps sit behind it, and they are why the naive narrowing is not
safe on its own: a single-column table-level foreign key gets no catalog proof at
all (`lower.rs:3285-3287` skips it, and `collect_typed_reference_sites` only
collects columns carrying a `references` facet, so neither pass sees it), and
SQLite's catalog check cannot tell uuid from text or TypeID because introspection
discards the distinguishing evidence. The authored-contract gate is currently the
only thing standing between that shape and a silently wrong foreign key.

### D4 - Make the inject gate prove conformance rather than deny outright

Both opinions landed on the same fix independently. When an inject covers the
target, parse the create's column list and admit it when every injected column
name is present and any pinned primary key matches exactly and in order; deny only
when the shape is short. `CREATE TABLE AS` and `SELECT INTO` carry no column list,
so conformance is unprovable and they stay denied.

The deciding constraint is that the guard must stay a pure function of its text.
The same SQL is re-guarded at six sites that hold nothing but a stored string
(`executor.rs:941`, `:1246`, `:2443`, `baseline.rs:146`, `precondition.rs:484`,
`engine.rs:649`), so a fix that threads an authored-origin marker through the
lowering path would not reach the guard that runs against the live database, and
would turn the marker into a persisted capability stored in the very artifact the
guard exists to distrust.

What this gives up, stated without softening it. Names are checked; types,
nullability, defaults, and injected indexes are not. An author holding
`schema.create_table` can write `created_at integer`, `version text NULL`, or a
pinned `id` of the wrong type, and can omit the injected indexes entirely, and the
create is admitted. Worse, the name-only immutability rules will then defend that
malformed column as though the operator had placed it. Types cannot be compared at
text level without re-deriving the whole dialect type-rendering table inside the
security layer, where it would drift from the renderer.

Both reviews agreed this is simultaneously two things, and it is worth holding
both. It IS a real regression against the categorical denial we have today. It is
ALSO exactly the granularity the guard's other inject rules already use:
`check_alter_table_injected` and `check_rename` identify a protected column by
name alone, and the pinned-PK rule is coarser still, denying any `DROP CONSTRAINT`
on a table with a pinned key without asking which constraint. So the create gate
stops being uniquely absolute and starts matching the gates that follow it.

One claim I made earlier does not hold and should not be repeated: the IR-level
`resolved_create_table_matches_inject` is NOT the same predicate. It checks full
column shape, exact primary key, and injected indexes, and `system_columns_match`
compares type, nullability, and default. The text-level check is strictly weaker.
It is a belt over that invariant, not a copy of it, and the honest statement of
what it buys is "the create does not omit an injected column slot and does not
contradict a pinned primary key".

#### The first implementation of D4 was bypassable, and the audit caught it

Worth recording because the failure was not in the design, it was in trusting a
green suite. The fix passed 2153 tests and its own seven new ones. An adversarial
pass that built a probe crate and drove `SqlGuard::check` directly found two ways
past it, both executed rather than reasoned.

`libpg_query` has already applied PostgreSQL's identifier fold by the time it
fills `colname`, so an unquoted `Created_At` arrives as `created_at` while a
quoted `"Created_At"` is preserved verbatim. The implementation folded that value
a second time, erasing the one distinction the parser had kept, and the collision
ran in the admit direction. Against the charter the tests themselves use, this
was admitted:

```
CREATE TABLE app.t ("Id" text PRIMARY KEY NOT NULL,
                    "Created_At" timestamptz NOT NULL,
                    "Deleted_At" timestamptz)
```

PostgreSQL creates `Id`, `Created_At`, `Deleted_At`. Not one injected column
exists. A trailing space inside quotes did the same, because the fold trimmed and
`compose::fold` does not.

Separately, `InjectSpec.columns` is `#[serde(default)]`, so an `[[inject]]`
carrying only `indexes` is a legal charter with an empty column list. Conformance
was `all()` over an empty list and `is_none_or` over `None`, which is true for
every create, so that charter shape switched the gate off entirely. Pre-fix it
denied. A fail-open reachable from a valid charter is worse than the defect being
fixed.

The lesson is narrow and worth keeping: a conformance check that re-normalizes a
value its parser already normalized will admit what the parser was distinguishing.
Compare the declared side verbatim and fold only the policy side.

Injected indexes are a separate matter and are deliberately not covered. A
`CREATE INDEX` is its own statement, so a `CREATE TABLE` can never carry proof of
an index obligation, and the guard is per-statement by contract. An admitted raw
create can therefore drop an injected index, which the old blanket denial
prevented. That is an accepted loosening rather than an oversight, and it is the
reason the unenforced injected-index immutability rule matters more than it looked
when first recorded.

Stripping injects from the guard's policy was rejected: the same `injects_for`
feeds the shape- and primary-key-immutability rules, so a strip would also let a
later migration drop `deleted_at` or the pinned key.

### D5 - Do not narrow the uuid predicate; close the API gap first, then prove from the catalog

Three independent reviews of F18. They disagreed on the fix and agreed on the two
things not to do, which is the useful part.

Rejected outright: dropping the `ColType::Uuid` arm from
`reference_is_format_bearing`. It fixes one type and leaves the class - a
consumer skipping already-applied files still breaks the moment any migration
authors a TypeID or ULID foreign key. Worse, it is not even sufficient for uuid:
checking catalog evidence in `validate_typed_reference_catalogs` cannot protect
table-level constraints, which run through a separate loop, so table-level
`uuid -> TypeID` on MySQL and SQLite and `uuid -> text` on SQLite would still be
admitted.

Also rejected: removing the `columns.len() <= 1` skip at `lower.rs:3285-3287` as
a standalone change. It cannot fix the reported failure, because the model gate
at `lower.rs:2994` runs before the catalog gate at `:3003`. And it is not
backward compatible: `LiveSchema::from_tables` deliberately carries names with no
snapshots, so a name-only consumer would start failing. The two reviews disagreed
on whether the in-repo suite would catch that - one found the fixtures survive,
the other named `ir_author_render_parity.rs` and `not_valid_validate_constraint.rs`
as breaking. Unresolved, and not worth resolving, since neither concludes it
should ship alone. If it is ever done it needs its own commit and a deliberate
decision about name-only `LiveSchema` users.

What ships, in this order.

First, the API gap, because it is small, additive, and changes no gate.
`LogicalColumnContract` has a private `candidate_key_sources` field and no
constructor, so a downstream crate cannot build one. `advance_logical_columns` is
the only door and it forces full strict revalidation as the price of
accumulation. That is why the consumer's first attempt silently lost contracts
for skipped files. Add a lenient sibling that accumulates under
`DeferToLower`. It must be built on `validate_per_row_op`, not on
`collect_logical_declarations_op`: the collector handles eight op kinds and would
lose the candidate-key lifecycle maintained by the `CreateIndex`, `DropIndex`,
`AddConstraint`, `DropConstraint` and `AlterPrimaryKey` arms, so a column made
referenceable by a later UNIQUE index would be wrongly rejected.

Second, the catalog proof, which is what the consumer actually asked for. Keep
the predicate; build a proof set before the missing-contract rejection. Native
`uuid` on PostgreSQL, an exact engine UUID format check on MySQL and SQLite, and
exact equality against the already-recovered `ColumnSnapshot.value_format` for
TypeID and ULID. Share one proof helper between the column-reference and
table-constraint paths, and derive the expected format from the authored column
rather than comparing two introspection-only booleans. A chained target that
deliberately omits its own check stays unprovable and stays rejected.

If that adds a field to `ColumnSnapshot` it must be excluded from `PartialEq`,
`Hash`, and the drift attribute diff. `mysql_default_generated` and
`mysql_text_storage` are the precedent. Made comparable it would produce
permanent phantom drift on every uuid column, and on SQLite a column-attribute
difference is reconciled by the table rebuild, so the cost is a rebuild of every
uuid-bearing table rather than a harmless diff.

## Findings that did NOT survive verification

Recording these so nobody re-chases them.

- **IR: "existence_guard is omitted from checksums."** Refuted. The omission from
  `ChecksumInput` is deliberate and documented; the IR-path drift anchor is
  `Checksum::of_ir` over the op-list, and the op-level `existenceGuard` is part of
  that canonical encoding. The finding missed the second half. It did point at a real
  test gap though - every checksum fixture left the field `None`, so nothing pinned
  the load-bearing half of the argument. Test added.
- **Render: "a hostile column name breaks MySQL quoting."** Half right. Plain column
  names escape correctly; only the constraint path was broken (see F4). A probe of
  the plain path showed correct output, which is why the fix landed where it did.
- **Policy: "the registry accepts permissive defaults."** Real but misrated as high.
  `PolicyRegistry::with` genuinely does not enforce the invariant `KnobDef` documents
  ("the default is ALWAYS the tightest"), but the registry is assembled by the trusted
  Rust host, not across a trust boundary. Worth fixing as an unkept promise; not an
  escalation.

## Reported but NOT yet verified

Findings below came from review agents and are recorded as leads. I have not
confirmed them, and some may not survive contact with the code - the two I did
chase (F4 above, and the plain-column case) showed the first reading was partly
wrong. Do not act on these without tracing them.

**Guard.** `ALTER ... RENAME TO` is admitted without inspecting `rename_type`, so
role/database/schema renames may pass; `DO LANGUAGE plpythonu $$...$$` may not get
the untrusted-language check that `CREATE FUNCTION` gets; quoted mixed-case schema
names may fold onto a granted lower-case schema; `SchemaScope::Single("")` (owning
no schema) may permit every schema in the body scanner; `guard_for` maps MySQL to
the no-op SQLite descriptor guard. Two more surfaced while deciding D4:
`ShapeElement::Index` appears nowhere in the guard, so the doc comment claiming
`DROP INDEX` on an injected index is enforced looks like an unkept promise; and
`BodyScopeDecisions::is_injected_shape` returns `false` unconditionally, so nothing
inside a function body is inject-checked at all.

**Apply.** PostgreSQL non-transactional crash recovery may replay an edited `up`
without comparing the inflight marker's checksum, which every other marker path
does compare; the same-deploy online-rename recovery described at length in
`journal.rs` appears to have no implementation and `deploy_envelopes` may drop the
obligation it opened; MySQL repeatables pass `had_inflight = false` unconditionally.

**Render.** Author-supplied identifiers are never length-capped, so two names
differing after byte 63 may collide silently on PostgreSQL; the catalog tokenizer
assumes `''`-escaping and may mis-parse MySQL's backslash escapes; `inline_literal`
does not reject embedded NUL although its siblings do.

**Policy.** Twelve findings, nine marked high. Several appear to target the
publicly-constructible Rust API rather than the strict TOML loader that is the
actual trust boundary, so the real severity is likely lower than reported. Needs a
verification pass before any change.

## What the two user-reported defects actually cost to close

Both entries in `ISSUES.md` are now fixed or decided, and the shape of the work is
worth recording because almost none of it was the fix itself.

`6b4cf16` closes issue 1. `5e920ae` and `730796b` came out of the same stretch.
All three are on `origin/main`.

### The first attempt at every one of them looked finished and was not

The inject-gate fix passed the full suite and seven new tests of its own, and was
bypassable two ways. Neither bypass was subtle once seen, and no amount of green
would have shown either, because both were about what the check ADMITS and the
suite only asserted what it denies.

The pattern generalises past this repo. A conformance check that re-normalizes a
value its parser already normalized will admit whatever the parser was
distinguishing. Fold one side, never both.

### Reproducing the failure yourself is the step that pays

For each fix the failing state was reproduced independently before the fix was
accepted: the guard tests against a clean worktree pinned at the pre-fix commit,
and the bool inversion by swapping the fix back out and watching `SELECT false`
cross the seam as `true` against a live PostgreSQL. That last one converted a
finding both we and the consumer had been calling "traced but not observed" into
an observed fact, and it took about a minute.

### A claim that costs nothing to make can cost a consumer real work

Two of ours did. The first said the constraint spelling of the identifier-length
defect reached the same silent failure the index check was written to stop; the
consumer wrote that justification into their source within the hour, and it was
wrong. The constraint spelling errors loudly; only the index spelling is silent,
because the engine emits `CREATE INDEX IF NOT EXISTS`. The mechanism half was
sound and the severity half was inferred, and only the mechanism half was labelled
as verified.

The second was worse in effect: every commit distance quoted to that consumer was
measured against a LOCAL `main` that had never been pushed. Acting on it would
have moved them onto a commit containing none of the fix. `main` was 57 commits
ahead of `origin/main` and nothing had said so.

Both are the same failure with different content: stating something checkable
without checking the part that makes it actionable.

## Findings that arrived as side effects

None of these were being looked for.

- The checked-in addon binary `crates/zero-migrate-node/zero-migrate-node.linux-x64-gnu.node`
  is months stale and fails 18 host tests on its own. The host suite has been
  substantially red, which means a genuine regression there would not stand out.
- `bridge.rs` is `#[cfg(feature = "napi")]`, so the gate CI runs never compiles it
  and the default-feature build cannot link. Clippy type-checks that file and
  nothing executes it.
- The connection-scoped pg type map pins some OIDs and borrows others from the
  mutable global registry, so the array shadows are not actually pins. Same shape
  as the bool defect, currently latent because the apply path reads no array
  column.
- A test deliberately scaffolds into a directory named `--json` and never cleans
  up, which is why that path keeps reappearing untracked. The CLI is behaving
  correctly; `--dir=--json` is its documented inline escape hatch.

### F19 - A truncated identifier is not a drift problem, it is a drop that lies

Traced properly after a downstream consumer asked whether their 60-byte constraint
names were in scope. The answer is worse than the drift I went looking for, and it
arrives from a different direction.

There is no production structural-drift comparison in this engine at all.
`diff_snapshots` is reachable only from tests and from an unused `DryRunReport`
field, and what the CLI calls drift is journal and checksum drift, not catalog
drift. So the question "does a truncated name cause perpetual drift" has no
mechanism behind it.

What a truncation actually breaks is the invariant `fold_ops ==
snapshot_schema(live)`, and every consumer of that invariant is keyed on the
object NAME. The migration that authors an over-long name applies and journals
clean. The damage is deferred to the next op that names it.

The sharp case: a guarded drop becomes a permanent silent skip that is journaled
as COMPLETED. `dropConstraint` and `dropIndex` with `ifExists` probe the AUTHORED
name against the INTROSPECTED snapshot. The catalog holds the truncated name, so
the probe does not match, the verdict is a satisfied no-op, and the executor skips
the statement while recording success. The constraint remains in the database and
the journal says it is gone. That is a wrong answer written down as a right one,
which is a worse failure than any amount of drift noise.

Two more, from the same root. The catalog-seeded fold hard-fails with a missing
constraint or index, so the migration can never apply. And the unique-index
approval gate ORs a live catalog fact into the author's `unique` hint precisely so
an author cannot defeat a destructive-change gate by declaring `unique: false`; a
truncated live name is never in that set, so the gate silently falls back to
trusting the hint it was written to distrust.

The codebase already knew this shape and designed around it once, for its own
journal triggers: a comment there explains that a full-name existence guard would
never match a truncated catalog name. The lesson was learned locally and not
generalised.

#### Two corrections to my own earlier work

`f501f1e`'s commit message says "MySQL is unaffected: it refuses an over-long
identifier itself with `ER_TOO_LONG_IDENT`". Wrong at the only boundary that
matters. MySQL 8 rejects at 65 bytes and accepts 64 verbatim, and 64 bytes is
exactly the shortest name PostgreSQL truncates. SQLite has no identifier limit at
all and stores a 1000-byte name byte-exact. So on the boundary case the other two
dialects silently accept what PostgreSQL silently mangles.

And `f501f1e` does not close the class it claims to. It matches only a standalone
`Op::CreateIndex`. An index or constraint name authored INSIDE `createTable`
reaches DDL unrefused, as do the names on `dropIndex`, `dropConstraint` and
`validateConstraint`.

#### What a length bound does and does not buy

It is sufficient for the truncation class, and not merely as a heuristic: the
engine already fail-closes on two objects with the same name, and those checks are
sound only while the engine's name equals the catalog's name. Bounding every
authored identifier restores that equality and lets the existing collision
machinery do its job.

It is not sufficient for a separate, pre-existing gap that the shared-budget
observation points at. The duplicate-name checks are scoped to one table, while
PostgreSQL's index namespace is per schema and shared between plain indexes and
the indexes backing UNIQUE and PRIMARY KEY constraints. Two tables in one schema
authoring the same short index name still collide, and the engine emits `CREATE
INDEX ... IF NOT EXISTS`, so the second create is the same silent no-op. That
needs a schema-wide uniqueness check over the union of index names and
constraint-backed index names, and it is not the same fix.

### D6 - Bound authored identifiers on the create side everywhere, and on the drop side only where it is safe

Two reviews of F19 agreed on the create side and split on the drop side, and the
split is the useful part.

Both agree: refuse an over-long authored identifier at validate, and extend it
past the standalone `createIndex` that `f501f1e` bounded to every authored name
that reaches DDL - `AddConstraint`, and the `constraints` and `indexes` authored
inline on `createTable`. The bound is 63 bytes on every dialect, which is what the
engine's two existing identifier checks already do.

They split on `dropIndex`, `dropConstraint` and `validateConstraint`, and the
objection I raised has a dialect-shaped answer I had not seen. A universal 63-byte
bound on the drop side would strand valid existing objects on MySQL, whose limit is
64 CHARACTERS rather than bytes, and on SQLite, which has no identifier cap at all.
It does NOT strand anything on PostgreSQL, because a PostgreSQL object that was
truncated has a physical name of at most 63 bytes by definition, so the bound can
never refuse a name that could have dropped it. The remedy for a legacy
PostgreSQL object is to name it as the catalog holds it.

So: bound the create side on every dialect, bound the drop side on PostgreSQL
only, and leave MySQL and SQLite reference names to their own limits.

Two corrections to the write-up in F19. MySQL's limit is 64 characters, not 64
bytes, so the boundary case is character-shaped rather than byte-shaped. And
`diff_snapshots` is publicly exported, so "no production caller" is true of this
repo and not of a downstream consumer that calls it directly.

One thing that got worse on inspection rather than better. F19 described the
unique-index approval gate degrading to trust the author's hint. For a GUARDED
drop that produces the skip already described. For an UNGUARDED PostgreSQL drop,
the server's own truncation resolves the name and the unique index is actually
dropped, without the approval the gate exists to require. That is not a skipped
operation, it is an unapproved destructive one.

`validateConstraint` shares the probe defect with the two drops and belongs in the
same change.

The schema-wide namespace collision stays separate and is higher priority than it
first looked: it affects valid short names, backing indexes and other relation
kinds, and it is a relation-namespace problem rather than anything to do with
truncation.

### D7 - Bound identifiers at lower, and keep a narrow probe backstop that resolves the truncated name

Two reviews of where to defend the truncation hazard. One picked the lower seam
alone, one picked both. They agreed on more than they differed on, and the
difference turned on one checkable fact, so I checked it.

Agreed by both, and confirmed: the load-time bound alone is not enough, and not
mainly because of the entry point. `validate_authored_identifier_lengths` matches
only top-level ops, so a `dropConstraint` nested in an `Op::Dialectal` leg passes
it untouched and lowers to a guarded drop on the fully routed production path.
That hole exists no matter which caller you come through. The Dialectal arm is
part of this fix, not a separate one, and it belongs in the shared function so the
load gate and the lower call get it from one edit, keying leg selection on the
same dialect the lowering will use.

Also agreed: no new `IrLowerError` variant. The enum is public and exhaustive, so
a new variant is a source-compatibility break, and `lower_steps` already refuses
authored input through an existing validation carrier.

The objection I built into the question was wrong. I asked whether adding the
bound at lower would break callers who deliberately skip validation. There are
none: the only non-load caller runs `validate_ir` first, and lower already runs
several validators of its own. So the lower seam is the primary defence and costs
nothing in contract terms.

Where they split was whether a probe backstop earns its place. The argument
against was that `existence_guard` is read from the freshly lowered plan and never
rehydrated from the journal, so nothing can reach the probe without passing
through lower. That is true of anything lower produced, and it is not true in
general: `Migration.existence_guard` is a public field on a struct that is not
`#[non_exhaustive]`, in a crate a consumer can depend on directly, so a migration
carrying a probe can be built without lowering ever running.

And a second face the lower seam does not cover on that path: an over-long
`IfNotExists` probe returns `RunBare`, which does not skip a drop but CREATES a
truncated identity.

So both, with the probe as a genuine backstop rather than a duplicate.

The refinement that decides how the backstop behaves, and the reason it is not
simply "error on any over-long name": derive PostgreSQL's own truncated spelling
and look THAT up. If the truncated name is present, the miss was a lie and it
should error as ambiguous. If even the truncated name is absent, the drop
postcondition genuinely holds and a legacy migration may safely no-op. A blanket
refusal would break migrations that are currently correct.

Both faces stay PostgreSQL-only and direction-aware. Ordinary absence under
`ifExists` is exactly what a satisfied no-op is for, so the probe cannot error on
a mismatch in general; the length case is distinguishable only because a
PostgreSQL catalog name is at most 63 bytes by construction, which makes the
lookup structurally incapable of matching and the miss carry no information.

### F20 - Rebuilding the addon corrected three of my own records and found a gate that passes SQL the server always refuses

I had this filed as "the checked-in addon binary is stale and fails 18 host tests".
Three things in that sentence were wrong, and the rebuild found something the
figure was hiding.

**It was never checked in.** `git log --all -- 'crates/zero-migrate-node/*.node'`
returns nothing; no commit has ever touched a `.node`. It is gitignored twice,
with a comment saying the generated `index.js` and `index.d.ts` are tracked on
purpose and only the compiled binary is not. So it is untracked local build
output, not a tracked liability. Removing it breaks no gate and no consumer; it
breaks a local host-suite run until you rebuild, which CONTRIBUTING already tells
you to do.

**The failure count was never drifting.** It is a pure function of which database
URLs are exported: none gives 6, both give 18, and PostgreSQL alone gives 10,
because exactly 8 of the 18 are MySQL-only. Both figures I recorded were correct
for the conditions they were measured under, and I read the difference as the
artifact rotting when it was my own harness varying.

**What the staleness actually costs** is the part worth keeping. Seven host test
files fall back to that path silently, so a months-old binary produced a
plausible-looking mostly-red suite instead of an obvious "addon missing" error. A
suite that is red for a reason nobody can attribute is worse than one that
refuses to run.

#### The rebuild surfaced what the stale binary was masking

It fixed 14 failures and produced 7 new ones. New failures after replacing a stale
artifact are the interesting direction, and they split cleanly.

Ten are a stale test charter. `packages/zero-migrate-cli/tests/host/policy.ts`
ships a bare `policy_version = 1`, and since the charter redesign a policy that
declares no cross-schema grant owns zero schemas, so the guard denies the suite
its own project schema. Proved rather than assumed: the same apply, run twice
against a live database with the fresh addon, fails with that bare charter and
succeeds with the include-scoped one the addon crate's own fixture already uses.
That fixture was updated for the redesign and the CLI host suite's was not.

One is a real defect. A fixture authors `t.text().notNull().default("new")`, the
MySQL renderer emits `text ... NOT NULL DEFAULT 'new'`, and MySQL 8 refuses a
literal default on TEXT unconditionally. `lint` reports **ok** on that migration,
so a plan-time gate is passing SQL the server will always reject. Nothing in the
engine rejects the shape. The stale binary rendered something MySQL accepted, so
this passed for months and only appeared once the artifact was current.

#### A gate nobody runs rotted in both directions

`pnpm --filter zero-migrate-node test` fails against both binaries and fails
DIFFERENTLY: the stale one passes two scripts and fails a third, the fresh one
passes that third and fails one of the first two. The rebuild fixed one gate and
broke another. CI runs neither, which is how it managed to rot in both directions
at once.

### D8 - Refuse MySQL-fatal storage shapes at validate, from one predicate the renderer shares

Both reviews picked validate, dialect-scoped. They agreed on the destination and
found different reasons, and the reasons matter more than the vote.

The objection I raised against putting it in the renderer was weaker than the
truth. I said a renderer refusal arrives too late, with a connection and lock
already held. That is so - lowering happens inside the project-lock bracket - but
the decisive fact is that it would never surface at all: `render_ir_ops` catches
every lowering error and degrades it to a `-- [runtime-resolved]` comment, by
deliberate design. `previewSql` would not throw, and lint would still print `ok`.
The other half of lint's verdict, the load-and-validate gate, feeds the result
directly, so only a validate-time refusal turns lint red. Apply runs that same
gate before lowering, so one placement closes both.

Precedent is exact: MySQL deferrable foreign keys are already refused at validate
with a dialect check and a "use a dialectal leg" remedy. And lint already calls
the gate once per selected dialect, so the same authored bytes can fail on MySQL
while passing on PostgreSQL and SQLite. The worry that a dialect-scoped refusal
would reject a dialect-agnostic artifact is answered by the architecture rather
than needing a design.

#### The constraint that decides how, not where

A fresh predicate in validate would be a SECOND COPY of the renderer's storage
decision, and a stale second implementation is exactly what produced this defect.
So the rule is only sound if the predicate is lifted into one function that both
validate and the MySQL type renderer call, with a test asserting they agree.
Written as an independent reimplementation it reintroduces the drift class it
exists to close.

It must key on RENDERED storage, not the authored type name. A bounded string
marked case-insensitive renders a bare `TEXT` regardless of its length, so
`t.string({ length: 50 }).caseInsensitive().default("x")` is equally fatal while
its authored name says "bounded". A name-keyed rule misses it. The coarse
reference-compatibility helper already in validate cannot be reused either, since
it collapses bounded and unbounded strings to one spelling and would refuse
`t.string({length})`.

Not every literal default is invalid, which a naive rule would get wrong. MySQL
permits an expression default on TEXT, and the engine already renders bytes
defaults and JSON container defaults that way. The rule must distinguish a bare
literal from a parenthesized expression.

#### It is a class of at least four, and the second one is already live

Beyond the reported literal default on TEXT/BLOB/JSON/GEOMETRY:

An index, primary key or unique constraint over a bare `TEXT` column without a
prefix length, which MySQL refuses outright. This is not hypothetical: the same
fixture renders `CREATE INDEX ... (sku)` over a bare text column and lint passes
it. The engine already knows this rule for its own journal tables and does not
apply it to user tables.

A bounded string longer than MySQL's row limit, rendered as `VARCHAR(n)`
unconditionally and refused by the server. The declarative schema path already
caps that to `LONGTEXT`, so the two paths in this engine already disagree with
each other about the same column.

And case-insensitivity on a bounded string, which renders bare text and therefore
inherits both of the above.

Validate closes the three column-shaped ones cleanly. The index case needs the
referenced column's type, which validate has for a column declared in the same
envelope - the live case - but not for one from an earlier envelope or an
unmanaged table. Neither placement closes the whole class alone; validate closes
more of it, closes it earlier, and is the only one that turns lint red.

#### What this does not fix

Neither review claims it would have caught the defect before the addon was
rebuilt. The refusal compiles into the same artifact as the renderer, so a stale
addon carries a stale validator too. That makes failing loudly on a stale addon
the load-bearing fix rather than a hygiene item, because no gate inside that
artifact can be trusted while the artifact can silently be months old.

A default set on a pre-existing column carries no type in its own op, so offline
validation cannot classify it. That case stays uncovered.

### F21

Connection lifecycle across the test corpus, reviewed independently by Codex
(read-only) and Opus and reconciled here. The headline is a negative result: there
is no connection leak. Every live-PostgreSQL test builds a function-local
`PgDevSession` owning one pinned client (`tests/support/mod.rs:242-263`), and the
locked `postgres` 0.19.14 closes the socket in `Client::Drop` on both a normal
return and a panic unwind. Nothing accumulates across a serial run.

The bound is comfortable. Cargo runs integration binaries one at a time, so the
ceiling is the largest binary: `pg_scenarios.rs`, 30 live tests plus one that opens
a second session, giving `min(T + 1, 31)` for `T` test threads. Against a nominal
`max_connections=100` that leaves 69 free. Even a runner that overlapped every
live-PG binary at once reaches 51, leaving 49. Connection exhaustion is not a
credible failure mode here and needs no semaphore.

What the review found instead was a schema leak, tracked separately. 44 of the 48
tests that create a persistent schema clean up only at the bottom of the happy
path, so any assertion failure strands the schema. The four that guard an ordinary
`Err` still do not guard a panic. Because schema names embed PID and time, no later
run reclaims an earlier run's residue, and the cleanup helpers discard teardown
failures with `let _ =`, so the leak is silent at both ends.

### F22

A connect failure in the CLI host suites is reported as a skip, and the default DSN
guarantees it fires.

`tests/host/e2e-pg.test.ts:67-77` catches every connect error with a bare `catch`
and returns null, which the call site at :131-134 turns into
`tc.skip("test Postgres unreachable ...")`. An authentication failure, a missing
database, a TLS error and a driver regression are therefore indistinguishable from
a contributor who has no database. The same shape repeats at driver-pg.test.ts:260,
:299, :340, authoring.test.ts:192, :268, and e2e-dml.test.ts:187.

The default DSN makes this constant rather than theoretical. Five files and
`oracle.ts:55` default to `postgres://postgres:zero_migrate@localhost:5440/...`,
but `docker-compose.test.yml:19` publishes `127.0.0.1:5434` with
`POSTGRES_PASSWORD: postgres` at :16, and the compose file's own header at :5
documents the correct DSN. Port and password are both wrong. A contributor who
starts the documented stack and runs the host suite without exporting
`ZERO_MIGRATE_TEST_PG_URL` connects to nothing and watches every PostgreSQL host
test skip green while the database is running.

CI exports the URL, so this is a local-developer trap rather than a CI hole - the
same shape as F19 one layer up, in TypeScript instead of Rust. The remedy is the
one the Rust harness already settled on: an unset variable stays a skip, because
breaking contributors without a database is not acceptable, but a DSN that is
present and does not work is a failure, and `ZERO_MIGRATE_REQUIRE_LIVE_DB` turns
the skip into a failure where a database is guaranteed.

### D9

A skip and a pass print the same exit code, so a gated suite has to make the
difference visible somewhere else. The rule adopted for the Postgres host suites,
mirroring what the Rust harness already does: an unset DSN skips, a configured DSN
that does not connect fails.

The asymmetry is the whole point. "This machine has no database" is a contributor
without Docker running, and failing them would be hostile. "A database was
configured and it did not work" is a wrong password, a missing database, or a
driver regression, and reporting that as a skip is how a real defect reaches main
looking green. The old bare `catch` could not tell the two apart because it never
asked which one it was in.

`ZERO_MIGRATE_REQUIRE_LIVE_DB` turns the remaining skip into a failure, and it
demands an EXPLICIT DSN rather than accepting a reachable default. That looked
over-strict until the reason was written down: the flag exists so a run can prove
it was configured for live coverage, and a default that happens to answer on one
machine proves only that the machine had a database. Accepting it would make the
flag mean "somebody nearby is running Postgres", which is exactly the ambient luck
the flag is there to rule out.

The gate lives in its own module rather than in `tests/host/policy.ts`. Policy owns
charter fixtures; a database gate filed there would be findable only by accident.

### F23

Rebuilding the addon turned `pnpm --filter zero-migrate-cli test:host` red, and the
engine is right to do it. `tests/host/mig/20260711000001_create_widgets.ts:9`
declares `status: t.text().notNull().default("new")`, and MySQL refuses a literal
DEFAULT on TEXT, BLOB, JSON and GEOMETRY. The refusal is the validation added for
the MySQL storage shapes; the fixture predates it and was always invalid for MySQL.

What makes this worth recording is why it was invisible. The refusal compiles into
the same artifact as the renderer, so while the checked-in `.node` was stale the
validation simply was not present, and the fixture passed. The defect and the proof
of the defect shipped in the same binary, and only rebuilding surfaced either. That
is the third finding in this family, after the stale addon itself and the drifted
`index.d.ts`: a generated artifact committed to the tree does not merely go stale,
it suppresses the gates that would have reported it stale.

The fixture is shared by four suites, so bounding the column changes PostgreSQL
rendering too. Left open rather than fixed in passing.

### D10

Two independent reviews and my own reading agree on bounding the fixture column:
`status: t.string({ length: 32 }).notNull().default("new")`. The reasoning that
settled it was not about MySQL at all.

`README.md:55` already writes `status: t.string({ length: 32 })` for exactly this
kind of column, and `docs/dialects.md:216-218` states the rule plainly: bounded
`t.string({ length })` for a value you index, filter or key on, `t.text()` for
unbounded prose. The fixture contradicted the project's own documented guidance.
So this is not a workaround for a dialect quirk, it is the authoring the docs
already prescribe, and the MySQL refusal is what made anyone look.

The premise challenge came back negative, twice, and the check is better than the
objection assumed. MySQL 8.0.13 and later accept a default on TEXT, BLOB, JSON and
GEOMETRY only in expression form - `DEFAULT ('abc')` is accepted where
`DEFAULT 'abc'` is refused, even though both carry a literal. `validate.rs:6520`
exempts any rendered default beginning with `(`, and the classifier keys on
rendered storage rather than the authored type name, so a `t.text()` that renders
`VARCHAR(191)` through a value format takes a literal default happily. The
validation is correctly scoped. The fixture was wrong.

Rejected alternatives. A MySQL-only fixture would cost the cross-dialect claim the
shared artifact exists to make, and the two copies could drift in column set or op
order while four suites kept asserting the same names. Dropping the default would
turn the suite green while removing the only create-time default this fixture
family carries through the lower.

One trap worth recording because it would silently undo the fix: a bounded
`t.string({ length })` marked `caseSensitive: false` renders bare `TEXT` again
(`declarative.rs:1266-1270`), and the refusal returns.

### F24

The fixture fix uncovered a third defect in the same family, and the reason it was
hidden is the more useful half.

`create_gadgets` indexes `sku`, an unbounded `t.text()` column, with no prefix
length. MySQL refuses that outright, and the rule is already written down at
`docs/dialects.md:230` and already recorded here as live and unfixed. It survived
for two independent reasons stacked on top of each other. That fixture is applied
only against PostgreSQL, so nothing exercised the MySQL verdict at all; and
validation returns on the first rejected op, so even once MySQL was asked, the
index at op_index 2 stayed behind the default at op_index 0 until that one was
fixed. Two masks over one defect, and removing either alone would have left it.

The instruction given to the agent was to leave `sku` as `t.text()`, on the
reasoning that one bare TEXT column should stay to cover TEXT rendering. That
reasoning was sound and the instruction was still wrong, because the column it
named is indexed. The coverage argument survives intact through `label` in
`create_widgets`, which is the fixture that actually runs on both dialects.

The general shape, now seen three times today: a rule the engine enforces
correctly, a fixture that predates it, and no gate that asks the question. The
remedy is to ask it unconditionally rather than only where a suite happens to
look, so the new lint validates every fixture against every dialect offline and
collects all failures instead of stopping at the first.

Still open, and inherited by the new lint: validation stops at the first rejected
op within one fixture, so a fixture carrying several bad shapes reports one per
dialect per run. The lint collects across fixtures, not within them.

### F25

The reported duplicate foreign key was in the producer, not the fold, and my own
localisation pointed at the wrong side of the seam. Worth recording because the
error message is what misled me.

`gen-types: fold the schema source failed` reads as "the source I just rendered",
so I traced the renderer and its lifted column references. It means "the source you
handed me". The fold runs over the OPS, before any TypeScript exists, so nothing in
the rendering path was involved.

The actual shape: `descriptors_to_create_ops` emitted two carriers of one key for a
`ref` field - the `ColType::Ref` brand, which the shared snapshot builder already
materializes into the derived `<table>_<column>_fkey`, plus a table-level `Fk`
constraint given the same derived name. The fold then met the same name twice and
failed closed.

Three independent facts say the producer was wrong rather than the fold being
strict. The recorder emits the brand alone. The lower pushes table-level keys with
no duplicate check, so accepting the pair would have rendered `CREATE TABLE` with
the constraint written twice - the fold would have been fail-open relative to apply.
And the IR validator refuses a `ColType::Ref` as the local side of a table-level
key, so those ops could never have been applied anyway.

The reason it survived is the sixth taxonomy member exactly: the addon's gate for
this verb runs, passes, and asserts byte-identical output, but builds its descriptor
with no `references` field, so the branch was never entered. The test that pinned
the producer's behaviour asserted the table-level constraint IS emitted - it
encoded the defect as the contract, which is the other half of why nothing caught
it.

Left open, found on the way: `logical_reference_types_match` compares `ColType`s
exactly except for the `String`/`Text` pair, so a `Ref` local against a `text` `id`
never matches even though both lower to `text`. Harmless for gen-types, which does
not validate, but it means no `ref`-branded column can carry a table-level key at
all. Whether `Ref` should join that equivalence class is undecided.

### F21 corrected

F21 concluded there is no connection leak, reasoned from `postgres` 0.19.14 closing
the socket in `Client::Drop`. That conclusion is now measured server-side and it
holds, but two things in it were wrong and the correction matters more than the
confirmation.

Measured against a live PostgreSQL 18 with `max_connections = 100` and an idle
baseline of zero, sampling `pg_stat_activity` filtered by `datname` and excluding
the sampler's own backend.

Serial, concurrency removed as a confound, 30 live tests over 13.3 seconds at 200ms
resolution:

    0 0 0 0 1 1 1 1 1 0 1 1 1 1 0 0 1 0 1 0 0 1 1 1 1 0 1 1 1 1 0 1 1 0 1 0 1 1 1 0
    0 0 0 1 0 1 1 0 1 1 1 1 1 1 1 1 1 1 1 1 1 1 1 1 1 1 1 1 1 1 1 0 1 0 2 1 0 1 1 0
    1 1 1 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0

Peak 2, and the 2 is the one test that deliberately opens a second session while
holding the project lock. Connections are torn down within a test. Backends
retained after process exit: zero, in every suite measured, including a 1938-test
run across 63 binaries.

Connections per test is 0.00 everywhere. The reporting consumer measured 0.6 and
1.9 per test in their own suites, so the comparison is not marginal.

The first correction: the headroom figure of 31 of 100 was computed from test
counts and is wrong as a description of anything observed. Measured parallel peak
is 13 to 15, because libtest runs one thread per logical CPU and this machine has
16. The ceiling was never approached and the arithmetic behind the old number
described a scenario that does not occur.

The second correction is the one that matters. This tree looked like a decisive
control for the reporting consumer's hypothesis that a compio runtime retains
sockets until process exit, because our live-PostgreSQL suites do run under
`#[compio::test]`. It is not decisive. `PgDevSession::connect` uses the BLOCKING
`postgres::Client::connect`, so the sockets belong to that client's own internal
runtime and were never compio tasks. A defect in compio's teardown could not appear
here whatever its state. A flat curve is therefore consistent with both "the
mechanism does not exist" and "the mechanism exists and cannot reach these
sockets", and it does not distinguish them.

So the measurement establishes that this engine does not leak connections, and
establishes nothing at all about the mechanism it was set up to test. The
instrument was validated separately by holding 20 connections open and observing
20, so the null result is a real null rather than a blind one.

### F26

Reading the five functions the product surface never names produced one structural
finding, three clean acquittals, and a correction to the detector that found them.

The correction first, because it undercuts the evidence. My candidate list came
from a bare-identifier grep, adopted specifically to fix an earlier miss where a
function passed as a value - `.or_insert_with(f)` - has no call parentheses
anywhere. That refinement traded one blindness for another. `restrict` is both a
policy-composition function and the foreign-key action string `"restrict"`, so the
sixteen hits that made it look reached were a doc comment and TypeScript fixtures
setting `onDelete: "restrict"`. VERIFIED: `restrict(` as a call appears nowhere in
any crate's `src` except its own definition at
`crates/zero-migrate-policy/src/compose.rs:1248`.

So a `name(` grep misses functions used as values, and a bare-identifier grep
matches domain vocabulary. Each refinement moves the blindness rather than removing
it, and the symbol most likely to collide with a domain string is exactly the kind
of short verb a policy API uses.

The structural finding. `docs/policy.md:74-105` is headed "Full admission flow" and
presents `overlay(root.as_trusted(), ...)` then `finalize_charter(assembled)` then
`admit(...)` as the way to layer charters. None of `overlay`, `restrict`,
`finalize_charter` or `as_trusted` has a caller in any `src`. Production layers
charters through `effective_policy_from_charter_layers`
(`crates/zero-migrate/src/model/table_shape.rs:673-694`), which composes by
repeated `admit` with every non-root layer parsed as `LoadContext::NonRootLayer`.
That path is live and fail-closed. The documented one is a complete parallel
algebra the product does not use, so a reader following the documentation would
build on code no shipped call site exercises.

The acquittals are worth recording because three of five looked alarming and were
not. `deny_all` is exported surface whose production counterpart is stricter: a run
with no charter returns "at least one policy charter is required" rather than
falling back to a default-deny floor. `disarm_all` is `#[doc(hidden)]` crash-fuzz
support, correctly public so integration tests can reach it, and its production
counterpart `trip` is engaged at eight sites. `guard_mode` is a redundant accessor
over a field that enforcement reads through `skips_denylist_belt()`, which is
genuinely called. `is_authorizer_denied` is a diagnostics gap rather than a security
one: the SQLite authorizer is installed in production, and what is missing is only
the ability to tell an authorizer denial from an ordinary statement error, so a
confinement block reaches the user as a generic failure.

Reported by that review and not verified here: that `GuardMode::Off` is assigned
only inside a `#[cfg(test)]` constructor with no callers, making the belt-off
posture unreachable in shipped code, and that the test proving the
`CreatableEscapesMandatoryInject` lint admits in its own comments that it could not
construct the real precondition and restricts a charter against itself instead.
Both are the manufactured-precondition shape and both need checking before they are
treated as findings.

### F25 narrowed

The measured no-leak result is true and narrower than it reads. VERIFIED: the only
non-test implementation of `SqlSession` in this workspace is `NapiHostSession`
(`crates/zero-migrate-node/src/session.rs:118`), which dispatches every query across
the napi bridge to a JS host driver. Every other implementation is a
`RecordingSession` inside a `#[cfg(test)]` module.

So in the shipped product this engine never owns a database socket. The connection
belongs to the consumer's driver on Node's event loop. The sockets measured were
test-support sockets opened by `PgDevSession` so the Rust integration suites can
reach a real server.

The engine does not retain connections in production because it does not open them.
Connection lifecycle in the shipped path is the host's concern, which also means a
consumer's pooling and teardown behaviour is not something this repo's tests can
observe.

### F27

The differential oracle runs never, and it is the harness whose whole purpose is
checking two independent implementations against each other.

`packages/zero-migrate-cli/tests/host/oracle.ts` states its own job in its header:
run host `apply`/`status`/`history` over `driver-pg` against live PostgreSQL,
assert journal ordering and checksum anchoring, prove the native recorder and the
host recorder agree on authoring, and run under BOTH bun and node so the two
runtimes can be compared.

VERIFIED, four ways, none of which required running anything:

Nothing invokes it. A search for the name across every `package.json`, the CI
workflow, every `*.json`, `*.yml` and `*.sh` in the repository, and `docs/`,
`CONTRIBUTING.md` and `README.md`, finds no invocation at all - only the file
itself.

It is outside the suite glob. `test:host` is
`node --import tsx --test tests/host/*.test.ts`, and this file is not a
`*.test.ts`.

Its Node arm cannot resolve its fixture. Under plain Node it imports
`./mig/20260711000001_create_widgets.mjs`. That file does not exist;
`tests/host/mig/` holds three files and all are `.ts`. The `.gitignore` beside them
ignores `mig/*.mjs` and says they are "regenerated via `bun build`", and no script
in the repository runs that build.

Its Bun arm has no runner. Bun appears in no `package.json` and no workflow.

So a harness documenting six or seven distinct oracles, including the only
cross-implementation parity check in the tree, is reachable by nothing and would
fail on its first import if it were reached. This is the plainest instance yet of a
suite that never runs, and it is worth noting that it was found while investigating
a much smaller worry - whether its generated fixture might be stale. The fixture is
not stale. It is absent, and so is the runner.

The header's Bun-versus-Node parity claim is the part to fix first regardless of
what else happens: it describes a comparison nothing performs.

### D11

Two independent reviews and my own verification agree: delete the differential
oracle, porting one assertion. The reasoning is worth keeping because the file
looked like the most valuable thing in the host suite and was worth less than
nothing.

It was born broken. The codex review traced it across all reachable refs, reflogs
and dangling commits: introduced on 2026-07-11 with a genuine native-PostgreSQL
reference fixture, and at that moment the package's only test glob was
`tests/*.test.ts`, which already excluded `tests/host/oracle.ts`. Roughly five hours
later the commit that deleted the native recorder binary removed the counterparty it
invoked. A later commit stripped the native reference arm and left the prose
describing it. CI arrived afterwards and wired only `test:host`. So no tracked
script or CI step ever invoked it, at any of its four historical paths.

It cannot run under any runtime. Verified by startup probe rather than by reading:
plain Node fails on `./policy.js`, since Node does not remap it to the TypeScript
source; Node with tsx gets past that and selects a `.mjs` fixture that does not
exist and that no script generates; Bun imports the TypeScript fixture and then
fails on the missing `target/debug/zero-migrate-js`, a binary that never existed in
this repository's history.

Everything it asserted is covered more strictly elsewhere, with one exception.
`e2e-pg.test.ts` asserts exact step names, declared order, strictly increasing
`event_seq` compared as `BigInt`, one shared anchor AND that the anchor is a 64-hex
digest, against the oracle's non-empty-name and set-size-of-one. `driver-pg.test.ts`
covers the poisoned-parser protection categorically better and, unlike the oracle,
restores the poison afterwards. The exception is `status()` against a freshly created
schema with no journal at all - the first call a new user makes on a cold database -
which nothing else exercises. That one assertion moves; the file goes.

The reason not to keep it as documentation of intent: its presence made an unguarded
gap look guarded. There is no second recorder implementation, so cross-implementation
authoring parity is genuinely unchecked, and a 340-line harness claiming to check it
is worse than an honest absence. That gap is now tracked on its own terms.

One assertion inside it was vacuous rather than merely unrun. Its exact-integer
check read the journal through the ordinary admin client after the global parser had
been poisoned, so raw text from that poisoned parser satisfied it, and a small
JavaScript number would satisfy `String(number)` too. It never established what it
claimed. Whether the surviving equivalent shares that hole is being checked as part
of the removal, and matters more than the deletion does.

### F28

Deleting the dead oracle turned up a worse defect in a test that is staying, which
is the more useful half of that task.

`e2e-pg.test.ts` asserted `/^\d+$/` over `String(event_seq)` and its comment called
that proof that connection-scoped exact-integer parsers prevent float rounding. The
assertion could not fail, measured three ways.

The read goes through the test's own client, built with no type-parser overrides, so
the driver's oid-20 pin is not in the path. A digits-only check cannot see precision
loss anyway: `Number("9007199254740993")` is `9007199254740992`, and that stringifies
to digits. And the companion guard against exponential notation defended a range no
int8 reaches, since `toString` only goes exponential above `1e21`. A lossy parser, a
raw wire string and the default value all satisfy it identically.

The oracle had the same check and the same comment, which is presumably where it was
copied from or to. Deleting one and leaving the other would have removed the dead
copy and kept the live one.

This is the shape worth naming. The other members of this taxonomy are tests that do
not run, or run against inputs that avoid the defect. This one runs, on every CI
build, against the real path, and asserts something that is true of every possible
value. It is not weak coverage; it is a sentence that reads like coverage. The
comment above it is what made it survive - it stated a mechanism confidently enough
that nobody checked whether the line below exercised it.

The fix keeps the loop for what it does prove, ordering, and moves the exactness
claim to where it is established: `driver-pg.test.ts` asserts the driver never
consults a global parser for a pinned oid, with the pinned set asserted equal to the
sample so a new pin cannot be added silently, and the `history()` arm asserts
`typeof eventSeq === "bigint"`, which no formatting coincidence satisfies.

A milder version survives at `driver-pg.test.ts:362-372`, unchanged: its comment
credits the oid-20 pin, but the query selects `event_seq::text`, so PostgreSQL
formats server-side and the pin is bypassed on that read. The surrounding test is
sound; only that line's stated justification is wrong.

### F29

The sibling of F28 turned out to be the smallest of three problems, and chasing it
found something larger about the arm that contained it.

The `event_seq::text` cast was really there, and removing it would have fixed
nothing. The read goes through the gate's client, built with no type-parser
overrides, so the oid-20 pin is not in that path with or without the cast. Worse,
under this file's poison - which leaks the raw wire text - a borrowed oid-20 parser
and the pin return the identical string, because the raw wire text of an int8 is
exactly the digits the pin's verbatim parser hands back. Measured, both give
`"9007199254740993"` as a JS string. No assertion on the value can distinguish them
here at all.

So the agent could not make the assertion sensitive and said so rather than
shipping a fix that would have carried a fresh claim of having been checked. That is
the right outcome and worth recording as one, because the tempting move was to drop
the cast, watch the suite stay green, and call it repaired.

The larger finding came from testing the enclosing arm rather than the line. Its
header claimed that nothing the apply path reads depends on a parser a host
application can rewrite. Removing every pin from `connectionScopedTypes` and running
the file fails six of eight arms and leaves this one green. The poison is genuinely
live - the arms that read a bool or a `name[]` fail - and this arm simply never
reads a value a raw-text leak corrupts. The claim was unsupported. It is a smoke arm
and now says so.

Two more of the shape were found and left for their own judgement. A test named for
MySQL session pinning asserts only that an exported constant contains two mode
flags, so deleting the line that issues it to a session leaves the test green; that
is worse than F28, since F28 was true of every value while this is true whether the
guard exists at all. And a UUIDv4 test checks 128 values for format and never for
distinctness, so a generator returning one constant passes.

The pattern across all four: the test asserts a property of a STRING while its name
or comment claims a property of a MECHANISM. Format is the easy half and it reads
like the whole thing.

### F30

The MySQL session-mode pin had no test, and the test named for it could not have
noticed. VERIFIED by removing the mechanism: commenting out the single call that
issues the mode left the whole host suite at 91 passed, 0 failed, including
`MySQL host sessions pin explicit legacy zero preservation`. That test asserted the
exported string constant contained two flags. The constant is not the pin; issuing
it is.

The replacement reads `SELECT @@SESSION.sql_mode` back through a session the driver
opened. With the call removed it fails and quotes the server's actual mode string.
I re-ran both directions myself rather than take the report: with the mechanism gone
the constant check still passes and the read-back fails, which is the contrast that
matters.

Reading the mode back was chosen over asserting the driver issued a statement. An
assertion about the call would be the same defect one level up - green after any
refactor that changed how the mode is set, while still sounding like a guarantee
about sessions.

The larger finding came out of the same run. The six live-MySQL apply tests could
not detect the missing pin either, because the Rust backend re-issues the mode
before every author step. So the host-side pin is the redundant half of a
belt-and-braces pair, end-to-end coverage survives losing it, and the half that
looked tested was the half with no test at all. Redundancy hid the gap: the system
kept working, so nothing went red.

This is the third shape on the can-it-fail axis, and the sharpest. The first is
unfalsifiable for any value. The second is falsifiable but matched the wrong thing.
This one is falsifiable and matches the right thing - the constant really does
contain those flags - but the thing it matches is never connected to the mechanism
the name describes. Only deleting the mechanism finds it.

The question that catches all three, and the one to ask of any test already open:
could this body pass if the mechanism its name describes were deleted entirely.

### F31 - the UUIDv4 test could not tell a generator from a constant

`packages/zero-migrate-cli/tests/host/mysql-authoring.test.ts` inserted 128 rows
whose default came from `MysqlDmlRenderer::uuid_v4`
(`crates/zero-migrate/src/render/renderer.rs:534`), then checked each value
against the v4 regex, `value[14] === "4"`, and `"89ab".includes(value[19])`.
Nothing compared any value to any other. A generator reduced to a single
well-formed constant satisfied all three checks 128 times over.

Category (c) of axis two: falsifiable, matching the right thing, never connected
to the mechanism the test name describes. Proven by stubbing `uuid_v4` to return
`('1b4e28ba-2fa1-4d1b-883f-e9b1f7c3a2d5')` - the format loop ran to completion
over all 128 identical values and the run failed on the new assertion alone,
`1 !== 128`.

The fix is `new Set(values).size === values.length`. Its comment states the
bound rather than implying a stronger one: 128 samples catch a constant or
near-constant generator and cannot detect bias, low entropy, or a long repeat
period.

The TypeID and ULID neighbours in the same file are a different shape and need
no change. Neither generates values; both insert hand-written literals and
assert a CHECK constraint accepts the valid ones and rejects the invalid ones,
so deleting the constraint fails 21 TypeID and 9 ULID rejection cases.

One hazard recorded for future stub cycles through the Rust addon: restoring a
stubbed source with `cp -p` preserves the original mtime, so cargo sees the file
as unchanged, skips the rebuild, and the confirming green run still executes the
stub binary. Force a recompile with `touch` before trusting the restore.

### F31 sibling - the SQLite UUIDv4 test has the same gap

`crates/zero-migrate/src/render/dml.rs:3491`
`sqlite_uuid_v4_samples_have_canonical_rfc_bits` evaluates the rendered
expression 128 times and checks length, the four separator positions, the
version nibble, the variant nibble, hex-digit membership, and lowercase spelling
- every one of them in place, against a value it then drops. It never collected
the values, so there was nothing to compare and a constant satisfied all 128
iterations. This is a separate implementation from the MySQL one
(`crates/zero-migrate/src/render/renderer.rs:411` versus `:534`), so it needed
its own fix rather than inheriting F31's.

Proven without stubbing any source, by shadowing the rendered expression with a
constant well-formed v4 inside the test itself. The run panicked at the new
assertion and nowhere else:

    panicked at crates/zero-migrate/src/render/dml.rs:3532:9:
    assertion `left == right` failed: 128 evaluations of the rendered UUIDv4
    expression must all differ
      left: 1
     right: 128

Feeding the assertion body a known constant is preferable to breaking the
mechanism when other work is in flight: it proves the same thing with no build
artifact left behind and no window in which a downstream consumer could load a
deliberately broken tree.

### F32 - the two claims left unverified from the guard-surface read, now checked

Both came from an agent report and were carried as unverified. I have now read
the code for each.

**Trusted posture is unreachable in this product.** Verified. `GuardMode::Off`
is written in exactly three places: `crates/zero-migrate/src/conn.rs:298`,
`crates/zero-migrate-guard/tests/guard_smoke.rs:40`, and
`crates/zero-migrate/src/guard_vendor_lower_tests.rs:1328`. The latter two are
tests. The first sits inside `ExecutorConfig::trusted`, which carries
`#[cfg(test)]` and `#[allow(dead_code)]` at `conn.rs:286-287` and admits in its
own comment that "the sole in-crate consumer (the Track-A live-Postgres
Trusted-apply tests) is gated behind a running DB and currently absent". The
production constructor pins `GuardMode::Enforced` at `conn.rs:197`. So within
this product `GuardConfig::skips_denylist_belt()` at
`crates/zero-migrate-guard/src/guard/mod.rs:229` can only ever return false, and
every branch predicated on it is dead.

One correction to the original claim, which said the mode is assignable only
through that constructor: `GuardConfig::from_policy_with_mode` at
`guard/mod.rs:173` is `pub` and takes the mode as a parameter, so any consumer
of `zero-migrate-guard` can select `Off`. The field itself is private and has no
setter. The accurate statement is that Trusted is unreachable through the
engine's own configuration path, not that it is unconstructable.

This is deliberate and documented rather than accidental - the comment says the
constructor "must not be deleted" because it pins the in-crate Trusted primitive
that a separate integration crate cannot build. Recording it so the dead
branches are known to be dead, not so they are removed.

**The finalize lint test restricts a charter against itself.** Verified, and the
problem is the comments rather than the assertion.
`crates/zero-migrate-policy/tests/compose_oracle.rs:1191-1234` carries three
consecutive paragraphs of abandoned reasoning: that wrapping the same source as
a trusted base "is illegal (mandatory on non-root)"; that building an assembled
charter from the root's `TrustedDoc` "is not possible (mandatory)", so the test
will instead "rely on admit's transitive bound for the root case"; and that
exercising the lint through two trusted docs "is impossible on non-root". It
then discards the parsed charter with `let _ = root;` and, two lines later, uses
`root` anyway - calling `restrict(root.as_trusted(), root.as_trusted(), &reg)`
and unwrapping it, which contradicts the claim of illegality directly above.

The assertion itself is sound: it pins `FinalizeError::CreatableEscapesMandatory
Inject` and the lint does fire. So this is not a test that cannot fail. It is a
test whose commentary describes a different test that was never written, asserts
a fallback ("admit's transitive bound") that nothing here checks, and leaves a
dead binding as evidence of the abandoned attempt.

### F33 - three authoring tokens sat outside the enumeration the drift gate reads

The premise this started from was wrong on three counts, and correcting it is
what found the real defect.

`packages/zero-migrate/src/generated/ir.ts` is NOT generated. Its own header
says so and gives the reason: the structural defs form a self-recursive `oneOf`
AST and `json-schema-to-typescript` v15 overflows its stack on the `$ref` cycle.
`dialect-table.ts` is generated from `crates/zero-migrate/dialect-support.toml`,
not from the IR envelope schema. And CI does invoke both generators - not
through the `gen` npm scripts, but through two drift tests that shell out with
`execFileSync` and byte-compare the result, which run in the node job. So the
gate that was supposed to be missing already existed, in a stronger form than a
`git diff --exit-code` step would have been.

Determinism was checked before any of that was concluded: each generator run
twice from a clean tree, `git diff --exit-code` zero every time, and the one
latent hazard found by reading - a `localeCompare` row sort in
`gen-dialect-table.mjs` - was tested rather than assumed, producing identical
output under C, en_US.UTF-8, tr_TR.UTF-8, de_DE.UTF-8, and sv_SE.UTF-8. It is
stable for today's ASCII camelCase token set and is a trap only if a token with
a digit, hyphen, or underscore is ever added.

The real gap is axis one, the enumeration-source shape: the schema declares 83
`$defs`, 33 of them closed string-enums, and `ENUM_DEFS` in
`scripts/gen-ir-types.mjs` lists 30. The three missing ones - `VectorMetric`,
`IrMaskKind`, `IrClassification` - back `t.vector({ metric })` and
`.mask({ kind, classification })`, and their TypeScript mirrors are hand-typed
unions in `ir.ts`. The regenerate-and-diff gate covers only what the generator
emits, so nothing covered them. The detector over `ENUM_DEFS` was perfect; what
was not in `ENUM_DEFS` was invisible to it.

I verified the consequence myself from the opposite side of the agent's probe.
Renaming `VectorMetric`'s `innerProduct` to `dotProduct` in `ir.ts` - a public
authoring token - left the package suite at 219 tests, 218 passed, 0 failed. The
DSL would have offered a token the engine rejects, with CI green. With the two
new tests present the same edit fails as `VectorMetric drifted from the schema
VectorMetric tokens`.

The second new test is the one that matters longer term: it fails when any NEW
closed string-enum appears in the schema with no TypeScript mirror, so the next
token added to the engine cannot repeat this by being left out of a list.

### F34 - the milestone references in comments, triaged rather than swept

Sixteen of twenty-three sites carried a reference to this project's development
schedule: `Phase 1a`, `Phase 1b-i`, `Phase 1b-ii`, `PHASE 4`, `Phase 2 Step 2a`,
`Phase 2 Step 2b`, `Track-A`, and spec numbering of the form `II.2.5`. Those tell
a reader nothing about the code and go stale the moment the schedule changes, so
they are gone, replaced by what the thing actually is.

Seven were left, because a phase that names a step the CODE PERFORMS AT RUNTIME
is not a schedule reference:

- `crates/zero-migrate-policy/src/scope/mod.rs:399,411` number the coverage and
  disjointness steps of the containment algorithm directly below them.
- `crates/zero-migrate/tests/backfill_sqlite.rs:270,283` name the two legs of the
  test scenario, a bounded run that crashes after three batches and the resume
  that must restart from cursor 300.
- `crates/zero-migrate/src/apply/executor.rs:973,1110` say REPEATABLE PHASE,
  which is Flyway and Liquibase vocabulary; the doc comment cites `R__` and
  `runOnChange` by name.
- `crates/zero-migrate/src/apply/backend/postgres/session.rs:887` is phase two of
  a protocol its own function doc at `:734` calls "Non-transactional apply:
  two-phase with a `started` marker".

The distinction worth keeping: strip a reference to WHEN the code was written,
keep a reference to WHAT IT DOES IN ORDER.

One rewrite replaced a claim rather than deleting a tag.
`crates/zero-migrate-guard/src/guard/mod.rs:137` asserted that "Every pre-PHASE-4
call site keeps this dialect, byte-identical", which is unverifiable once the
schedule is forgotten. It now says a config keeps its dialect unless
`GuardConfig::for_dialect` selects another. That is checkable and checked:
`self.dialect` is assigned in exactly one place after construction, `mod.rs:211`,
inside `for_dialect`.

The `II.x.y` spec numbering is dangling - nothing under `docs/` defines it - and
roughly 150 references remain across the policy and guard crates, still open.

The list of twenty-three was not exhaustive. Also outstanding: the same
schedule-tag class at `guard/mod.rs:114,991`, `guard_vendor_lower_tests.rs:1317`,
`apply/executor.rs:2511`; `phase-1a` at `scope/mod.rs:45,196`,
`scope/pattern.rs:71`, `tests/compose_oracle.rs:5`; `Phase-4` at
`tests/guard_security.rs:1359,1397` and `render/dml.rs:2736`; and `Cut 3` /
`cut 4e` at `model/load.rs:59`, `model/validate.rs:4642,8987`,
`zero-migrate-node/src/lower.rs:202`, `apply/backend/mysql/mod.rs:1033`.

Two are not comments at all and so are a code change rather than a comment
change: `render/declarative.rs:6549` and `render/lower.rs:7138` both raise the
error text "renameColumn is not live-rendered for MySQL in render-only Phase 1",
which puts a schedule reference in front of a user.

### F35 - the differential oracle was not missing, it was disconnected

The premise behind this item was wrong in the way that mattered. I recorded that
`buildEnvelope` has one implementation and no independent producer to check it
against, so a self-consistent recorder bug is invisible. The first half is right.
The second is not: an independently-produced golden corpus exists, and its
provenance is certified.

It is `crates/zero-migrate/tests/op_fixtures/`, 26 `<stem>.mig.js` inputs paired
with 26 `<stem>.golden.json` envelopes - verified by listing the directory. The
goldens were produced by the Rust side, not by the TypeScript recorder, so they
are a genuine second opinion rather than a self-portrait.

The proof is a commit. `2726339` (2026-07-04) deleted the 3029-line V8 recorder
`crates/zeroship-migrate/src/frontend/migrate_ops.js` and replaced it with the
tsup build of `ops.ts`, and it re-blessed ZERO goldens - verified with
`git show --name-only 2726339 | grep -c golden.json`, which returns 0.

That only proves independence if the comparison was actually running at the time,
so I checked. At `2726339` the corpus test `op_round_trip.rs` existed, was not
touched by that commit, and carried NO cfg attribute at all - `git show
2726339:crates/zeroship-migrate/tests/op_round_trip.rs | grep -n "cfg"` returns
nothing, and the crate's feature block at that commit is only `default = []` and
`standalone-cli = []`, with no `zsv8`. It was an ordinary integration test that
ran under a plain `cargo test`. So the byte-comparison ran against the newly
swapped recorder and passed without a single golden being re-blessed. The
TypeScript recorder reproduced the independent V8 recorder exactly, and the
goldens are a frozen snapshot of a comparison that passed.

What was lost was the connection, not the oracle. `op_round_trip.rs` was deleted
in `c07e98f` (2026-07-11), "move authoring and database drivers from V8 to
N-API", because by then it was gated on the V8 feature that commit removed. The
`oracle.ts` deleted earlier in this review was the second casualty of the same
architectural move, not an isolated piece of rot.

What remains today:

- `UPDATE_CORPUS` appears nowhere in the tree, so there is no regeneration path.
- The 26 `.mig.js` inputs are consumed by nothing. The only mention is a stale
  comment at `crates/zero-migrate/tests/not_valid_validate_constraint.rs:222`.
- `crates/zero-migrate/tests/op_support_matrix.rs:81,90` still reads the fixture
  directory, but to enumerate op-kind coverage, not to compare against a
  producer.
- `packages/zero-migrate/tests/golden-parity.test.ts` is the only test comparing
  the recorder to the goldens. It is live and green, but loads 6 of the 26
  fixtures - `alter_primary_key`, `ddl_rename_table`, `fluent_ddl`, `fluent_dml`,
  `pg_vendor`, `synchronize_identity` - and hand-transcribes the migration bodies
  rather than importing the `.mig.js`, so the test's copy can drift from the
  fixture it claims to mirror.

The decay mechanism is the important part, and it is visible in that test's own
header, which records re-blessing `fluent_ddl`'s `label` column from `string` to
`text`. Every hand re-bless converts a fixture from independent to circular. The
agent's count, which I did NOT recount, is 14 of 26 already re-blessed since the
twin died. Left alone this reaches 26 of 26, at which point the corpus really does
become the worthless self-portrait I assumed it already was.

So the direction is to reconnect an oracle already paid for rather than build a
new one, and NOT to restore an easy `UPDATE_CORPUS=1` affordance, since that
affordance is precisely what converts the corpus into a mirror.

Coverage figures from the agent, computed from the goldens and NOT recounted by
me: 56 op kinds total, 34 compared against the recorder, 12 covered by a
live-database result assertion, and 20 with neither.

Provenance of this entry: I verified the corpus contents, the zero-golden commit,
the absence of a cfg gate and of a `zsv8` feature at that commit, the absence of
`UPDATE_CORPUS`, the unconsumed `.mig.js` inputs, and the six fixture stems, each
with the command shown. I did not recount the 56/34/12 coverage figures or the
14-of-26 re-bless count. A codex read-only job run on the same question
independently reproduced the history - `op_round_trip.rs` at 261 lines, deleted
in `c07e98f` - but I could not extract a clean final recommendation from its
output, so this is a single opinion I checked rather than two reconciled.

### F35 addendum - the two opinions disagree about where authority should sit

A correction to my own premise first. I wrote that every `buildEnvelope`
reference outside its definition is the dist re-export or a test caller. That is
false, and it was false because I truncated the grep with `head -20`. Verified
now with the full output: `packages/zero-migrate-cli/src/index.ts:519` calls it
inside `authorEnvelope`, which five production sites call (`:182`, `:184`,
`:305`, `:333`, `:426`), and `packages/zero-migrate-cli/src/cli.ts:658` calls it
directly. The recorder is on the production path, not only under test. That
strengthens the live-database suites as evidence, because they drive the same
code a user drives.

The two opinions agree on the history and split on the remedy, and the split is
worth keeping rather than resolving by fiat.

Both reject building a second producer - it duplicates the whole DSL and has
already demonstrated its maintenance failure mode - and both reject simply
accepting the limit. Both independently propose the same missing piece: a
schema-derived coverage manifest requiring every one of the 56 `Op` tags to name
a case, so the gap is visible rather than inferred.

They disagree on what should be authoritative.

One says restore the byte-comparison over all 26 fixtures as the primary oracle,
on the grounds that the goldens have certified independent provenance and are
therefore a real second opinion, and that this is the cheapest guarantee
available because it is already paid for.

The other says do not treat the corpus as an oracle at all. Call it a drift
sentinel, and put authority on the result side instead: exact reviewed SQL
goldens for broad database-free coverage, plus live catalog and row assertions
for anything resolved at runtime. Its argument is that a golden envelope only
ever proves the recorder still says what it said in July, never that what it said
was right, and it points out that envelopes reaching Rust are already
structurally validated by serde at `crates/zero-migrate/src/model/load.rs:49-63`,
so schema validation largely duplicates the authoritative boundary. It notes
`crates/zero-migrate/tests/sql_preview.rs:36` already pairs independently written
IR with exact SQL expectations, and that feeding an equivalent TypeScript
migration through `buildEnvelope` into those same expectations would join two
halves that are currently disconnected.

That last suggestion is the one worth taking first, because it satisfies both
positions: it is a result-side assertion, and it reuses an existing independent
artifact rather than blessing recorder output.

The disagreement is real and it is about a genuine tradeoff - a frozen envelope
comparison catches drift cheaply and broadly but can never catch a defect that
was already there, while a result-side assertion catches semantics but costs more
per operation and today covers 12 of 56. Recorded unresolved rather than settled.

### F34 continued - the rest of the schedule tags, and two claims that were wrong

Sixteen more sites carried `Track A`, `phase-1a`, `Phase-4`, `Cut 3`, `cut 4e`, or
`redesign step 5a`. All are gone, replaced by what the code does. Two of them were
not tags at all but claims that depended on the schedule, and both were false:

`crates/zero-migrate/tests/ir_author_render_parity.rs:1116` said a user primary key
is "support-refused at validate-time in Slice 5 because the platform owns the
primary key". Neither half holds. `IrConstraintKind` at
`crates/zero-migrate-ir/src/ir.rs:1575` has exactly four variants - `Fk`, `Unique`,
`Check`, `Exclusion` - and no primary-key variant, verified by scanning the enum
body for one and finding zero. A stand-alone `addConstraint(pk)` is therefore not
expressible at all rather than refused; primary-key changes go through
`Op::AlterPrimaryKey`. And platform ownership is now a policy knob resolved by
`resolve_create_table_policy`, not a validate-time refusal. The comment now states
the representability fact.

`crates/zero-migrate/tests/guard_security.rs:1397` claimed a test "pins that the
Phase-4 widening opened no hole". The widening is the kind gate admitting
`CreateDomainStmt` and `AlterDomainStmt`, stated three lines above it, so the
comment now names that instead of a date.

`crates/zero-migrate-node/src/lower.rs:202` said the lowering "no longer takes a
separate `PolicyProfile` (retired in Cut 3)". `PolicyProfile` has no definition
anywhere - the only four occurrences in the crates are comments discussing its
absence - so the sentence now states the property rather than the transition.

Left alone, on the rule that a phase naming a runtime step stays: the two-phase
journal protocol at `apply/journal.rs:328,1060,1114`, `fault.rs:130`, and
`tests/pg_scenarios.rs:2027`, all of which are the `started`-marker protocol whose
module doc opens by calling the executor two-phase and idempotent; and the `M1`
references in `tests/sqlite_confinement.rs`, which name a confinement rule with a
matching backstop arm at `apply/backend/sqlite/authorizer.rs:535` rather than a
milestone.

Two classes remain and both need their own decision rather than the same rule:

The `S0.x` cluster sits partly in GENERATED files. `dialect-support.toml:2` opens
"Phase 0, slice S0.1", and that header is emitted from a template string literal
inside `packages/zero-migrate/scripts/gen-dialect-table.mjs`, which carries the tag
itself. Fixing it means editing string literals in a generator and regenerating
artifacts that a drift gate pins, which is a code change rather than a comment
change.

Thirty-three sites use unnumbered deferral vocabulary - "a later cut", "a later
phase", "this slice". These point at unbuilt work rather than tagging past work,
several sit beside a genuine not-yet-built fact, and one is inside an `#[error]`
string that reaches users. Expanding the rule to cover them is a separate call.

One methodology change landed with this. The workspace gate now runs with
`--no-fail-fast`, because cargo stops at the first failing target otherwise, so a
red target would leave the remaining ones unenumerated and the reported count would
be a partial silently presented as a total. Verified on this tree: with the flag,
2206 passed / 0 failed across 74 targets, identical to the count without it. The
value is not today's number, it is the first day the number would otherwise be
wrong.

### F36 - the authoring recorder is now joined to hand-written SQL expectations

The step both #62 opinions endorsed is in.
`packages/zero-migrate-cli/tests/host/sql-preview-parity.test.ts` re-authors three
of `crates/zero-migrate/tests/sql_preview.rs`'s cases through the public DSL,
runs them through `buildEnvelope`, renders with the addon's `previewSql`, and
asserts the SAME strings that Rust test pins by hand. Those strings were typed
against the SQL, never generated from the recorder, so they are an expectation
the recorder cannot influence.

The valuable part of this was not the new test but what proving it cost.

The first mutation tried - recording `text` instead of `{ string: { length } }` -
WAS caught by the existing suites: the package suite went 219/1 and the host
suite failed two tests. So for column-type spelling the gap was narrower than I
had recorded, and the honest answer was to say so rather than claim a win.

A second, equally realistic mutation found the real gap. In `recordCreateView`
at `packages/zero-migrate/src/ops.ts:4294`, the STRUCTURED branch passes
`replace: undefined` while the raw branch at `:4284` keeps `replace: args.replace`
- a field dropped on one of two branches, which is what an ordinary refactor
mistake looks like. I reproduced both halves myself:

    not ok 93 - authored MySQL feature migration renders the SQL sql_preview.rs pins
        CREATE VIEW `public`.`active_teams` AS SELECT `id`, `name` ...

against a pinned `CREATE OR REPLACE VIEW`. And with that same mutation in place
the existing package suite was COMPLETELY GREEN - 221 tests, 220 passed, 0 failed.
The TypeScript suites pin op SHAPE deeply, which is why the type mutation was
caught, but nothing connected recorder output to SQL MEANING until now.

That contrast is the finding. A gap is not uniform across a surface: the same
producer was well guarded for one facet and unguarded for another, and only
running two different mutations distinguished them. One mutation would have
produced a confident and wrong conclusion either way - the first would have said
"no gap", the second "total gap".

The test carries no regenerate affordance, deliberately, and says why: re-blessing
from this side converts an independent oracle into a mirror of the recorder,
which is the failure mode the corpus in F35 has already suffered 14 times.

Its comment states what it does NOT prove, including that it is not a second
renderer - the SQL text still comes from the one engine renderer, and only the IR
reaching it comes from the TypeScript side.

Mutation window recorded per the downstream-consumer rule: opened 10:16:52 UTC,
closed 10:17:36 UTC, `src/ops.ts` restored byte-for-byte
(sha256 3e7e196d033f2986763384ea0ba8acbd397cdf0761a98da3d95b5d76cb521b72) and the
tracked build output rebuilt after a `touch`, so no stale artifact survived.

### F37 - the SQL preview omits what apply will actually create

Found while establishing whether the render path was reachable from TypeScript,
and it is a user-facing divergence rather than a test gap.

`crates/zero-migrate-node/src/bridge.rs:161` exposes `previewSql`, which calls
`render_ir_envelope_sql` on the RAW envelope. It never calls
`resolve_create_table_policy`. The apply path does, at
`crates/zero-migrate-node/src/lower.rs:206`, and so does `sql_preview.rs`'s own
golden helper.

So `zero-migrate plan --sql` and `validate --explain` show an operator a
`CREATE TABLE` WITHOUT the policy-injected columns and indexes that the
subsequent apply will actually create. The preview is not a preview of the
statement that runs.

This also explains why the whole-file goldens under
`crates/zero-migrate/tests/golden/` are not byte-comparable through the
TypeScript path, and why F36 ports the hand-typed exact-SQL cases instead: those
assert author-declared shape, which resolution leaves untouched.

Not fixed here. Whether preview should resolve the policy, or should state
plainly that it omits injection, is a product decision.

### F37 decided - preview should resolve, and the module's own header says so

Reconciled from one full opinion, my own verification, and a partial second. Being
precise about that: the Opus job returned a complete recommendation; the codex job
ran about eighteen minutes, produced 406KB that is almost entirely file dumps, and
STOPPED WITHOUT A VERDICT. So this is not the two-opinion reconciliation the process
calls for. It is one opinion plus independent checking, and the one thing that makes
that acceptable is that the decisive evidence is three code contracts I read myself
rather than anybody's reasoning.

A circularity worth recording first. The Opus job's HEADLINE evidence that the
behaviour is unintentional was `docs/review-log.md` F37 - an entry I wrote two hours
earlier. My own review log cannot corroborate my own finding. This is the decay shape
from F35 applied to prose: a claim I wrote becomes, one hop later, corroboration for
itself. My review log is now an evidence source agents read and cite back to me, and
I have to discount it accordingly.

The real evidence, all three verified by me by reading:

`crates/zero-migrate/src/render/sql_preview.rs:82-84` documents
`PreviewOpts.effective_policy` as "The composed policy whose inject rules shaped any
RESOLVED create-table operation being previewed." The design assumes the envelope
arriving is already resolved.

`crates/zero-migrate/src/model/load.rs:60-62` says the author-PK conformance check
"is owned by the injection resolver `resolve_create_table_policy`, which the server
runs over the operator's `EffectivePolicy` BEFORE this load."

And the decisive one, which the codex job found before it stalled and which neither
I nor the Opus job had looked at - the preview module's own header at
`sql_preview.rs:13-19`, under a section titled "The honest boundary (the load-bearing
design point)":

    DB-INDEPENDENT ops - `createTable`/`dropTable`/`addColumn`/... render their REAL
    SQL: their `up`/`template` is fully determined offline

`createTable` is named in that list. So the module states that what it renders for a
create-table IS the real SQL, and today it is not - it omits the policy-injected
columns and indexes apply will create. The behaviour contradicts the contract written
at the top of the file implementing it. That settles question four: not deliberate,
and not merely undocumented, but documented in the opposite direction.

The decision is to resolve, placed engine-side rather than in the addon so the Rust
API stops diverging too. Not the show-both option: `plan --sql` output is piped to
files and pasted into change reviews, so emitting two executable-looking `CREATE
TABLE` blocks invites running the wrong one, and the operator already has the
migration source for author intent.

Recorded as unverified and required before this lands: whether
`packages/zero-migrate-cli/tests/host/sql-preview-parity.test.ts` still passes once
preview resolves. It runs under the injecting charter, its assertions are substring
checks on author-declared facets, and the surviving-resolution argument is an
inference from the fold logic that nobody has run. Its comment block also states that
preview does NOT resolve, which becomes false and has to be rewritten rather than left
as a stale explanation of a behaviour that no longer exists.

### F37 correction - the second opinion did not stall, and it changed the answer

The entry above says the codex job "STOPPED WITHOUT A VERDICT" and that the decision
was therefore one opinion plus independent checking. Both halves are wrong, and the
way they are wrong is the same error this review keeps finding.

The job had a `## Recommendation` section the whole time, roughly eight thousand
lines into an output file that is mostly tool transcript. I searched the tail, then
searched the section headings for verdict-shaped words, found nothing, and concluded
absence. The heading was titled plainly and my pattern excluded it. That is the
truncation error in a third costume - not `head -20`, not a `--lib` filter, but "I
looked at the end and at the headings I expected". The enumeration source was my
search pattern.

It matters because the missed opinion CONTRADICTED an instruction I had already
given the implementation agent. I told it to run the resolve AFTER `validate_ir`.
The second opinion showed it must run BEFORE, and cited the reason:
`crates/zero-migrate/src/model/validate.rs:9516-9529` is an existing test that
resolves first and then asserts `validate_ir` succeeds, with the message "a partial
index on `deleted_at` must resolve system fields". `deleted_at` is charter-injected,
so an index predicate over it only validates once injection has happened. Verified by
me by reading, along with the apply path's own order at
`crates/zero-migrate-node/src/lower.rs`, which resolves at :206 and validates inside
`load_and_lower_guarded` afterwards. The correction was sent to the running agent.

So the two opinions did converge on the decision - resolve, engine-side, in
`render_ir_envelope_rendered` - and the second one corrected the implementation
detail the first got wrong. The dual-opinion process worked exactly as intended, and
I nearly discarded the half that paid for it.

Two further things the second opinion supplied that the first did not:

It found stronger intent evidence. `docs/proposals/id-system-design.md:1463-1465`
states an injected ID must appear exactly in the resolved plan AND PREVIEW, and
`docs/cli.md:38-43` calls plan output "the SQL that would be applied".

And it contradicts the first on blast radius. The first said `lint` is unaffected
because its policy loader defaults to a no-inject charter. The second says `lint`
calls `previewSql` even WITHOUT `--explain` and folds preview failure into its
verdict at `packages/zero-migrate-cli/src/cli.ts:777-805`, so policy-shape
collisions that currently fail only at apply could begin failing lint earlier. I
have verified NEITHER version; the implementation agent has been told to establish
which is true and report it, because if the second is right it is a user-visible
behaviour change that needs stating rather than discovering.

### F37 closed - the preview now renders what apply runs, and two mutations survived

The fix runs `resolve_create_table_policy` inside `render_ir_envelope_rendered`,
covering both public entries with no bridge change. Order is parse, resolve,
validate, lower.

The end-to-end proof is the part worth keeping: `plan --json` previewed 8 columns
and 3 indexes, the migration was then applied, and `information_schema` read back
the identical 8 columns and 3 indexes plus the primary key. The preview shows what
apply runs, demonstrated against a live database rather than argued from the code.

**Two of three mutations survived the first round of tests**, and one of them was my
own instruction.

M2 moved the resolve to AFTER `validate_ir` - the ordering my original brief
specified before a second opinion corrected it. It survived ALL 23 tests, including
the new ones written for this change. So had the correction not arrived, the wrong
order would have shipped green, and the test suite written specifically for this
feature would not have caught it. The agent closed it with
`preview_resolves_before_it_validates`, a partial index predicate on the injected
`deleted_at`, which fails under M2 with `column "deleted_at" does not resolve on the
enclosing target table "notes"`.

M3 hardcoded `"public"` instead of `opts.default_schema` and also survived, because
every existing test previews under `public`. Closed with
`preview_resolves_against_the_requested_default_schema` using a schema-scoped inject
charter.

That is the three-mutation rule paying for itself twice in one change. A single
mutation would have reported the work complete.

**The lint disagreement is resolved and codex was right.** I verified the mechanism
myself: `packages/zero-migrate-cli/src/cli.ts:788-798` calls `previewSql` with no
`args.explain` guard - that flag only decides whether the rendered `sql` appears in
the output - and the verdict is `ok: verdict.ok && previewError === undefined`. So a
preview failure fails lint. Under an injecting charter, lint now rejects a migration
it previously passed, without `--explain`:

    lint collide: fail (1 ops)
      postgres: previewSql: envelope[0] failed to render: table-shape resolve for IR
      envelope: createTable "gadgets" declares column "created_at", which collides
      with an injected system column

That is a user-visible behaviour change and it is documented in `docs/cli.md` rather
than left to be discovered. Without `--policy` the default no-inject charter makes
the resolver early-return and output is byte-unchanged, so the first opinion's claim
was true of the default and false of the case that matters.

Idempotence was confirmed rather than assumed, by reading
`resolved_create_table_matches_inject` and by a new test asserting byte-identical
preview across all three dialects for raw and pre-resolved spellings of the same
envelope. The whole-file goldens already pre-resolve their fixtures, so the change is
a double-resolve there and a no-op; all three pass untouched.

Nothing pins the old output: the CLI tests use a `CREATE TABLE` regex and the parity
test uses substring checks. This IS a machine-readable change for `plan --json`
consumers, mitigated only by the project being 0.1.0.

Two things surfaced and not fixed here. `render_ir_envelope_sql_statements` has no
production caller - its doc calls it "the DB-free lint seam" but lint reaches
`render_ir_envelope_sql` through `previewSql` instead, so only tests call it, and the
comment oversells it. And `crates/zero-migrate-node/index.d.ts` drifts on every
`napi build` over one line, `[StatusReply]` versus its qualified form, meaning the
committed file is stale against the current napi codegen. Both are pre-existing.

### F38 - the addon can now say which build it is, and the types file is gated

Two coupled items. The addon exposed only `irVersion()`, so a consumer resolving
the `.node` by absolute path could not tell which artifact it had - the exact
situation that cost a downstream project an hour when they could not distinguish a
pre-fix from a post-fix build. And `crates/zero-migrate-node/index.d.ts` is napi
codegen output that is COMMITTED and shipped in the package `files`, so a consumer's
types come from the checked-in copy rather than from any build, with nothing
comparing the two.

`buildInfo()` returns `{ version, irVersion, sourceDigest }`. The digest is a sha256
over committed bytes only - `Cargo.lock`, the manifests, and every file under
`crates/*/src` - sorted by workspace-relative path.

MY PREMISE WAS WRONG ABOUT THE DRIFT DIRECTION and the correction matters. I recorded
that codegen emitted the short `[StatusReply]` and the committed file was correct.
The opposite is true, verified by me: `git show HEAD:crates/zero-migrate-node/src/
bridge.rs` already carries `[\`StatusReply\`](crate::wire::StatusReply)`, so the
COMMITTED `index.d.ts` was the stale side. Fixing it means accepting generated
output, not editing Rust.

What was rejected is the more useful record. A wall-clock timestamp, hostname,
absolute path, or git dirty flag are all nondeterministic and would make the gate
permanently red - the trap this was designed around. The git HEAD SHA was rejected
for a sharper reason: the downstream consumer loads a WORKING TREE by absolute path,
which is precisely the case where HEAD lies about what actually compiled. The crate
version alone is deterministic but stays `0.1.0` across a pre-fix and post-fix build,
which is the incident itself; it is kept as a field, not as the identity.

Determinism was verified rather than assumed, and I re-ran it myself: the digest
value appears zero times in `index.d.ts` and zero times in `index.js`, and once in
the compiled `.node`. Only the TYPE reaches the gated file; the value is folded in at
compile time and read at runtime. Two forced rebuilds, each a genuine recompile, both
produced `index.d.ts` sha `acb7e210170f7541`, identical to the baseline.

The gate is `git diff --exit-code -- crates/zero-migrate-node/index.d.ts`, placed
after the release-addon build. It is the first `git diff --exit-code` in this
workflow - `grep "git diff" .github/workflows/ci.yml` previously exited 1 - so it
establishes the pattern rather than matching one. Its comment states the scope
explicitly: `index.d.ts` only, and `index.js` is regenerated by the same command and
is NOT gated.

The gate was proven to catch two different failures, not one. A hand-edited return
type fails it, and so does a REMOVED export: deleting the `#[napi] buildInfo` and
rebuilding drops the declaration and the JS gate fails with `addon.buildInfo is not a
function`. A single mutation would have proven only that the text comparison works.

One hazard recorded for whoever reads the step next: it is cwd-sensitive. The agent
hit a real false pass running it from inside `crates/zero-migrate-node`, where the
pathspec does not resolve. The workflow default is the repo root so CI is correct,
but a local run from the wrong directory reports success.

A BASELINE OF MINE WAS UNDER-SPECIFIED, and this is my error rather than a change.
I have been recording the host suite as 95 tests / 90 pass / 0 fail / 5 skip. That is
what it produces with ONLY `ZERO_MIGRATE_MYSQL_URL` set. With BOTH database URLs it
is 95 / 95 / 0 / 0, which I re-ran and confirmed. The five skips were the PG-gated
arms all along. The number was never wrong, it was quoted without its environment -
the same failure I wrote the "always name the env" rule about.

### F39 - the committed bundle is gated, and the design I adopted would have destroyed an oracle

The gate is one CI step comparing the regenerated `dist/embedded-recorder.js` against
the committed copy. That file is the ONE thing under `packages/zero-migrate/dist/`
that is force-tracked, so a consumer loading this tree by absolute path reads the
checked-in bytes and nothing compared the two.

THE PLAN WAS WRONG AND THE AGENT WAS RIGHT TO REFUSE HALF OF IT. I had adopted a
suggestion - switch the three tests to import from `src/` so one gate owns the
artifact comparison - and endorsed it as better than my own first idea. It would have
created twenty unfalsifiable assertions.

`packages/zero-migrate/src/embedded-recorder.ts` is a PURE RE-EXPORT: seventy-one
lines whose body is a single `export { ... } from "./ops.js"`. So the tests' two
recorders would become the same objects. Verified by me, running it:

    src/ops.table === src/embedded-recorder.table : true
    src/ops.table === dist/embedded-recorder.table: false

Those tests re-author the same migrations through `src/ops.ts` AND through the built
artifact, then assert the recorded ops match. That is a differential oracle, and it
requires the two sides to be DIFFERENT objects. Importing both from source would have
made roughly twenty `assert.deepEqual(publicOps, engineOps)` calls compare a thing to
itself - category (a) of the taxonomy, unfalsifiable for any value, which is the shape
this whole review exists to find. I would have shipped it while quoting the taxonomy.

The premise was also partly false. I recorded the dist import as "accidental
coverage". It is a working behavioural staleness detector: mutating `src/ops.ts`
without rebuilding fails twenty tests, every one a parity oracle.

So the tests stay as they are and the gate is ADDITIVE. The division of labour is
written into the step's comment: the tests catch drift that changes recorded output,
the gate catches drift that does not. I reproduced the justifying case myself - a
comment-only edit to the committed artifact makes the gate exit 1 while the package
suite passes 220 of 220. Neither mechanism subsumes the other.

Determinism was the precondition and was verified before the gate was trusted: two
forced rebuilds and the committed copy are three-way byte-identical at sha256
`129cd32d396cdf2863bd13a0ae2ffec7c80b66568a53055f9ac8261191b77bf7`.

Two corrections to my own brief, both found by reading rather than assumed. THREE
tests import the artifact, not four - `golden-parity.test.ts` only mentions it in a
comment. And `.gitignore:15-16` describes the file as "include_str!'d by the crate",
which is false: nothing under `crates/` references it, so its only consumers are those
three tests and the out-of-tree absolute-path consumer. That comment is wrong in the
tree and is left for a separate change.

The cwd hazard carried over from the previous gate was reproduced rather than assumed:
with drift present, the identical command run from `crates/` returns exit 0, a false
pass. The step comment says it must not be moved under a `working-directory`.

### F40 - the schema-leak item, measured instead of estimated

Every number I had for this item was a source-text count standing in for a runtime
quantity. Measured against a live server, the item is BIGGER IN SCOPE and MUCH LESS
URGENT than filed, and the fix I was about to write would have missed most of it.

THE INSTRUMENT. `log_statement = 'ddl'` on the container plus before/after snapshots
of `pg_namespace`, reset afterwards. An event trigger was considered and rejected for
a reason worth recording: creating one would have added a schema to the very catalog
being counted. The instrument must not perturb the population it measures.

WHAT A GREEN RUN ACTUALLY DOES. Rust suite 2211 passed: 209 `CREATE SCHEMA`
executions, 88 distinct schemas. Host suite 95 passed: 97 executions, 34 distinct.
Total 306 executions, 122 distinct schemas, and ZERO survivors. User-schema count 14
before and 14 after with byte-identical name lists.

THE FINDING THAT CHANGES THE FIX. Most schema creation is not in the tests at all.
`crates/zero-migrate/src/apply/journal.rs:446` issues
`CREATE SCHEMA IF NOT EXISTS {meta}` on every apply - verified by me - which accounts
for 159 of the Rust run's 209 executions and every `*_migrations` meta schema. A guard
scoped to `CREATE SCHEMA` in TEST SOURCE would miss every meta schema, and those leak
paired with their project schema. My enumeration source was test files; the property
belongs to the engine as much as to the tests.

THE PREMISE HOLDS, and now mechanically rather than by assumption. A temporary panic
after schema creation in `uuid_generation.rs` left
`uuid_v4_2152600_1786103915846099765_0` in `pg_namespace`, user-schema count 14 to 15.
The mechanism: `grep -rn "impl Drop" crates/zero-migrate/tests/` returns ZERO, verified
by me. Cleanup is a plain statement at the end of each test body, and a panic unwinds
past it. Probe restored byte-for-byte, sha256 identical, `git diff` empty.

MY COUNT WAS WRONG IN BOTH DIRECTIONS. Of the 19 occurrences, FOUR create nothing -
`guard_security.rs` is a pure in-process guard suite with zero live-DB markers,
confirmed by grep and by the DDL log containing none of its schema names. And there
are FIVE helpers, not the two I found: the largest is
`crates/zero-migrate/tests/pg_scenarios.rs:73 ensure_project_schema` with 28 callers,
more than my two known helpers combined. So 19 occurrences are 15 executing sites are
50 executions.

The cross-check is what makes those numbers trustworthy: static analysis predicted 19
plain non-`IF NOT EXISTS` executions for the Rust run and the DDL log observed 19;
predicted 17 for the host run and observed 17. Two independent methods agreeing
exactly.

The host suite is genuinely uncovered - all TWELVE occurrences execute, none is an
assertion on SQL text, so my upper bound was the actual count. It stays clean today
only because every host site already has `try`/`finally`. The Rust side is where that
equivalent is missing.

URGENCY, honestly. Both suites are green and leak zero. The panic path fires only when
a test is already broken, so this is hygiene for the debugging loop rather than a
correctness or CI bug. Its real cost is visible in the BEFORE snapshot: THIRTEEN stale
schemas from earlier failed runs - `proj_*` and `meta_*` names pointing at
`pg_scenarios.rs`, `pg_declarative.rs`, and `truncated_identifier_pg.rs` - slowly
dirtying a shared dev database. That is standing evidence the leak is real, just not
observable on a passing run.

NOT MEASURED, and the gaps are named rather than hidden: what a NATURALLY failing test
leaks, as opposed to one synthetic panic; MySQL; and the `zero-migrate-guard` and
`zero-migrate-node` crates' own occurrences, which were outside the questions asked.

### F41 - the unreferenced preview entry is retained, and it is one of three not one

The claim was that `render_ir_envelope_sql_statements` has no production caller. It
is CONFIRMED, with the over-counting grep run untruncated across the whole tree:

    $ grep -rn --binary-files=without-match "render_ir_envelope_sql_statements" . \
        --exclude-dir=target --exclude-dir=node_modules --exclude-dir=.git

Five hits total - a prose mention in this log, the re-export at
`crates/zero-migrate/src/lib.rs:337`, the definition, and two `#[cfg(test)]` tests in
its own file. Zero in `crates/zero-migrate-node/`, zero in
`packages/zero-migrate-cli/src/`, zero in the integration suite. A bare identifier
over-counts, so a zero result is the sound direction for proving something unreached.

THE DISPOSITION IS RETAIN, NOT REMOVE, and the reason is the part the original aside
missed. The function is `pub` and re-exported at the crate root, and
`docs/embedding.md` documents this crate as a path dependency for out-of-tree hosts.
Whether an out-of-tree consumer calls it is UNFALSIFIABLE from inside this tree, and
that asymmetry is itself the argument: a claim that cannot be checked from here should
not be the basis for deleting a published surface.

It is also not uniquely unreached. Verified by me: `render_plan_sql` and
`render_set_sql` are re-exported on the same line and have ZERO references in the
addon and CLI sources; `render_ir_envelope_sql` is the only member of that exported
family a production caller reaches. Removing one of four would not be a coherent
cleanup. Removal would also orphan `wrap_mysql_statements`, whose only two references
are this function and one test.

The doc comment was FALSE and is the real defect either way. It called itself "the
DB-free lint seam"; lint reaches `render_ir_envelope_sql` through the addon's
`previewSql` verb instead. It now says what the function does not do, including a
hazard worth having in writing: an op that degrades to a `[runtime-resolved]` label in
the human preview has NO entry in the statement stream at all, so a short stream is
not evidence of a short plan.

A CORRECTION TO THIS LOG. I have written `plan --sql` and `validate --explain`
repeatedly in earlier entries and in commit messages. Neither name exists. Verified by
me: a grep for `--sql` in `packages/zero-migrate-cli/src/cli.ts` returns nothing, and
`cli.ts:334` reads "flag --explain is only valid with lint". The accurate statement is
that `plan` renders SQL as part of its normal output and `lint --explain` includes the
rendered SQL in its report. Earlier entries naming the flags are wrong on that detail;
the findings they describe are unaffected, since the code paths were identified by
file and line rather than by flag name.

### F42 - the end-to-end arm is blind to exactly the break the narrow arm catches

`#39` is closed, and the finding worth keeping is not the fix. It is that the two
arms guarding one escape hatch fail on DISJOINT mutations, so neither is a stronger
version of the other.

THE ROOT CAUSE I FILED WAS WRONG, AND THIS LOG ALREADY SAID SO. I filed `#39` as a
parser bug: `zero-migrate new --json` treating the flag as a positional path. Line
1044 of this file already recorded the opposite - the CLI is behaving correctly and
`--dir=--json` is its documented inline escape hatch. The actual cause is one line of
test setup: `cli.test.ts:159` called `runCli(...)` with no `cwd`, so the scaffold
inherited the test process's directory and landed in the package root. The literal
`--json/` directory that reappeared after every host run was a test writing where it
was told to.

WHAT THE OLD ASSERTION PROVED. `assert.doesNotMatch(inline.stderr, /needs a value/)`
passes when the CLI crashes for an unrelated reason, when it prints nothing, and when
it does not run at all. It is category (a) - unfalsifiable for any value the mechanism
could produce.

TWO MUTATIONS, BOTH RUN BY ME, EACH GATED BEHIND AN ENV VAR SO THE TREE'S DEFAULT
BEHAVIOUR WAS NEVER BROKEN FOR THE CONSUMER THAT LOADS IT BY PATH. Windows 12:38:39 -
12:39:26 and 12:39:42 - 12:40:15 UTC, both restored with an empty `git diff`.

Mutation A - `case "dir"` at `cli.ts:215` silently drops a `--`-leading value:

    not ok 7 - CLI value-taking flags reject a following flag as their value
    ok 8   - CLI scaffold under an inline dash-leading --dir applies to live PostgreSQL

Mutation B - `scaffold()` at `cli.ts:710` emits `export const migration` instead of
`export default`:

    ok 7     - CLI value-taking flags reject a following flag as their value
    not ok 8 - CLI scaffold under an inline dash-leading --dir applies to live PostgreSQL
      zero-migrate: host recorder: the migration module exports no `up()` function
      (named export `up` or `default.up`)

THE LIVE ARM SURVIVES MUTATION A BECAUSE THE BREAKAGE IS SYMMETRIC. `new` and `apply`
read `--dir` through the same parser, so a parser that stops routing the literal value
moves the scaffold AND the apply to the same wrong directory. The migration is still
found, still applied, and the journal row still lands. The end-to-end path cannot see
a fault that displaces every participant equally, and going through a real database
does not help - it is the shared reader, not the database, that is wrong.

A TEST THAT DRIVES MORE OF THE SYSTEM IS NOT AUTOMATICALLY STRICTER. It is strict
about different things. The narrow filesystem assertion is the only one that pins
WHERE the value went; the live arm is the only one that pins that what landed there
can actually run. Neither subsumes the other, which is why both are retained and why
the narrow one stays ungated - making it live-gated would surrender the parser
guarantee on every machine without a database.

WHAT THE CATALOG READ CAN PROVE HERE IS BOUNDED BY THE STUB. `scaffold()` emits an
`up()` whose body is entirely commented out, so a correct apply creates no user
schema at all; `lint` reports `ok (0 ops)`. The catalog-observable positive is the
journal row in `<schema>_migrations.schema_migrations`, and the arm also asserts the
project schema is ABSENT, which is what zero ops means. Authoring real ops into the
file first would test authored ops rather than what the CLI scaffolds, and would
duplicate `e2e-pg.test.ts`.

Host suite moves 95 -> 96 with both database URLs exported, and the stray
`packages/zero-migrate-cli/--json/` no longer appears after a run.

Also observed, and independent evidence for the open schema-leak item: a schema
`probe_len` containing a table `t` is present in the test PostgreSQL and belongs to no
run in this session.

### F43 - the tracked artifact's stated consumer does not exist

`#76` closed. `.gitignore:13-15` explained why one build output is tracked with a
reason that was never true:

    # Derived TS build output (tsup/tsc). The ONLY tracked dist artifact is the
    # engine-embedded recorder (`include_str!`'d by the crate); everything else under
    # dist/ is regenerated by `pnpm build`.

VERIFIED BY ME, with the grep run in the sound direction. A bare identifier
over-counts, so a zero result is the safe way to prove something unreached:

    $ grep -rn "embedded-recorder" --include='*.rs' crates/
    (no output, exit 1)

Every `include_str!` under `crates/` accounted for, none of them this file: a
fixture at `tests/hr_sqlite.rs:15`, two goldens at `render/declarative.rs:9049-9050`,
and `render/lower.rs:13417` including its own source.

THE SECOND HALF OF THE CLAIM IS ALSO FALSE, AND IT IS REPEATED IN FOUR OTHER PLACES.
`tests/ops.test.ts:47`, `tests/column-facets-lockstep.test.ts:8`,
`tests/sequences-exclusion.test.ts:12` and `src/embedded-recorder.ts:4` all describe
this bundle as what "the engine host consumes". Nothing in Rust loads it. There are
47 `recorder` mentions under `crates/`, and reading them shows the recorder the
engine talks to is the JS one that hands ops across the N-API bridge
(`zero-migrate-node/src/api.rs:136`, `wire.rs:157`) - ops arrive already recorded, so
the engine has no reason to read a bundle. The never-compiled `v8-host` source does
not name it either, which was the one remaining candidate.

THE REAL REASON IT IS TRACKED is the one `#73` established and the comment never
said: `package.json:64` runs the package tests with NO build step, while CI builds
first at `ci.yml:100`. So a fresh checkout needs a committed bundle for
`tests/ops.test.ts:64`, `tests/column-facets-lockstep.test.ts:41` and
`tests/sequences-exclusion.test.ts:20` to import, and CI gates the committed copy
against the rebuild at `ci.yml:129`. The comment now says that.

WHY THIS ONE WAS WORTH THE WORDS. A wrong rationale on an ignore rule is not a
cosmetic defect: the next person to ask "can we stop tracking a build artifact?"
reads `include_str!'d by the crate`, concludes a Rust build depends on it, and stops.
The true reason - a test script with no build step - points at a fix (build before
test, or import from `src/`) that the false reason forecloses. A COMMENT THAT NAMES
THE WRONG CONSUMER DOES NOT JUST MISINFORM, IT PROTECTS THE THING IT DESCRIBES FROM
BEING RECONSIDERED.

Ignore behaviour is unchanged, confirmed rather than assumed: `git check-ignore`
still exits 1 for `embedded-recorder.js` (not ignored) and 0 for other `dist/`
output, and the file is still tracked.

### F44 - the second opinion killed a change the first opinion and I both endorsed

`#38` is NOT being implemented as filed, and the reason is the whole value of the
two-opinion rule. The Opus opinion and my own reading CONVERGED on one change: add a
dialect capability and, at the three `DuplicateIndex` sites in `render/fold.rs`, scan
`tables.values()` instead of only `snap.indexes`. Codex was asked the narrow design
question and refused that shape on four grounds. I verified each one myself.

THE CONVERGENT ANSWER WOULD HAVE MADE ONE CASE WORSE, NOT BETTER. During
`Op::CreateTable` the pending snapshot is a local: `build_resolved_table_snapshot` at
`fold.rs:1015` builds `snap`, the inline indexes are folded into it, and only then
does `fold.rs:1047` run `tables.insert(name.clone(), snap)`. VERIFIED by reading the
span. So at the moment the inline-index check runs, the table being created IS NOT IN
THE MAP. Replacing the local scan with a map scan would have ACCEPTED two identically
named inline indexes on one new table - a case the current per-table check catches
today. THE FIX HAD TO BE ADDITIVE, AND BOTH OF US WROTE IT AS A REPLACEMENT.

IT WOULD ALSO HAVE REJECTED VALID INPUT. `TableSnapshot` at `model/snapshot.rs:696`
carries columns, indexes, constraints, runtime options, partition spec, comment and
stored SQL - and NO owning schema. VERIFIED. Ops do carry one: `fold.rs:1011` reads
`schema.as_deref().unwrap_or(project_schema)`. PostgreSQL scopes index names PER
SCHEMA, so an unqualified `tables.values()` scan would refuse `s1.a/shared_idx`
alongside `s2.b/shared_idx`, which PostgreSQL accepts. Worth stating precisely: the
map is ALREADY schema-blind, since `tables.insert` keys on the bare name, so the
blindness is not new - but the REJECTION would be, because today the per-table scope
never asks the cross-table question at all.

THE BREAKING-CHANGE ANSWER IS PATH-DEPENDENT, WHICH IS WHY ASKING IT MATTERED.
Ordinary PostgreSQL apply is safe: `zero-migrate-node/src/lower.rs:397` calls
`ops_without_completed_journal_evidence` (defined at `:812`) and folds only pending
ops, so a completed historical index is not re-judged. Artifact generation is NOT
safe: it replays every envelope, and `render/gen_types.rs:356` calls
`fold_to_field_defs(ops, SqlDialect::Postgres, ...)` with the dialect HARD-CODED.
VERIFIED by reading the call. So `genArtifacts` would newly fail on already-applied
history.

AND A LEGACY HISTORY THAT HITS IT DEMONSTRABLY EXISTS. `render/declarative.rs:8113`
emits `CREATE {unique}INDEX IF NOT EXISTS`. VERIFIED. A second, colliding create is
therefore SKIPPED BY PostgreSQL and the migration journals as successful - so a
project can be carrying a silently-missing index right now, with a green journal. The
widened check would reject that history. It is a real defect being exposed, but it
arrives as a build that used to pass and now does not.

THE CONCRETE WORSENING, which is the question I added precisely because the first two
opinions agreed: a VALID MySQL history with `idx_shared` on two tables would fail
`genArtifacts`, because that dialect-neutral entry point hard-codes Postgres. The
capability cannot be honoured there until the real target dialect is threaded in.
That is now a prerequisite task, not a detail.

WHAT I TAKE FROM THIS. Two independent analyses agreeing is not corroboration when
both are reading the same three call sites; it is the same view held twice. The
objection that mattered came from asking a question whose answer could only be NO -
"name a case where this makes things worse" - and from asking about a path neither of
us had opened. CONVERGENCE IS WHEN A SECOND OPINION IS MOST WORTH BUYING, NOT LEAST.

### F45 - the guard defect was real, on the dialect the ticket did not name

`#77` is fixed, and the ticket was wrong about where it bites. I filed it as "the
probe assumes schema-wide index names, so MySQL silently no-ops". The dialect fact
was right and the consequence was not reachable there.

MYSQL NEVER EVALUATES EXISTENCE GUARDS AT ALL. VERIFIED by me, with the
under-counting grep that makes a hit meaningful:

    $ grep -rn "existence_probe::decide" --include='*.rs' crates/zero-migrate/src/apply/
    backend/postgres/session.rs:443
    backend/postgres/session.rs:766
    backend/sqlite/mod.rs:541

Three call sites, none MySQL. Every `existence_guard` mention under
`apply/backend/mysql/` is an `existence_guard: None` constructor. So the verdict
function cannot be reached with `SqlDialect::Mysql` in production, and the silent
no-op I described cannot happen there.

THE SAME SILENT NO-OP IS REACHABLE ON POSTGRESQL, which does evaluate guards. That
is worse than the ticket, not better. A guarded `createIndex` for a name another
table already owns returned `SatisfiedNoop`: apply reported success, the version was
journaled, and the index was never created.

THE DEFECT GENERALISES DIFFERENTLY THAN I FILED IT. It is not "the scope assumption
is wrong on MySQL". It is that the fallback resolved an index by NAME and ignored
WHICH TABLE owned the hit. For `ifNotExists` that is wrong wherever names are
schema-wide: a hit on another table means the name is taken AND the declared index is
absent, which is the one case that must fail rather than no-op.

THE VERDICT HAD TO BE `FailDrift`, NOT `RunBare`, AND THAT IS NOT A STYLE CHOICE.
`render/declarative.rs:8113` and `:8390` always emit `CREATE INDEX IF NOT EXISTS`, so
letting the statement run bare on a name collision is ALSO silent - PostgreSQL
swallows it. Only a typed refusal surfaces.

MY OWN RED, run from ONE compiled addon with an env-gated restore of the old lookup,
window 13:57:48 - 13:59:57 UTC, residue grep zero after removal:

    not ok 1 - PostgreSQL: a guarded createIndex is refused, not skipped, when
               another table owns the name
      Missing expected rejection: the guarded create must fail closed on a name
      another table owns
    ok 2 - PostgreSQL control: the same guarded createIndex still runs when the
           name is free
    ok 3 - MySQL: a guarded createIndex lands on its own table under a name
           another table also uses

The control passing IN THE RED RUN is what makes it a control rather than a second
symptom. A NEGATIVE RESULT NEEDS A CONTROL THAT WOULD HAVE BEEN POSITIVE.

A MUTATION THAT WAS NOT CAUGHT, AND IT IS THE INTERESTING ONE. Flipping the MySQL arm
of `Capability::SchemaWideIndexNames` to `true` leaves every arm of the suite green.
That is not a gap in the tests, it is a consequence of the first finding: the MySQL
arm governs a code path MySQL never reaches, so nothing end to end can pin it. It is
correct by construction and it is what `#38` will consume. RECORDING AN UNPINNED
VALUE IS BETTER THAN MANUFACTURING A TEST THAT PINS IT THROUGH A PATH THE PRODUCT
DOES NOT USE - that test would pass forever and prove nothing.

WHAT THE MODIFIED SQLITE SUITE ACTUALLY DID, since a changed existing test is where a
fix hides. `git diff --stat` shows 98 insertions and 1 deletion, and the deletion is
an import line reflowed to add `IndexElement`. No assertion was relaxed.

Counts moved and both are explained: workspace 2211 -> 2212 across the same 74
targets (the new SQLite arm in an existing target), host 96 -> 99 with both database
URLs exported (two PostgreSQL arms and one MySQL arm in a new file).

### F46 - the premise I gave the agent was wrong, and the defect was live

`#78` is fixed. I filed it as a LATENT problem - "no fold rule currently diverges by
dialect, so an honest end-to-end RED may be impossible today" - and told the agent to
say so plainly if it could not construct one. It could, because that premise was
false.

A FOLD RULE ALREADY DIVERGES BY DIALECT. VERIFIED by me: `selected_dialectal_leg` at
`render/fold.rs:442` matches on the dialect and returns a DIFFERENT op sequence for
Postgres, SQLite and MySQL; `fold_to_field_defs` reaches it through
`flatten_dialectal_ops(ops, dialect)` at `fold.rs:3245`. The public authoring DSL
emits exactly that op - `dialect({ pg, mysql })` in `packages/zero-migrate/src/ops.ts`.
So `Op::Dialectal` has always been dialect-sensitive, and it flows straight into
artifact generation. The defect needed no future capability to bite.

I ALSO NAMED HALF THE DEFECT. There were TWO hard-coded sites, not one:
`gen_types.rs:356` drives `schema.runtime.json`, and a second at `:475` drives
`env.db.ts`. My ticket cited only the first.

THE HARD-CODE WAS DELIBERATE AND ITS JUSTIFICATION WAS TOO NARROW, which is the third
option I offered and the one that turned out true. The old comment read "the FieldDef
map is dialect-neutral for type recovery" - accurate about `ir_column_to_field`, and
silent about leg selection happening in the same fold.

MY OWN RED, run from ONE compiled addon with an env gate forcing BOTH fold sites back
to Postgres, window 14:41:55 - 14:44:21 UTC, residue grep zero after removal:

    not ok 1 - genArtifacts folds the MySQL target's own dialectal leg
               (matches the live MySQL catalog)
      the mysql schema.runtime.json field set equals the live column set
        [ 'label',
      +   'pg_only'        <- what the artifact claimed
      -   'mysql_only'  ]  <- what the MySQL database actually has
    ok 2 - genArtifacts folds the Postgres target's own dialectal leg

The Postgres arm passing IN THE RED RUN is the control. The expectation is read from
`information_schema.columns` on the live server rather than from a fixture, so the
oracle is the database.

THE MUTATION THAT ESCAPED IS THE ENUMERATION LESSON AGAIN. Forcing the SECOND site
(`authoring_tables_from_ops`) to Postgres was NOT caught by the first version of the
test, because that test read only `schema.runtime.json`. `genArtifacts` CO-EMITS TWO
artifacts, and a test that reads one of them cannot see a defect in the other. The
test now asserts both against live truth. A TEST ENUMERATES ITS OUTPUTS, AND AN OUTPUT
MISSING FROM THE ENUMERATION IS UNGUARDED HOWEVER GOOD THE ASSERTION OVER THE OTHERS.

TWO THINGS I WORRIED ABOUT AND WAS WRONG ABOUT, recorded because the worry cost real
attention. `render/fold.rs` appearing in the diff looked like `#38` arriving through
the back door; it is ONE LINE, in a test, adding the new argument. And
`tests/gen_artifacts_byte_identical.rs` is a determinism oracle whose modification I
flagged as the highest-risk hunk; it gained 28 lines and lost 9, every deletion a
signature update or a reworded doc line, with `assert_eq!(generated.runtime_json,
manual.runtime_json)` untouched. It also gained a paragraph saying what it does NOT
cover: both arms pin Postgres, so cross-dialect divergence is the live test's job.

THE BREAKING CHANGE IS MINE, NOT THE AGENT'S, and it was offered for veto.
`GenArtifactsSource.dialect` is REQUIRED with no default. An optional field defaulting
to Postgres would reinstate the exact defect being fixed - silently generating a MySQL
project's artifacts under Postgres rules. VERIFIED: `genArtifacts` has zero in-repo
production callers, so the only consumer affected is the downstream project that loads
this tree by absolute path, and a TypeScript error at their build beats artifacts
naming columns their database does not have.

TWO PRE-EXISTING HOLES FOUND AND DELIBERATELY LEFT. `runtime_metadata_from_ops`
(`gen_types.rs:224`) iterates raw ops and never flattens dialectal legs on ANY dialect,
so an index authored inside a `dialect()` leg is missing from `schema.runtime.json`
even for Postgres. And `resolve_create_table_policy` (`model/table_shape.rs:247`)
walks top-level ops only, so a `createTable` nested in a leg is never policy-resolved -
the same shape as the `dropConstraint` hole at line 1167 of this log. Both are
orthogonal to the hard-code and both change Postgres output, so neither belongs in
this commit.

Host suite 99 -> 101 with both database URLs exported; the two new arms are the MySQL
and Postgres halves of the live test. Workspace unchanged at 2212 across 74 targets.

### F47 - a correction to F43, and a tag vocabulary the sweep never enumerated

Two errors of mine, found while closing the follow-up F43 left open.

F43 SAID FOUR FILES REPEAT THE FALSE CONSUMER CLAIM. THREE DO. I listed
`packages/zero-migrate/src/embedded-recorder.ts:4` among them. Reading it, that file
says the OPPOSITE of what I recorded - it correctly names its real consumers:

    // This module is compiled by `tsup` into ONE self-contained ESM artifact
    // (`dist/embedded-recorder.js`) exposing the FULL recorder surface. The SDK's
    // recorder-internal tests import it directly
    // (`tests/{ops,sequences-exclusion,column-facets-lockstep}.test.ts`)

The five genuine sites were `tests/ops.test.ts:47`,
`tests/column-facets-lockstep.test.ts:8` and `:30`, and
`tests/sequences-exclusion.test.ts:12` - three files, five occurrences, all now
saying which suite imports the bundle rather than inventing an engine that reads it.
The `column-facets-lockstep.test.ts:30` replacement also states what the oracle does
NOT prove, since "artifact-identity" is easy to read as "the engine consumes this".

I FOUND THE WRONG FILE BY GREPPING FOR THE PHRASE AND THEN TRUSTING MY OWN EARLIER
NOTE FOR THE FIFTH. The note was the enumeration source, and it was wrong.

THE SECOND ERROR IS LARGER. Opening `embedded-recorder.ts` to check the first one
surfaced a phase tag on its line 1 - `(DSL redesign S0.5)` - which the schedule-tag
sweep of `#10` and `#69` should have caught and did not. An over-counting grep for
the `S<n>.<n>` form finds SEVEN surviving sites:

    crates/zero-migrate/src/model/dialect_table.rs:9,10       (GENERATED)
    packages/zero-migrate/src/generated/dialect-table.ts:11   (GENERATED)
    packages/zero-migrate/tsup.config.ts:27
    packages/zero-migrate/src/embedded-recorder.ts:1,23
    packages/zero-migrate/src/ops.ts:427

THE SWEEP ENUMERATED A TAG VOCABULARY, AND A FORM OUTSIDE THAT VOCABULARY WAS
INVISIBLE HOWEVER THOROUGH THE SWEEP WAS OVER THE FORMS IT KNEW. Same axis as every
other detector in this log; the enumeration source here was my own idea of what a
schedule tag looks like.

THEY ARE NOT FIXED IN THIS COMMIT, AND THE REASON IS WORTH RECORDING. Two of the
seven are in files headed `GENERATED FILE - do not edit by hand`, both derived from
`crates/zero-migrate/dialect-support.toml`, which carries the tags at its own lines
2, 17, 21, 29 and 30. Editing the outputs would be overwritten on the next
`pnpm --filter zero-migrate gen:dialect-table`, and
`crates/zero-migrate/tests/dialect_table_faithfulness.rs` asserts output matches
sidecar - so a source edit without regeneration turns that test red, which is the
safety property working rather than an obstacle. That is a regenerate-and-verify
change and belongs in its own commit.

AND THOSE LINES CARRY A SECOND, NON-COSMETIC DEFECT. The sidecar says at :29-30
"S0.1 is ADDITIVE - no consumer reads the table yet (that is S0.2)". VERIFIED FALSE
for Rust: `crates/zero-migrate/src/model/op_support.rs:38` calls
`crate::model::dialect_table::lookup(kind, variant)` in engine source, not a test.
VERIFIED STILL TRUE for TypeScript, with an over-counting grep returning zero: no
file in the repo outside the generated one references `generated/dialect-table`,
`DIALECT_TABLE` or `dialectTable` on that side. One sentence covering both sides is
now half wrong, so the replacement has to speak about each separately. Recorded on
`#70` so the tag and the false claim get fixed in one pass rather than the lines
being touched twice.

Package suite unchanged at 221 tests / 220 pass / 0 fail / 1 skip.

### F48 - #38 is rejected as filed, and one of my own objections was backwards

Two independent opinions, and this time THEY DISAGREED - which is where the value
was. Both refused to widen the fold. They differed on what follows, because they were
answering different questions: codex answered the one I asked ("is there a coherent
FOLD formulation?" - no) and the Opus opinion questioned the placement instead.

MY OBJECTION (c) WAS FACTUALLY WRONG, AND IT WAS WRONG IN THE DIRECTION THAT MATTERED.
I asserted across three separate dispatch briefs that after renaming `old` to `new`,
`old_pkey` lingers, so recreating `old` collides - and that this argued FOR a
whole-snapshot post-mutation invariant. VERIFIED BY ME against live PostgreSQL 18:

    CREATE TABLE v_c.old (id int PRIMARY KEY, x int);
    ALTER TABLE v_c.old RENAME TO new;
    CREATE TABLE v_c.old (id int PRIMARY KEY, x int);   -- SUCCEEDS

     tbl |    idx
    -----+-----------
     new | old_pkey
     old | old_pkey1

PostgreSQL AUTO-UNIQUIFIES implicit constraint names. Only an explicitly named
constraint errors, and zero-migrate renders a single-column PK INLINE, hence
auto-named: `should_render_table_pk` (`render/declarative.rs:3635`) returns true only
when the PK has more than one column. So the invariant I was arguing for WOULD HAVE
REJECTED A HISTORY POSTGRESQL ACCEPTS. The objection did not argue for the post-
mutation shape; it argued against it.

OBJECTION (b) DISSOLVES TOO. `drift::snapshot_schema` (`drift.rs:622`) takes one
project schema and filters every query on it, so a `SchemaSnapshot` is single-schema
by construction; same-named tables in two schemas already collide as `DuplicateTable`
at `fold.rs:1003`; and `effective_schema` is read at exactly one site (`fold.rs:1011`)
only to build FK definitions. The cross-schema false positive I feared is unreachable,
because a multi-schema fold is already incoherent for reasons that predate this check.

Objection (a) still binds exactly as stated.

THE REAL DEFECT IS ON A PATH #77 NEVER TOUCHED, AND IT IS THE SAME FAILURE MODE.
VERIFIED by me:

    lower.rs:4368     if let Some(g) = guard { probe = Some(GuardProbe::Index { ... }) }
    declarative.rs:8113   "CREATE {unique}INDEX IF NOT EXISTS {} ON ..."

The rendered statement carries `IF NOT EXISTS` UNCONDITIONALLY, but the decision
machinery is stamped ONLY when the author wrote a guard. So an UNGUARDED
`op.createIndex` on a name another table owns is silently skipped by PostgreSQL,
journaled green, and the index never exists - which is precisely what F45 fixed, on
the branch F45 did not cover. `existence_probe.rs:504` says as much in its own
comment. My #77 fix closed the guarded path and left the unguarded one open, and I
did not notice because the ticket framed the whole question around guards.

WHY THE FOLD IS THE WRONG HOME, stated as the reason rather than the conclusion. At
apply time the base is the LIVE CATALOG, which is single-schema by construction, and
history is never replayed - so the retroactive-failure problem that blocked #38 simply
does not arise. `genArtifacts` stays untouched, and no project's build can break on
history it cannot change. The fold-level version would also produce a STRICTLY WEAKER
end-to-end test: a fold rejection fires before any SQL runs, so the post-state is
identical to a run that never happened, and there is no catalog to read back.

CODEX'S THREE STRUCTURAL FINDINGS STAND, all verified by me, and they are why the
alternatives fail rather than merely being unattractive: `fold_ops_onto` (`fold.rs:872`)
receives no journal or envelope provenance; `GenArtifactsReply` (`wire.rs:473`) is
`{ok, env_db_ts, runtime_json, error}` with NO WARNING CHANNEL; and `api.rs:170`
flattens every envelope into one `Vec<Op>` before folding, discarding boundaries. So
"scope to pending ops" and "warn at generation" are not tuning choices, they are
unimplementable without new plumbing.

BOTH OPINIONS NAMED A CASE WHERE THEIR OWN RECOMMENDATION IS WORSE, which is the
question that has now paid off three times. Codex: a fresh disaster-recovery database
has no completed journal evidence, so replaying a legacy history hard-fails at the
second migration even though production journaled it green. Opus: a MySQL-authored
history applied to PostgreSQL currently degrades silently but DEPLOYS, and would
instead wedge MID-BATCH, because existence-guard verdicts are evaluated in the second
pass inside `execute_pending` after earlier migrations have already committed - and
the remedy changes checksums the applied prefix will then refuse.

DECISION: #38 as filed is rejected, not deferred. Widening the fold is the wrong
change on three counts and one of my own stated reasons for it was inverted. The
defect is real and moves to the unguarded lowering path.

### F49 - the sweep could not see the file, because grep cannot read it

`#70` is fixed, and the reason two cleanup passes missed these tags is not
carelessness. It is that the file holding them IS INVISIBLE TO GREP ON THIS MACHINE.

`grep` here is ugrep 7.5.0 aliased over the name. Demonstrated:

    $ grep -Fn "S0.1" packages/zero-migrate/scripts/gen-dialect-table.mjs
    (no output, exit 1)
    $ sed -n '1p' packages/zero-migrate/scripts/gen-dialect-table.mjs
    // Generate the single-source dialect-support table (DSL redesign Phase 0, S0.1).

A FIXED-STRING search returning no match on text `sed` prints verbatim. The cause:
that file contains a NUL byte at offset 4393, ugrep classifies a NUL-containing file
as binary, and reports nothing rather than erroring. Exactly two tracked files in the
repository have this property - the dialect-table generator and its drift test - and
they are precisely the two that `#70` was about. Filed as `#83`, with the enumerating
command.

SO MY "SEVEN SITES" COUNT WAS AN UNDERCOUNT, and not by a vocabulary this time. The
real total is fourteen: seven visible, plus six in the generator and one in the drift
test that no search of mine could reach. Reading them needs `tr -d '\0' < FILE | grep`.

THE FALSE CLAIM LIVED IN THE GENERATOR, WHICH IS WHY EDITING THE SIDECAR DID NOTHING.
I corrected `dialect-support.toml` first and regenerated; `git status` showed the two
generated artifacts UNCHANGED. The header they carry is not copied from the sidecar -
it is a template literal at `gen-dialect-table.mjs:128-129` (Rust) and `:216` (TS).
That is what `#70`'s own title said, and I had not been able to confirm it because the
file could not be searched.

TWO MORE DEFECTS ON THE SAME LINES, both now fixed. The generator's header named its
own output as `sdks/migrate/src/generated/dialect-table.ts` - a PRE-RENAME PATH; it
writes to `packages/zero-migrate/`. And it asserted the Rust table is "NOT wired yet",
which `crates/zero-migrate/src/model/op_support.rs` refutes by calling
`dialect_table::lookup`. A downstream project had warned me their vendored copy of
this generator had fallen behind mine and emitted a stale path; the same staleness was
in my own copy, in the file I could not grep.

WHAT I ALSO CHECKED, BECAUSE A GENERATED-FILE CHANGE IS EASY TO GET WRONG: the
regenerated `dialect_table.rs` still carries `#[rustfmt::skip]` at `:65` (the same
downstream project warned that a generator omitting it would silently break
`cargo fmt --check`); both regenerated artifacts are header-only diffs, 6 insertions
and 3 deletions between them, with no row content moved; and neither generated file
contains a NUL, so the byte is not being emitted.

THE LESSON IS NOT ABOUT TAGS. Twice today I concluded "absent" from a grep that had
not looked - once because my note was the enumeration source and was wrong, once
because the tool silently declined to read the file. A SEARCH THAT CANNOT READ A FILE
AND A SEARCH THAT FINDS NOTHING IN IT ARE INDISTINGUISHABLE FROM THE OUTPUT. The
defence is a positive control: search for something you KNOW is in the file, and if
that comes back empty, the instrument is broken rather than the corpus clean.

fmt 0, clippy 0, workspace 2212 passed / 0 failed across 74 targets, the
`dialect_table_faithfulness` drift test green, package suite 221 / 220 / 0 / 1.

### F50 - the phase-named errors, and the wording was already in the tree

`#68` closed. Four sites, and the two that mattered are runtime errors a user hits:

    apply/backend/sqlite/mod.rs:518  "sqlite backend P2: supersession (squash)
                                      journaling is not yet implemented (P5/P6)"
    apply/backend/sqlite/mod.rs:524  "sqlite backend P2: journal kind '{kind}'
                                      not yet implemented (only 'apply')"

Someone running a squash against SQLite was told about "P2" and "P5/P6" - internal
planning labels that mean nothing outside this repository. The other two were
`render/declarative.rs:6549` and `render/lower.rs:7138`, both carrying the identical
string "renameColumn is not live-rendered for MySQL in render-only Phase 1", plus a
`**P7**` marker in a test comment at `schema/query.rs:3538`.

I DID NOT INVENT THE REPLACEMENT WORDING, AND THAT IS THE PART WORTH RECORDING.
`model/op_support.rs:214` already said the same thing correctly and without a tag -
"renameColumn is render-only for MySQL, not live-rendered" - so a third site had the
right sentence the whole time and the two defective ones just had to match it. The
SQLite pair likewise now match the MySQL backend's house style, which never carried
tags: "mysql backend: precondition evaluation is not yet implemented on MySQL in v1".
When a codebase already contains a correct phrasing of the thing you are about to
reword, use it; a fourth independent phrasing is a fourth thing to keep consistent.

NO TEST PINNED ANY OF THE FOUR. Checked with fixed-string searches for the full
strings and for the substrings "not yet implemented", "journal kind" and
"render-only Phase 1" - and, because of F49, WITH A POSITIVE CONTROL ON EACH FILE
FIRST. `grep -Fc "sqlite"` on the SQLite backend returns 62, so the instrument was
demonstrably reading that file before I believed its silence about tests.

LEFT DELIBERATELY, and the boundary is the point. Three sites keep a tag: the test
function name `p7_id_prefix_decl_emits_single_id_column` (`schema/query.rs:3536`), a
test name at `packages/zero-migrate/tests/ops.test.ts:2171` ending "(P4)", and an
assertion label at `crates/zero-migrate/tests/ir_author_render_parity.rs:950` reading
"C1/P1:". The standing rule is about COMMENTS and about text a USER can see. An
identifier is neither, and renaming a test function is a different decision with a
different blast radius. That question is `#71`, which now has three concrete instances
instead of an abstract prompt.

fmt 0, clippy 0, workspace 2212 passed / 0 failed across 74 targets, package
221 / 220 / 0 / 1, host 101 / 101 / 0 / 0 with both database URLs exported. No count
moved, which is what a pure message change should do.

### F51 - the invisible byte was load-bearing, and I filed it as an accident

Correcting `#83` before anyone acts on it. I found two tracked files that the local
grep cannot read (F49), traced it to a NUL byte in each, and filed the fix as "remove
the NUL - almost certainly an editing accident". I did not read the bytes around it
first. VERIFIED now, and it is not an accident:

    gen-dialect-table.mjs        const id = `${row.kind}\0${row.variant}`;
    dialect-table-drift.test.ts  return `${r.kind}\0${r.variant}`;

It is a COMPOSITE-KEY SEPARATOR, and a correct one. The generator de-duplicates on
`id` via `seen.has(id)`, and no identifier can contain a NUL, so `kind + NUL + variant`
is collision-free BY CONSTRUCTION rather than by convention. Deleting the byte - the
fix I wrote down - would have silently traded a structural guarantee for an assumption,
to make a search tool happier.

THE COST IS STILL REAL, WHICH IS WHY THIS IS NOT SIMPLY "LEAVE IT". Those two files
were invisible to every sweep of this repository, and that is precisely why the tags in
`#70` survived two cleanup passes: the generator emitting them could not be searched.
So both halves are true at once - the byte earns its place, and it costs more than it
is worth.

THE REPLACEMENT HAS TO PRESERVE THE GUARANTEE, NOT JUST THE BEHAVIOUR. Every `kind` and
`variant` in the sidecar today matches `[A-Za-z0-9_]+`, VERIFIED with an over-counting
extraction whose complement is empty, so a printable `|` cannot collide now. But THE
RISK IS THE NEXT ROW, NOT THE EXISTING 92 - a bare swap converts a fact into a habit.
Either pair the printable delimiter with a throw when a field contains it, or use a
non-NUL control character and first confirm the tool actually reads it. Recorded on
`#83` with both options and the reason not to take the third.

WHAT I ACTUALLY GOT WRONG IS SMALLER AND MORE ANNOYING THAN THE USUAL. Not a
measurement, not an enumeration - I saw a byte that explained a symptom, and wrote down
a cause without looking at what the byte was doing. THE SYMPTOM WAS FULLY EXPLAINED AND
THE EXPLANATION WAS STILL NOT THE WHOLE PICTURE. A thing can be both the cause of your
problem and someone else's deliberate solution.

### F52 - write the escape, not the byte

`#83` Part A is done, and the fix is smaller than either option I had written down.

I had framed the problem as "the NUL separator is load-bearing, so replacing it needs
either a printable delimiter plus a throw, or a control character I first confirm the
tool reads". Both were answers to the wrong question. The separator was never the
problem. THE SOURCE ENCODING WAS.

    gen-dialect-table.mjs:105    const id = `${row.kind}\0${row.variant}`;
    dialect-table-drift.test.ts:64  return `${r.kind}\0${r.variant}`;

Those two lines now contain the two-character ESCAPE - backslash, zero - where they
previously held a literal `0x00` byte on disk. VERIFIED before the change with a raw
byte dump: `${row.kind}` followed by `00`, unambiguously a literal.

The escape is ordinary ASCII source that greps like any other line. The byte is what
made ugrep classify the file as binary and report no matches in it. Same string at
runtime, verified rather than assumed:

    node -e 'const esc = `a\0b`; const lit = "a" + String.fromCharCode(0) + "b";
             console.log(esc.length, esc.charCodeAt(1), esc === lit)'
    -> 3 0 true

So the guarantee survives untouched: NUL is still the separator, no identifier can
contain one, `kind + NUL + variant` is still collision-free BY CONSTRUCTION. No throw,
no delimiter audit over the 92 rows and the next one, no test of what the tool does
with U+001F. A source-encoding change with NO semantic change.

WHAT PROVES THERE WAS NO SEMANTIC CHANGE, and it is not the suite being green.
Regenerating produced BYTE-IDENTICAL artifacts - `git diff` on
`crates/zero-migrate/src/model/dialect_table.rs` and
`packages/zero-migrate/src/generated/dialect-table.ts` is empty - and the drift suite's
regenerate-and-diff arm passed, which is the arm that would notice if the de-dup key
had changed meaning. `git ls-files` now reports ZERO tracked files carrying a NUL,
down from two.

THE CREDIT IS NOT MINE. A downstream project carries the identical construct - same
composite key, same de-dup - written as the escape from the start, and their NUL gate
passes on both of their files. They noticed because I sent them a correction saying my
NUL was deliberate and warning them not to copy my "just delete it". They read that,
looked at their own equivalent, and found it solved the same problem a different way.
They had previously recorded those files as "clean" and moved on without noticing why.

THE SHAPE WORTH KEEPING. I had a real constraint (the separator must stay), a real
cost (the file is unsearchable), and I went looking for a THIRD THING that satisfied
both - a different delimiter. The actual answer changed neither: it changed how the
same value is SPELLED IN SOURCE. WHEN TWO REQUIREMENTS LOOK LIKE THEY NEED A
COMPROMISE, CHECK WHETHER THEY ARE EVEN IN THE SAME LAYER. Runtime semantics and source
encoding were never in tension; I had collapsed them into one axis and then negotiated
along it.

`#83` Part B - the gate that fails on a NUL in any tracked text file - is still open and
is now the whole of that task. Zero is the right time to install it: the check is
trivially green today, so the planted-NUL red run is the only thing that would prove it
works, and a gate installed while the tree is dirty proves nothing about either.

Package suite 221 tests / 220 pass / 0 fail / 1 skip, unchanged.

### F53 - a line-scoped filter over multi-line SQL misses 70 percent of this file

Not my finding. A downstream project described nearly shipping a wrong conclusion
because their search was `grep "FROM .*audit" | grep -iE "select|query"` - a two-stage
LINE filter run over SQL whose `SELECT` and `FROM` sit on different lines. The zero it
returned produced a complete-feeling explanation ("nothing reads this table, so its
non-atomicity protects a record with no reader") that survived until they wrote a test
to DEFEND the premise and it failed on the very file they had read.

I measured the same hazard here rather than agreeing with it. In
`crates/zero-migrate/src/apply/drift.rs`, with a positive control first (`grep -Fc "fn "`
returns 45, so the file is being read):

    total SELECT..FROM pairs:  27
    same-line only:             8
    SPANNING LINES:            19

A two-stage line filter sees 8 of 27. IT MISSES 70 PERCENT OF THE QUERIES IN THE FILE,
and reports a number rather than an error while doing it.

THIS IS A THIRD DISTINCT WAY A SEARCH HAS LIED TO ME TODAY, and the three do not share
a mechanism. F49 was the tool declining to read a file at all (a NUL byte, silently
binary). F47 was my own note standing in as the enumeration source. This one is the
SHAPE of the query: line-oriented matching over content whose unit is not a line. A
multi-line string, a formatted SQL block, a wrapped function signature, a doc comment
spanning lines - each is a unit the grep cannot see whole, and each produces an
undercount that looks exactly like a small true number.

NO CONCLUSION OF MINE CURRENTLY RESTS ON ONE, WHICH I CHECKED RATHER THAN ASSUMED. The
absence claims in this log used single-token searches - `existence_probe::decide`,
`embedded-recorder`, `restrict(`, `genArtifacts` - where the token and the line are the
same unit, so line-scoping costs nothing. The hazard is recorded because the NEXT
search over SQL or any multi-line construct is where it would bite, and by then the
number will look reasonable.

THE DEFENCE THEY FOUND IS THE PART WORTH COPYING, and it is not "grep more carefully".
They caught it by WRITING A TEST TO DEFEND A PREMISE THEY BELIEVED - and the test
failed immediately. Their own note is that they would probably not have written it had
the premise felt shakier, which inverts the usual instinct: the conclusions worth
building a guard around are the ones that feel finished, not the ones that feel
uncertain. AN EXPLANATION THAT ACCOUNTS FOR EVERY FACT YOU HAVE IS INDISTINGUISHABLE
FROM ONE THAT ACCOUNTS FOR EVERY FACT.

For multi-line content the practical instrument is a whole-file slurp with a
dot-matches-newline pattern - `perl -0ne` - rather than a pipeline of line filters. Use
it, and keep the positive control either way.

### F54 - the obvious spelling of the NUL gate is not broken, it is INVERTED

Preparing #83's gate, I measured three candidate detectors against a PLANTED NUL before
writing any of them into the tree. The obvious one is the one that would have shipped:

    for f in ...; do LC_ALL=C grep -qU $'\0' "$f" && echo "NUL: $f"; done

Run over one clean file and one file with a NUL in the middle, it reports:

    A says NUL:   clean.txt      <- WRONG
    A says clean: dirty.txt      <- WRONG

BOTH ANSWERS ARE BACKWARDS. Two independent faults compose into an exact inversion:

  1. The shell cannot put a NUL in an argument, so `$'\0'` reaches grep as the EMPTY
     pattern, and the empty pattern matches every file. Every clean file is reported
     as an offender.
  2. F49: this `grep` is ugrep, which silently declines to read a file containing a
     NUL and exits 1. The ONE file that actually has the byte is the one reported
     clean.

Neither fault announces itself. There is no error, no warning, and no exit code that
differs from a normal run.

WHAT THIS WOULD HAVE COST is worse than a gate that does nothing. A gate that matches
nothing looks like a clean tree; this one looks like a tree where every file is dirty
EXCEPT the dirty ones. The first response to 406 flagged files is an ignore list, and
the ignore list is written against the clean files, because those are the ones being
flagged. The gate ends up green, permanently, on exactly the corpus it was built to
catch - and the ignore list is the artifact that makes the green look earned.

TWO DETECTORS SURVIVE THE PLANTED NUL, both verified on the same pair:

    tr -d '\0' < "$f" | cmp -s - "$f"                       # unchanged => no NUL
    perl -0777 -ne 'print "$ARGV\n" if /\0/' -- "$f"        # prints offenders only

Both avoid grep entirely for the NUL itself, which is the point: the instrument that
cannot read the byte cannot be the instrument that looks for it.

MEASURED SCOPE, with the working detector, at this commit: 406 tracked files, ZERO
carrying a NUL - so the gate installs at zero and the planted NUL is the only thing
that can prove it works. The naive filesystem walk remains the wrong scope for a
separate reason already recorded (it reaches the gitignored compiled addon).

THE GENERAL SHAPE, and it is the same one F49 and F53 keep circling from different
sides: I HAD BEEN TREATING "THE CHECK RETURNS SOMETHING PLAUSIBLE" AS EVIDENCE THE
CHECK RUNS. Here the check returned 406 hits and 0 misses, which is a perfectly
plausible-looking pair of numbers for a corpus with a real problem, and every single
one of them was wrong. The only thing that separated it from a correct detector was
planting a byte I already knew the answer for. A GATE'S FIRST TEST IS NOT THE TREE IT
GUARDS - IT IS AN INPUT WHOSE ANSWER YOU FIXED IN ADVANCE.

### F55 - the cost I priced into #81 was not a cost, and three separate things say so

I briefed #81 with an objection I was confident in: stamping an ownership probe on an
unguarded `createIndex` would make one case WORSE. A MySQL-authored history replayed on
PostgreSQL degrades silently today but DEPLOYS; with the probe it would wedge mid-batch,
because guard verdicts are evaluated in the second pass after earlier migrations have
committed, and the remedy - renaming the index - changes checksums the applied prefix
refuses. I offered three answers and said plainly that shipping NEITHER was a real one.

Every load-bearing clause of that objection is false, and each is false for its own
reason:

  1. THE REMEDY CHANGES NO CHECKSUM. `existence_guard` is DELIBERATELY EXCLUDED from
     `ChecksumInput` / `Checksum::of` (`crates/zero-migrate-ir/src/migration.rs:691-699`,
     which says so in its own words), and the IR-path anchor `Checksum::of_ir` folds the
     OP LIST - and the op is unguarded, so it is unchanged. Stamping a probe moves no
     checksum anywhere.

  2. THE FAILING MIGRATION IS NOT IN THE APPLIED PREFIX. A `FailDrift` rolls back and
     writes no journal row (`postgres/session.rs:454-465`), and on the non-transactional
     path returns before `record_started` (`:818-826`). `compare_applied_to_set` reads
     only `Phase::Completed` (`drift.rs:189`). So the refused migration stays pending and
     is freely editable. The host test asserts exactly this from the server:
     `after.length === before.length`.

  3. THE HOIST WOULD NOT HAVE FIXED THE CASE I INVENTED IT FOR. A pre-flight catalog read
     happens BEFORE the batch. A history replayed against a FRESH PostgreSQL sees an
     EMPTY catalog, finds no collision, passes, and still fails later when a migration
     collides with an index an earlier migration in the same run created. The mitigation
     was blind to its own motivating scenario.

And a fourth, which kills the repair: making the pre-flight batch-aware means folding
each pending migration's index claims, which is blind to an unguarded `dropIndex` (it
carries no probe, `lower.rs:4600`). A batch that drops `idx_shared` from A and recreates
it on B is LEGAL and would be FALSELY REFUSED. The mitigation for a silent skip would
have introduced a loud wrong answer.

WHAT I ACTUALLY GOT WRONG IS NARROWER AND WORSE THAN "I WAS MISTAKEN ABOUT CHECKSUMS".
I reasoned about the interaction of four mechanisms - checksums, journaling, batch
boundaries, the second pass - from how I remembered each one behaving, and every step
was individually plausible. The chain was coherent. Coherence is what made it survive
being written into a brief three times without my checking a single one of the four at
its source. THE COST OF A WRONG PREMISE IS NOT THAT IT IS WRONG, IT IS THAT IT ARRIVES
PRE-JUSTIFIED, and a justified premise is the one nobody re-reads.

This is the fifth premise of mine to fail this session (#77 named the wrong dialect, #78
asserted no fold rule diverges by dialect, #38 had an inverted objection, #83 called a
deliberate mechanism an accident). The pattern across all five: none was a fact I
misremembered in isolation. Each was an INFERENCE I made from facts, and the inference
step is the one I never labelled as such when writing it down.

The practical rule that follows, and it is cheap: WHEN A BRIEF ASSERTS THAT A CHANGE HAS
A COST, THE COST CLAUSE NEEDS A FILE:LINE THE SAME WAY THE DEFECT CLAUSE DOES. I gave
`lower.rs:4368` for the defect and gave nothing for the cost, and the cost is what the
agent was being asked to weigh.

Shipped as 8f13611: probe alone, no hoist. Workspace 2218 passed across 74 targets (from
2212 - five new decider unit tests and one SQLite end-to-end arm), package 221/220/0/1
unchanged, host 104 passed / 0 skipped (from 101 - the three arms of the new file), with
ZERO_MIGRATE_TEST_PG_URL and ZERO_MIGRATE_MYSQL_URL both exported. The 0 skipped is the
part worth stating: both live databases actually ran.

TWO GAPS RECORDED RATHER THAN CLOSED, both filed. An unguarded `createTable` with inline
`indexes` goes through the `CreateTable` arm and gets no probe, so the same silent skip
survives there (#85 - and I have NOT confirmed that premise myself, which is the whole
subject of this entry). And the MySQL arm of `Capability::SchemaWideIndexNames` still
cannot be pinned end to end, because `existence_probe::decide` has exactly three call
sites and none is MySQL (#79, verified here with a positive control).

### F56 - I fixed four instances of a bug and left the bug, and did not notice for an hour

Auditing comment citations for #84, my first pass reported 30 dead paths. Four were
`scripts/gen-ir-types.mjs` and `scripts/gen-dialect-table.mjs`, cited from
`packages/zero-migrate/package.json` and two test files in that package. Measured, both
spellings side by side against a file that plainly exists:

    packages/zero-migrate/scripts/gen-dialect-table.mjs      exists, 10073 bytes

    root-only resolution of "scripts/gen-dialect-table.mjs"  -> FLAGGED (false positive)
    ancestor walk from packages/zero-migrate/package.json    -> not flagged (resolved)

A citation written inside a package is PACKAGE-RELATIVE. I was resolving every path
against the repository root only.

WHAT I DID ABOUT IT IS THE ENTRY. I recognised the four filenames, added ONE HARDCODED
LINE to the detector - `next if -e "packages/zero-migrate/$p"` - and got 26, which was
the right answer. I never named the class. Because I never named it, I never asked
whether any other directory in the tree had the same shape, and the general fix (walk
every ancestor of the citing file) never occurred to me. I FIXED THE FOUR INSTANCES AND
LEFT THE BUG, and shipped an hour of work on top of it.

It happens to be harmless here: re-resolving all 26 with a proper ancestor walk still
returns 0 resolvable, so the finding stands and no rewrite removed a live citation. That
is a fact about this tree's layout, not about my method. In a tree with more
nested packages the same detector would have reported a number I had no way to doubt.

THE TELL I RELIED ON WAS NOT A CHECK. I caught the other first-pass false positives
(`ir-envelope.schema.js`, `package-lock.js` - a regex alternation listing `js` before
`json`, matching inside `.json`) because THE FILENAMES LOOKED WRONG. Zeroship caught the
same class in their own run because THE NUMBER LOOKED TOO ROUND. Both of us were rescued
by a surface property of the output. Neither of us had an instrument for it.

THE MISSING DEFENCE, and it is a third axis rather than a stronger version of the other
two:

    LOOSE      catches what you failed to PREDICT       - a guard calibrated to your
                                                          belief cannot refute it
    PLANTED    catches an instrument that is not READING - F54's inverted NUL detector
    ALIVE-HIT  catches an instrument RESOLVING wrongly   - this entry

CHECK A HIT YOU EXPECT TO BE ALIVE. Not a planted absence - a known PRESENCE the detector
claims is missing. It is the only one of the three that tests the MODEL rather than the
mechanism. A planted input proves the detector reads and matches, but only for the one
path planted; it cannot reveal that a whole CLASS of paths is being resolved against the
wrong base, because that class never appears in the output as anything but a number.

Cheapest form, now adopted: for any detector that reports absences, take the LOUDEST
SINGLE ENTRY and `ls` it before believing the total. My four `scripts/gen-*.mjs` were the
top repeated target of that run, and one `ls` would have shown the model was wrong rather
than the corpus dirty.

NOT DONE, and worth stating because the whole point of this entry is not to let a partial
fix read as a whole one: I have applied the alive-hit test to the citation detector ONLY.
The NUL gate from F54 is plant-verified but I have not fed it a file I expect to PASS and
confirmed it passes for the right reason. The phase-tag sweeps are three rounds old and
were never tested this way at all. One of their misses is already known to be
resolution-shaped: three of the dead citations found in #84 name PHASE-TAGGED DOCUMENTS
(`docs/proposals/p4-search-implementation-plan.md` at `schema/query.rs:1725`,
`docs/proposals/p5-encryption-backup-implementation-plan.md` at `:2496` and
`schema/descriptors.rs:70`). Those sweeps searched comment PROSE for phase vocabulary and
the tag was living in a PATH, so the scope hole was not the corpus and not the pattern -
IT WAS WHICH PART OF THE LINE I COUNTED AS TEXT.

### F57 - counting reads and writes separately, and the one place that counting lies

> CORRECTED BY F61. This entry recorded #79's premise as refuted. The control it rested on
> was run with NON-EMPTY priors, which is the half of the space where PostgreSQL and MySQL
> agree for an unrelated reason, so it could not have refuted anything. #79 was reopened and
> is now recorded correctly in F65 and F67.

#79 asked whether MySQL should evaluate existence-guard probes. Two independent opinions
converged on "no - document it", and both refuted the premise I dispatched with: I said a
guarded op on MySQL reaches a bare `CREATE INDEX` and errors at the server. It does not,
on the shipping path. The Node host projects pending ops onto the LIVE snapshot at
`crates/zero-migrate-node/src/lower.rs:397-428` and the fold DELIBERATELY IGNORES the
guard (`render/fold.rs:39-47`), so the op is refused earlier with a typed error and no
inflight marker. PostgreSQL, which DOES evaluate probes, produces the IDENTICAL refusal -
the positive control was not green.

WHAT SHIPPED IS TEXT, NOT BEHAVIOUR: `crates/zero-migrate/tests/golden/sql_preview_mysql.txt`
told an operator a guarded `addColumn` was "catalog-probed at apply (run / satisfied-noop /
fail-drift)" on a dialect that probes nothing. Four author-facing sites said versions of
the same thing. No apply path changed.

THE FINDING WORTH KEEPING IS HOW THE FALSE CLAIM SURVIVED. Ask "does the MySQL backend
handle existence guards?" and the obvious check answers YES:

    $ grep -rc "existence_guard" crates/zero-migrate/src/apply/backend/mysql/
    7

Seven hits, right directory, exact identifier. Every one is `existence_guard: None` - a
struct-literal CONSTRUCTION. Split them:

    reads:  0
    writes: 7

The backend writes the field seven times and reads it never. THE MOST MISLEADING VERSION
OF A FALSE CAPABILITY CLAIM IS THE ONE WITH SOME CODE NEAR IT: an absent capability fails
an obvious grep, an inert one passes it.

THE METHOD, and it is mechanical for anything with a NAME:

    reads  = grep -rn "NAME" <dir> | grep -v "NAME: "
    writes = grep -rn "NAME" <dir> | grep    "NAME: "

For a struct field, `NAME:` in the hit is construction and its absence is consultation.
Count both, never quote the total. Claims with no name to count ("fast path") get no help
from this.

WHERE IT LIES, and this is the part I would otherwise have discovered on something that
mattered. A rejection arm READS the thing in order to refuse it. Zeroship's case:

    PlanStep::OnlineRename(RenameStep::SqliteRebuild(_)) => {
        return Err(... "only pure DDL is supported" ...)

That is the only substantive SQLite reference in a crate whose landing page lists SQLite
as supported. The split scores it as a READ and PASSES the claim. So there is a third
bucket - READS THAT CONSUME RATHER THAN HONOUR - and grep does not give it to you. You
have to read the arm.

A READ/WRITE RATIO IS A POINTER, NOT A VERDICT. They ran the split on their own tree,
found a write-only security field, had the severity written before finishing the check,
and then found the field IS consulted - in a different crate. The real defect was narrower
than the alarm: a crate declaring a security-mechanism field it takes no part in. Both
steps were necessary.

AND THE REFRAME I AM TAKING, because it is better than the self-criticism it replaced.
I recorded the 7/0/7 split carefully in two messages and treated it as a caveat on a
sentence rather than as a class - the third time in one exchange I was one level too
concrete. Their correction: BEING ONE LEVEL TOO CONCRETE IS A FAILURE OF FILING, NOT OF
OBSERVATION. The observation was complete both times. What was missing was the question
"is this an instance of something", which is cheaper and different from "have I found
everything".

One structural note on why this class persists: about thirty of their test fixtures
construct the write-only field to satisfy a struct literal, so deleting it touches all of
them. THE COST OF DELETION IS WHAT KEEPS A WRITE-ONLY FIELD ALIVE, and it grows with every
fixture. My seven are not that case - the field IS read, by the PostgreSQL and SQLite
backends - so the split flagged both and only the follow-through separated them.

### F58 - the op manufactured the state I thought needed a crash, and my repro could not reach it

#86 as I filed it: a guarded masked `addColumn` builds ONE probe describing the MAIN column
and the generic stamp copies it onto BOTH units, including the `<column>_masked` sibling's.
I predicted a silent skip and guessed the reachability - a partial apply, an adoption where
the main column arrived out of band, a re-run after a failure between the two units. I
wrote "treat this as the premise most likely to be wrong".

IT WAS WRONG IN THE DIRECTION THAT MATTERS. No crash is needed. The two units are separate
`Migration`s - separate transactions, separate journal rows - so UNIT 0 HAS ALREADY
COMMITTED when unit 1 snapshots the catalog. Unit 1 probes the main column, finds it
present and matching, returns `SatisfiedNoop`, skips its own `ADD COLUMN` and journals
green. On a clean database, first apply, every time. THE `<column>_masked` SIBLING WAS
NEVER CREATED AT ALL, and the mask sentinel `COMMENT` rides the same skipped statement.

AND THE REPRODUCTION I SPECIFIED COULD NOT HAVE FOUND IT. I asked for: apply, drop the
sibling out of band, re-apply. That never reaches the probe - pending is recomputed as
`set - completed - superseded` (`apply/executor.rs:910`) before `apply_one` runs, so an
already-journaled version is filtered out ahead of the guard. A second authored plan with
fresh versions is required. So the ticket would have produced a green run and a closed
issue.

Verified by me, RED and GREEN from ONE compiled binary via an env gate, window 17:51:11 -
17:51:46 UTC:

    ZERO_MIGRATE_V86_OLD_STAMP=1
      a_guarded_masked_add_column_adds_the_sibling_on_a_clean_first_apply ... FAILED
      a_crash_between_the_masked_add_column_units_still_adds_the_sibling_on_resume ... FAILED
      a_guarded_masked_add_column_is_a_clean_noop_when_both_columns_are_present ... ok
    env unset
      all three ... ok

THE ENGINE ALREADY KNEW. `render/declarative.rs:7581-7595` documents this exact failure
mode as the reason `createTable` attributes a per-unit probe: "once unit 0 creates the
table, units 1..N see the table PRESENT ... SKIPPED but journaled completed". The masked
`addColumn` arm had the same two-object shape and did not follow the pattern written down
one file away. Fixed as 63ddb1e by using that pattern rather than inventing one.

THE COMMENT WAS THE REAL DEFECT, and it is why this survived. `lower.rs:5196` justified the
blanket stamp: "each re-probes the live catalog under the held lock and gets the same
verdict." That sentence is TRUE for multiple statements about one object and it is the
FAILURE MODE for two objects - and it reads as a safety argument either way. Now restated:
what makes the stamp sound is that every unit it touches describes the SAME OBJECT, not
that the units re-probe under one lock. A WRONG REASON ATTACHED TO CORRECT CODE IS A
LOADED GUN: the code was fine for every arm that existed when the comment was written, so
nothing failed, and the next two-object arm inherited the blessing.

TWO GAPS RECORDED RATHER THAN CLOSED, both filed: `dropColumn` on a masked column emits one
unit and leaves the sibling behind (#89, NOT verified by me), and the sibling's probe checks
the column's shape but not its sentinel `COMMENT`, so a sibling present but unmarked reads
as satisfied (#90, mechanism verified, reachability not).

### F59 - two independent reviews agreed, and the premise was still wrong on three counts

#88 came from BOTH #79 opinions, independently: `createPartition ifNotExists` and
`dropPartition ifExists` return early before building a probe, and therefore bypass the
fail-closed `GuardProbeUnbuildable` check that exists precisely to stop a guard being
silently dropped. Two reviews, arrived at separately, saying the same thing. I filed it as
worse than the rest of the guard gaps for exactly that reason.

VERDICT: REJECTED AS FILED. Every load-bearing part was wrong.

  1. EVERY LINE NUMBER BOTH REVIEWS CITED MISSED. Real: CreatePartition 4427-4476 with the
     early return at 4461-4464; DropPartition 4505-4539 returning at 4519-4527; the
     fail-closed check at 5243-5258, not the ~5230 I passed on. The two reviews cited
     DIFFERENT wrong ranges, which I noted in the brief as a reason to read rather than
     trust - and it was the only part of my framing that held.

  2. THE GATE IS `!matches!(self.dialect, SqlDialect::Postgres)` - ALL NON-POSTGRES. Both
     reviews framed it as MySQL, and I carried that framing into the ticket. SQLite is
     equally affected and neither report mentioned it.

  3. THE REMEDY IS NOT IMPLEMENTABLE, which is the part no amount of re-reading the arm
     would have shown. The early return yields `LoweredOp::Dml(step)`. The fail-closed
     check inspects `migs`, a DDL unit list, so it STRUCTURALLY CANNOT SEE a Dml result -
     routing these arms through it is not a small change, it is a category error. And
     `PlanStep::Dml` (`render/step.rs:90-134`) HAS NO `existence_guard` FIELD AT ALL, so
     building a probe for them is blocked too. On the default/hash path the return is
     `LoweredOp::Ddl(Vec::new())`, where `migs.iter().any(...)` over an empty vec is false
     and the check would be VACUOUS even if reached.

AND THE BEHAVIOUR IS HARMLESS WHERE I SAID THE BUG WAS. Guarded and unguarded lowerings are
BYTE-IDENTICAL on SQLite and MySQL. Live MySQL: a guarded createPartition produced the
identical catalog, identical journal and identical downstream error as the unguarded
control.

THE REAL DEFECT IS IN THE ARM NOBODY LOOKED AT - the one that DOES build a probe, on the
one dialect that DOES evaluate probes. `drift.rs:670` excludes partition children from the
tables snapshot (`AND c.relispartition = false`); `existence_probe.rs:297` is
`live.tables.contains_key(table)` and never consults `live.partitions`. So a partition
child is ALWAYS absent to the probe. Observed live, control differing only by the flag:
`dropPartition({ifExists:true})` skipped the DROP, journaled the migration `applied`, and
left both the partition and its rows in place. The unguarded form dropped correctly. THE
GUARD DOES NOT WEAKEN THE DROP, IT CANCELS IT. Filed as #91.

WHAT I ACTUALLY GOT WRONG IS NOT "I BELIEVED TWO AGENTS". Their reports were honest, both
labelled the claim as read-not-run, and I recorded that. The error was treating AGREEMENT
as if it were INDEPENDENT CONFIRMATION. Two readers of the same twenty lines who share a
prior are one measurement, not two - and the shared prior here was mine, since both were
answering a #79 brief that framed the whole area as a MySQL problem. I MANUFACTURED THE
CORROBORATION I THEN TREATED AS EVIDENCE.

The thing that settled it was none of the reading: it was running the op against a live
server and reading the catalog back. Third time today that a premise survived every review
and died on first contact with a database.

### F60 - both opinions agreed, and the premise they agreed against was mine

#91: on PostgreSQL a partition child is invisible to `decide_table`, so
`dropPartition({ifExists:true})` returns `SatisfiedNoop`, skips the DROP, journals the
migration applied, and leaves the partition and its rows in place. The unguarded form drops
correctly. THE GUARD DOES NOT WEAKEN THE DROP, IT CANCELS IT.

I framed the decision around a cost that does not exist. I told both opinions that option
(b) - a `GuardProbe::Partition` variant - "CHANGES A SERIALIZED WIRE SHAPE", citing
`ir-envelope.schema.json` and the gen-artifact goldens, and pointed at `8f13611` as the
precedent that made it expensive. VERIFIED BY ME after both came back:

    GuardProbe in crates/zero-migrate/ir-envelope.schema.json   0
    golden files carrying existence_guard/GuardProbe            0
    positive control, GuardProbe in zero-migrate-ir/src/probe.rs 3

`existence_guard` is excluded from `ChecksumInput` by design (`migration.rs:691`), the IR
checksum covers the unchanged source op list, and migrations are stored as TypeScript
SOURCE and re-lowered every run - the probe is a transient in-memory artifact. The
`8f13611` precedent does not transfer either: that added a FIELD to an existing variant,
which does move that variant's bytes unless skipped. A NEW VARIANT HAS NO EXISTING BYTES TO
PRESERVE.

BOTH RECOMMENDED (b), and the value was in where they DIVERGED rather than where they
agreed:

  - Codex refined the wire answer rather than repeating it: the checksum cost is zero, but
    a new variant DOES change the serialized lowered-`Migration` wire, so an old reader
    would reject an unknown tag - and no `serde(default)` can fix a discriminant. Opus
    reached the same residual risk from a different direction (`bridge.rs:978-994` exposes
    a napi entry deserializing `Migration` JSON supplied by JS). Same hazard, two routes,
    neither of which was my framing.
  - Codex CORRECTED Opus on the `expect_columns: []` question. Opus said the probe could
    never return `SatisfiedNoop` "by any route"; codex found the exception - a ZERO-COLUMN
    `TableSnapshot` falls through to `SatisfiedNoop` at `existence_probe.rs:351`. The
    absolute was too strong.
  - Codex found that option (a) needs more than the one edit it looks like: changing
    `present` at `:297` is insufficient because `IfNotExists` independently calls
    `live.tables.get(table)` at `:307`.

AND THE MIRROR BUG I RELAYED FROM #88 WAS REFUTED. `createPartition ifNotExists` does NOT
raise `relation "events_0" already exists`; the plan is refused before any DDL by the
static projection, identically with and without the guard.

THE BEST ARGUMENT AGAINST MY OWN PREFERRED FIX came from the mandatory "where does your
recommendation make things worse" question, which has now paid for itself every time I have
asked it. A team hit this months ago: production ran the guarded drop, it journaled green,
the partition quietly survived with its rows, and nobody noticed - a silent no-op only ever
leaves you with MORE data than you asked for. Ship the fix, and the next environment
rebuilt from that same authored history - a fresh staging DB, a new region, a DR restore, a
per-PR database - replays the identical migration text against the corrected engine and
ACTUALLY DROPS IT. Production and staging diverge in the DESTRUCTIVE direction, from
migration text that reads as already-proven, with nothing in the plan output to warn
anyone. The current bug is a silent no-op; the fix converts it into a silent, correct,
irreversible DROP delivered to the environment least likely to be watched.

That is not an argument against fixing it. It is an argument that the fix must ANNOUNCE
ITSELF - a plan-time note, or routing the newly-live drop through the existing destructive
approval path - and that belongs in the same change rather than a follow-up.

Recorded separately as #92, and larger than #91: the pending-schema projection ignores
existence guards entirely, so across the four cells the probe ONLY EVER EXECUTES IN THE
CELL WHERE IT IS WRONG, and in the two cells the guard exists for the plan is refused
before the probe runs. Not partition-specific - `dropTable ifExists` on a table no
migration created is refused with `fold: table 'widget' does not exist`.

### F61 - correcting F57: the control that refuted #79 was run on the wrong half of the space

F57 recorded that #79's premise was refuted. The premise was that a guarded op on MySQL
reaches bare DDL and errors at the server; the refutation was that the Node host's
pending-schema projection refuses first, and - the sentence I put most weight on - that
POSTGRESQL PRODUCES THE IDENTICAL REFUSAL, so "the positive control was not green".

THE PREMISE WAS TRUE. The control was run in the one configuration where the difference is
invisible.

VERIFIED BY ME by reading, after an agent measured it against both live servers:
`crates/zero-migrate-node/src/verbs.rs:263` branches on `prior_envelope_json.is_empty()`.
With EMPTY priors, apply takes `lower_envelope_to_plan_with_live` and NEVER FOLDS. With
non-empty priors it takes the folding path. And `packages/zero-migrate-cli/src/cli.ts:945`
passes `migrations.slice(0, index)`, so:

    MIGRATION #0        empty priors   -> probe path, guard evaluated
    MIGRATIONS 1..N     prior slice    -> fold path, projection pre-empts the guard

Measured by the agent across both dialects:

    priors NON-EMPTY   PG and MySQL identical - both refused by the projection
    priors EMPTY       PG honours the guard (OK); MySQL emits bare DDL and takes a
                       server error (1051 / 1050)

So F57's control was green in the sense that PG and MySQL agreed - AND THEY AGREE ONLY
BECAUSE THE FOLD MASKS BOTH. Run the same comparison at migration #0 and they diverge
completely, which is the case #79 was actually about.

WHY THIS MATTERS BEYOND THE BOOKKEEPING: the realistic use of `createTable ifNotExists` as
migration #0 is ADOPTING AN EXISTING DATABASE. That is the flagship case for the whole
guard feature, it is the one an operator reaches for first, and it is the one cell where
MySQL fails at the server. #79's verdict (c) - document it, do not implement - was decided
against a premise that had been marked refuted. The verdict may still be right; it was
reached on a false floor and has to be re-derived.

THE SHAPE OF MY ERROR, and it is not "I trusted an agent". Both #79 opinions were honest
and both measured what they said. I took a control that PASSED and read it as covering the
question, when it covered one configuration of a two-configuration space and nobody had
named the second. A CONTROL PROVES THE COMPARISON IT MAKES, NOT THE QUESTION YOU ASKED IT.
The way to have caught it was to ask what varies that the control holds fixed - here, the
prior chain, which is not a parameter anyone had thought of as one.

Also corrected: the four-cell table filed under #92 has one cell now false. "Drop ifExists,
child live-PRESENT, fold passes, probe SatisfiedNoop, silent skip" was the PRE-7c8404a bug
and is fixed - the probe now returns RunBare and the DDL runs. The true statement is the
DUAL of what I filed: the probe executes in the two cells where its verdict changes nothing,
and the two cells where the guard exists to produce a no-op are pre-empted by the
projection. Same conclusion, different mechanism, and the mechanism decides the fix -
"let SatisfiedNoop through the projection" rather than "teach the fold to ignore drops".

### F62 - the two opinions agreed on the sequence and disagreed on the one thing that matters

#79 and #92 are entangled: making the projection guard-aware removes the thing currently
protecting MySQL. I asked both opinions for a SEQUENCE and for the state the tree is in
BETWEEN the steps, which is the question a sequencing decision actually turns on.

BOTH SAID: contain MySQL first, implement MySQL probes second, fix the projection third.
Neither picked either of the two candidates I offered.

THEY DISAGREED ON WHERE THE CONTAINMENT GOES, and the disagreement is the finding:

  Opus  - at the apply seam, `mysql/session.rs` before `record_started`, per migration.
  Codex - in the executor's STATIC FIRST PASS, which validates every pending migration at
          `apply/executor.rs:928-955` and only begins executing at `:969`.

CODEX IS RIGHT AND THE REASON IS THE BETWEEN-STATE. Opus's placement refuses during
execution, so migrations 1..k commit and k+1 stops - a mid-batch halt, which on MySQL means
a `started` marker and a recovery conversation. Codex's placement refuses before ANY
migration in the batch executes. Same rule, same dialect, opposite blast radius, and only
the question "what does the tree look like between step one and step two" separates them.

CODEX ALSO KILLED MY OWN OPTION (3). I had offered "document that the guard is coherent
only at migration #0". That boundary does not exist: `priorMigrations` is OPTIONAL and
defaults to `[]`, the documented programmatic examples omit it, and `ApplyRequest.priorEnvelopes`
defaults absent. An embedder omitting priors is on the probe path for EVERY migration, so
there is no #0 boundary to document.

THREE OF MY PREMISES WERE CORRECTED, two of which I have now verified myself:

  1. "EMPTY PRIORS MEANS NO FOLD" IS FALSE. `crates/zero-migrate-node/src/verbs.rs:274-289`
     catches an error from direct lowering and FALLS BACK to one-envelope ordered lowering:
         Err(_) => { ... lower_ordered_envelopes_to_plans_for_apply(&[envelope_json...]) }
     So the fold is reachable with empty priors after any direct-lowering failure. VERIFIED
     BY ME by reading.
  2. The #0-versus-1..N split is POSTGRESQL AND MYSQL CLI ONLY. SQLite goes through
     `deploy_envelopes` with the full sequence and never touches that branch. Relayed.
  3. `lower.rs:812` marks an ENTIRE OP completed when ANY step in its ranges is completed.
     That is too coarse for a partially completed multi-unit guarded op - a guarded
     `createTable` lowers to separately guarded table, index and FK units, so a completed
     table unit suppresses the whole op and leaves a pending index unit unprotected by any
     op-scoped refusal. VERIFIED BY ME that the function is structured per-op over step
     ranges; the consequence is codex's.

That third one is why codex's step 3 is "per lowered UNIT and per-unit completed evidence,
not per Op" - and it means the op-scoped refusal Opus proposed has a hole in exactly the
case the interlock exists for.

WHAT I TAKE FROM THE PAIR. Both were competent, both ran things, and the useful output was
not the verdict they shared - it was the placement they did not. ASKING FOR THE SEQUENCE
WOULD HAVE PRODUCED AGREEMENT AND A WORSE FIX; asking for the BETWEEN-STATES is what
separated them. A decision about ordering is not really about the order, it is about what is
true in the gaps, and that is the question to put in the brief.

Neither is implemented. #94 - the PostgreSQL snapshot dropping varchar length, so adopting
any `t.string()` column fails closed - was found by the Opus agent in passing and confirmed
live by me with a `text` control that adopts cleanly. That defect says the guard rejects the
principal case it exists for on the one dialect that evaluates it, which plausibly outranks
deciding where else to evaluate it.

## F63 - The guard's principal case was broken by a catalog column nobody recomposed (#94)

`information_schema.columns` splits a length-qualified type in two: `data_type` holds the
bare base name and `character_maximum_length` holds the modifier. The desired side spells
the length INLINE - `character varying(255)` for `t.string()`, which defaults to
`length: 255` (`packages/zero-migrate/src/ops.ts:1101`). `snapshot_schema` recomposed
`character(N)` and nothing else, so the two sides could never compare equal and every
bounded varchar column false-drifted.

WHAT THAT COST. `t.string()` IS the default string type, and the existence guard's whole
purpose is adopting a table that already exists. So the guard refused the principal case it
was built for, on PostgreSQL, which is one of only two dialects that evaluate it at all
(`existence_probe::decide` has three call sites, none MySQL - see #79). The same
`ColumnSnapshot.data_type` feeds `diff_snapshots`, so `plan_declarative` would also plan a
spurious `ALTER COLUMN TYPE` on a table that is already correct.

THE FIX IS KEYED ON THE CATALOG DATUM, NOT ON A NAME. `crates/zero-migrate/src/apply/drift.rs:919`
now recomposes whenever `character_maximum_length` is non-null and positive, rather than
matching another type name. Measured against the live PostgreSQL 18 at 5434:

    character varying(255) -> cml 255      character(10)   -> cml 10
    bit(8)                 -> cml 8        bit varying(16) -> cml 16
    varchar (unbounded)    -> cml NULL     numeric(10,2)   -> cml NULL, numeric_precision 10
    timestamp(3)           -> cml NULL, datetime_precision 3
    varchar(3)[]           -> data_type ARRAY, cml NULL

Exactly four base types populate it and nothing else does, so the datum IS the predicate. A
per-name arm would have left the same trap open for the next type - which is how the
`character`-only arm came to exist in the first place.

WHAT IT DELIBERATELY DOES NOT COVER, and why that is not an omission: `numeric` precision
and time/interval precision arrive through OTHER catalog columns and stay bare on BOTH
sides on purpose - the desired side routes decimal precision to `ddl_type_override` and
keeps `numeric` as the comparison key, so recomposing those here would CREATE the drift
this removes. Arrays and domains never reach the arm; the earlier `type_kind`/`USER-DEFINED`/
`ARRAY` arms claim them, and PostgreSQL reports a NULL length for an array of a bounded type
anyway.

THE THIRD ARM IS THE ONE THAT MATTERS. Two arms would have been satisfied by a "fix" that
stopped comparing `data_type` at all, so the test also declares `t.string({ length: 100 })`
against a live `varchar(255)` and requires the refusal to NAME BOTH WIDTHS. That arm passed
BEFORE the fix for the wrong reason - it refused because the length was missing, not because
the widths differ - which is the same false-green shape as F49 and #83. Reproduced by me
with an env-gated mutation, RED and GREEN from the SAME compiled addon:

    mutation ON   arm 1 FAIL  arm 2 (text control) PASS  arm 3 FAIL
    mutation OFF  arm 1 PASS  arm 2 PASS                 arm 3 PASS

and the RED messages read from the server:

    declared character varying(255) but the live database has character varying
    declared character varying(100) but the live database has character varying

Arm 3's RED says `character varying` where the fix makes it say `character varying(255)`.
That difference is the whole finding: before, the refusal was about an absent length; after,
it is about the widths.

Gates, both DB URLs exported: fmt 0, clippy 0, workspace 74 targets / 2227 passed / 0
failed, package 222/221/0/1, host 107/107/0/0 - the only moved count is host 104 -> 107,
exactly the three arms.

TWO THINGS FOUND WHILE VERIFYING, both filed rather than fixed here. #95: `render/fold.rs:1570`
dispatches a column's ID default on `data_type` and lists `== "character varying"`,
`starts_with("varchar")` and `starts_with("char(")` but NOT `starts_with("character varying(")`
- which is exactly what the desired side spells. Found independently by me and by the agent,
which is the only reason I trust it enough to file; reachability is unmeasured and is the
first thing to settle. #96: `pnpm-workspace.yaml:16` commits `esbuild: set this to true or
false` as the build permission, and pnpm 10.34.5 accepts the instruction text without a
word and writes it verbatim into `node_modules/.modules.yaml`.

## F64 - A security decision was committed as an instruction to write one (#96)

`pnpm-workspace.yaml:17` read `esbuild: set this to true or false`. `allowBuilds` decides
whether a dependency's install scripts execute - pnpm stopped running them by default in
v10 because they are arbitrary code from the dependency tree - so that slot holds a
decision, and what was committed was the reminder to make it.

pnpm 10.34.5 accepted the instruction text without a word and wrote it VERBATIM into
`node_modules/.modules.yaml`:

    "allowBuilds": { "esbuild": "set this to true or false" }

THE CAUSE I REACHED FOR WAS THE WRONG ONE, and isolating it is the only reason I know that.
`pnpm install --frozen-lockfile` was exiting 1 in the devShell with
`ERR_PNPM_ABORTED_REMOVE_MODULES_DIR_NO_TTY`, and a config value pnpm had just recorded is
an obvious suspect. It is not the cause. Restoring the placeholder over a consistent
`node_modules` and installing again exits 0:

    placeholder restored, install  -> exit 0, "Already up to date"
    fix restored,        install  -> exit 0, "Already up to date"

The exit 1 was a one-time stale-modules purge that the reinstall cleared, and it would not
have reached CI regardless (GitHub Actions sets `CI=true`, which suppresses the prompt). Had
I written this up when the correlation looked clean, the entry would have named a cause that
a two-command experiment refutes.

SO THE DEFECT IS NARROWER THAN IT LOOKED, and still worth fixing: esbuild's build was not
blocked (`@esbuild/linux-x64@0.28.1`'s binary is present and `transformSync("const a=1")`
returns `const a = 1;`), nothing failed, and nothing warned. The value is simply undefined
behaviour standing where a boolean belongs - pnpm documents `true`/`false` and says nothing
about a string, so whether the build runs is decided by a coercion nobody chose. I did NOT
measure what pnpm does with a non-boolean; I measured that it does not complain.

Set to `true`, matching the intent the adjacent `onlyBuiltDependencies: [esbuild]` already
expressed, and dropped that legacy key: pnpm superseded it in 10.26 and removes it in 11.0,
so keeping both would leave the same permission recorded twice and read from once.

THE GATE IS THE POINT. `packages/zero-migrate/tests/workspace-build-permissions.test.ts`
asserts every `allowBuilds` value is a real boolean. It checks the SHAPE, not the answer -
`esbuild: false` is a legitimate decision it must accept. Three states measured, not two:

    committed placeholder   FAIL, naming `pnpm-workspace.yaml:17 esbuild: set this to ...`
    esbuild: true           PASS
    esbuild: "true"         FAIL  (planted: a string that READS as an answer)

The third is the control that matters. A gate written as "is the value non-empty" would pass
all three, and the quoted spelling is the one a person fixing this by hand would plausibly
write. The block-presence assertion is separate from the entry check for the F49 reason: a
renamed key and an empty block must not report the same green.

Package suite 223 tests / 222 pass / 0 fail / 1 skip - the one moved count is the new test.

## F65 - Both agents contradicted my premise, and the clause that made them do it was "argue against yourself" (#79)

I briefed an Opus agent and a read-only codex on a single narrow question: given that MySQL
evaluates no existence guards, does the fail-closed interlock ship first, or the MySQL probe?
The brief carried a mechanism I had researched and believed:

    a guarded `createTable ifNotExists` on MySQL runs BARE - it relies on MySQL's own
    IF NOT EXISTS and never verifies the existing object has the DECLARED SHAPE

THAT MECHANISM IS WRONG, AND BOTH FOUND IT INDEPENDENTLY. MySQL does not fall back on a
native clause. It DROPS the guard and runs bare DDL, so a re-run ERRORS. Fail-loud, not
fail-open. VERIFIED BY ME at three places after they contradicted me:

    render/sql_preview.rs:838   const fn mysql_guard_is_native(op: &Op) -> bool {
                                    matches!(op, Op::DropView { .. })
                                }
    model/support.rs:406        the generated support matrix ALREADY declares MySQL
                                unsupported, in these words: "the MySQL backend evaluates
                                no existence-guard catalog probe at apply, so a guarded
                                statement runs unconditionally and a re-run errors; the
                                sole exception is dropView"
    tests/golden/sql_preview_mysql.txt:21-23
                                a guarded addColumn previews as bare ALTER TABLE under a
                                comment saying exactly that

The answer was committed in three places, one of them a GENERATED artifact. No instrument
was missing and no search came back empty. I had a confident wrong model and never asked it
a question it could fail.

WHAT CAUGHT IT WAS NOT A BETTER QUESTION. Both agents answered the ordering question inside
my frame. The premise broke in the section where each had to name a concrete case where ITS
OWN recommendation makes things worse - because that forces a walk of what the status quo
actually DOES, which the question never described. One of them then REVERSED its own
recommendation mid-thread after I forwarded it a fact the other had surfaced.

BOTH CONVERGED ON THE SAME THREE CONCLUSIONS.

  1. THE INTERLOCK IS MISFILED AS A BLANKET REFUSAL. `dropView` genuinely lowers to native
     `DROP VIEW IF EXISTS` on MySQL, so `existence_guard.is_some()` would refuse the one op
     MySQL honours correctly. And on a fresh database where the object is absent, the bare
     DDL is exactly right - so the refusal breaks working deployments. Both named that as
     their own worse-case, separately.
  2. THE LAYER IS VALIDATION, NOT THE EXECUTOR. model/support.rs:401 states outright
     "Validation never gates on this feature", and the sibling `Feature::RenameColumnGuard`
     IS gated in one line at model/validate.rs:5013. The machinery exists and is unwired.
  3. WIRING THE PROBE ALONE WOULD CREATE THE HOLE I THOUGHT EXISTED. schema/query.rs:2857
     folds `varchar(N)` to `text` for EVERY N, :2872 folds `decimal(p,s)` to `decimal`,
     :2863 folds `datetime(6)` to `datetime`; apply/backend/mysql/drift_sql.rs:210
     canonicalises ON INGEST with `ddl_type_override: None`, so the raw COLUMN_TYPE is
     DISCARDED and unrecoverable downstream. A declared `varchar(255)` against a live
     `varchar(64)` would compare text to text, return SatisfiedNoop, and JOURNAL COMPLETED.
     That trades today's loud error for a green deploy over a column a quarter of the
     declared width, with the failure relocating to a production insert weeks later.

So the work is ONE unit: carry the raw type in the MySQL snapshot AND require raw equality
for SatisfiedNoop, using the coarse fold only for present/absent and RunBare. Neither half
ships alone, which is the opposite of the sequencing I went in with.

WHAT EACH ADDED THAT THE OTHER DID NOT. Codex: the executor's first pass covers pending
VERSIONED migrations only and repeatables are handled later - I checked, and it is half
right, because repeatables DO get their own all-up-front gate at executor.rs:1184
(`guard_repeatable_batch`, "a denial applies NOTHING"), so it is a second first-pass rather
than a hole; what survives is that a repeatable denial lands after every versioned migration
has committed, which the versioned comment's "EVERY pending migration" does not convey.
Codex also noted that PostgreSQL's own probe proves column set, type and nullability but NOT
defaults, primary-key semantics or collation - so "shape-verified" is narrower than it reads
even on the dialect that works. Opus: `ifNotExists` is strictly opt-in
(`ifNotExistsGuard(v) => v ? "ifNotExists" : undefined` at ops.ts:2857, and zero default-on
sites anywhere), which is what makes a refusal's blast radius self-selected.

AND ONE ALARM I RAISED AND REFUTED MYSELF. Chasing the consequence I convinced myself that
`Op::existence_guard()` returning None for `Op::Dialectal` silently strips a guard authored
inside a per-dialect leg, on every dialect including PostgreSQL. One line settles it -
render/lower.rs:4033 makes `lower_one_op` REFUSE a dialectal op ("dialectal op must be
expanded before lower_one_op"), which proves legs are expanded upstream and each leg op is
lowered carrying its own guard. The wrapper has no guard; the legs do. Recorded in #80 so
the next reader does not re-raise it.

That non-defect matters to #79's cost more than anything else here: because leg guards ARE
stamped, and `dialect()` is authorable (ops.ts:2420),

    dialect({ pg: () => table("t").create({ ..., ifNotExists: true }),
              mysql: () => table("t").create({ ... }) })

is a WORKING in-history escape hatch - full PostgreSQL guard safety, no MySQL refusal, one
history, no fork. Opus's strongest objection to the refusal was that a multi-dialect shop
would be forced to fork its history, and that objection does not survive this. I found it by
checking a thing I expected to be a defect.

NOTHING IS IMPLEMENTED. #79 is rewritten to carry the corrected mechanism and the one-unit
sequencing, and the old framing is struck from it, because a ticket that reads as a silent
data-loss hole when the behaviour is a loud declared limitation will misdirect whoever picks
it up next - which is the specific way it misdirected me.

## F66 - "Phase" is two different words, and only one of them ages (#71, #97)

#71 asked whether the comment rule ("no phase/milestone/stage references") covers deferral
vocabulary that carries no number. Settled by reading all seventeen surviving sites rather
than by ruling in the abstract, because the answer turned out to depend on which word is
actually being used.

THE RULE, with its own test cases:

  A CAPABILITY STATEMENT SAYS WHAT THE ENGINE CANNOT DO. Keep it. The reader needs it, and
  it stays true until someone changes the code, at which point they change the sentence.
      "supersession journaling is not supported on SQLite"
      "the rebuild is not built"

  A SCHEDULE CLAIM SAYS WHEN SOMEONE WILL FIX IT. Delete it. It is unkeepable by the file
  it lives in, and it is wrong the moment it ships.
      "in v1"   "deferred to a later phase"   "a later cut adds it"   "when it lands"

  "NOT YET" IS THE SCHEDULE CLAIM WEARING THE CAPABILITY STATEMENT'S CLOTHES. "yet" is a
  promise; drop the word and the sentence says the same thing about the code and stops
  making one. Six sites about the SQLite 12-step rebuild now read "is not built".

  AND "PHASE" IS SOMETIMES NOT A SCHEDULE AT ALL. Three sites use it for a stage of a
  PIPELINE, and deleting the word would cost real meaning:
      sqlite/authorizer.rs:388, :895   "the 12-step rebuild's engine ALTERs, later phase"
      render/fold.rs:8                 "later phases (`gen-types`) emit the `env.db`"
  A blanket sweep would have taken these, which is the reason #71 existed and the reason it
  is answered by reading sites rather than by choosing a vocabulary.

THE MEASUREMENT THAT PRODUCED THIS. #97 shipped the user-facing strings; the sweep then
found four release claims in comments (`zero-migrate-node/src/lib.rs:17`,
`plan/author.rs:6`, `zero-migrate-ir/src/ir.rs:648`, `zero-migrate-ir/src/validate.rs:978`),
six "not yet built", and the three pipeline uses. Seventeen sites, three verdicts.

A NOTE ON MY OWN INSTRUMENT, since it failed the way #83 and F49 keep failing. My original
#97 list was built with

    grep -rnE '"[^"]*(in v1|not yet implemented|a later cut|for now)[^"]*"' --include='*.rs' crates/*/src

which requires the literal to sit on ONE LINE. It missed `declarative.rs:4395`,
`mysql/mod.rs:847` and two others solely because those are multi-line literals, and it
missed `sqlite/mod.rs:730` because "later-phase capability" was outside the alternation. I
did not notice; the agent working the ticket found them by reading around each hit. A grep
that returns five results feels like a complete answer in a way a grep that returns zero
does not, and it is exactly as incomplete.

## F67 - The control I added while verifying something else moved the finding (#79)

F65 recorded that I had marked one claim INFERRED: that a guarded op on MySQL ERRORS rather
than silently succeeding. I had read it off the emitted DDL and the engine's prose without
running it. zeroship flagged the marker back at me, so I measured it against the live
MySQL 8 this repo's compose file serves. Exit codes captured with `$?` on a redirect:

    CREATE TABLE notes (id INT PRIMARY KEY, body VARCHAR(64));      seed,   exit 0

    CREATE TABLE notes (id INT PRIMARY KEY, body VARCHAR(255));
      ERROR 1050 (42S01) at line 1: Table 'notes' already exists            exit 1
    ALTER TABLE notes ADD COLUMN body VARCHAR(255);
      ERROR 1060 (42S21) at line 1: Duplicate column name 'body'            exit 1

The inference held. Then the control, which was two lines away once the harness existed -
the IDENTICAL shape, same columns, same widths, same key:

    CREATE TABLE notes (id INT PRIMARY KEY, body VARCHAR(64));
      ERROR 1050 (42S01) at line 1: Table 'notes' already exists            exit 1

ER_1050 IS AN EXISTENCE ERROR, NOT A SHAPE ERROR, and that changes what #79 is about. Every
sentence I had written framed the gap around DIVERGENT objects - "a re-run errors instead of
no-opping", "the guard is dropped so a divergent object errors" - and every one of them
quietly implies a MATCHING object would be fine. It is not fine. On MySQL a guarded
`createTable ifNotExists` against a table matching the declaration EXACTLY fails as hard as
against one that diverges.

So the cost is not "divergence goes unprotected on MySQL". It is ADOPTION IS IMPOSSIBLE:
the entire point of `ifNotExists` - point the engine at a database that already has the
object, verify, move on - cannot be done on MySQL for ANY object. That also means the
population #79's fix serves is larger than the ticket implied, and the escape hatch recorded
in #80 (`dialect({ pg: guarded, mysql: unguarded })`) does NOT help them: dropping the guard
on the MySQL leg still leaves bare DDL that errors on an existing table.

WHAT THIS SAYS ABOUT THE PRACTICE. The control was not in my plan. I set out to verify one
inferred sentence and added the identical-shape case because the seed was already there. A
verification pass is the cheapest moment to run the control, because the fixture is built
and the alternative is being confidently wrong for another week - and the control is what
found something, not the verification.

STILL NOT MEASURED, and I will not generalise past it: only `createTable` and `addColumn`
were tested. `createIndex`, `dropTable ifExists`, `renameTable` and the partition ops were
not. And I ran the DDL directly against MySQL rather than through the engine's apply path -
the step I bridged by reading is that the engine emits exactly this bare DDL, which
`tests/golden/sql_preview_mysql.txt:21-23` shows, but a golden is a rendering and not an
execution.

## F68 - Executing the join found a stranded journal row I had filed as a future risk (#79, #92)

F67 closed one NOT-CHECKED and left another: I had confirmed MySQL's behaviour by issuing
DDL directly, not through the engine, and said so - "a golden is a rendering, not an
execution". zeroship named the same gap on their side. I closed mine with a throwaway host
test: authored through the public DSL, lowered by the native addon, applied through
`zero-migrate-cli`'s `apply()` over the real `mysql2` seam, against a table seeded OUT OF
BAND with the EXACT shape the migration declares.

    seeded:   CREATE TABLE `notes` (id INT NOT NULL PRIMARY KEY, body VARCHAR(255))
    authored: table("notes").create({ columns: { id: t.int().notNull(), body: t.string() },
                                      primaryKey: ["id"], ifNotExists: true })
    result:   ERROR: migration mig_7n42DGM5Q8vB5mzPkuNAgR failed to apply:
                     Table 'notes' already exists

`t.string()` defaults to 255, so declaration and live table match exactly. The join holds:
what the golden RENDERS is what the apply path EXECUTES, and `ifNotExists` does not reach
the server.

THE JOURNAL DUMP WAS THREE EXTRA LINES AND IT IS THE FINDING. After the failure:

    schema_migrations:          []
    schema_migrations_inflight: [{ version: "mig_7n42DGM5Q8vB5mzPkuNAgR",
                                   name: "create_table_notes", checksum: "603f1a1d...",
                                   applied_by: "zzprobe" }]
    schema_migrations_recovery: []

Nothing completed and a STRANDED INFLIGHT ROW. The failure is not merely a red deploy; it
leaves the project needing recovery.

AND IT RELOCATES #92'S CONSTRAINT FROM THE FUTURE TO THE PRESENT. #92 records the stranded
inflight row as a consequence of the pending fix: making the projection guard-aware removes
a pre-flight refusal, so the failure moves from before the deploy into the middle of one.
This run used a SINGLE migration, which takes the empty-priors path where no such refusal
exists (`crates/zero-migrate-node/src/verbs.rs:263`). So the stranded row is what MySQL does
TODAY, for the first migration of any project whose guarded op meets an existing object. The
pending change would widen it from one migration to all of them. It does not introduce it.

That is the second time in two measurements that the incidental query beat the intended one
- the identical-shape control in F67, the journal dump here. Both were cheap only because
the rig was already standing. The rule is not "measure more", it is: WHILE THE FIXTURE IS
UP, ASK IT THE QUESTIONS YOU WERE NOT SENT TO ASK.

NOT CHECKED, and the gap is now precisely the one that matters: only `createTable`, and only
the SINGLE-migration path. The multi-migration (non-empty priors) path is the one #92 is
actually about, and I inferred its behaviour from the branch condition rather than running
it. That inference is the same kind that was wrong twice today.

The rig was deleted; `git status` is clean, `crates/zero-migrate/tests/*.rs` is 61, and
`SHOW DATABASES LIKE 'zzprobe%'` returns nothing.

## F69 - The two agents agreed on the verdict and disagreed on the placement, and the disagreement was the answer (#92)

Both were asked the same narrow question with the same required worse-case section. Both
returned (ii): ship the guard-aware projection now with a refusal for dialects that cannot
evaluate a guard. If I had asked only one, I would have implemented it in the wrong place.

WHERE THEY AGREED, and I verified each myself:
  - The projection is guard-blind by design (render/fold.rs:39-42 declares existence guards
    fold-irrelevant) and `CreateTable` returns `DuplicateTable` on NAME PRESENCE alone.
  - Do NOT gate on `Migration.existence_guard.is_some()`. That refuses `dropView`, the one
    op MySQL honours natively (render/sql_preview.rs:838-840, emitted at lower.rs:7805).
  - The empty-priors branch is not a guarantee: verbs.rs:274 is `Err(_) =>` and falls back
    to ordered lowering with a single envelope.
  - Refusal at lowering is before the authored DDL and before that migration's inflight
    marker, but NOT before `ensure_journal` and the project lock (verbs.rs:237).

WHERE THEY DISAGREED, which is the useful part. Opus proposed placing the refusal inside the
loop that already scopes to ops without completed journal evidence, calling that precedent
exactly right. Codex said explicitly do not, and gave the reason. VERIFIED BY ME at
crates/zero-migrate-node/src/lower.rs:820-838:

    completed |= steps.iter().any(|step| step_has_journal_phase(step, journal_entries, Phase::Completed));

An op is marked completed when ANY step in its ranges is completed, and no checksum is
compared anywhere in the function. So the predicate is op-level and checksum-blind, and a
partially completed multi-unit guarded op - a guarded `createTable` lowers to separately
probed table, index and FK units (render/lower.rs:4204) - would be exempted whole on the
strength of its table unit, leaving the index unit unprotected. Codex is right. I had
recorded the same coarseness independently in an earlier session, which is why I trust it
without a third opinion.

Codex's placement instead: a whole-plan preflight in `MigrationEngine::apply_plan_locked`
after journal bootstrap (engine.rs:1787), retained also after `pending` is computed
(executor.rs:908) for direct executor callers, classifying per LOWERED UNIT with explicit
lower-time metadata (ProbeRequired versus Native) rather than per raw `Op`. The whole-plan
form matters because DML and DDL interleave: checking only as a later DDL batch enters the
executor lets an earlier DML step commit first.

THE TWO WORSE-CASES ARE ABOUT DIFFERENT HALVES OF THE FIX, AND TOGETHER THEY BRACKET IT.
  - Opus, on the SATISFY branch: lower.rs:1077-1078 is
    `Op::CreateTable { name, .. } => { registry.insert(name.clone(), owner_app.to_string()); }`
    an unconditional ownership claim with no prior-owner check, running over the same op
    list at lower.rs:445-450. A `SatisfiedNoop` over a table ANOTHER app created would drop
    the op AND silently claim ownership, then journal completed - after which nothing
    re-examines it. VERIFIED BY ME at the line.
  - Codex, on the REFUSE branch: it names an EXISTING PASSING TEST that a blanket refusal
    breaks - packages/zero-migrate-cli/tests/host/existence-guard-index-scope.test.ts:249,
    "MySQL: a guarded createIndex lands on its own table under a name another table also
    uses". MySQL scopes index names per table, the target is absent, the fold succeeds and
    the bare DDL works today. VERIFIED BY ME that the test exists and says that.

So the fix must neither satisfy blindly (it would transfer ownership) nor refuse blindly (it
would break a green test and reject genuinely fresh creates). A hypothetical worse-case is
worth less than a named one: codex's costs a red test on the next run, and I would have
found it the hard way.

WHAT I MEASURED WHILE THEY RAN, both through the real path with the object seeded OUT OF
BAND at exactly the declared shape:
  - MySQL, priors path: refused at lowering, `failed to project pending schema after
    envelope "create_notes": fold: table `notes` already exists`, inflight EMPTY.
  - MySQL, no priors: reached the server, `Table 'notes' already exists`, ONE STRANDED
    inflight row (F68).
  - SQLite, priors path: APPLY SUCCEEDS. The guard is honoured and the migration completes.

That last one is the dialect asymmetry stated plainly: the same authored migration set that
SQLite applies cleanly is refused on MySQL by a projection that runs before either backend
is consulted.

A RIG FLAW WORTH RECORDING BECAUSE IT ALMOST BECAME A FINDING. My first SQLite run seeded
`notes` through the engine rather than out of band, so the table was in the HISTORY, not
only in the live catalog. Apply then failed with `failed during historical schema
projection`, which reads exactly like a refutation of the claim I was testing. It was a
different scenario. The seed method decided the answer, and the two spellings of "the table
exists" are not the same question.

NOTHING IS IMPLEMENTED. #92 carries the reconciled design; #98 (the recovery API no CLI or
SDK user can reach) and #99 (the SQLite plan/apply split) were spun out and #98 outranks
this sequencing work.

## F70 - The two opinions disagreed on the VERDICT, and one cheap measurement separates them (#98)

F69's pair split on placement. This one split on the answer. Opus: misfiled, ship the reword
only, defer the verb. Codex: ship the verb WITH the reword, and do not ship the reword alone
because "a product that can create a fail-closed state during normal MySQL operation must
also ship its audited exit path".

WHAT I VERIFIED MYSELF, and each changes the shape of the question:

  - THERE ARE TWO DEAD ENDS AND THE ONE I FILED IS THE BETTER ONE. executor.rs:1048-1056
    returns `ApplyError::ChecksumDrift` BEFORE `let had_inflight = inflight.is_some();` at
    :1057, and that message names neither the marker nor recovery. A user whose re-lower
    does not reproduce the checksum never sees the recovery instruction at all.
  - THE DOCS FORBID THE ONLY REACHABLE ACTION. docs/troubleshooting.md:461: "Do not add a
    fake completion event or delete journal rows."
  - AND THAT ACTION IS LEGITIMATE BY DESIGN. mysql/journal_sql.rs:143-147 calls the inflight
    table "The MUTABLE inflight side-table ... NOT guarded by the immutability triggers; the
    marker is deleted on successful completion or by an audited repair."
  - POSTGRESQL AUTO-RECOVERS. postgres/session.rs:835-845 calls `recover_non_transactional`,
    which clears the marker and re-arms before replaying. And MySQL's `ddl_is_transactional`
    is false, so EVERY MySQL migration writes a marker while on PostgreSQL only a
    `transaction:false` one does. Every MySQL user can get stuck; almost no PostgreSQL user
    can.
  - THE "LINK THE RUST CRATE" ESCAPE IS NOT A SHIPPED PATH. docs/embedding.md:9: "The Rust
    crate is not published yet. From this source checkout, use a path dependency."
  - RECOVERY DOES NO LIVE-SCHEMA VERIFICATION. Its complete call set is
    `journal_sql::inflight_for_update`, `append_recovery_audit`, `append_completed`,
    `clear_inflight`, `session::acquire_project_lock`, `insert_supersedes_edges`,
    `release_project_lock`. Journal and lock only. The resolution is an OPERATOR
    ATTESTATION, and the message's "the API verifies marker identity" invites a reader to
    generalise that into "the API verifies".

MY FIRST INSTRUMENT FOR THAT LAST ONE WAS BROKEN AND ITS POSITIVE CONTROL CAUGHT IT. I
grepped a line range for `snapshot_schema|information_schema|SHOW COLUMNS` and got zero -
then ran a positive control for `query|execute|INSERT|SELECT` over the SAME range and ALSO
got zero. A range containing no SQL at all cannot tell you the function issues no schema
read. The real answer came from enumerating what the function CALLS, which is the behaviour
question rather than the spelling one. The control is the only reason I did not publish the
first number.

BOTH WORSE-CASES ARE THE SAME OUTCOME REACHED FROM OPPOSITE DIRECTIONS: a completion
journaled over a table whose shape does not match the declaration. Opus reaches it through
the guard-aware projection skipping on NAME presence rather than shape; codex reaches it
through an operator running `--mark-applied-after-verification` having checked only that the
table exists. That convergence is the strongest signal in the pair: whatever ships, the
failure mode to defend is a green journal row over a wrong-shaped object.

THE DECISION, AND IT IS NOT A COMPROMISE. Two parts, because the pair separates cleanly:

  1. THE REWORD SHIPS AND DOES NOT DEPEND ON THE VERB. Both agents want it, and it must
     carry the disclaimer codex found: recovery verifies marker and source IDENTITY and
     audits the operator's assertion; IT DOES NOT VERIFY SCHEMA SHAPE. It must also amend
     docs/troubleshooting.md:461, which currently forbids the reachable action, and add the
     same pointer to the ChecksumDrift message so the reachable dead end is not fixed while
     the unreachable one stays.
  2. THE VERB IS GATED ON ONE MEASUREMENT, NOT ON A PREFERENCE. Opus objects that a CLI verb
     can only obtain its `&Migration` by re-lowering, and Node lowering projects pending ops
     onto the LIVE snapshot (zero-migrate-node/src/lower.rs:397-428), which a partially
     applied DDL may have altered - so the shipped verb could fail `MarkerMismatch` and
     leave the user stuck AND convinced the supported path is broken. Codex's own design
     requires that same re-lowering and does not resolve the objection. NEITHER MEASURED IT.
     The experiment is cheap: strand a marker, then re-lower and compare the checksum. If it
     reproduces, codex is right and the verb is sound. If it does not, Opus is right and the
     verb ships broken.

That is the honest state: I am not choosing between two arguments, I am running the
experiment that makes one of them wrong.

ALSO CORRECTED: both agents caught that my ticket listed 11 addon exports when there are 12
- I omitted `irVersion`. It does not change the reachability conclusion, and I would rather
record the miscount than quietly fix it, because I had presented the list as exhaustive.

## F71 - The experiment ran and refuted the objection it was built to test (#98)

F70 gated the recovery verb on one measurement neither agent had run: a CLI verb can only
obtain its `&Migration` by RE-LOWERING the authored files, and Node lowering projects pending
ops onto the LIVE snapshot (zero-migrate-node/src/lower.rs:397-428). If a partially applied
DDL alters that snapshot, the re-lowered checksum could diverge and the shipped verb would
fail `MarkerMismatch`.

THE SECOND APPLY IS THE DISCRIMINATOR, because the two dead ends verified in F70 are its only
outcomes: reaching the recovery message means the checksum REPRODUCED; reaching
`ApplyError::ChecksumDrift` (executor.rs:1048-1056, which runs FIRST) means it DIVERGED.

Two arms, because the easy case proves nothing about the hard one. Both against live MySQL 8
through the real path, `notes` seeded out of band:

  SIMPLE - one guarded createTable over the existing table. The failed CREATE changes
           nothing, so the catalog at re-lower time is identical.
      FIRST  -> Table 'notes' already exists
      MARKER -> checksum adcccef52eb4145738849c957b4ce8663f39de0004ddbfbdfbed73cb36af886c
      LIVE   -> [notes]
      SECOND -> "has an inflight marker from an interrupted auto-committing DDL apply ..."

  PARTIAL - two ops in ONE migration. `fresh` does not exist so op 1 SUCCEEDS and
            auto-commits; `notes` does exist so op 2 fails. The catalog HAS changed when the
            re-lower happens. This is the case the objection is about.
      FIRST  -> Table 'notes' already exists
      MARKER -> checksum ae213b13d82f11e1adebd5dc6d01740c9cdd9d2f13c9daac7fcdf025bfd487bc
      LIVE   -> [fresh, notes]          <- the control: the schema really did mutate
      SECOND -> "has an inflight marker from an interrupted auto-committing DDL apply ..."

BOTH REACH THE RECOVERY MESSAGE. The re-lower reproduces the marker's checksum even after a
DDL statement committed and changed the catalog. THE OBJECTION DOES NOT HOLD for this shape,
and the verb is obtainable.

THE `LIVE TABLES` LINE IS THE WHOLE EXPERIMENT. Without it the partial arm is
indistinguishable from the simple one - a migration refused before any DDL would produce the
identical transcript and I would have recorded a two-arm confirmation that was really one arm
run twice. I added the line only because the previous SQLite rig taught me that the seed
method decides the answer, and it is the difference between a measurement and a coincidence.

WHAT THIS SETTLES AND WHAT IT DOES NOT. It settles the point that was actually in dispute
between the two opinions: codex's position that the verb is obtainable survives, and the
soundness objection that would have blocked it does not. It does NOT settle whether the verb
should ship, because every other finding stands unchanged - recovery performs no live-schema
verification, both worse-cases converge on a green journal row over a wrong-shaped table, and
the reword is required either way.

NOT TESTED, and the gap is specific: only ONE shape of partial application, where a preceding
`CREATE TABLE` committed. An `ALTER` that half-changed a column the lowering reads to build
its plan is a different shape, and a guarded op is exactly where the projection consults live
state. I would not generalise from two arms to "re-lowering is always stable".

## F72 - The reword shipped, and the three docs it did not touch now understate the repair (#98 Part 1)

F70 split #98 into a reword that ships independently and a verb gated on a measurement; F71
ran the measurement and unblocked the verb. This is the reword.

WHAT CHANGED. The MySQL inflight refusal now names two repairs: the reachable
`DELETE FROM <meta>.schema_migrations_inflight WHERE version = '<v>'`, printed with the
project's real meta database and version substituted, and `recover_inflight_ddl` as the
Rust-host alternative with what it adds stated (marker-identity check, immutable audit row).
Both carry the sentence that matters most: neither route inspects the database, so recovery
records the operator's assertion rather than verifying it. `ChecksumDrift` gets the same
pointer because it returns BEFORE the inflight branch and named neither the marker nor a
repair. `docs/troubleshooting.md` and `docs/operations.md` stop forbidding the reachable
action by separating the mutable marker table from the append-only events table.

VERIFIED BY ME, not taken from the agent:
  - The modified existing test is PURELY ADDITIVE. All four original conjuncts survive
    (`inflight`, `inspect`, `recover_inflight_ddl`, the version) and three were added. The
    only `-` line is a conjunct moving position.
  - THE RED IS REAL WITHOUT REVERTING ANYTHING. `git show HEAD:...session.rs` contains
    "recovery does NOT verify schema shape" 0 times and "schema_migrations_inflight WHERE
    version" 0 times, while containing `recover_inflight_ddl` once - so the kept conjunct
    passes on the old text and the two new ones cannot. That is the assertion's strength
    proven by construction rather than by watching it fail.
  - THE PRINTED DATABASE NAME IS THE RIGHT ONE. The message interpolates
    `quote_ident_mysql(&cfg.pg.meta_schema)`, and `cfg.pg.meta_schema` is the same field
    `journal_sql.rs:85` uses to build the meta database and `:200`/`:250`/`:300` pass as the
    schema parameter. A confidently wrong DELETE would have been worse than the old message.
  - `quote_ident_mysql` rejects only empty and NUL-bearing identifiers, so the `?` on the
    error path cannot realistically mask the refusal.
Gates run by me with both DB URLs exported: fmt 0, clippy 0, workspace 74 targets / 2227
passed / 0 failed / 0 ignored. 61 test files. No count moved, because the agent extended
`crashed_ddl_is_not_blindly_replayed` rather than adding a test.

THE AGENT TOUCHED ONE SITE BEYOND ITS BRIEF AND WAS RIGHT TO. `docs/operations.md:456-487`
sits 150 lines above the checklist it was asked to fix and said "A Rust host resolves it with
`MysqlBackend::recover_inflight_ddl`" as though that were the only resolution. Left alone,
the file would have contradicted itself after the fix. It flagged the excursion rather than
burying it, which is the behaviour I want - a brief's line list is a starting set, not a
fence, and the test of an excursion is whether it was declared.

WHAT IS NOW INCONSISTENT, and it is the honest cost of a scoped fix: three further docs carry
the Rust-host-only framing and were deliberately left - `docs/dialects.md:370-378`,
`docs/security-model.md:296-302`, `docs/embedding.md:145`. They now UNDERSTATE the repair
relative to the two files that were corrected. A reader who lands on dialects.md still
believes the only route is an API they cannot reach. That is a smaller defect than the one
just fixed and it is the same defect, so it should not sit long.

ALSO UNTOUCHED: `RollbackError::ChecksumDrift` (executor.rs:1943) carries the identical
original message text. The rollback path has no inflight-marker involvement, so the pointer
would be wrong there - but the two variants having the same words and different correctness
is the kind of thing that reads as an oversight later.

NOT MEASURED: the printed DELETE was never executed against a live MySQL to confirm the
privilege claim. That rests on `clear_inflight` (journal_sql.rs:671-683) issuing the same
statement on every successful apply, which is a read, not a run.

## F73 - The inherited list was incomplete in the file I had already fixed (#100)

F72 recorded three docs left carrying the Rust-host-only framing and filed them as #100. I
briefed the sweep with those three line numbers and told it not to trust them, because a list
I inherited is exactly the kind of thing that turns out incomplete. It was.

ALL THREE WERE REAL, and each was slightly off in position - dialects.md's paragraph is
370-377 not 370-378, security-model.md's list runs 297-303 not 296-302, and embedding.md:145
is INSIDE a code block, with the prose framing two lines above and three below. Reported
line numbers point NEAR the thing; they are a starting address, not a citation.

THE FOURTH WAS IN THE FILE I HAD ALREADY CORRECTED. docs/troubleshooting.md:587, about a
hundred lines below the section 3c316a3 rewrote, said "Do not edit or delete journal rows to
make status look healthy" - a near-verbatim repeat of the exact sentence that commit
identified as the root problem. The file contradicted itself, and my own fix is what made it
a contradiction rather than a consistent error.

That is the lesson worth keeping: FIXING A SITE MAKES ITS UNFIXED SIBLINGS WORSE, because a
reader can no longer tell which statement is current. A partial correction is not half a
correction; it is a new defect of a different kind. The sweep that follows a fix is not
tidying, it is part of the fix.

A SECOND ERROR I HAD NOT NOTICED, found while correcting the first. security-model.md listed
"and verified live shape" among the arguments to `recover_inflight_ddl`, which reads as an
argument the API checks. Nothing is checked - the call set is journal and lock operations
only (F70). In a security document that is the sentence that matters most, and it said the
opposite of the truth. Now stated as the operator's own step.

THE ROLLBACK VARIANT: CHANGED, on a reason I verified rather than the one I had. I filed it
as "two same-named variants with different words reads as an oversight", which is cosmetic.
The real argument is failure-mode: leaving it bare invites the next reader to fix the
asymmetry the obvious way, by copying the apply wording, which would tell operators to look
for a marker that cannot exist there. VERIFIED BY ME at executor.rs:2396 and :2419-2431 -
`selected` comes from `select_rollback_versions(&request.target, applied)`, and the compare
uses `record.checksum` from those applied records, so `recorded` is always a completed event
on that path. The durable part of the change is the doc comment saying "Do not copy the apply
wording across: the marker pointer would be false here."

MY OWN CALL ON THE ONE ITEM LEFT TO ME. The production checklist read "MySQL DDL has an
AUDITED inflight repair procedure". The audit row is obtainable only from the route a CLI or
Node operator cannot reach, so the checklist demanded evidence the product does not offer
them. Changed to "reviewed". One word, and it was the word the whole ticket is about.

Gates run by me with both DB URLs exported: fmt 0, clippy 0, workspace 74 targets / 2227
passed / 0 failed / 0 ignored, 61 test files. Both new doc anchors verified against the
actual heading text (operations.md:623, troubleshooting.md:454).

NOT DONE: no test pins the new rollback message. The apply-side equivalent IS pinned by
`crashed_ddl_is_not_blindly_replayed`, so the two variants now have unequal protection - the
one an operator is more likely to see is the guarded one, which is the right way round, but
it is an asymmetry rather than a decision.

## F74 - The agent solved hazard 1 better than I specified it (#92, first slice)

> CORRECTED BY F75 AND F77. The stated reason SQLite went unexercised ("the Node host
> `DriverConfig` has no SQLite seam") is FALSE - it has one. And the ownership invariant this
> entry credits with covering "present but owned by ANOTHER app" does not reach that case;
> `enforce_ir_ownership` refuses it upstream. The check itself was removed in 6dab519.

F69 reconciled the design; this is the PostgreSQL/SQLite slice. The projection now asks the
executor's own `existence_probe::decide`, per lowered UNIT, and drops an op only when every
unit is `SatisfiedNoop`.

I BRIEFED HAZARD 1 AS A NAME LOOKUP AND GOT AN INVARIANT INSTEAD. My instruction was
"refuse when a SatisfiedNoop createTable's target is absent from the incoming registry".
What shipped is:

    let mut projected = registry.clone();
    advance_ownership_registry(&mut projected, std::slice::from_ref(op), dialect, owner_app);
    projected == *registry

an op the guard drops must leave the ownership registry UNCHANGED. Because `lower.rs:1077`
inserts this app unconditionally, that holds exactly when the registry already records this
project as the owner - so it covers my case, plus the one I did not name (present but owned
by ANOTHER app, where the insert overwrites), plus every other registry-mutating op, with no
enumeration. My version would have needed a new clause per op; this one cannot fall behind
the ops list because it asks the mutation itself.

That is the difference between specifying a CHECK and specifying the PROPERTY the check
exists to preserve. I specified the check.

VERIFIED BY ME WITH AN ENV-GATED MUTATION, RED and GREEN from the SAME compiled artifact -
one `napi build`, the branch forced to `NotSatisfied` behind `ZM_MUT_GUARD_OFF`:

    mutation ON   1 FAIL  2 FAIL  3 FAIL   4 PASS (unguarded control)  5 PASS (MySQL scope)
    mutation OFF  1 PASS  2 PASS  3 PASS   4 PASS                      5 PASS

BOTH CONTROLS HOLD IN BOTH DIRECTIONS, which is the property that matters: the unguarded
control and the MySQL leg are unaffected by the mutation, so they are testing something
other than the branch under test. A control that moves with the mutation is not a control.

Arm 3 is the one worth naming. It REFUSED before the fix too - with "already exists" - so a
pass/fail assertion would have been green on the broken code. It asserts on `/ownership/`,
which is what makes it a real RED rather than an accidental one, and it is exactly the state
in which a careless widening would have transferred ownership silently.

Gates run by me, both DB URLs exported: fmt 0, clippy 0, workspace 74 targets / 2227 passed /
0 failed (unmoved), package 223/222/0/1, host 107 -> 112 (the five new arms, no existing test
moved), 61 test files, no residue of the mutation.

THE DECLARED GAP THAT MATTERS. SQLite is IN SCOPE of the change (`dialect != Mysql`) and is
NOT MEASURED: the Node host `DriverConfig` has no SQLite seam, so no arm drives it through
the real path. The agent said so plainly rather than letting "PostgreSQL and SQLite" in the
brief imply both were exercised. That is half the stated scope resting on reading, and #99 -
where SQLite's plan and apply already disagree - is the ticket that will have to close it.

ALSO NOT MEASURED: guarded ops other than `createTable`; a partially matching table whose
secondary index is absent (the per-unit rule is designed for it and no arm proves it); and
multi-op interaction inside one envelope, which the doc comment now states is out of scope
because the projection asks about the base snapshot.

## F75 - #99 was already fixed, and the reason I recorded for its gap was wrong (#99, #102)

Two corrections and one new defect.

THE HEADLINE CLAIM WAS ALREADY CLOSED. #99 said SQLite `plan`/`status` refuse a guarded
migration that `apply` runs. Measured against the real CLI on live SQLite, two identical
databases from one seed: plan exit 0 and apply exit 0, agreeing. `ea8d3ff` fixed it, because
SQLite is `dialect != Mysql` and the projection now asks the probe. The right outcome for
#99 was a test pinning the agreement, not a fix - which is the outcome I told the agent to
prefer, and it is worth noting that "the ticket is already fixed" only surfaced because the
brief asked for a measurement BEFORE a change.

F74'S STATED REASON FOR THE GAP WAS WRONG, AND IT WAS MY SENTENCE. I recorded that SQLite
went unexercised because "the Node host `DriverConfig` has no SQLite seam". It has one:
`packages/zero-migrate-cli/src/index.ts:73` is
`| { kind: "sqlite"; appPath: string; journalPath: string }`, and both `apply()` and
`statusEnvelopes({ readOnly: true })` accept it. The real obstacle was narrower - the
un-exported `authorEnvelope` - and it has a workaround I did not look for: the exported
`plan()` returns the envelope it authored. I took a reported obstacle and wrote it down as a
structural fact without checking whether the structure said so.

THE NEW DEFECT IS THE ONE WORTH KEEPING (#102). With the target absent from the incoming
registry:

    plan  -> exit 1, "the existence guard is satisfied, but dropping the operation would
                      change project ownership the incoming registry does not record"
    apply -> exit 0, and `schema_migrations` carries the migration as COMPLETED

SQLite apply silently adopts a table this project does not own. On PostgreSQL both refuse,
because PG's apply routes through the same projection. VERIFIED BY ME structurally:
`guard_skip_preserves_ownership` exists in exactly two places, both in the NODE crate
(`crates/zero-migrate-node/src/lower.rs:1031` and its one call site at `:444`), while SQLite
apply goes `index.ts:186` -> `applyIrSqlite` -> `bridge.rs:748` -> `deploy_envelopes`, which
lives in the ENGINE crate and cannot see it.

So the ownership invariant ea8d3ff added is PLAN-TIME ONLY. That is worse than no check in
one specific way: the refusal tells the operator the engine enforces project ownership, and
on the path they may actually run, it does not. Not fixed here - it changes shipped SQLite
apply semantics and the check lives in the wrong crate for the fix.

NOT MEASURED: whether a Rust embedder calling `deploy_envelopes` directly loses the same
invariant on PostgreSQL and MySQL too. Structurally it should, since the check is in the node
layer, and if so the guard protects the CLI's PG path and nothing else. That is the first
thing to settle on #102.

Gates run by me: fmt 0, clippy 0, workspace 74 targets / 2227 passed / 0 failed, package
223/222/0/1, host 112 -> 115, 61 test files, probe project removed, no mutation residue in
the shipped addon.

## F76 - Which drafts were ever exposed by the masked hole, and a grep scope that nearly made me contradict a correct message

zeroship closed the last cell of the 17b297a matrix by running the two-layer masked hole at
their PRE-FIX pin, which is the only direction my tree cannot reach. The bug reproduces:
ADMITTED. Combined with the three cells already measured, the fix closes a real hole and
leaves legitimate single-layer charters alone.

THE FINDING THAT REFINES MY OWN COMMIT. 17b297a's body says the single witness "sat outside
it, where the charter still granted". True, and it understates a boundary condition worth
stating outright:

    A DRAFT NARROWER THAN OR EQUAL TO THE MASK IS REFUSED EVEN PRE-FIX.
    ONLY A DRAFT SPANNING BOTH REGIONS SLIPS THROUGH.

Measured by them at the pre-fix pin: a draft scoped to `secret` alone is REFUSED
(`GrantExceedsCharter`), because a draft whose scope IS the mask gets its witness inside the
mask, where the charter says false. The escape needs the draft to span the boundary so the
single witness lands in the granted part and the mask is never sampled.

VERIFIED BY ME that my own regression test only exercises the spanning shape:
`crates/zero-migrate-policy/tests/compose_oracle.rs:1580`, the refused draft is
`scope = "all"` with the comment "An untrusted draft re-granting over the whole universe
must be refused." So the test pins the exposed shape and says nothing about the narrower one
- correctly, since the narrower one was never exposed.

That matters to anyone auditing whether they were affected: it is not "any draft re-granting
a masked key", it is "a draft whose scope crosses the mask boundary".

AND I NEARLY CONTRADICTED THEM WITH A SCOPED GREP. They noted they built their probe with
`effective_policy_from_charter_layers` rather than my test's
`finalize_charter(overlay(...))`. I grepped for it in `crates/zero-migrate-policy/src` and
got EXIT 1 - nothing. The obvious reading is "that function does not exist at my HEAD", which
would have been a confident, wrong correction of a correct message.

It exists. Nineteen hits, in a different crate: `crates/zero-migrate/` uses it, including
`crates/zero-migrate/tests/layered_policy.rs:4`. My grep was scoped to the crate I assumed
owned the concept, and the assumption was the error, not the pattern.

The positive control I ran (`finalize_charter` IS in the policy crate) proved the DIRECTORY
was readable and told me nothing about whether the SYMBOL was elsewhere. A control proves the
instrument can see inside the scope it was given; it cannot tell you the scope was wrong.
That is a distinct failure from the ones catalogued so far - not a bounded output, not a
guessed window, but a search whose universe was chosen by a belief about where code lives.

STILL OPEN, and it is their caveat, not mine to close by reading: whether
`effective_policy_from_charter_layers(&[root, mask])` and
`finalize_charter(overlay(&root, &mask, &reg))` produce equivalent layer stacks. Both
implement the charter surface; they are different construction paths and nobody has verified
they agree. Their ADMITTED describes the first. My regression test describes the second. If
the paths diverge pre-fix, the matrix has a cell nobody has actually filled.

## F77 - The same scoped-grep failure, one hour after I wrote it down (#102, corrects F74)

F76 catalogued a fourth instrument shape: a search whose UNIVERSE was chosen by a belief
about where code lives. I then made that exact error again, in the ticket I filed the same
hour, and an agent caught it.

MY #102 PREMISE IS FALSE. I claimed the ownership invariant lives only in the node crate and
that `deploy_envelopes` therefore cannot enforce ownership at all. I had grepped for
`guard_skip_preserves_ownership` - MY symbol, added hours earlier - and concluded from its
absence that the CONCEPT was absent. VERIFIED, the engine enforces ownership on every path:

    crates/zero-migrate/src/engine.rs:497   author.load_and_lower_guarded(.., app, &effective_registry, ..)
    crates/zero-migrate/src/model/load.rs:67    enforce_ir_ownership(&ir, deploying_app, registry)?
    crates/zero-migrate/src/model/load.rs:23    pub use zero_migrate_ir::load::*;

The checker lives in a THIRD crate, `zero-migrate-ir`, re-exported through the engine. Two
crates in my search universe, three in the answer. So a Rust embedder calling
`deploy_envelopes` does get per-table ownership enforcement on PostgreSQL, MySQL and SQLite -
the hypothesis "the guard protects the CLI's PostgreSQL path and nothing else" is refuted.

THE REAL GAP IS ONE CASE. `enforce_ir_ownership` pre-registers every `createTable` target
with `owners.entry(table).or_insert(deploying_app)` - the documented DECLARER RULE. A table
the registry names as another app's is already refused, everywhere, SQLite apply included. A
table the registry does not name is CLAIMED. That is sound when declaring and unsound when
ADOPTING an object that already exists out of band, and the engine never consults the live
catalog for ownership, so it cannot tell the two apart.

TWO CORRECTIONS TO F74, both mine:

  1. F74 credits the invariant with covering "present but owned by ANOTHER app, where the
     insert overwrites - the one I did not name". It does not reach that case:
     `enforce_ir_ownership` refuses it upstream, before the projection loop runs. The only
     reachable input for `guard_skip_preserves_ownership` is ABSENT FROM THE REGISTRY.
     REPORTED as INFERRED by the agent and NOT yet confirmed by mutation; that confirmation
     is the first thing to run.
  2. The test comment I shipped says the arm covers the case where "some OTHER app created
     it". Per (1) that is not what it tests. It tests a maintained registry that omits the
     table.

AND THE ONE THAT MATTERS MOST: THE REGISTRY DEFAULTS TO EMPTY. VERIFIED at
`packages/zero-migrate-cli/src/cli.ts:439` - `loadRegistry(undefined)` returns `{}` - and
`--registry` is optional, flattened at four `opts.registry ?? {}` sites in
`packages/zero-migrate-cli/src/index.ts`. So for every user who never passes `--registry`,
"absent from the registry" is the DEFAULT STATE, not evidence of foreign ownership.

The consequence for what I shipped in ea8d3ff: the guard-aware projection's benefit is
UNAVAILABLE to those users. Their guarded adoption still refuses - not with the old
"fold: table already exists", but with an ownership message that blames project ownership for
a missing CLI flag. Not a behaviour regression, since it refused before too, but the fix does
not do for the default configuration what its commit message says it does, and the new
message is less accurate than the old one for that population.

My host arm passes `{ [BASE_TABLE]: OWNER_APP }` - a maintained registry that omits the
table, which is the meaningful case. The EMPTY registry, which is the common one, is
untested.

NOTHING IS CHANGED YET. Codex is still running on the same question and the fix is not
obvious: gating the refusal on "a registry was supplied" would disable the alarm exactly when
a CI refactor silently drops the flag, which is the agent's own worse-case and a good one.

## F78 - Both agents said (C), and codex found the tested contract my own fix contradicts (#102)

The pair split on reasoning and converged on the verdict. Opus refuted my premise (the engine
DOES enforce ownership, via `enforce_ir_ownership` in a third crate - F77). Codex accepted
that and found the thing that settles what to do about it.

THE DECIDING EVIDENCE, VERIFIED BY ME. `packages/zero-migrate-cli/tests/host/existence-guard-varchar-adoption.test.ts`
seeds a table OUT OF BAND, passes `registry: {}`, and requires the guarded adoption to
SUCCEED. It carries no `priorMigrations` (grep exit 1), so it takes the empty-priors branch
at `verbs.rs:263` and never reaches the projection. It comes from commit `9d1e0fd` - my own
#94 fix - whose message calls adoption "the principal case the guard exists for".

So for one authored scenario:

    empty priors     -> ADOPTS   (tested, required, mine, hours earlier)
    non-empty priors -> REFUSES  (ownership, mine, hours later)

The two never collide because they take different branches, which is exactly why I did not
notice. I shipped a refusal that contradicts a contract I had shipped the same day, and the
suite stayed green because no test crosses the branch.

WHAT THE LOADER ALREADY DISTINGUISHES, and what my helper conflates
(`crates/zero-migrate-ir/src/load.rs:321` and around `:341`):

    registry does not name the table   -> declarer rule, the deploying app owns it
    registry names ANOTHER app         -> preserved, and refused

My `guard_skip_preserves_ownership` treats both as "would change ownership, refuse". The
first is the default state for anyone not passing `--registry`, and the second is already
refused upstream before the projection runs.

CODEX'S COVERAGE TABLE, which corrects mine in both directions. REPORTED, and I verified only
the rows marked:

    Rust deploy_envelopes, PostgreSQL   silently adopts, journals completed
    Rust deploy_envelopes, SQLite       silently adopts, journals completed
    Rust deploy_envelopes, MySQL        does NOT adopt - bare CREATE errors, marker stranded
    CLI PostgreSQL, no priors           silently adopts   <- VERIFIED BY ME via the test above
    CLI PostgreSQL, non-empty priors    projection refuses <- VERIFIED BY ME, host arm
    CLI SQLite apply                    adopts; plan refuses <- VERIFIED BY ME, F75

THE DECISION: narrow the refusal rather than mirror or delete it. Refuse only when the
registry EXPLICITLY names a different owner; let an absent entry take the declarer rule, so
the priors path matches the empty-priors path that is already tested. Then settle whether the
explicit-foreign-owner branch is reachable at all - Opus says `enforce_ir_ownership` refuses
it upstream, INFERRED and not confirmed by mutation. If it is unreachable, the honest outcome
is to remove the helper and say why, not to keep a branch nothing can select.

CODEX'S WORSE-CASE IS THE COUNTERWEIGHT AND IT IS REAL: an incomplete registry that omits
`accounts`, app A applying a matching guarded `createTable("accounts")` followed by an
approved `dropColumn("accounts", "ssn")`. Under the narrowing, A adopts and then drops app
B's column; today's projection refuses at the create. So the narrowing removes real
defence-in-depth against an incomplete registry - and the counter to THAT is that the same
attack already succeeds today by simply having empty priors.

That is the shape of the whole finding: the protection was never a protection, it was an
accident of which branch the migration count selects.

## F79 - For an absence result, the control has to live OUTSIDE the scope you searched

F76 catalogued a fourth instrument shape - a search whose universe was chosen by a belief
about where code lives - and noted that a positive control does not rescue it: the control
proves the instrument can see INSIDE the scope, and nothing inside the scope can report that
the scope is wrong. zeroship turned that into a rule I can actually follow:

    FOR AN ABSENCE RESULT, THE CONTROL MUST LIVE OUTSIDE THE SCOPE BEING SEARCHED.
    Grepping the whole tree and then narrowing is cheap. Grepping a directory you chose and
    then controlling within it proves nothing about the choice.

Applied to my own case: searching `crates/zero-migrate-policy/src` twice - once for the
symbol, once for `finalize_charter` as a control - could never have found
`effective_policy_from_charter_layers`, because it lives in `crates/zero-migrate/`. Searching
`crates/` and reading the file list catches it immediately. The cheap move is to start wide
and narrow, not to start narrow and validate.

This also retires a habit I have been applying all day without noticing its limit: I ran
positive controls diligently for grep-shaped questions, and every one of them was INSIDE the
scope I had already chosen. They were rescuing the pattern, never the universe.

ALSO CLOSED, and it makes an earlier entry stronger. zeroship ran BOTH charter constructions
at their pre-fix pin - `effective_policy_from_charter_layers(&[root, mask])` and
`finalize_charter(overlay(&root, &mask, &reg))` - and both ADMIT. The second is the
construction my own regression test uses, so the two-layer cell is now a clean before/after
on ONE path:

    path B, pre-fix   ADMITTED   measured by them
    path B, post-fix  REFUSED    my regression test at compose_oracle.rs:1580

Before this the pairing crossed constructions, and F76 recorded that as an open gap. My green
test now has a verified before-picture rather than an assumed one.

STILL NOT ESTABLISHED, and narrower than F76 left it: general equivalence of the two
constructions. One document pair, one draft shape, one pin. The `finalize_charter` lints are
the obvious place they could diverge and nobody has looked.

## F80 - A green suite across a branch nobody crosses, and two checks that catch it

F78 recorded that the ownership refusal I shipped contradicts an adoption contract I shipped
the same day, and that they never collide because one takes the empty-priors branch and the
other the priors branch. zeroship named the class and supplied a detector, plus a second
check that applies to something I do constantly.

THE CLASS. Every instrument failure catalogued so far - F66, F76, F79 - is about a SEARCH
that cannot see. This one is about a TEST SUITE that cannot see, and it is worse, because a
green suite is what everyone treats as the answer. Their instance: a test named for a process
restart drops an outbox and reopens it, hand-passing the same path to both opens, while
production derives that path from a per-boot UUID and never reopens the same file. The test
asserted a property the system does not have, passed, and its passing is why the gap
survived.

THE DETECTOR, and it is the only one either of us has for this:

    Of a GREEN test, ask: what would production have to do for this assertion to be
    reachable? If the answer is "something it never does", the assertion is decorative.

Mine fails that question in the same way: the two contracts are both green and no product
invocation crosses from one branch to the other, so neither test can ever observe the
other's condition.

THE SECOND CHECK, which applies to how I write comments. They claimed in a doc comment that
a test "fails if someone bounds the count with a constant", then ran the mutations instead of
trusting the sentence. `n.min(65535)` - the capacity-capping form - left the test GREEN,
because the vector still grows past its reservation. Only the REJECTING form,
`if n > 65535 { return Err(..) }`, turned it red. The claim was true of one mutation in the
class and false of another, and the comment stated the general form.

    A COMMENT CLAIMING WHAT A TEST CATCHES MUST NAME THE MUTATIONS ACTUALLY RUN,
    NOT THE CLASS IT HOPES TO COVER.

I have been writing exactly that kind of general claim all day - "the control does not move
with the mutation", "this arm is what makes it a real RED" - each verified against ONE
mutation. Those claims are true as far as they were tested and stated more broadly than they
were tested.

AND THE SCOPE FAILURE SURVIVES BEING WRITTEN DOWN. They adopted F79's amendment and hit the
same failure an hour later: reviewing 27 clippy-flagged numeric casts, all 27 accounted for,
a clean negative - while the actual defect had NO lint, because `u32 as usize` is widening on
64-bit and clippy does not fire. A 6-byte frame requesting ~16 GiB. Their search universe was
"the sites the tool flagged", which is the most seductive scope of all, because it arrives
pre-justified.

That is the second time today the lesson has been that adopting a rule does not prevent the
failure the rule describes. Recording it is not the same as being protected by it.

## F81 - The instrument that would have given the right answer while broken (#102)

The check I shipped in ea8d3ff is removed. The reasoning is in the commit; what belongs here
is how the answer was obtained, because the first instrument nearly supplied it by accident.

THE QUESTION was whether the explicit-foreign-owner branch is reachable at the projection at
all - Opus said no, INFERRED. The agent's first probe was an `eprintln!` inside
`guard_skip_preserves_ownership`. IT DEADLOCKED THE ADDON: the adopt arm hung for 600s with
"Promise resolution is still pending", while the same binary without the env var passed in
350ms.

Reading "no trace lines appeared" off that run would have produced THE CORRECT ANSWER FROM A
BROKEN TOOL. Unreachable is what no-trace-lines means, and unreachable is the truth - so the
conclusion would have been right, the reasoning would have been worthless, and nothing in the
output would have said so. It was replaced with a file sink and re-run with a positive
control:

    registry names THIS app (control) -> trace WRITTEN, op=CreateTable{ existence_guard: Some }
    registry names ANOTHER app        -> trace NEVER CREATED, refused upstream with
                                         "ownership violation: op 0 targets table \"notes\"
                                          owned by app_guard_fold_other"

That is the F80 lesson arriving from the other direction. F80 was a green TEST that could not
see; this is a green ANSWER that could not see. Both are cases where the output is
indistinguishable from the output you would get if the instrument worked, and the only
defence is a control that must produce something.

FIVE MUTATIONS, ONE ARTIFACT, and the table is the point:

    refuse if dropping would CHANGE the registry (ea8d3ff)   parity only turns red
    refuse if it would NOT change it (inverted)              both ADOPT arms red, parity GREEN
    refuse only on explicit foreign owner (narrowed)         NOTHING turns red
    no check at all (what ships)                             nothing turns red
    enforce_ir_ownership -> Ok(()) (loader gate off)         foreign-owner arm only

Row three is why the helper was deleted rather than narrowed: narrowing is INDISTINGUISHABLE
FROM DELETION on every input the suite can construct, which is what "unreachable" means when
you stop reasoning about it and measure. Row two is why the test's comment does not claim it
catches changes to the ownership check - the parity arm catches exactly one form, and saying
otherwise would have been the zeroship mutation error verbatim.

THE COORDINATOR CHECK THAT CHANGED THE TEST. I sent the agent F80's detector mid-run: of a
green test, ask what production would have to do for the assertion to be reachable. Applied
to a PARITY test the answer is sharp - a parity assertion passes just as happily when both
halves take the SAME branch. So it added a branch witness that drives the one shape both
paths refuse and requires the refusals to come from DIFFERENT layers:

    non-empty priors -> "failed to project pending schema ...: fold: table `notes` already exists"
    empty priors     -> "migration mig_7n42... failed to apply: relation \"notes\" already exists"

The empty-priors half is refused by PostgreSQL itself at execution and never builds a
projection. The fork at verbs.rs:263 is now an assertion rather than a comment. That is the
first time today one of these lessons changed work in flight instead of describing work
already done.

ONE DEVIATION, FLAGGED BY THE AGENT AND ACCEPTED: the brief said keep a foreign-owner arm
only if the branch is reachable. It is not, and the arm was kept anyway - repurposed to pin
the LOADER, asserting the full "ownership violation ... owned by app_guard_fold_other"
instead of a bare /ownership/. Mutation five proves it is load-bearing there. The loose regex
is also what let the retired arm look green while testing the wrong layer.

Gates run by me: fmt 0, clippy 0, workspace 74 targets / 2227 passed / 0 failed (unmoved),
package 223/222/0/1 (unmoved), host 115 -> 117, 61 test files, no ZM_MUT residue, helper gone.

NOT MEASURED, and the list is the honest cost of the removal: guarded ops other than
createTable lose the same refusal and no arm drives one; whether the foreign-owner branch is
unreachable for those ops too; MySQL and SQLite foreign-owner behaviour (the reachability
experiment was PostgreSQL only); and the counterweight sequence itself - the `accounts` +
dropColumn("ssn") adoption - which is asserted by construction and never run.

## F82 - A false negative that leads to a true statement leaves no evidence behind

zeroship applied F80's two-mutation observation to their own tree and found three claims of
the same shape, one committed twenty minutes earlier. The transferable part is not the count.

THE PROPOSITION SUBSTITUTION. They had verified a derivation by mutation - collapse it to a
constant, the test goes red - and then written a comment claiming the test "must go red when
the WAL is made to survive a restart". Those are different propositions. The mutation proved
THE DERIVATION IS USED; the comment promised A TRIPWIRE FOR THE DEFECT. The per-boot UUID is
minted in two binaries their test's crate cannot see, so the repair anyone would actually
make leaves the test green.

That is the exact move I have been making. Every mutation I ran today proved a specific
substitution changes a specific arm. Several of my comments then generalised to "this catches
regressions of this kind". The mutation licenses the first sentence and not the second, and
the gap is invisible because the first sentence is true.

AND THE LINE THAT NAMES WHY THIS CLASS SURVIVES:

    A FALSE NEGATIVE THAT LEADS TO A TRUE STATEMENT LEAVES NO EVIDENCE BEHIND AT ALL.

Their fourth instrument instance: grepping `registry.build(` returned nothing because the
call is split across lines, and the silence confirmed what they were about to write anyway.
Re-grepping `build(` found it immediately. The conclusion was CORRECT - so had they shipped
it, nothing in the tree, the log, or the reasoning would ever have recorded that the search
could not have seen a counterexample.

That is the same shape as F81's deadlocked probe, which would have produced the right answer
from a broken tool, and it explains why both of us keep finding these late: the failure only
leaves a trace when it happens to also be wrong. Every time it is right, it is invisible and
compounds into confidence.

WHAT I OWE ON MY SIDE. The comments I wrote today claim what a test catches, and each was
verified against one mutation. F81's five-mutation table is the only one where the claim and
the evidence match, and that is because a peer's error made me demand it of an agent rather
than of myself. The rest should be read as narrower than they are written until checked.

## F83 - The repo already had the discipline, and my version of it is missing the half that matters

> CORRECTED BY F85. This entry attributes the false "no SQLite seam" comment to
> `existence-guard-varchar-adoption.test.ts`. That file never carried it; the claim lived in
> four siblings. I read the line out of an aggregated `git log -p` and assigned it by
> proximity.

zeroship ran the audit I had only queued, and found their repo already carried an explicit
catches / does-NOT-catch pair, written before either of us named the move, in a crate they
had been reading all day - because they brought a defect-hunting scope to the file rather
than a convention-hunting one. I ran the same check here, searching WIDE first per F79.

MY TREE HAS IT TOO, in two places, both predating this session:

    crates/zero-migrate-guard/src/analysis/classify.rs:786-795
    crates/zero-migrate/src/plan/manifest.rs:8-18

And both are BETTER THAN WHAT I HAVE BEEN WRITING. `classify.rs` enumerates what the pass
does not catch and, for each item, NAMES WHERE IT IS CAUGHT INSTEAD - "the guard's deny-list
+ cross-schema confinement own these", "falls to the line-2 least-privilege `migrator`
role", "guard + role govern it" - and closes one item with "noted, not silently narrowed",
which is the principle I have spent the day re-deriving.

THE GAP IN MINE IS SPECIFIC. Every "Does NOT cover" I wrote today states the exclusion and
stops:

    "Does NOT cover guarded ops other than `createTable` ..."
    "Does NOT cover SQLite (the Node host DriverConfig has no SQLite seam) ..."
    "Does NOT cover MySQL (`mysql_canonical_type` folds `varchar(N)` to `text` ...)"

Two of those give a REASON, which is better than nothing, and none says whether the excluded
class is caught SOMEWHERE ELSE or not caught at all. That difference is the whole value: it
tells the reader whether the gap is a HOLE or a HANDOFF. A handoff needs no action; a hole is
a ticket. My comments make them indistinguishable, which is the same failure as a green test
that cannot be told from a green test that never ran.

Worse, one of the lines above is a reason that turned out to be FALSE - "the Node host
DriverConfig has no SQLite seam" (F75 corrects it; the seam exists). A stated reason invites
trust in proportion to its specificity, so a wrong one costs more than none.

THE ADOPTED FORM, taken from the house pattern rather than invented:

    Does NOT cover X. <Where X is caught instead, or plainly that it is not caught.>

STILL NOT DONE, and I will not claim otherwise: sweeping the PRE-EXISTING comments in this
tree for the same substitution. The two I found are the ones matching a narrow phrasing; the
wider class - comments asserting what a test catches - is unaudited. Both of us now have that
same open item, which is itself evidence about how much of it there is.

## F84 - The exclusion and the handoff are two claims, and only one is licensed by writing the test

zeroship found the same half-written pattern on their side and both of their exclusions
turned out to be HOLES, checked rather than assumed - two greps changed both answers from
"presumably somewhere" to "nowhere". The refinement they added is the part I want kept:

    The exclusion and the handoff are two separate claims, and only the FIRST is licensed by
    having written the test. The second is a claim about the REST of the suite.

That is why the missing half is not a stylistic gap. Writing a test tells you what it covers.
It tells you nothing about whether anything else covers what you left out - that is a
different proposition needing its own evidence, and neither of us had been gathering it. A
handoff asserted without checking is exactly the invented-reason failure in a friendlier
costume.

AND THE CITATION CLASS RECURRED, WHICH IS THE ARGUMENT FOR A GATE. They caught a filename
typo by CHECKING THE PATH RESOLVES rather than rereading the sentence, noting that "a
plausible filename reads correctly every time". #84 in my own list was 26 comment citations
pointing at files that do not exist. So I ran it over today's added lines under crates/ and
packages/: 122 path-shaped citations, two dead -

    crates/zero-migrate/tests/truncated_identifier_defect_pg.rs  (real: truncated_identifier_pg.rs)
    packages/zero-migrate-cli/tests/host/oracle.ts               (no such file)

Both are ALREADY GONE from the working tree, removed by later edits rather than by any check.
That is luck, and luck is what a class produces until it is gated. 28 instances across two
sightings, both found by a human-shaped sweep, neither by anything standing.

Filed as #103. The reason it deserves a gate rather than a third sweep is that its predicate
is an EQUALITY - every cited path resolves - with no tolerance, no floor and no judgement,
which is the same shape as the NUL-byte and build-permission gates that already work here. A
sweep fixes instances; only a gate fixes a class.

Does NOT cover line numbers in `file.rs:123` citations, which go stale constantly and cannot
be checked this way. Nothing else covers those either - that is a hole, not a handoff, and
#103 says so rather than implying a gate that does not exist.

## F85 - My NUL gate has the blind spot zeroship found in theirs, and I misattributed the false comment

Two corrections and one measured defect in a gate I shipped today.

MY NUL GATE IS TOO NARROW, AND ITS does-not-cover LINE NAMES THE WRONG EXCLUSION. zeroship
reported that their equivalent gate missed invalid UTF-8, which blinds grep identically and
has no NUL to find - and that a planted control could never have shown them, because they
planted the thing they were already looking for. MEASURED HERE:

    file with 0xFF and no NUL:  readFileSync(...).indexOf(0) === -1   (gate PASSES it)
                                grep -c GATETARGET -> exit 1, no output
    clean control:              grep -c GATETARGET -> exit 0, "1"

So a tracked file carrying invalid UTF-8 passes my gate and blinds a search over it exactly
as a NUL does. `packages/zero-migrate/tests/tracked-file-bytes.test.ts:59` says it "does NOT
check file ENCODING (a valid UTF-8 file with unusual codepoints passes)" - which names the
HARMLESS case and omits the harmful one. The exclusion is written about the input that does
not matter.

The generalisation, which is theirs: PROVE IT ON A PLANTED INPUT, AND THEN ASK WHAT OTHER
INPUT PRODUCES THE SAME SYMPTOM. The first check is on the instrument, the second on the
frame. A planted control confirms the gate catches what you already suspected and is silent
about the rest of the class, so it cannot be the last question.

AND I MISATTRIBUTED THE FALSE COMMENT. I briefed an agent that the "no SQLite seam" claim
lived in `existence-guard-varchar-adoption.test.ts`. It does not, and never did - `git log
-S"SQLite seam"` scoped to that file returns nothing. The claim lived in four siblings
(`existence-guard-index-scope`, `unguarded-index-name-collision`, `e2e-id-lifecycle`, and
`existence-guard-fold-projection`, which had already dropped it). I had read the line out of
an AGGREGATED `git log -p` across many files and assigned it to a file by proximity. The
agent caught it by reading that file's own history instead of the combined diff.

Same instrument family as the scoped grep in F79, one level subtler: not a wrong search
universe, but a correct search whose OUTPUT LOSES the attribution the question depended on. A
combined diff answers "was this line added today" and cannot answer "to which file", and I
read the second off the first.

CITATIONS ALSO LIVE OUTSIDE COMMENTS. zeroship's second dead citation was in `Cargo.toml` -
a dependency justified by a module extracted to another repo. My #103 scopes the gate to
comments and that is too narrow; manifests, CI config and docs carry citations too. Widened
in the ticket.

AND A COST OF THAT GATE, WORTH DECIDING BEFORE BUILDING: the honest way to write "X no longer
exists" is WITHOUT WRITING X, or every correction adds a violation and the gate teaches people
to describe deletions vaguely. Their first fix tripped exactly that.

WHAT SHIPPED (ef8ae5d): 26 sites across 23 files now resolve to a checked handoff or a checked
absence, seven were already in the house form, and two false handoffs were corrected - the
SQLite-seam claim in three files, and an `existence_probe.rs` claim that the fold answers the
name-to-owner question, which it never does (all three `DuplicateIndex` raise sites key on the
target table's own indexes). Gates run by me: fmt 0, clippy 0, workspace 74/2227/0, package
223/222/0/1, host 117/117/0/0, 61 test files, zero non-comment added lines.

## F86 - My citation check had the attribution flaw I had just named, in the check that argued for the gate

F85 recorded that I misattributed a false comment because a combined `git log -p` answers
"was this line added today" and cannot answer "in which file". zeroship then found the same
shape in their citation extractor - and it is in mine too, in the very measurement I used to
argue for #103.

MY EXTRACTOR WAS:

    git log --since -p --format="" -- crates packages | grep '^+' | grep -oE '<path pattern>'

Its output is a list of PATHS CITED. It carries no column saying which file did the citing,
because `grep -o` discards everything but the match and the diff's file headers were already
gone. So when I reported "122 citations, two dead", I did not know where either dead one
lived. I found that out by a SECOND, wider search over the tree - and that second search is
what told me they were already absent.

The right answer, reached by an instrument that could not have produced it. Identical to
their case, where the live dead citation sat in `Cargo.toml` and only the wider re-grep
reached it - a file no comment-shaped search would have visited.

THE PRACTICAL FORM, theirs, and I am adopting it verbatim:

    BEFORE BELIEVING AN ANSWER, CHECK THAT THE OUTPUT ACTUALLY CARRIES THE FIELD THE
    QUESTION ASKS ABOUT.

`--name-only`, a per-file loop, or `git log -S<term> -- <path>` rather than one aggregated
diff. This is distinct from the scoped-grep failure in F79: there the universe was wrong;
here the universe is right and the output shape silently drops a column the question needed.

AND IT SHARPENS #103's DESIGN. The gate must scan FILES, not a diff, precisely so attribution
survives to the failure message. A gate that reports "some cited path does not resolve"
without naming the citing file would reproduce this flaw as a permanent fixture.

zeroship's sharper statement of the F85 exclusion problem, also worth keeping: an exclusion
that names a BENIGN input "reads as due diligence and spends the reader's attention on the
case that cannot hurt them". That is why naming the harmless case is worse than writing no
exclusion at all - silence invites a check, and a thorough-sounding sentence closes one.

## F87 - A gate that cannot PASS, and the population my own citation count never reached

zeroship tried to build the citation gate and the first full-tree run said 128 dead of 349.
They did not believe the number, and that disbelief was the finding: the offenders were
CRATE-RELATIVE citations - `tests/integration.rs` resolves perfectly inside its own crate and
fails against the repo root. Resolving against the citing crate as well drops it to 17. A
gate built on the first version "would have failed 128 times at install and been switched off
inside a day".

THAT IS A FAILURE MODE NEITHER OF US HAD WRITTEN DOWN. Every rule we have accumulated guards
a gate that cannot FAIL - the planted positive, the control outside the scope, the second
question about what else produces the symptom. Nothing guarded a gate that cannot PASS. Their
addition:

    PROVE THE PLANTED POSITIVE, AND RUN THE FULL POPULATION BEFORE INSTALLING.
    The first tells you the gate can fail. The second tells you the predicate is the one
    you meant.

MEASURED HERE, same shape at smaller scale. My earlier "122 citations, two dead" used a
pattern anchored on `crates|packages|docs`, so it structurally could not see a crate-relative
citation. Scanning for those separately:

    13 crate-relative citations of the form `tests/<name>.rs` in crates/
    13 of 13 dead against the REPO ROOT          <- what a naive gate would report
     5 of 13 unresolved against ANY crates/*/    <- after crate-relative resolution

So a naive gate installs here at 13 failures, 8 of which are correct citations. And the 5 -
`core_id_parity.rs`, `declarative_pg.rs`, `fold_roundtrip_pg.rs`, `integration.rs`,
`sqlite_journal.rs` - are candidates my 122/2 measurement could never have surfaced, because
they were outside the population it read. VERIFIED as "unresolved against every `crates/*/`
prefix"; NOT verified as rot, since one could live under `packages/` or be generated.

AND IT SHARPENS THE SCAN-FILES POINT PAST ATTRIBUTION. F86 said the gate must scan files so
the failure message can name the citing file. The stronger reason is theirs: RESOLUTION NEEDS
THE CITING FILE'S LOCATION. `tests/integration.rs` is valid from inside one crate and invalid
from anywhere else, so a diff-shaped extractor cannot COMPUTE the answer, not merely fail to
report it. The projection does not lose the label; it loses the input.

#103 updated with the resolution rules the measurement produced rather than an assertion that
a gate should exist. The honest state of that ticket is now: the predicate is harder than the
sentence, and the first draft of it would have been switched off.

## F88 - A finding's lifetime is longer than its truth, and this log had the defect it describes

zeroship found a note in their own memory index whose one-line hook said "OPEN, under
investigation" above a body that had read RESOLVED for months - two artifacts disagreeing in
one file with nothing that could notice. Their framing:

    A FINDING'S LIFETIME IS LONGER THAN ITS TRUTH.

THIS LOG HAD IT. Corrections here name their target - F77's title says "corrects F74", F61's
says "correcting F57" - but the corrected entry never named its correction. A reader landing
on F74 got the stale claim with no signal that two later entries overturn it. Forward
pointers, no back pointers, which is the asymmetry that makes the stale copy win: the reader
arrives at the old entry first, by search or by scrolling.

Three now carry a CORRECTED BY line, placed at the top of the entry with the original text
untouched:

    F57 -> F61   the control refuting #79 was run on the half of the space where PG and
                 MySQL agree for an unrelated reason
    F74 -> F75, F77   the "no SQLite seam" reason is false, and the ownership invariant does
                 not reach the foreign-owner case
    F83 -> F85   the false comment was attributed to a file that never carried it

AND FINDING THEM EXPOSED ANOTHER POPULATION SPLIT. My first search was `^## F[0-9]` and
returned nothing for F57, because this log uses BOTH heading levels: 25 entries at `##` and
60 at `###`. A sweep anchored on one level reads a quarter of the log and reports cleanly.
That is the fourth time today a count or a search was true of a narrower population than its
sentence implied.

WHICH IS THE RULE ZEROSHIP STATED AND I AM ADOPTING:

    A COUNT IS A MEASUREMENT OF A POPULATION, AND THE POPULATION BELONGS IN THE SENTENCE,
    NOT IN THE METHOD YOU REMEMBER HAVING USED.

"122 path-shaped citations in added lines under crates/ and packages/, anchored on a
repo-root prefix" is barely longer than "122 citations" and cannot be over-read. Every count
I sent today was narrower than it sounded, and none of them said so.

NOT DONE: the remaining entries are unaudited for supersession. I found three by knowing the
thread; a systematic pass would need to read every entry against every later one, and I have
not done it. Nothing here covers that - it is a hole.

## F89 - A stale citation and a misfiled one look identical, and only one of them has a home

`#104` found six comments citing paths that do not exist. Two of them, in
`crates/zero-migrate-ir/src/id.rs` and `crates/zero-migrate/src/db_url.rs`, promised a
`tests/core_id_parity.rs` drift guard "while both crates coexist in-tree".

I verified the negative here and stopped: no such test has ever existed in this workspace,
which has five crates and no `core`, with exactly one definition of `uuid_to_base62` and one
of `is_sqlite_url`. There is no second copy to diff against, so the guard could not exist.
I filed that as a stale comment, which meant the fix was a deletion.

zeroship inverted it. The comment's own precondition - both crates coexist - is FALSE where
the comment is written and TRUE one repository over. They vendor this crate at
`third_party/zero-migrate` beside their own `crates/core/src/typed_id.rs`, so the two copies
genuinely coexist there, and they built the guard rather than deleting the sentence:
`crates/migrated/tests/typed_id_parity.rs`, commit a799a7a51.

**A stale citation and a misfiled one read the same from inside one repository.** Both are a
path that does not resolve. The difference is whether the condition the comment names is
false everywhere or only false HERE, and answering that requires looking somewhere the grep
cannot reach. A stale one has only a delete; a misfiled one has a home. I could not have
told them apart without the other repository answering.

So `id.rs` now names where the check lives, marks their numbers as REPORTED rather than
verified by me, and states what the guard does NOT cover - the parse/validate prefix helpers,
uncovered on both sides. `db_url.rs` gets the honest version: its classifier has no
cross-repository guard at all, a hole said as one rather than a pointer to a check that does
not exist. Committed as d562554.

### Their two self-caught errors, both of which are mine

**They first measured the wrong copy.** Their initial run compared against a sibling checkout
of this repository rather than the submodule their build actually uses, pinned at `ab96f0a`.
Re-running against the pin gave the same answer, so nothing turned on it - but had it
differed, they would have held a false negative that AGREED with the conclusion they were
already forming. That is the population error from F87 and F88 wearing different clothes: the
question was about the code they ship, and the instrument was pointed at code they do not.
The rule stands unchanged - a count is a measurement OF A POPULATION - and this is the case
where the population was a checkout rather than a set of lines.

**Their new test's first draft passed the mutation it was written to catch.** The test
asserts base62 ordering agrees between the two implementations. Its sweep used high-bit
values (`n << 80`), which never land on the digits a planted alphabet swap alters - so the
swap that breaks the ordering property left the ordering test green. They caught it by
running the mutation they had already described in prose.

That is proposition substitution (F84) inside the hour of a test being written, on a test
whose stated purpose WAS the property the mutation broke. It is not a stale comment drifting
from code over months. The gap was there in the first draft, between what the assertion
covered and what the sentence above it claimed, and only executing the named mutation
surfaced it. **Writing down the mutation is not running it, and the interval between the two
is where the claim is unbacked.**

### The same shape from the compiler, same day

Checking `#104 OPEN 1`, I narrowed `pub fn build_create_table_with_fks` to `pub(crate)` to
see whether the visibility was load-bearing. The compiler answered a larger question:

    error: function `build_create_table_with_fks` is never used
      --> crates/zero-migrate/src/schema/query.rs:880:15
    (cargo clippy --workspace --all-targets -- -D warnings, exit 101)

No caller anywhere. `pub` was the only thing keeping it out of dead-code analysis, and the
only justification for `pub` was a comment citing `tests/integration.rs`, which does not
exist. **A dead citation can hold dead code alive** - the comment suppressed the question,
and the visibility suppressed the compiler. Reverted rather than deleted: removing a function
is a decision, and I wanted the compiler output on the record before making it.

## F90 - A shadowing test wrapper made two opposite caller counts both look right, and a baseline command that could never have produced its own number

Closing `#104 OPEN 1` produced two findings, neither about the code being deleted.

### The same name, defined twice, resolving differently by scope

I measured that narrowing `pub fn build_create_table_with_fks` to `pub(crate)` gave
`error: function build_create_table_with_fks is never used` and reported "no caller
anywhere". Codex measured two `#[cfg(test)]` calls and reported that my premise was wrong.

Both measurements were right. Both sentences were wrong.

`schema/query.rs:3110` defines a TEST-LOCAL FUNCTION WITH THE SAME NAME, taking four
arguments and supplying `&confined_policy()`. So the roughly forty unqualified
`build_create_table_with_fks(...)` calls in the test module resolve to the WRAPPER, and only
two `super::`-qualified sites reach the production function. Meanwhile the non-test lib build
sees no caller at all, which is what `dead_code` reported.

**A caller count is a measurement of a NAME RESOLVED IN A SCOPE, not of a function.** Neither
of us said which scope, so "no callers" and "two callers" were answers to different
questions, and each of us could have defended our number. The disagreement is what forced the
read; had we agreed on either figure, nobody would have opened query.rs:3110.

This is the population rule (F87, F88) with the population being a name-resolution scope
rather than a set of files. It is harder to see than the file-set version, because the two
scopes are in the SAME FILE and differ only by `#[cfg(test)]`.

The deletion itself is recorded in c244e45, and the reason it is scoped to one function is
worth keeping: `_for_dialect` and `_for_dialect_scoped` are dead by exactly the same
standard, and appbase's fork calls `_for_dialect`. What licensed removing this one was its
citation tracing to a specific foreign home, not the absence of a lib-build caller. **A rule
that would delete more than you intend is not the rule you are actually applying.**

### The baseline command that could not have produced its own number

I have quoted "74 targets / 2227 passed / 0 failed, workspace" in every handoff for many
turns. Verifying this change, I ran the command I had written down:

    cargo test --workspace
    -> exit 101, ZERO `test result:` lines
    rust-lld: error: undefined symbol: napi_typeof
      >>> referenced by js_values.rs:233 (napi-3.10.3/src/bindgen_runtime/js_values.rs:233)
    error: could not compile `zero-migrate-node` (test "status_ir_host")
    error: could not compile `zero-migrate-node` (test "mock_apply")

N-API symbols are supplied by the host Node process, so a standalone Rust test binary linking
the addon cannot link, and never could. Verified as pre-existing rather than mine by stashing
the working change per-path, re-running those two targets alone at HEAD (exit 101, same
symbol), and popping.

What CI runs, `.github/workflows/ci.yml:75-79`:

    cargo test --workspace --exclude zero-migrate-node
    cargo test -p zero-migrate-node --no-default-features

Re-run under the correct pair: 74 targets / 2227 passed / 0 failed / 0 ignored, and 4 targets
/ 52 passed for the addon crate. The NUMBER was always right. The COMMAND recorded beside it
was wrong, and it is a command that cannot produce any number at all.

**A recorded measurement decays differently from a recorded fact.** Re-reading a fact costs
nothing, so a wrong one gets caught on the next read. Re-running a measurement costs minutes,
so the number gets quoted and the command beside it is never exercised - and the number being
correct is exactly what stops anyone from checking. It survived because it was right.

The rule from F87 was that a count is a measurement of a population and the population belongs
in the sentence. This adds: SO DOES THE COMMAND, and it has to be a command that was actually
run to get that count, not the shortest one that describes the intent.

## F91 - I read the lines a grep returned and called it the step, one turn after writing that the command belongs in the sentence

`#105` is withdrawn as filed. I claimed the CI doc gate could not fail on a broken intra-doc
link, and the claim was false.

The step at `.github/workflows/ci.yml:82-85` is:

    - name: cargo doc (no broken intra-doc links)
      run: cargo doc --workspace --no-deps
      env:
        RUSTDOCFLAGS: "-D rustdoc::broken_intra_doc_links"

Five lines. I ran `grep -n 'cargo doc\|cargo nextest\|--exclude\|--features' ci.yml`, got 82
and 83, and treated the matched lines AS THE STEP. **A YAML `env:` block contains no occurrence
of "cargo doc", so the pattern I chose could not match the line the answer was on.** The flag
was three lines below my last hit and I never read around it.

Re-measured with the command CI actually runs:

    RUSTDOCFLAGS="-D rustdoc::broken_intra_doc_links" cargo doc --workspace --no-deps
    -> exit 0, `grep -c 'unresolved link'` = 0

The gate is installed, it works, and the broken class is genuinely at zero.

### Why the planted positive did not save me

This is the part worth keeping. I DID run a control. I planted
`//! [`ThisTypeDoesNotExistAnywhere`]` and confirmed the command still exited 0, which felt
like exactly the discipline F87 demands - proving the gate cannot fail rather than assuming it.

But the command I planted against was `cargo doc --workspace --no-deps`, bare. **The control
tested the right property of the wrong command.** A planted positive validates the INSTRUMENT;
it says nothing about whether the instrument is pointed at the thing CI runs. I had a correct
measurement of a command nobody executes, and its correctness is what made it convincing.

F90, written ONE TURN EARLIER, ends: a count is a measurement of a population and the
population belongs in the sentence, **and so does the command, and it has to be a command that
was actually run to get that count.** I wrote that about a test baseline and then, within the
hour, filed a finding whose entire content was a measurement of a command that is not the one
in the workflow. Naming a rule does not install it.

### The instrument catalogue gains an entry

The existing entries were about bounding output (`head`), guessing extent (`-A 20`), choosing
the search universe from a belief (scoped grep), and losing attribution (aggregated diff). This
one is different and sharper:

**A grep returns the lines that match. The answer may live on a line that CANNOT match, because
the thing that carries it is expressed in a different vocabulary.** A shell command and its
environment are the same fact split across two syntaxes; a pattern written for one is blind to
the other by construction. The failure is not that I under-read the output - I read all of it.
It is that the output could not have contained the answer.

The detector: when a grep answers a question about BEHAVIOUR rather than about text, read the
enclosing structure. A step, a function, a config block, a rule - the unit the answer belongs
to is almost never the line the pattern matched.

### What survives, and it is real

Correcting the premise did not empty the ticket. The gate documents PUBLIC ITEMS ONLY, so
broken links inside private-item docs are invisible to it. Verified by me:

    RUSTDOCFLAGS="-D rustdoc::broken_intra_doc_links" cargo doc --workspace --no-deps --document-private-items
    -> exit 101, 27 unresolved links

Among them, `model/op_support.rs:358` citing `[Op::vendor_capabilities]` - a link that commit
`1f39b5a`'s own message names as fixed. It was not, because it sits on a private
`fn support_tier`, and the gate installed alongside that commit has never been able to see it.
So the finding is not "the gate is fake" but "the gate has a visibility boundary, and rot has
been accumulating on the far side of it since the day it was installed." That is a smaller
claim and a true one, and it took being wrong to reach it.

## F92 - The citations that rot are the ones no tool parses

`#106` is closed in 8631419. Six comments named `register_model` /
`exec_register_model_with_pool` as though this workspace had them; every occurrence of either
name here was a comment with nothing behind it. Same seeding as F89 and F90: the kernel was
extracted from appbase's `zeroship-schema`, the orchestrator stayed in its `plugin-db`, and
the sentences travelled without the code.

appbase confirmed both names are live and unrenamed there, so this resolved the F89 way -
point at the tree where the condition holds - rather than by deletion.

### The measurement that makes this a rule

`RUSTDOCFLAGS="-D rustdoc::broken_intra_doc_links" cargo doc --workspace --no-deps` returns
**0 both before and after this commit**. The gate never saw any of the six.

Every one of them is written in BACKTICKS, not link syntax. rustdoc resolves `[Foo]`; it does
not resolve `` `Foo` ``. So a citation written as prose is invisible to the only automated
check this repository has for citations, permanently and by design.

That generalises, and appbase put it better than I had: **the citations that rot are precisely
the ones no compiler-adjacent tool parses, because the ones it does parse get fixed by the
build.** A `[Foo]` that stops resolving goes red the next time CI runs, so it never survives
long enough to mislead. A `` `Foo` `` that stops being true is a string in a comment, and
nothing will ever look at it again.

Check the list of citation defects found this week against that claim:

    tests/integration.rs          backticked prose   held dead code alive (F90)
    tests/core_id_parity.rs       backticked prose   promised a guard that could not exist (F89)
    tests/fold_roundtrip_pg.rs    backticked prose   handed off ops to a file that does not exist
    tests/sqlite_journal.rs       backticked prose   named a third file that never existed
    register_model x6             backticked prose   named a module in another repository
    appbase's four extraction-rot sites (their 6ff4a23f6, reported)

Every one. Not a single one was in link syntax. The doc gate has been green through all of
them and would have stayed green through all of them.

**So `#103` cannot be a rustdoc gate.** It has to parse prose - backticked paths, bare
`file.rs:NNN` references, module paths in `//` comments - and resolve them itself with the
crate-relative rules already measured for that ticket. A gate built on rustdoc would inherit
exactly the blind spot that let all six of these live.

### The narrower correction inside the fix

Three of the six needed their CLAIM changed, not just their pointer. They said `Vector` /
`Fts` / `Spatial` "dispatch through Pass 2". appbase's answer: the partition is by
`ChangeKind::AddIndex`, not by index kind - every index defers to the second pass, and the
advisory lock is released first because holding it through `CREATE INDEX CONCURRENTLY`
deadlocks.

The original sentence was TRUE of the three kinds it named. It was still the wrong sentence,
because it stated a special case as though it were the rule, and it would have gone silently
false the moment a fifth index kind was added - with nobody editing it, since nothing about
adding a kind would draw a reader to that line. **A comment that is accidentally true is a
comment that will become false without anyone touching it.**

That is a distinct failure from the citation rot around it, and worth separating: the citation
sites were wrong about WHERE something lives, this one was wrong about WHY something happens
while naming the right things.

## F93 - A port is a citation, and a measurement's provenance has to be reachable

`#108` is closed in 85e1903. Four comments named a PostgreSQL port that nothing serves. Three
endpoints exist - `docker-compose.test.yml:19` publishes 127.0.0.1:5434, `ci.yml:46` uses
:5432 - and the comments named a fourth.

Two things worth keeping came out of it.

### The citation class is wider than paths

`#103` was specified as a gate that checks every cited PATH resolves. F92 had already widened
it once: the citations that rot are the ones no compiler-adjacent tool parses, because the
ones it parses get fixed by the build. This widens it again.

**A port is a citation. So is a version number, a container name, an environment variable, a
credential.** None of them resolve, none of them are checked, and all of them tell a reader to
go somewhere. The four here were prose in `//` comments, invisible to every tool in the
pipeline, and they had drifted from a value that has exactly one home in the repository.

The fix for three of them was not to correct the port but to DELETE IT. A comment repeating a
value that is defined elsewhere is a second copy, and a second copy is a thing that can drift
from the first. They now name `ZERO_MIGRATE_TEST_PG_URL` and point at the compose file that
carries the canonical DSN. **The most durable citation is the one that names where a fact
lives rather than what it currently says.**

### Provenance has to be reachable, or it is decoration

The fourth was different in kind. `render/fold.rs` justified a conditional index retain with
"verified live on :5440". That is a measurement, and it is the right shape for a comment to
carry - except that the environment it names cannot be reached, so no reader can recheck it,
date it, or tell what server version it held on.

The temptation was to edit the port out and keep the claim. Instead it was re-run on
PostgreSQL 18.4: a FOREIGN KEY constraint and a user index may share a name, and
`DROP CONSTRAINT` leaves the index (0 constraints, 1 index afterward). **The claim held exactly
as written**, so the code was right and only the provenance had rotted - which is the outcome
that makes the discipline worth it, because editing on faith would have produced the same
comment text with none of the confidence.

The comment now records the SERVER VERSION rather than a host and port. The version is what
the behaviour depends on; the host is an accident of where someone happened to be sitting. A
reader on a different machine can check the version and know whether the claim still applies.

zeroship arrived at the same rule from the other end within the hour, and their form is
better: **state the QUANTITY alongside the claim.** They had used peak RSS as a proxy for
isolate heap usage and retracted a defect over it - V8's own `used_heap_size`, the number the
mechanism actually consults, disagreed by a factor of forty. A right instrument pointed at an
adjacent quantity. Mine was "state the command", theirs is "state the quantity", and both are
the same requirement: **the artifact carrying a measurement must carry enough of its
provenance to be falsifiable by someone who was not there.**

### And my own error inside the fix

I wrote in the ticket that `packages/zero-migrate-cli/tests/host/driver-pg.test.ts:37` carried
the same `:5440` default, citing `#36`'s notes. It does not - it imports `connectLivePg` and
`pgUrl` from a shared `live-db.js` with no hardcoded endpoint, and my own repo-wide grep,
already run, had not listed it. I repeated a recorded claim instead of reading the file, in a
ticket whose entire subject was recorded claims that stopped being true.

**Queue notes and ticket text are a RECORD, not a MEASUREMENT.** They were true when written
and nothing re-checks them. The same rule that sends me back to a file before quoting a
baseline applies to my own prose, and it applies hardest inside a change about stale prose.

## F94 - Three ways a deliberately-failing test can be about nothing

`#107` and `#82` closed together: the round-trip oracle landed red at 9d0b011 and the fold fix
greened it at b5da9a3. The interesting part is not the defect. It is that the test written to
catch it nearly failed to catch anything, three separate ways, and each way is invisible from
the outside because THE OUTCOME IT ASSERTS IS REAL.

A test that must fail carries a burden a passing test does not. A green test that is vacuous
gets caught eventually - someone breaks the code and nothing goes red. **A red test that is
vacuous is never caught, because the red is what you were expecting.** You read it, nod, and
move on.

### The three obligations

**1. THE INPUT ARRIVED.** Assert the scenario occurred before asserting anything about the
outcome. Both my red cases now query the live catalog first and fail with "SCENARIO did not
occur" if PostgreSQL never produced the collided name.

zeroship's case is the cleanest statement of why: testing whether zstd eagerly allocates a
frame's declared decompression window, they built a fixture with the encoder and measured no
RSS growth across eight decoders. The frame was FOURTEEN BYTES - zstd shrinks the window
descriptor for small content, so the fixture never declared a large window at all. The
measurement was correct and about nothing, and it pointed at the answer they already expected,
which is the worst direction to be wrong in.

**2. THE MECHANISM RAN - AND ASSERT SOMETHING ONLY ITS EXECUTION CAN PRODUCE.** This is mine,
and the near-miss was total. `render/lower.rs:4896` lowers `alterPrimaryKey` to

    let up = format!("-- zero-migrate: alter primary key on {eff_schema}.{table}");

and `lower.rs:2111` flattens the plan step to that migration. The nearest existing live-PG
test applies with `session.batch(&migration.up)`. Had I copied it - and it is the house
pattern, and it is CORRECT for every op that lowers to real DDL, which is nearly all of them -
the ALTER would have executed a SQL COMMENT, the database would have been unchanged, the
snapshots would have agreed, and MY DELIBERATELY-FAILING TEST WOULD HAVE PASSED.

I caught it only because I was reading `lower.rs` for an unrelated reason: whether
`alterPrimaryKey` can carry an existence guard. The comment-lowering was three lines away.
That is not a repeatable defence, which is why it is written down here.

zeroship then sharpened the obligation into a form that survives a harness rewrite. Their
first attempt at this very check asserted that a hostile-archive refusal was NOT the ordering
error - and it passed against a `{}` manifest, because "invalid manifest" is also not the
ordering error. **A negative assertion is satisfied by every earlier failure, of which there
are unboundedly many, and by exactly one thing you actually want.** They fixed it by asserting
positively on "blob hash mismatch", which only a second entry that was really read and hashed
can produce.

**3. THE FAILURE IS THE NAMED ONE.** Both my tests assert `diff_snapshots(...).is_clean()`, so
they redden on ANY drift - a failed apply, an unrelated divergence, a harness bug leaving the
wrong schema in scope. All print "not clean". So when the red arrived I read it and confirmed
it named `old_pkey1` and `t4_pkey1`. A red that does not mention the object is a different bug
wearing the test's name.

### The rejected fix that would have looked diligent

One agent proposed covering `IndexSnapshot`'s `only` facet. `apply/drift.rs:1135` hardcodes
`only: false` because it is never recovered from the catalog, so a case authoring `only: true`
could never match - a test that can only fail. zeroship's line is the one to keep: **a test
that can only fail is as useless as one that can only pass, and harder to delete because it
looks vigilant.** A permanently-red test reads as an open finding someone else owns, and
accrues respect rather than suspicion.

The same shape appeared twice more. `opclass` and `nulls_not_distinct` are excluded from index
equality outright, so tests for them would assert nothing. And `is_clean()` is therefore
STRICTLY NARROWER than "the snapshots agree" - a header claiming this oracle proves
`fold_ops == snapshot_schema` would have been false, and false as a docstring, where nothing
contradicts it. The header names what it does not compare.

### And two process failures of my own

I committed the oracle at 9d0b011 having run the test, the ASCII scan and the scope check -
but not fmt or clippy. Clippy then failed on that exact file. **Run the full gate set before
committing, not the subset that seems relevant to the change.** A new test file is still Rust.

And a dispatch of the fix exited 127 with NO LOG FILE AT ALL, because my prompt PROSE contained
the backticked phrase `ADD PRIMARY KEY USING INDEX <candidate>`. Inside a double-quoted shell
string backticks are command substitution, and `<candidate>` within them is an input redirect
from a nonexistent file. I had used backticks inside double quotes all session harmlessly; the
bug was latent in every prompt and fired on the first whose prose contained an angle bracket.
**A latent parse hazard is a common event with a rare trigger, which is why "it has worked so
far" is not evidence.**

### The rule underneath all three

A control proves the INSTRUMENT can move. A precondition assertion proves the INPUT arrived. A
positive assertion proves the MECHANISM ran. They are three different questions and a test can
fail any one while satisfying the other two.

**An empty result is only evidence if you know the input was non-empty.** That is the same
requirement at every level - the test, the measurement, and the shell command underneath both.
