# Composing full-text search: the primitive gap

**Status: Draft. This is not a plan — it is a record of measured fact.**

The design principle behind removing full-text support, stated by the user:

> fts should not be a builtin/atomic type, it should be composited from small stuff.

So this is not "delete FTS, add a macro later". **FTS being a builtin was the design
error**; a macro is only the composition mechanism. That is why `IndexMethod::Fts5`
goes too: a composed feature expands to primitives, so the IR must not carry a
first-class full-text index method.

**The headline finding is that the primitives to compose it do not currently
exist**, and the reason is a single clean gap: the SQLite authorizer takes no
policy input, so everything it permits or denies is a compiled-in constant. §1 is
that gap, and the direction that resolves it — the engine should not hardcode what
is forbidden; operators should define policy, and the authorizer should derive its
floor from that policy rather than from constants. Everything after §1 is the domain
detail the removed code encoded — what FTS actually decomposes into — recorded so
the next person starts from measured fact.

This document does **not** design the composition.

Everything below is labelled **VERIFIED** (measured in this tree, on a real
database, or read directly from code that was under test) or **INFERRED**.

Placement note: this sits in `docs/proposals/` rather than `docs/` because it
describes something that does not exist. It is not operator documentation. The
operator-facing consequence of the removal is in `docs/dialects.md`.

---

## 1. THE PRIMITIVE GAP — read this first

FTS decomposes into four small pieces. Three of them the engine can express today.
One is **denied outright**, and it is denied on purpose.

| Piece | Expressible today? |
|---|---|
| A base table with the source columns | **Yes** — ordinary `createTable` |
| Sync triggers mirroring rows into the index | **Yes** — ordinary trigger DDL |
| A naming contract binding index to parent | **Yes** — pure convention, no engine support needed |
| **A virtual table with external-content configuration** | **NO** |

### 1.1 A user cannot author a virtual table at all

**VERIFIED**, `apply/backend/sqlite/authorizer.rs` (state at the base of this
change, before the `fts5` entry was removed):

```rust
AuthAction::CreateVtable { module_name, .. } => match current {
    // Engine-emitted goodie DDL may create an fts5/vec0 vtable, ONLY in
    // engine mode. Creator mode can never make a vtable.
    Mode::EngineJournal
        if module_name.eq_ignore_ascii_case("fts5")
            || module_name.eq_ignore_ascii_case("vec0") => Authorization::Allow,
    _ => Authorization::Deny,
},
```

`journal_sql.rs` states the same rule from the apply side: an ordinary creator `up`
runs confined, "denied from `_mig`, from transaction boundaries, from PRAGMA, **from
making a vtable**".

So "composite FTS from small stuff" is **currently impossible**: the smallest
necessary piece is refused.

### 1.2 The one allowance is a two-item allowlist, not a general rule

This is the part most likely to be misread. The engine-mode path is **not** "the
engine may create virtual tables". It is a hardcoded match on two module name
strings, `fts5` and `vec0`. There is no general primitive behind it.

**This change removes `fts5` from that list**, leaving `vec0` alone — because the
engine no longer authors any FTS DDL, and conceding a capability nothing asks for is
not a neutral act. A composed FTS therefore needs that list to stop being a
constant at all -- see 1.3.

### 1.3 Why it is hardcoded — and the direction that resolves it

The denial reads like deliberate hardening, and it is: the comment calls it "belt
and suspenders alongside `load_extension_disable` at open", and a virtual table is
an execution surface — the module runs C inside the connection, which is why
`TRUSTED_SCHEMA=false` exists to stop a creator-authored schema object becoming a
deferred-execution device for one (§5).

But conservatism is not the whole reason, and the real one is more useful.
**VERIFIED**, `apply/backend/sqlite/authorizer.rs:458`:

```rust
pub(crate) fn make_authorizer(
    mode: AuthMode,
    denials: DenialLog,
) -> impl for<'r> FnMut(AuthContext<'r>) -> Authorization + Send + 'static
```

It receives an atomic mode byte and a denial log. **No policy, no charter, no
capability set.** It is installed once at connection open (`actor.rs:686`). So every
decision it makes is necessarily a compiled-in constant — the `{fts5, vec0}` vtable
allowlist, the fail-closed function-name allowlist, the whole deny matrix.

> **The authorizer is not hardcoded out of conservatism. It is hardcoded because it
> has nothing else to consult.**

The user's direction settles which way this should go:

> we should support users to do anything, and user can define the policies.

So the engine should not hardcode what is forbidden; the policy layer is the
mechanism, and it is operator-controlled.

**The required shape already exists one layer up. VERIFIED:** the charter already
gates `code.extension`, `code.function`, `code.materialized_view`, and
`zero-migrate-ir/src/policy_capability.rs:11` records that *"Every capability knob
but `code.extension` is a `Bool` grant"* — i.e. `code.extension` is already a
**named-value allowlist**, which is exactly the shape a `code.vtable_module`
capability needs. `support::operator_charter` already carries
`code.extension = ["citext", "pgcrypto"]`.

So the headline restates as: composing FTS from primitives needs an authored
migration to **name a virtual-table module**; naming a module is the one capability
the sandbox withholds; and the resolution is a **policy-derived authorizer** rather
than a widened constant. The operator's charter says which modules are permitted,
`validate` checks it at plan time, and the authorizer is configured from the same
policy.

### 1.3.1 The caution that comes with it

This is easy to get wrong in a way that looks finished.

The authorizer is **line-2 confinement** — the runtime analogue of PostgreSQL's
least-privilege `migrator` role, checked at **prepare time on the connection**.
Policy is checked at **plan time**. Making the authorizer policy-derived must
**not** collapse those two layers. It should take its floor from the charter instead
of from constants and still enforce independently, on its own, at its own moment.

> **A line-2 authorizer that trusts line 1 to have already checked is not defence in
> depth at all — it is one check with extra steps.**

### 1.3.2 The same gap has a second instance

**VERIFIED:** the SQL preview validates with **no policy at all** —
`render/sql_preview.rs` passes `None` for both schema scope and vendor authority.

That is the same class of defect as the authorizer's missing policy input: **policy
does not reach every enforcement point.** Whoever picks this up should know it is
not a one-site fix, and should look for the other sites rather than assume these two
are the whole set.

### 1.4 Drift is the second precondition

If virtual tables are to become composable, drift must tolerate them **generally**
rather than by an `fts5` special case. The `DropOfVirtualTable` guard this change
adds (§6) is the first half of that, and it is a precondition for the composition
story rather than only a safety net for this removal. The second half — teaching
drift to *recognise* a composed vtable as a declared object rather than merely
refusing to drop it — does not exist.

---

## 2. Why the builtin broke

The facet worked in the declarative lane and was **broken in the versioned/export
lane**, which is the one a downstream platform reads.

**VERIFIED.** `IrColumn` had no `fts` field. `descriptors_to_create_ops` therefore
dropped the facet on the way in, and `ir_column_to_field` had nothing to recover on
the way out — while the DTO slot still existed and reported `false`. A consumer
reading that slot got a constant, not a schema fact.

**The lesson for a macro design, stated as a constraint:** do not reintroduce a
slot that *looks* answerable and is not. A facet that cannot round-trip through the
IR should not have an IR-adjacent representation at all. A macro that expands to
primitive ops satisfies this by construction — there is nothing to round-trip,
because the expansion has already happened by the time the IR sees it.

---

## 3. The SQLite shape

### 3.1 External-content mode, and why

**VERIFIED** (was pinned by `schema/fts_sqlite.rs`'s own tests):

```sql
CREATE VIRTUAL TABLE IF NOT EXISTS "<coll>__fts"
  USING fts5("col1","col2", content="<coll>", content_rowid="rowid")
```

`content=` / `content_rowid=` select **external-content** mode: the FTS5 index
stores only the tokenised inverted-index payload, and the source text stays in the
base table. The alternative (standalone/contentless) doubles storage and breaks the
`SELECT t.* FROM coll t JOIN coll__fts f ON t.rowid = f.rowid` join that returns
every base column unchanged.

This choice has consequences that reach much further than storage — see §3.3 and
§3.4.

### 3.2 The naming contract

**VERIFIED.** The vtable is `<collection>__fts`. Its parent collection is recovered
by **stripping that exact suffix** — that was the whole of `fts_parent_collection`.

The suffix was load-bearing in both directions: the drift introspector required
*both* a `__fts` suffix **and** a parsed `USING fts5(...)` create before it would
treat a table as an FTS index, so an ordinary table coincidentally named `x__fts`
was not misread.

**The generalised lesson:** name conventions are not a safe classifier on their own.
The removed code paired the name with the stored `CREATE` text, and the replacement
guard (§6) dropped the name half entirely and keys only on the DDL shape.

### 3.3 The three sync triggers

**VERIFIED.** `<coll>__fts_ai` / `<coll>__fts_ad` / `<coll>__fts_au`, all **AFTER**
(not BEFORE), so the canonical row state has landed before the index sees it.

The DELETE and UPDATE-eviction legs cannot use a plain `DELETE FROM`: that is not
allowed on an external-content vtable. They use the FTS5 **"delete command"** form:

```sql
INSERT INTO <fts>(<fts>, rowid, <cols>) VALUES ('delete', OLD.rowid, <OLD.cols>)
```

Note the first column is the vtable's own name used as a sentinel — an FTS5 idiom
that reads like a typo and is not.

**VERIFIED, SQLite engine rule:** the table referenced inside a trigger **body**
cannot be database-qualified. SQLite resolves it within the same attached database
as the trigger. So the body always references `"<coll>__fts"` unqualified even when
the trigger header is qualified. This is why the removed builders took
`schema: Option<&str>` and applied it to the header only.

### 3.4 The shadow tables — including a correction

**VERIFIED by direct measurement** (a real SQLite database, one `.fts()` column on
a collection `posts`, read back from `sqlite_master`):

```
posts            <- the base table
posts__fts       <- the vtable
posts__fts_config
posts__fts_data
posts__fts_docsize
posts__fts_idx
```

That is **one vtable and FOUR shadow tables**, not five.

**`_content` is NEVER created under external-content mode.** The removed
`is_fts5_shadow_table` carried a five-element `SUFFIXES` list —
`_data`, `_idx`, `_docsize`, `_config`, `_content` — of which the last matched a
mode this engine never used. It was defensive, not wrong, but every count derived
from that list was off by one, and at least one review inherited the error.

**INFERRED:** `_content` is what FTS5 creates when it must store the source text
itself, i.e. when `content=` is absent. Not measured here, because the engine never
emitted that form.

### 3.5 Dropping the vtable cascades the shadows

**VERIFIED by direct measurement:**

```
DROP TABLE "posts__fts"          => OK        (all four shadows disappear with it)
DROP TABLE "posts__fts_config"   => ERROR: no such table
DROP TABLE "posts__fts_data"     => ERROR: no such table
DROP TABLE "posts__fts_docsize"  => ERROR: no such table
DROP TABLE "posts__fts_idx"      => ERROR: no such table
```

This is why the removal's original failure mode was **destructive-first and
non-atomic**: a plan that authored five drops (one per table it could see) committed
the destructive one first and then failed partway through on tables that no longer
existed, reporting an error that did not name the damage. Migrations commit
individually, so the first drop was already durable.

A macro that emits a teardown must drop the **triggers first, then the vtable**, and
must not attempt the shadows at all.

---

## 4. The PostgreSQL shape

**VERIFIED** (read from the removed `fts_objects_pg` and the deleted truncation
test): PostgreSQL used an entirely different shape, and the two never shared DDL —
only the `.fts()` descriptor that produced them.

- One composite **`__fts` GENERATED tsvector column** per collection, folding every
  `.fts()`-marked column. The generated-column form is trigger-free, so the whole PG
  FTS shape was pure DDL.
- One **GIN index** over it, named `<collection>__fts_idx`.
- The language token (`english`, `simple`, …) is the tsvector configuration. It is
  honoured on PG and **ignored on SQLite**, whose default tokenizer is
  language-agnostic Unicode. The removed code took the first non-empty language
  among a collection's `.fts()` fields and defaulted to `english`.

`tsvector` has no SQLite spelling. An earlier bug emitted the PG-shaped `__fts`
index on SQLite, where apply failed with `no such column: "__fts"`. **The dialect
split is not cosmetic** — a macro must expand differently per dialect, not emit one
shape and hope.

### 4.1 The 63-byte index-name clip, and why not a hash tail

This is the knowledge from `fts_index_name_truncation_pg.rs`, which the removal
deletes. It is worth keeping because it is counter-intuitive.

**VERIFIED.** PostgreSQL truncates any identifier over `NAMEDATALEN - 1` (63) bytes
at CREATE, with only a NOTICE. A collection name over 54 bytes pushes
`<collection>__fts_idx` past that bound, so the name the catalog ends up holding is
not the name that was emitted. Because the index diff is keyed on **name**, the
desired (full) spelling then reads as missing and the live (truncated) spelling as
unexpected — on every re-diff, forever.

The fix was to derive the **truncated** spelling at author time so desired equals
what is already on disk.

**The trap:** the engine's general `cap_ident_name` / `index_name` scheme appends a
hash tail to over-long names. Applying it here would have been wrong twice — it
*replaces* the tail, renaming an index that already exists on a live database under
the server's own truncation, and it does not produce a `__fts_idx` spelling at all,
which was the contract the data plane's search read. **Mimicking the server renames
nothing; hashing renames everything.**

The clip counts **bytes** but stops on a **character boundary** rather than splitting
a UTF-8 sequence — which is what the server does too. **VERIFIED** on PostgreSQL
18.4 with a UTF8 server encoding: a 64-byte name of one ASCII byte plus 21
three-byte characters is stored as 61 bytes (21 characters), not cut at byte 63
mid-sequence.

**Left open, deliberately:** two collections sharing a 54-byte prefix derive the
same 63-byte index name, and the second `CREATE INDEX IF NOT EXISTS` is skipped,
leaving that collection without an index. That is what the server already does with
the untruncated names, so the derivation neither introduced nor closed the
collision. Closing it needs a distinguishing tail — which is the rename the whole
scheme exists to avoid. A macro inherits this tension unchanged.

---

## 5. The authorizer, in full

**VERIFIED** (`apply/backend/sqlite/authorizer.rs`):

- **A creator may never create a virtual table.** `CREATE VIRTUAL TABLE` is denied
  outright in `CreatorUp` mode. Engine-emitted vtable DDL was permitted **only** in
  `EngineJournal` mode. A macro that expands to `CREATE VIRTUAL TABLE` must arrive
  through an engine-mode path; expanding it into an ordinary creator `up` will be
  refused.
- The `fts5` module was removed from that allowance with this change. `vec0`
  remains. Restoring FTS means restoring the module to that arm deliberately.
- **`PRAGMA data_version` on the app database is conceded in BOTH modes, and this
  outlived the feature.** FTS5's `xUpdate` issues it internally on first access to
  an index object on a connection. Without it, nothing can be written to an FTS5
  index at all. It is still conceded after the removal because removing the feature
  did not remove the data: a legacy database still carries `<coll>__fts` and its
  triggers, and an ordinary creator INSERT into the base table fires those triggers,
  which routes into FTS5 and issues the pragma. The concession is **scoped by
  database** — the same pragma on the `_mig` journal stays denied, because
  `data_version` counters are per-schema and a name-only allow would hand a creator
  a monotone counter of the engine's own journal commits.
- **`SQLITE_DBCONFIG_DEFENSIVE` is the only thing stopping a creator `up` from
  rewriting an FTS5 shadow table's b-tree directly.** The authorizer permits creator
  DML on any `main` table that is neither a schema table nor in `_mig`, and the
  shadow tables are exactly that. With DEFENSIVE off, the same `DELETE` succeeds and
  the next search fails with `fts5: corruption found reading blob`. That test
  survives this removal, re-pointed at a raw-seeded legacy index
  (`tests/policy_charter/sqlite_confinement.rs`).
- **`SQLITE_DBCONFIG_TRUSTED_SCHEMA=false`** stops a creator-authored VIEW body from
  being a deferred-execution device for virtual tables. It gates **use**, not
  creation: the `CREATE VIEW` naming a vtable is accepted and the refusal arrives
  when something later reads the view.
- The engine never issues an FTS5 `MATCH`. `match` is deliberately **absent** from
  the authorizer's function allowlist, and the old tests read the index back on a
  reopened raw connection for exactly that reason. A macro does not change this:
  searching is the data plane's job, not the migration engine's.

---

## 6. Drift, and what replaced the FTS-specific tolerance

**VERIFIED.** The removed introspector did two things that were *not* about
authoring FTS, and that a macro will need again in some form:

1. It converted a live `<coll>__fts` vtable into an `IndexSnapshot` with
   `access_method = "fts5"` attached to its parent collection, so a re-diff of an
   unchanged FTS schema was zero-drift.
2. It **excluded the shadow tables entirely** from the snapshot, like the `sqlite_*`
   internals, so they never read as drift.

Without (2), the shadows surface as ordinary base tables. **VERIFIED by
measurement:** with the tolerance removed and no other guard, the differ authored
five `DROP TABLE`s against a legacy FTS database.

That is now blocked by a **general** guard rather than an FTS-shaped one:
`DeclarativeError::DropOfVirtualTable` refuses to author a `DROP TABLE` for any live
table whose stored `CREATE` is a `CREATE VIRTUAL TABLE`, keyed on the DDL token
shape and **not** on a module allowlist or a name convention. It fires ahead of the
ownership check, because the ownership guard only fails closed when a caller cannot
confirm an owner — an orchestrator that maps every live table to the deploying app
resolves cleanly and would otherwise reach the drop.

**This is forward infrastructure, not only a safety net.** A macro that expands to
`CREATE VIRTUAL TABLE` needs drift to tolerate virtual tables generally. The guard
is the first half of that. The second half — teaching drift to *recognise* a macro's
vtable as a declared object rather than merely refusing to drop it — does not exist
and will have to be built.

**INFERRED:** `vec0` vtables created by a data-plane runtime are exposed to the same
drop pass and were exposed before this change too. The absence of any general
virtual-table exclusion is VERIFIED; that a real `vec0` table gets dropped end to
end is NOT — the hardened connection refuses to load `sqlite-vec`, so it could not
be constructed here. The guard's recognition of `vec0`'s exact DDL shape *is*
verified, by unit test.

---

## 7. `engine_goodie_ddl` is now a constant

**VERIFIED.** `MigrationFlags::engine_goodie_ddl` routes a migration's `up` to
`EngineJournal` instead of `CreatorUp`. Its **only** producer was the FTS5 vtable
create. The IR lane cannot set it — `validate_ir_plan_execution_metadata` rejects an
authored value outright. After this removal nothing in the tree sets it true, so it
is a constant `false`.

It was **retained, not removed**, and the reason matters: it is covered by the
canonical checksum image, so deleting it would invalidate every recorded migration's
checksum. That is a strictly larger consequence than the removal that stranded it,
and it belongs with the IR-version question rather than being slipped in here.

**A macro will hit this immediately**, because engine-mode DDL is exactly what a
vtable-emitting macro needs. The flag is already there and already wired through
`journal_sql.rs`; it needs a producer, not a design. Note the honesty problem it now
has in the meantime: it is the same "slot that looks answerable and always says the
same thing" shape that motivated removing the `fts` DTO slot in the first place.

---

## 8. What the deleted tests knew

Sixteen tests were identified as full-text-only. **Fourteen were deleted**; the
other two turned out to have an independent purpose and were repaired instead (see
below). Most of the fourteen were shape assertions whose content is reproduced above
(the DDL strings, the trigger forms, the column-list parser). Two categories were
worth more than their assertions, and are captured here rather than lost:

- **`fts_index_name_truncation_pg.rs`** — the entire §4.1 argument. The test asserted
  a re-diff was clean; the *reasoning* about why hashing is wrong and clipping is
  right was in its prose and in `fts_index_name`'s doc comment. Both are now above.
- **The two confinement tests** were NOT deleted. They pin `SQLITE_DBCONFIG_DEFENSIVE`
  and the `data_version` concession, which are security properties independent of
  FTS — the FTS index was only their test vector. They were repaired to seed a legacy
  index on a raw connection instead of having the engine author one.

The remaining deletions — the `fts_sqlite.rs` unit tests, the `fts_index_name` clip
tests, the SQLite apply/behaviour tests — asserted behaviour that no longer exists
in any form. Their factual content is §3 and §4.
