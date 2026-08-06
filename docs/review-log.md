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
the no-op SQLite descriptor guard.

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
