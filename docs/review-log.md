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
