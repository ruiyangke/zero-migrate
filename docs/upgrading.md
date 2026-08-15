# Upgrading to the schema/data protocol

This release replaces `up()` / `down()` with `schema()` and `data()`. There is no
compatibility path and no alias: a migration on the old shape is refused at
authoring time, before anything reaches a database.

Everything here is mechanical. Nothing about what your migrations DO changes —
only which function they are written in, and what a data migration must say about
reversing itself.

## The shape

DDL: create, alter or drop tables, columns, indexes, constraints, views.

```ts
import { table, t } from "zero-migrate";

export default {
  schema() {
    table("orders").create({ columns: { id: t.int().notNull() }, primaryKey: ["id"] });
  },
};
```

DML that can be reversed exactly:

```ts
import { table } from "zero-migrate";

export default {
  data() {
    table("orders").insert({ rows: { id: 1 } });
  },
  inverse() {
    table("orders").delete({ where: (col) => col("id").eq(1) });
  },
};
```

DML that cannot:

```ts
import { table } from "zero-migrate";

export default {
  data() {
    table("orders").update({ set: { status: "archived" } });
  },
  irreversible: "the prior status is not recorded, so it cannot be restored",
};
```

One module carries DDL **or** DML, never both. A `data()` migration declares
exactly one of `inverse()` or `irreversible`.

## Converting an existing migration

**1. A migration that only changes schema.** Rename `up` to `schema`. Done.

```diff
-export default { up() { table("orders").column("note").add({ type: t.text() }); } };
+export default { schema() { table("orders").column("note").add({ type: t.text() }); } };
```

**2. A migration that only writes rows.** Rename `up` to `data` and add a
declaration.

```diff
-export default { up() { table("orders").insert({ rows: { id: 1 } }); } };
+export default {
+  data() { table("orders").insert({ rows: { id: 1 } }); },
+  inverse() { table("orders").delete({ where: (col) => col("id").eq(1) }); },
+};
```

**3. A migration that does both — the one that takes real work.** Split it into
two files. The DDL keeps the original timestamp; the DML gets the next one, so it
still applies after the table exists.

```diff
-// 20260101000000_add_and_seed.ts
-export default {
-  up() {
-    table("orders").create({ columns: { id: t.int().notNull() }, primaryKey: ["id"] });
-    table("orders").insert({ rows: { id: 1 } });
-  },
-};
+// 20260101000000_add_orders.ts
+export default {
+  schema() {
+    table("orders").create({ columns: { id: t.int().notNull() }, primaryKey: ["id"] });
+  },
+};
+
+// 20260101000001_seed_orders.ts
+export default {
+  data() { table("orders").insert({ rows: { id: 1 } }); },
+  inverse() { table("orders").delete({ where: (col) => col("id").eq(1) }); },
+};
```

**One thing to expect when you split.** A migration that both created a table and
wrote to it established ownership implicitly. Once the write lives in its own
file, the table must be in your ownership registry, or apply refuses:

```
ownership violation: op 0 targets table "orders" owned by <unregistered>
```

Add the table to `registry.json`. That is the registry doing its job, not a
regression from the split.

**4. A migration with an authored `down()`.** Delete the `down` body. Rollback no
longer calls authored reverse code: a `schema()` migration is reversed by the
engine's own inverse, and a `data()` migration by the `inverse()` you record.

## Already-applied migrations

Migrations already in your journal are unaffected. Their checksums do not move —
the checksum folds a declared reverse only when one is present, so an artifact
that declares none hashes exactly as it did before.

You still have to convert the FILES, because `rollback` re-reads them and
`status` re-authors them to compare against the journal. A file left on `up()`
will be refused the next time either verb runs, even though the migration itself
applied cleanly months ago.

## What the refusals say

Each names the fix, so you can work through a project by running `lint` and
reading the output:

| message | what to do |
|---|---|
| `up() is no longer supported; use schema() for DDL or data() for DML` | rename, per cases 1–3 above |
| `schema and data changes must be separate migrations` | split the module (case 3) |
| `schema() recorded the DML operation <op>; move this operation to data()` | the split missed a write |
| `data() recorded the non-DML operation <op>; move this operation to schema()` | the split missed a schema change |
| `a data() migration must declare exactly one of inverse() or irreversible` | add one |
| `a data() migration cannot declare both inverse() and irreversible` | pick one |
| `irreversible must be a non-empty string` | give the reason, not `true` |

The last one is worth dwelling on. `irreversible` takes prose because an operator
reads it mid-incident while deciding whether to reach for a backup. Write what is
lost:

```ts
import { table } from "zero-migrate";

export default {
  data() {
    table("orders").update({ set: { status: "archived" } });
  },
  irreversible: "overwrites status without recording the prior value",
};
```

not `irreversible: "test fixture"` or `irreversible: true`.

## Why the phase is decided by your ops, not your function name

Both the recorder and the engine classify a migration by the operations it
records. Writing a row inside `schema()` is refused rather than accepted, and the
engine applies the same rule to any envelope it is handed, whatever produced it.

That matters because the alternative was hollow: if the phase came from the
function name, an author who did not want to write a reverse could skip the
requirement by typing `schema` instead of `data`, and the guarantee would hold
only for people who were not trying to avoid it.

## What rollback can do now

A `data()` migration with a recorded `inverse()` unwinds by running that inverse
as parameterized DML on PostgreSQL, MySQL and SQLite. One declaring
`irreversible` is refused, quoting your reason.

Two limits are worth knowing before you rely on it:

- the forward plan must lower to exactly **one** journaled step;
- a recorded inverse must lower only to transactional DML.

Anything outside those is refused before execution, not partway through.

## Related

- [Writing migrations](writing-migrations.md)
- [Operating migrations](operations.md)
- [CLI reference](cli.md)
