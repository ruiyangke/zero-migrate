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
