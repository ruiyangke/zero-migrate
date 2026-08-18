# zero-migrate issues

Defects observed by downstream consumers, with the commit they were seen on and
enough detail to reproduce. Distinct from `TODO.md`, which tracks intended work;
everything here is something behaving other than as documented.

Each entry states where it was observed and whether it has been re-checked
against a newer commit, because a consumer usually pins an older engine than
`main`.

**Status as of 2026-08-17 (`01385061`): all five entries below are RESOLVED**, and
each carries the commit that fixed it plus the tests that now pin it. They are kept
rather than deleted because a consumer pinned to an older engine will still hit
them, and the entry tells them which version to move to.

Entries 4 and 5 were reported and fixed on the same day, both against a live
database rather than by reading. Both reports were accurate about the SYMPTOM and
wrong about the CAUSE, and in each case the stated cause would have sent a fixer to
the wrong file - so each entry now leads with the correction. That is the useful
half: a reproduction is evidence, and a diagnosis attached to it is a hypothesis.

Two of the first three were fixed WEEKS before their re-check and nobody noticed,
because nothing re-runs these reproductions: entry 1 said "not re-checked", and
entry 2 said "still present" on the strength of a run measured against a `main`
that was already two weeks stale. A defect list that is not re-checked drifts into
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

---

## 4. `genArtifacts` emits two artifacts from one fold that disagree about an enum column

**RESOLVED.** Fixed by `a4974347` (2026-08-17), *"fix(fold): a t.enum column's members
now reach the runtime descriptor"* - the same day it was reported. `runtimeJson` now
carries the enum's members on the field, in declaration order, on every dialect.

**The conclusion was right and the stated reason was not**, which matters because the
stated reason would have sent a fixer to the wrong file. See "Verified versus inferred"
below; the correction is the first item there.

Re-checked against `main` by RUNNING it, which the reporter could not do. What now pins
it, all asserting on CONTENT rather than on `ok` - a silently dropped enum returns
`ok=true` too, which is exactly how this shipped:

- `crates/zero-migrate-node/tests/gen_artifacts_enum_column.rs` (4 arms) - the
  reproduction below through `genArtifacts`, both artifacts, `sqlite` + `postgres` +
  `mysql`; the members in declaration order; control A no longer indistinguishable from
  the subject; control B still `"int"`; the `createEnum` in an EARLIER migration still
  reaching the later file's column; an unprovable membership OMITTED rather than
  invented; and the descriptor source keeping what it declares.
- `crates/zero-migrate/tests/enum_membership_reaches_no_second_check.rs` (3 arms) - the
  real lowered DDL on both dialects plus the SQLite 12-step rebuild, proving the fix
  puts no CHECK anywhere it did not already exist.
- `packages/zero-migrate-cli/tests/host/gen-artifacts-enum-column.test.ts` (2 arms) -
  the reproduction through the recorder and the REAL addon, which is how it was
  reported.

**Where the members actually live, and why the fix is wide.** `ColType::Enum { name,
schema }` (`zero-migrate-ir/src/ir.rs:634`) carries the NAME ONLY. The members are in a
separate `Op::CreateEnum { name, schema, values }` (`ir.rs:3380`). So no mapping whose
whole input is one `IrColumn` can populate `enum_values`, at any signature - they have
to be resolved from the op STREAM. The `FieldDef` projection carries the same
`NamedTypeRegistry` the DDL lower and the snapshot fold resolve named types through, and
lifts the membership at the three sites where a column acquires a type (`createTable`,
`addColumn`, `setColumnType`).

**A consumer still seeing this is pinned to an engine older than `a4974347`.**

**Originally observed on:** `cb1bcb59` (the commit appbase vendors), via the
`zero-migrate-node` addon built from that checkout.

**Reported by:** zeroship (/home/ruiyang/Projects/appbase), 2026-08-17
**Severity (as reported):** the runtime loses a closed set the database enforces;
the app's generated typing and its `env.db` validation both see a bare string

One `genArtifacts` call returns two co-emitted artifacts. For a `t.enum` column they
did not agree: `envDbTs` kept the enum, `runtimeJson` reduced it to `string` and
dropped the members. The `RuntimeSchemaDescriptor` is the artifact a deployed app
actually installs `env.db` from, so the half that lost the information is the half
that matters at runtime.

### Minimal reproduction

One table, three columns: the subject plus two controls. Recorded through
`recordMigrationsDir`, then `genArtifacts({ envelopes, projectSchema: "public",
charterLayers: [<confined ceiling>], dialect })`.

    enumType("issue_status").create({ values: ["UNCONFIRMED", "CONFIRMED", "RESOLVED"] });
    table("issues").create({
      columns: {
        status:  t.enum("issue_status").notNull().default("UNCONFIRMED"),  // subject
        summary: t.text().notNull(),                                       // control A
        weight:  t.int().notNull().default(0),                             // control B
      },
    });

The recorded op carries the enum, so nothing is lost before the fold:

    { "name": "status", "type": { "enum": { "name": "issue_status" } },
      "nullable": false, "default": { "literal": { "value": "UNCONFIRMED" } } }

Result BEFORE the fix, IDENTICAL for `dialect: "sqlite"` and `dialect: "postgres"`,
both `ok=true`:

    --- envDbTs ---
    status:  t.enum("issue_status").notNull().default("UNCONFIRMED")
    summary: t.text().notNull()
    weight:  t.int().notNull().default(0)

    --- runtimeJson ---
    status:  {"type":"string","required":true,"default":"UNCONFIRMED"}
    summary: {"type":"string","required":true}
    weight:  {"type":"int","required":true,"default":0}

    the substring "enum" appears ANYWHERE in runtimeJson: false

Result AFTER the fix, on `sqlite`, `postgres` AND `mysql`:

    status:  {"type":"string","required":true,"default":"UNCONFIRMED",
              "enum":["UNCONFIRMED","CONFIRMED","RESOLVED"]}
    summary: {"type":"string","required":true}
    weight:  {"type":"int","required":true,"default":0}

### Controls

**Control A (`t.text`) makes the loss legible rather than cosmetic.** `status` and
`summary` were indistinguishable in `runtimeJson` - both `"type": "string"` - though
one is a closed set of three values and the other is free text.

**Control B (`t.int`) rules out "the descriptor is just coarse".** `weight` keeps
`"type": "int"` in the same table in the same call, even though `@zeroship/db`'s
TypeScript lexicon has no integer builder and the token has nowhere to go on the
consumer side. So the descriptor does preserve a narrowing it cannot express
downstream; enum is not being dropped under that rule.

**The DDL is correct, which is why this stayed invisible.** On SQLite the same
migration applies as `"status" TEXT NOT NULL DEFAULT 'UNCONFIRMED' CHECK ("status"
IN ('UNCONFIRMED', 'CONFIRMED', 'RESOLVED'))`. The database enforces the set; only
the descriptor forgot it. That remains true after the fix, byte for byte.

### Where it happened

`crates/zero-migrate/src/render/lower.rs:10451` at `518de22b`:

    ColType::Enum { .. } | ColType::Domain { .. } => ("string".into(), None),

in `col_type_to_token`. That arm is UNCHANGED by the fix, and correctly so: the type
TOKEN of an enum column really is `"string"`, and the fix adds the sibling
`enum_values` facet rather than moving the token. `gen_types.rs:1467`
(`ColType::Enum { name, .. } => format!("t.enum({})", ...)`) was already right.

### What was ruled out (by the reporter)

- **A stale vendored engine.** The mapping above was read at `main` (`518de22b`),
  not only at the vendored `cb1bcb59`.
- **Dialect.** Both `sqlite` and `postgres` produced byte-identical field entries.
- **The consumer's own renderer.** appbase discards the engine's `envDbTs` and
  re-renders its `env.db.ts` from `runtimeJson`, so its generated types inherited
  this. But the disagreement is inside one `genArtifacts` reply, before any
  consumer code runs - reproduced by calling the addon directly.
- **The charter.** A single minimal confined ceiling was used; the loss was in the
  type mapping, not in an inject rule.

### Verified versus inferred

**CORRECTED - the reporter's reasoning about the signature.** The report said the fix
"looks wider than a match arm" because `col_type_to_token` returns
`(String, Option<String>)` and "the `Option` is spoken for by `ColType::Ref`'s target,
so there is no room in this signature for the values". That does not hold.
`col_type_to_token` has ONE caller, `ir_column_to_field` (`lower.rs:10111`), which
invokes it as `col_type_to_token(&c.ty)` - the caller already holds the whole `ColType`
and the whole `IrColumn`, and already sets six sibling facets (`vector_dims`,
`char_len`, `max_length`, `unbounded_text`, `encrypted`, `mask`) the two-slot return has
no room for either. The signature was never the obstacle.

The real obstacle is stronger and the report did not state it: **the column does not
carry the members at all.** `ColType::Enum` is `{ name, schema }`; the values are in
`Op::CreateEnum`. `ir_column_to_field(c: &IrColumn)` could not populate `enum_values`
from `c` no matter what it returned. That is why the fix lives in the fold behind the
`FieldDef` map (`fold_to_field_defs` when this was written; `project_field_defs` since
step 4 consumer 3 deleted that walker),
which has the op stream, and not in the type mapping.

VERIFIED by the reporter, by running: the reproduction above against the addon built
from `cb1bcb59` - the recorded op, both dialects, both artifacts, and the absence of the
substring "enum" in `runtimeJson`. VERIFIED by reading `main`: `lower.rs:10451` and
`gen_types.rs:1467` at `518de22b`.

NOW VERIFIED BY RUNNING, the three things the reporter listed as unverified:

- **`main` reproduces it.** Confirmed at `518de22b` by building and running it. The
  RED failed with the members absent (`left: None`), matching the report exactly, and
  the neuter (fix disabled, addon REBUILT from the neutered tree) reproduces that
  failure on demand.
- **The descriptor path did NOT lose it.** A `CollectionDescriptor` has no way to NAME
  a native enum type. `enum_values` on a `string` field is the only enum a descriptor
  can express, `descriptors_to_create_ops` turns it into a table-level CHECK in the
  closed OR-chain shape, and `recover_check_facet` lifts it straight back onto the
  column. The membership survived that path all along, by a different mechanism. So the
  two sources now reach the same `runtimeJson` field by two different routes, and only
  the envelope route needed fixing.
- **`enum_values` round-trips cleanly, and the new-CHECK hazard does not occur.** The
  slot has a second reader, `field_check_constraints`, which renders it as
  `CHECK (<col> IN (...))`. That reader is never reached from this replay: a named enum
  column's storage comes from the `NamedTypeRegistry`, not from a `FieldDescriptor`.
  Measured on the real lowered DDL - PostgreSQL emits `CREATE TYPE` plus a native-typed
  column with ZERO CHECKs; SQLite emits exactly ONE inline
  `CHECK ("status" IN (...))`, the same one as before. The one path where this replay's
  output IS load-bearing for DDL (the engine seeds `live.sqlite_schemas` from it on the
  SQLite leg, and the 12-step rebuild renders from that) was measured with the lift
  disabled and enabled: the `CREATE TABLE` is BYTE-IDENTICAL.

TWO SEPARATE, PRE-EXISTING DEFECTS this work measured and did NOT fix, recorded so they
are not rediscovered as regressions:

1. **A descriptor-declared membership is refused outright on SQLite.** The CHECK
   `descriptors_to_create_ops` emits is table-level, and `createTable table-level CHECK
   is PostgreSQL-only`. Any descriptor carrying `enum_values` - or `min`/`max`, which
   take the same route - fails on SQLite. Older than this fix, untouched by it, pinned
   in `gen_artifacts_enum_column.rs`.
2. **A SQLite rename rebuild emits an inline CHECK naming the PRE-rename column.**
   `sqlite_rename_rebuild` renames `ColumnSnapshot::name` and the generated expressions
   but not `inline_checks`, so the rebuilt table reads
   `"state" TEXT NOT NULL CHECK ("status" IN (...))`. Byte-identical with and without
   this fix. Bounded: reachable only on the fold-seeded path, because a catalog-read
   live snapshot carries `stored_create_sql`, which makes the rebuild preserve the
   stored body and let SQLite's own `RENAME COLUMN` rewrite the predicate. Pinned as
   current behaviour in `enum_membership_reaches_no_second_check.rs`.

STILL NOT FIXED, and out of this entry's scope: `ColType::Domain` shares the
`("string", None)` arm, so a domain over `int` gets the runtime token `"string"`. It was
deliberately left out of this fix - a domain's constraint is an arbitrary predicate, not
a closed value set, so `enum_values` would be a lie about it - but the token coarseness
is a real, separate defect.

---

## 5. An injected system column cannot carry a collation, so `ORDER BY id` is not creation order on PostgreSQL

**RESOLVED.** Fixed by `f0e6dc67`, *"fix(policy): a charter-injected column can pin
the byte order its ids sort by"* - the same day it was reported.

**The open question, answered: NEITHER of the two options this entry offered.** The
fix is a new field on `InjectColumn`, but it is not the inject-only knob the entry
imagined, and it is not reuse of the value-format mechanism either. Both were
measured and both are wrong:

- **An authored column could not express a collation today.** `IrColumn` had no
  collation field at all. The ONLY route to `COLLATE "C"` was as a side effect of
  declaring a TypeID or ULID value format, which `crates/zero-migrate/src/render/fold.rs`
  stated in as many words ("the ONE fold-side writer of this field is `value_format`'s
  `bytewise_catalog_collation`"). So this was never an inject-only hole.
- **Reusing the value format would have broken the table.** The engine's TypeID
  alphabet is Crockford base32 LOWERCASE (`0123456789abcdefghjkmnpqrstvwxyz`). The
  ids described above are base62, MIXED CASE - which is precisely why their upper
  and lower runs interleave. `ValueFormat::TypeId` on the injected `id` would emit a
  CHECK every existing and future row FAILS. And `created_by`/`updated_by` are actor
  stamps with no value format at all.
- The sharpest evidence: `IrColumn::id_prefix`'s own doc describes the legacy
  platform-ID format as `<prefix>_<22 base62 UUIDv7>` - verbatim the format above.
  An author who declares that prefix got `character varying(255)` with no collation,
  measured. The engine already knew the column held base62 ids and still ordered it
  by the server's locale.

So the fix is a per-column collation INTENT on `IrColumn`, which the charter's new
`InjectColumn::collation` maps onto. It rides the same `ddl_type_override` +
`ColumnSnapshot::collation` seam the value formats use, so it inherits their drift
comparison and live introspection.

**The charter surface:**

    columns = [
      { name = "id", type = "text", nullable = false, collation = "bytewise" },
    ]

One closed token, not a collation name, because a charter has to be sound on three
dialects: PostgreSQL `COLLATE "C"`, SQLite `COLLATE BINARY`, MySQL
`utf8mb4_0900_bin`. An unknown token fails to LOAD, with the TOML line. The
collation joins the II.2.6b conformance check (an author column matching an
injected slot on everything BUT the collation is not the injected shape) and the
policy seal (two charters resolving to different DDL must not seal identically).
Pinning it on a non-text column is refused, not dropped.

**The report understated the blast radius.** MySQL has the same defect: an injected
column lands on `utf8mb4_0900_as_cs`, which is case-sensitive but LINGUISTIC, not
bytewise. Only SQLite was correct, and only by accident.

**Tests that pin it:** `crates/zero-migrate/tests/injected_column_collation.rs`
(9 tests) plus `column_collation_round_trips_and_absent_collation_omits_key` in
`crates/zero-migrate/tests/ir_wire_contract.rs`.

The PostgreSQL legs measure ROW ORDER, not DDL spelling: four ids whose byte order
is known are inserted through engine-emitted DDL and read back with `ORDER BY id`,
against a live PostgreSQL 18.4 whose `datcollate` is `en_US.utf8` (queried before
any ordering result is trusted). Before the fix that read back
`["...aaa", "...AAA", "...zzz", "...Zzz"]` - the interleave itself.
`injected_id_without_a_pinned_collation_loses_creation_order` is a PERMANENT neuter
check: it pins that the same fixture with the pin removed still comes back wrong,
and both legs refuse to run on a `C` or `POSIX` database, where they would prove
nothing. The live leg also diffs the folded snapshot against a fresh introspection,
so the fix cannot emit correct DDL and then report the schema as drifted.

**What is NOT covered, stated rather than implied:**

- `addColumn` does not accept the facet; only `createTable` columns can pin one.
- The descriptor path and the TypeScript authoring lexicon have no verb for it. The
  charter is the authoring surface today.
- This tightens the STRUCTURED resolver only. The guard's raw-create admit compares
  column NAMES and the pinned key order, and never looked at type, nullability or
  default either, so a raw `CREATE TABLE` without the collation is admitted exactly
  as before. That gap predates this issue.
- The MySQL spelling is pinned at the DDL-text level; no live MySQL ordering run was
  made. PostgreSQL and SQLite ordering were both measured against a real database.

**A consumer still seeing this is pinned to an engine older than `f0e6dc67`.**

**Originally observed on:** `cb1bcb59`; re-checked and fixed against `main`
(`518de22b`).

**Reported by:** zeroship (/home/ruiyang/Projects/appbase), 2026-08-17
**Severity (as reported):** silent wrong ordering in production only; dev is correct,
which is the worst shape for it

`InjectColumn` (`crates/zero-migrate-policy/src/rule.rs:74`) had four fields and no
collation slot:

    pub struct InjectColumn {
        pub name: String,
        pub ty: String,
        pub nullable: bool,
        pub default: Option<String>,
    }

A charter that injects `id` / `created_by` / `updated_by` therefore could not pin a
collation on them, and they landed on the database default.

**Why that is a correctness problem and not a preference.** The consumer's ids are
typed ids: a prefix plus base62 of a UUIDv7, so their BYTE order is creation order.
Under `en_US.utf8` - the common PostgreSQL default - base62's upper- and lower-case
runs interleave, so `ORDER BY id` is not creation order. The consumer's own
non-charter renderer pins `COLLATE "C"` on the same three columns precisely for
this; the charter path could not, so the two producers of the same logical table
disagreed.

Dev (SQLite, BINARY collation) orders correctly, so this reproduced only against a
deployed PostgreSQL, and it failed silently rather than erroring.

### Verified versus inferred

VERIFIED by the reporter, by reading: the struct at both `cb1bcb59` and `518de22b`,
and the absence of any collation handling in the policy crate. The consumer-side
half (its renderer pinning `COLLATE "C"`, and the divergence measured on a deployed
app schema) is recorded on the consumer side and is not something this repo need
take on faith.

NOT VERIFIED by the reporter, and NOW ANSWERED ABOVE by measuring: whether an
authored (non-injected) column CAN express a collation today (it could not), and
therefore whether the fix is a new `InjectColumn` field or reuse of an existing
mechanism (a new `IrColumn` collation intent that `InjectColumn` maps onto - neither
of the two options as posed).
