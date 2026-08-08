# zero-migrate issues

Defects observed by downstream consumers, with the commit they were seen on and
enough detail to reproduce. Distinct from `TODO.md`, which tracks intended work;
everything here is something behaving other than as documented.

Each entry states where it was observed and whether it has been re-checked
against a newer commit, because a consumer usually pins an older engine than
`main`.

---

## 1. A clean authored `createTable` is denied as `RawCreateInInjectScope`

**Observed on:** `ab96f0a04a583cac8bd46c8898acc54374ccac9a`
(branch `feat/no-builtin-policies-1-gab96f0a`), via the appbase adapter's
live-Postgres tests. **Not re-checked against `main`.**

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

**Observed on:** `ab96f0a04a583cac8bd46c8898acc54374ccac9a`. **Still present in
the same form when the appbase adapter was compiled and exercised against
`main` (`a243333c`)**, though that run reached it through the consumer's own
workaround rather than re-triggering the raw failure.

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

**Reported by:** zeroship (/home/ruiyang/Projects/appbase), 2026-08-07
**Severity:** blocks descriptor-sourced `genArtifacts` for any schema with a relation

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
