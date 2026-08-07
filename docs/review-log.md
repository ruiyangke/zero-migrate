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
