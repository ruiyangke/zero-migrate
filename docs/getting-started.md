# Getting started

zero-migrate is a no-raw-SQL, fully-structured migration toolchain: you author
schema changes as portable op-DSL modules and a host runtime lowers and applies
them across PostgreSQL, MySQL, and SQLite.

It ships as **two packages**:

- **`zero-migrate`** — the authoring DSL you write migrations in (`table()` /
  `t.*` / `view()`). Pure JS, no DB, no native addon.
- **`zero-migrate-engine`** — the host runtime and `zero-migrate` CLI that lower
  those migrations (over the native addon) and apply them to a live database.

**Driver model.** The network dialects — PostgreSQL and MySQL — are driven over
the host driver seam using the standard npm drivers (`pg` and `mysql2`); you
install whichever you target. SQLite runs **in-process** inside the addon
(rusqlite) and never crosses the seam, so it needs no npm driver.

---

## 1. Install

Install the DSL and the engine, plus the driver(s) for the databases you target:

```bash
# the authoring DSL + the host/CLI
npm install --save-dev zero-migrate zero-migrate-engine

# a driver per network dialect you apply against (SQLite needs none)
npm install --save-dev pg        # PostgreSQL
npm install --save-dev mysql2    # MySQL
```

The `zero-migrate` CLI ships as a bin from `zero-migrate-engine`. Migrations are
`.ts` modules; run the CLI under a TypeScript loader (`tsx` is simplest):

```bash
npx tsx node_modules/zero-migrate-engine/dist/cli-bin.js --help
# or, once the bin is on PATH:
zero-migrate --help
```

---

## 2. Scaffold a migration

`zero-migrate new <name>` writes a timestamped op-DSL module into the migration
directory (`./migrations` by default; override with `--dir`):

```bash
zero-migrate new create_users
# Creating migration: ./migrations/20260713xxxxxx_create_users.ts
```

The migration name must be `[A-Za-z0-9_]` (use `_` for spaces/dashes). The
generated file is a `zero-migrate` DSL module that imports `{ table, t }` and
exports a `default { up }`:

```ts
import { table, t } from "zero-migrate";

export const name = "create_users";

export default {
  up() {
    // Author your schema change with the fluent op DSL, e.g.:
    // table("widgets").create({
    //   columns: {
    //     label: t.text().notNull(),
    //   },
    // });
  },
};
```

---

## 3. Write a migration

A migration authors schema changes against the ambient per-migration recorder
via the fluent `table()` handle. Every table/column name is a plain string.
Columns are built with the immutable `t.*` type lexicon — nullable by default;
`.notNull()` is the opt-in.

Here is a complete, compiling migration that creates a `users` table and adds an
index on `email`:

```ts
import { table, t } from "zero-migrate";

export const name = "create_users";

export default {
  up() {
    table("users").create({
      columns: {
        id: t.id({ prefix: "usr" }),
        email: t.text().notNull().unique(),
        display_name: t.text(),
        org_id: t.ref("orgs").notNull(),
        created_at: t.timestamp().notNull().default(now()),
      },
    });

    table("users").index("users_email_idx").add({
      on: ["email"],
      unique: true,
    });
  },
};
```

The pieces:

- **`table("users").create({ columns })`** — creates a table. `t.id({ prefix })`
  is a non-null UUID primary key branded as a typed id (`usr_<base62>`).
- **`t.text().notNull().unique()`** — the `t.*` chain is immutable; each modifier
  returns a fresh `ColumnDef`. `.default(now())` uses a portable function
  expression, never raw SQL.
- **`t.ref("orgs")`** — a foreign-key reference column (plain-string target).
- **`table("users").column("c").add({ type })`** — the selector form for adding a
  column to an existing table (used in later migrations), e.g.
  `table("users").column("bio").add({ type: t.text() })`.
- **`table("users").index("users_email_idx").add({ on: [...] })`** — records an
  index; `unique: true` makes it a unique index.

`now()` is a portable function expression exported from `zero-migrate`; import it
alongside `table` and `t`:

```ts
import { table, t, now } from "zero-migrate";

export default {
  up() {
    table("events").create({
      columns: {
        id: t.id(),
        at: t.timestamp().notNull().default(now()),
      },
    });
  },
};
```

---

## 4. Preview the IR envelope

Every migration lowers to an **IR envelope** — a `{ ir_version, name, ops }`
document. `zero-migrate preview` authors that envelope offline (no DB) and prints
it, so you can see exactly what the addon will lower and apply:

```bash
zero-migrate preview --dir ./migrations
# preview create_users: ir_version=6 ops=2
# [ { "op": "createTable", ... }, { "op": "createIndex", ... } ]
```

Add `--json` for a machine-readable array of envelopes. `preview` is fully
offline — it never opens a database connection.

---

## 5. Plan (the dry-run gate)

`zero-migrate plan` is the fast, DB-free pre-apply gate. It loads every
migration, authors its envelope, and runs the addon's fail-closed structural,
confinement, and ownership verification — no database connection required:

```bash
zero-migrate plan --dir ./migrations
# plan create_users: ok (2 ops)
```

A migration that fails verification prints `ERROR` with the reason and the
command exits non-zero, so `plan` is safe to wire into CI as a required check.
Add `--owner-app` / `--schema` to plan under the same owner/schema you will apply
under.

---

## 6. Provision, then apply

Apply is **confined to a pre-provisioned schema**: the engine applies *within*
the project schema, it does **not** create it. Create the schema once, out of
band, before the first apply:

```sql
-- run against your database (psql / your admin tooling)
CREATE SCHEMA IF NOT EXISTS app;
```

Then apply every migration in the directory, in filename order, over the driver
inferred from the `--database-url` scheme:

```bash
zero-migrate apply \
  --dir ./migrations \
  --database-url postgres://user:pass@localhost:5432/mydb \
  --schema app \
  --owner-app app_myproject
# apply create_users: {"applied":true,...}
```

Flags:

- **`--database-url`** — a `postgres://` (or `postgresql://`) or `mysql://` (or
  `mariadb://`) DSN. Falls back to the `DATABASE_URL` env var. A `sqlite:` URL is
  refused here: SQLite runs in-process in the addon, not over the host driver
  seam.
- **`--schema`** — the confined project schema the ops are pinned to (default
  `public`).
- **`--owner-app`** — the deploying app id stamped as `owner_app` and folded into
  each migration's checksum (default `app_cli`).

MySQL is applied the same way with a `mysql://` URL.

---

## 7. Check status

`zero-migrate status` reconciles the live journal against the database. It reads
the journal over the driver — no migration directory needed:

```bash
zero-migrate status \
  --database-url postgres://user:pass@localhost:5432/mydb \
  --schema app
# status: {"currentVersion":...,"pending":[...]}
```

Add `--json` for the raw typed reply.

---

## 8. Embedding programmatically

The CLI is a thin wrapper over the `zero-migrate-engine` host API. To drive
apply/plan/status from your own code, import the verbs directly. The `migration`
is an imported DSL module (the same `{ up }` shape the CLI discovers):

```ts
import { apply, plan } from "zero-migrate-engine";
import * as migration from "./migrations/20260713000000_create_users.js";

// DB-free pre-check first (the plan gate).
const report = plan({
  migration,
  ownerApp: "app_myproject",
  dialect: "postgres",
});
if (!report.ok) throw new Error(report.error ?? "plan failed");

// Then apply over the pg/mysql2 seam. The schema must already exist.
const outcome = await apply({
  migration,
  ownerApp: "app_myproject",
  projectSchema: "app",
  driver: { kind: "postgres", url: "postgres://user:pass@localhost:5432/mydb" },
});
console.log("applied:", outcome);
```

`plan`/`validate` are synchronous and DB-free; `apply`/`status`/`history` open a
pinned host session over the driver and always close it (success or throw). See
[`embedding.md`](./embedding.md) for the full host surface and the Rust seams.

---

## Where to next

- [`architecture.md`](./architecture.md) — the crate structure and how the DSL,
  IR, guard, and native addon fit together.
- [`embedding.md`](./embedding.md) — the host/facade API, the CLI, and the Rust
  embedding seams.
- [`driver-authors.md`](./driver-authors.md) — the `SqlSession` driver seam for
  authoring a new host driver.
- [`op-dsl.md`](./op-dsl.md) — the complete op-DSL reference (every `t.*`
  factory, every table/view/enum op, and the IR envelope contract).
- [`security-model.md`](./security-model.md) — the defense-in-depth layering
  that gates what a migration may do.
