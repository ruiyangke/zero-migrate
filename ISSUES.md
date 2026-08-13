# zero-migrate issues

Defects observed by downstream consumers, with the commit they were seen on and
enough detail to reproduce. Distinct from `TODO.md`, which tracks intended work;
everything here is something behaving other than as documented.

Each entry states where it was observed and whether it has been re-checked
against a newer commit, because a consumer usually pins an older engine than
`main`.

**Status as of 2026-08-13 (`23dca98d`): all three entries below are RESOLVED**, and
each carries the commit that fixed it plus the tests that now pin it. They are kept
rather than deleted because a consumer pinned to an older engine will still hit
them, and the entry tells them which version to move to.

Two of the three were fixed WEEKS before this re-check and nobody noticed, because
nothing re-runs these reproductions: entry 1 said "not re-checked", and entry 2
said "still present" on the strength of a run measured against a `main` that was
already two weeks stale. A defect list that is not re-checked drifts into
misinformation in both directions.

---

## 1. A clean authored `createTable` is denied as `RawCreateInInjectScope`

**RESOLVED.** Fixed by `6b4cf165` (2026-08-06), *"fix(guard): admit a create that
carries the shape its charter injects"* — 18 days after this was observed. Of the
two possibilities this entry raised, it was the first: the rule was a blanket deny
on any create inside an inject scope, and the fix made it a CONFORMANCE check. A
create carrying every injected column with the pinned primary key is now admitted;
the structured resolver renders those columns into the text it hands the guard, so
the authored path conforms by construction.

Re-checked against `main` (`43bec481`): `crates/zero-migrate-guard/tests/namespace_authority.rs`
§1b pins it in both directions — `raw_create_carrying_the_full_injected_shape_is_admitted`
(a shape all but identical to the one quoted below), plus
`create_short_one_injected_column_is_denied` and
`conforming_create_outside_the_create_table_grant_is_still_denied`, so the fix did
not become a blanket allow. 30/30 pass.

A consumer still seeing this is pinned to an engine older than `6b4cf165`.

**Originally observed on:** `ab96f0a04a583cac8bd46c8898acc54374ccac9a`
(branch `feat/no-builtin-policies-1-gab96f0a`), via the appbase adapter's
live-Postgres tests.

Two tests that assert an authored IR set lowers with no policy denials both fail
once a live Postgres is configured:

- `crates/zeroship-migrate-adapter/tests/author_and_apply_pg.rs:367`
  (`authored_v1_envelope_lowers_and_applies_over_native_compio_seam`)
- `crates/zeroship-migrate-adapter/tests/smoke_apply_pg.rs:226`
  (`ir_envelope_lowers_and_applies_over_native_compio_seam`)

Failure:

```
no denials on a clean authored IR set:
[("mig_7n42DGM5PHcyVnhNdFICqJ",
  NamespacePolicy { rule: "RawCreateInInjectScope",
    statement: "CREATE TABLE \"proj_..._...\".\"notes\" (
      \"body\" text, \"created_at\" timestamptz NOT NULL, \"created_by\" text,
      \"deleted_at\" timestamptz, \"id\" text PRIMARY KEY NOT NULL,
      \"title\" text NOT NULL, \"updated_at\" timestamptz NOT NULL,
      \"updated_by\" text, \"version\" integer NOT NULL)" })]
```

The statement is an ordinary `CREATE TABLE` in the migration's own project
schema, authored through the recorder rather than written as raw SQL. Either the
`RawCreateInInjectScope` rule is matching authored creates it should not, or the
tests encode an expectation the policy no longer holds. Which of those it is
should be settled before assuming the tests are simply stale.

**Impact on the consumer:** these two targets fail whenever the live-database
gate is set, so a downstream crate cannot get a green suite with a real database
configured, and the failure is easy to mistake for a local problem.

---

## 2. Foreign-key value-format validation cannot see a target authored in an earlier migration

**RESOLVED.** The catalog fallback this entry asks for landed in `4d4f26b6`
(2026-08-06), *"feat(migrate): prove a foreign-key target's value format from the
live catalog"* — which answers the design question below directly: when the
referenced target already exists in the live catalog, its own format evidence
(PostgreSQL's native `uuid` type, or the engine's exact UUID/TypeID/ULID spelling
CHECK on MySQL/SQLite) now proves the reference without an authored contract.

**The "still present" note below was measured against a stale `main`.** It cites
`a243333c`, dated 2026-07-22; the fix is from 2026-08-06, two weeks later. The
note also says that run "reached it through the consumer's own workaround rather
than re-triggering the raw failure", so it was weak evidence for the claim even at
the time — worth stating, because a stale "still present" sends a consumer looking
for a workaround they no longer need.

Re-checked against `main` (`23dca98d`): `crates/zero-migrate/tests/catalog_format_proof.rs`
pins it in both directions, 6/6. Catalog UUID evidence proves BOTH reference
surfaces (the column-level `references` facet and the table-level single-column
`fk` constraint, which run through separate validation loops). And it did not
become a blanket allow — a live `text` target without UUID evidence, a differing
catalog TypeID, and a chained target carrying no CHECK of its own all stay
rejected.

**Consequence for the workaround:** the downstream `advance_logical_columns`
replay described below should no longer be necessary for targets that exist in
the live catalog, which was the stated cost ("every consumer driving multi-file
ordered applies has to rediscover this").

**Originally observed on:** `ab96f0a04a583cac8bd46c8898acc54374ccac9a`.

Lowering a migration whose table-level foreign key references a table created by
an *earlier* migration fails when the runner does not carry authored logical
column metadata forward:

```
IrAuthor::lower of a DML op: declare or import the referenced candidate key with
the exact same value format [OP_INVALID kind=op op_index=62 dialect=postgres]:
table-level foreign key app_deploys.app_deploys_app_id_fkey is invalid:
position 1 local column "app_id" carries canonical UUID, but the referenced
target has no authored value-format metadata (possible engine op-support gap)
```

Both columns are plain `uuid`; neither carries a separate `valueFormat` field,
and UUID semantics come from `type: "uuid"` itself.

The engine's own error text says "possible engine op-support gap", and the
question it raises is a real one: when the referenced target already exists in
the live catalog, should validation require the authored contract at all, rather
than resolving the target's value format from the catalog or from an imported
declaration?

**Workaround in use downstream:** the consumer accumulates authored logical
column contracts across ordered files and replays them onto each freshly seeded
`LiveSchema` via `advance_logical_columns`. That works, but it means every
consumer driving multi-file ordered applies has to rediscover this, and it
interacts badly with skipping already-applied files - a consumer that skips
lowering for a file also loses that file's contracts for later files.

If validation could fall back to the live catalog for an already-existing target,
the whole class of consumer-side bookkeeping would go away.

## genArtifacts: a single `references` field emits its foreign key twice

**NO LONGER REPRODUCES on `main` (`23dca98d`), re-checked 2026-08-13.** The
reporter's own minimal reproduction — the `users`/`posts` descriptor pair below,
`projectSchema: "public"`, `charterLayers: ["policy_version = 1\n"]` — now returns
`ok=true`, and the reporter's `type: "string"` control still returns `ok=true` too,
so the harness matches theirs.

Checked for non-vacuity rather than trusting the boolean: a silently DROPPED
`references` would also produce `ok=true` while losing the foreign key, which would
be a worse defect wearing a green. The emitted `envDbTs` carries
`references("users", "id")` exactly once — emitted, and emitted singly, which is
the precise property this entry is about.

The fixing commit was not identified; the searches over `fold.rs` and the
descriptor path since 2026-08-06 did not isolate it, and naming a commit that has
not been verified would be worse than leaving it unnamed.

**Reported by:** zeroship (/home/ruiyang/Projects/appbase), 2026-08-07
**Severity (as reported):** blocks descriptor-sourced `genArtifacts` for any schema
with a relation

A descriptor field carrying `references` makes the fold emit the derived foreign
key twice, so `genArtifacts` returns `ok=false` with a duplicate-constraint error.
Any schema with a single relation is affected; there is no caller-side shape that
avoids it short of dropping `references` and losing the FK.

### Minimal reproduction

`genArtifacts({ descriptors, projectSchema: "public", charterLayers: ["policy_version = 1\n"] })`
with

    users: fields [{ name: "email", type: "string", required: true }]
    posts: fields [{ name: "authorId", type: "ref", references: "users" }]

both carrying `runtimeOptions { softDelete: false, versioning: false, strictness: "strict" }`.

Result:

    ok=false
    gen-types: fold the schema source failed: fold: constraint `posts_authorId_fkey` already exists on `posts`

### Control

The identical descriptor pair with `type: "string"` in place of the ref returns
`ok=true`. So the trigger is the `references` field, not the collection shape.

### What was ruled out

- **Caller duplication.** The descriptor carries `references` exactly once and
  declares no named constraint. `FieldDescriptorDto` in your own `index.d.ts`
  declares `references?: string`, so the shape conforms.
- **The charter.** A minimal `policy_version = 1` charter fails identically, so it
  is not an `[[inject]]` rule adding the second constraint. The reporting project's
  richer confined ceiling produces the same error.
- **The caller's mapper and recorder.** Reproduced by calling the addon directly
  with a hand-written descriptor, which removes all of the reporting project's
  code from the path.

### Verified versus inferred

VERIFIED by the reporter: the four cases above, run against the `zero-migrate-node`
addon resolved from this checkout. NOT VERIFIED: which side of the fold emits the
duplicate, or whether the envelope-sourced path has the same defect - only the
descriptor path was exercised.
