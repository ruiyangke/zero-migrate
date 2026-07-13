# zero-migrate — the op DSL

`zero-migrate` (the **npm package**) is the no-raw-SQL, fully-structured,
fluent authoring surface for database migrations. A migration is a `.ts` (or
`.js`) module that imports the helpers it needs from `zero-migrate` and exports
a single `default { name?, up, down? }` object. You describe schema changes
(DDL) and data migrations (DML) once through the fluent `table()` handle; the
engine lowers them per-dialect and applies them faithfully. PostgreSQL is the
first-class target; a construct with no native realization on another target
fails closed unless the author supplies an explicit `dialect()` leg.

The authoring surface lives in `sdks/migrate/src/`. Every op it records is a
node of the closed `Op` / `Expr` model defined in the `zero-migrate-ir` crate —
the frozen wire contract the engine loads, validates, and checksums. Both sides
emit the identical dialect-neutral op objects; the canonical IR shape is the
contract.

```ts
// migrations/20260712093000_split_name.ts
import { table, t, concatWs } from "zero-migrate";

export default {
  name: "split_name_column", // optional; defaults to the filename label

  up() {
    const users = table("users");
    users.column("first_name").add({ type: t.text() }); // nullable by default
    users.column("last_name").add({ type: t.text() });
    users.backfill({
      set: {
        first_name: (col) => col("name").splitPart(" ", 1),
        last_name: (col) => col("name").splitPart(" ", 2),
      },
      where: (col) => col("first_name").isNull(),
    });
    users.column("name").drop();
  },

  down() {
    const users = table("users");
    users.column("name").add({ type: t.text() });
    users.backfill({
      // concatWs is NULL-skipping — the safe join; copy this, not `.concat`
      set: { name: (col) => concatWs(" ", col("first_name"), col("last_name")) },
    });
    users.column("first_name").drop();
    users.column("last_name").drop();
  },
};
```

There is **no `op.` prefix** and no flat `createTable`/`addColumn` vocabulary.
Table operations are methods (or selector terminals) on the handle `table()`
returns. This document describes the current surface as exported from
`sdks/migrate/src/index.ts`.

---

## Module shape

A migration module is a single default-exported object:

```ts
export interface Migration {
  name?: string; // optional; defaults to the filename label (e.g. "split_name")
  up(): void; // required
  down?(): void; // optional; only present when the migration is rollbackable
}
```

- `up()` is **required**; `down()` is optional.
- `up()`/`down()` are **parameterless and return `void`**. They do not execute
  SQL — the `table()` handle's terminals *record* a plain-data op onto an ambient
  per-migration recorder, synchronously (no `await`). The host (the
  `zero-migrate-engine` package, via the pure-JS recorder at
  `zero-migrate/internal/recorder`) installs a fresh recorder before calling
  `up()` (and again before `down()`), drains the recorded op list, and
  canonicalizes it as the `{ ir_version, name, ops }` envelope.
- Authoring **outside an active recorder** — at module top level, or after
  `up()` returns (e.g. from a stray `setTimeout`) — throws a structured
  `OP_OUTSIDE_RECORDER` error. The op cannot be silently lost.
- A **selector that is never terminated** (`table("u").column("email")` with no
  terminal such as `.add()`/`.drop()`/`.rename()`) is a hard
  `SELECTOR_NOT_TERMINATED` build error at drain — never a silent no-op (see
  [Selectors must be terminated](#selectors-must-be-terminated)).

The default export is one typed migration object, never a loose top-level
`export function up()` plus a stray `export const name`.

### `down()` is not auto-derived for DML or lossy DDL

The engine auto-derives a reverse for *reversible* DDL (an `addColumn`'s inverse
is a `dropColumn`, etc.). A migration is auto-reversible only if **every** op is
auto-reversible. A `backfill`/`update`/`delete` (DML — no general inverse) or a
`dropColumn` (data-destroying) yields no auto-inverse, so a migration containing
one is irreversible unless you hand-write `down()`. The hero example above
hand-writes `down()` for exactly this reason: it contains a `backfill` and a
`dropColumn`. The DSL never silently fabricates an inverse for DML or lossy DDL —
an author-supplied `down()` is itself a structured migration (its own op calls),
never a raw-SQL string.

---

## Core entry points

The authoring surface is reached through direct named exports from
`zero-migrate` (`sdks/migrate/src/index.ts`):

```ts
import { table, view, enumType, comment, t, now, genRandomUuid } from "zero-migrate";
```

| Export | Purpose |
| --- | --- |
| `table` | table DDL/DML entry — returns the reusable `TableHandle` |
| `view` | cross-dialect view entry — returns a `ViewHandle` (a `SelectAst` builder by default) |
| `enumType` | portable enum entry — returns an inert `EnumHandle`; `.create({ values })` records |
| `domain`, `sequence` | portable domain / sequence entries |
| `comment` | standalone structured object comments |
| `t` | the immutable column-type lexicon |
| `dialect` | per-dialect value or whole-op escape hatch |
| `fromDb` / `colTypeFromDbField` | the db field (`dbType.*`) → migration `ColumnDef` bridge |
| `lintDeterminism` | the best-effort determinism source scan |
| `countStar` | receiver-less aggregate helper for `COUNT(*)`; receiver aggregates are `ExprChain` methods |
| `concatWs` | receiver-less NULL-skipping concatenation |
| `now`, `genRandomUuid`, `currentSetting`, `currentUser`, `interval`, `nextval`, `minValue`, `maxValue`, `lit`, `decimal`, `byteValue` | top-level value constructors |

**Postgres-vendor exports** (`schema`, `extension`, `role`, `grant`, `revoke`,
`createFunction`, `dropFunction`, `dropOwnedBy`, `raw`, `check`) are first-class
root exports too. They are Postgres-only and **capability-gated**: a confined
creator migration that reaches for one is refused by the engine's per-op
`VendorCapability` validation (`VENDOR_OP_DENIED`). `raw({ sql, reason })` is the
one deliberate whole-statement escape hatch — a trust-gated, reason-required
vendor-DDL emitter for constructs the structured surface cannot yet express.
There is **no** raw *expression* escape (property A, below).

`table(name, { schema? })` returns a handle whose methods are the whole DDL+DML
surface (see [The `table()` surface](#the-table-surface)). Each terminal records
eagerly and returns the handle, so calls chain and a handle is reusable across
statements.

---

## Views — `ViewQuery::Structured { SelectAst }` and `::Raw`

`view(name, opts?)` returns a structured `SelectAst` builder by default. Its
query callback supports `from`, `select`/projection, `join`/`innerJoin`/
`leftJoin`, `where`, `groupBy`, `having`, `orderBy`, and `limit`; `groupBy`
accepts column names or expressions, and `having` may use aggregate expressions
such as `countStar()`, `col("amount").sum()`, or PG-first aggregates like
`col("name").stringAgg(", ")`. This lowers to `ViewQuery::Structured { select:
SelectAst }` — the engine's own closed SELECT model in `zero-migrate-ir`
(`ir::ViewQuery` / `ir::SelectAst`).

For a construct outside the structured view surface, the **raw view body**
escape (`ViewQuery::Raw { sql }`) carries a read-only raw `SELECT`. It is
capability-gated: it requires `VendorCapability::RawViewBody` and is unreachable
from a confined creator migration.

There is **no scalar-function namespace**: scalar functions with a natural
receiver are chain methods on `ExprChain` (see
[The fluent expression surface](#the-fluent-expression-surface)). The one
receiver-less scalar helper is the top-level `concatWs(...)` import. Aggregates
follow the same receiver-first shape (`col("x").sum()`,
`col("x").count({ distinct: true })`); receiver-less `COUNT(*)` is the top-level
`countStar()`. The common PostgreSQL aggregates `stringAgg(delimiter)`,
`arrayAgg()`, `boolAnd()`, and `boolOr()` are first-class chain methods, but
validate fail-closed on SQLite and MySQL (`DIALECT_UNSUPPORTED`) unless wrapped
in `dialect({...})`.

---

## `dialect()` at value and op position

`dialect(legs)` is the explicit portability escape. It has two modes, selected
by the leg values:

- **Expression/value position**: legs are expression values. The recorder emits
  `Expr::Dialectal`, and a target with no own leg and no `default` leg is a hard
  portability error. Use this inside defaults, predicates, generated expressions,
  DML values, and other expression slots.
- **Statement/op position**: legs are thunks. The recorder runs each present
  thunk in canonical order (`default`, `pg`, `sqlite`, `mysql`), captures the ops
  it emitted, removes those captured ops from the outer recorder, and emits one
  `dialectal` op containing the per-target op lists. A target with no own leg and
  no `default` leg skips the op entirely.

```ts
import { dialect, table } from "zero-migrate";

dialect({
  pg: () => table("docs").index("docs_embedding_hnsw_idx").add({
    on: ["embedding"],
    using: "hnsw",
  }),
});
```

An explicit empty thunk is a present no-op leg for that target. An absent key is
different: absent own leg plus absent `default` means "skip" for op-level
`dialect()` and "error" for expression-level `dialect()`. Mixing thunk legs with
expression-value legs in the same call throws `OP_INVALID`.

---

## Names are strings (and why)

**Every table/column/name reference is a plain `string`.** There is no generic
`S extends Schema` parameter, no `TableName<S>` / `keyof RowOf<S,T>` binding to a
live db schema. `table`, `column`, `from`, `to`, `name`, `cursorColumn`, every
`set` key, every `where`-referenced column, and every `col("…")` argument are
strings whose existence is validated at **apply time against the real DB**, never
at `tsc` time (`sdks/migrate/src/types.ts`).

**Why binding names to the live schema is wrong (the rot bug).** Migration files
are immutable historical artifacts. If a terminal typed its names against the
*current* schema, a migration that referenced `users.last_seen` would **stop
compiling** after a *later* migration dropped that column — the whole history
would become un-compilable as the schema evolves, tempting authors to edit
committed migrations to make them compile, changing the op list, changing the
checksum, and triggering a drift abort. No mature migration tool binds migration
files to the live schema: Kysely uses `Kysely<any>` inside migrations; Alembic
uses string names (`op.add_column("users", …)`); Drizzle migrations are
generated SQL.

**What IS type-checked (structural safety, preserved):**

- **Op argument shapes** — you cannot pass a number where a `ColumnDef` is
  expected, or omit a required field on a terminal's args object.
- **The `t` column-type lexicon** — `t.text()` / `t.numeric()` and their
  chainable modifiers (`.notNull()` / `.default()`) are typed.
- **The fluent-expression node shapes** — `col`'s methods (`.eq` / `.concat` /
  `.gt` / `.splitPart` …) have typed arities and return an `Expr`; calling a
  non-existent operator method fails `tsc`.
- **Insert-row VALUE shapes** — rows are a loose `Record<string, ScalarValue>`.

So the guarantee: op shapes, the `t` lexicon, expression node shapes, and value
kinds are typed; **names are validated at apply/render time, never `tsc`-bound to
the live schema.**

---

## The column-type lexicon (`t.*`)

Every column-type position (`create`'s `columns`, `.column().add()`,
`.column().rename()`, `.column().setType()`) takes a chainable `ColumnDef`
produced by the fluent `t.*` lexicon. **Columns are nullable by default**;
`.notNull()` is the rarer, riskier opt-in. The `t.*` chain is **immutable**:
every modifier returns a **fresh** `ColumnDef` rather than mutating the receiver,
so a hoisted type var is safe to reuse across columns.

The shipped factories (`sdks/migrate/src/ops.ts`):

| Factory | Column type |
| --- | --- |
| `t.id(opts?)` | a non-null `uuid` PK defaulting to `gen_random_uuid()`; `t.id({ prefix })` brands it a typed id (`prefix_<base62>`) |
| `t.text()` | text |
| `t.int()` / `t.bigInt()` | 32-/64-bit integer |
| `t.real()` / `t.double()` | single-/double-precision float |
| `t.numeric({ precision?, scale? })` | fixed-precision decimal (default `(38, 9)`) |
| `t.boolean()` | boolean |
| `t.timestamp()` | timestamp |
| `t.uuid()` | uuid |
| `t.bytes()` | byte array |
| `t.json()` | json |
| `t.vector({ dimensions, metric? })` | a pgvector column; `metric` pins the distance metric |
| `t.geoPoint()` | a geo point |
| `t.ref(targetTable)` | a foreign-key reference (plain-string target) |
| `t.encrypted({ of })` | an application-level encrypted column wrapping an inner type |

Chainable modifiers, each returning a fresh `ColumnDef`: `.notNull()`,
`.default(value)` (a typed scalar literal, `now()`/`genRandomUuid()`, or a
function-expression callback — never raw SQL), `.primaryKey()`, `.unique()`, and
`.mask({ kind, classification? })`.

```ts
import { table, t } from "zero-migrate";

export default {
  up() {
    table("orders").create({
      columns: {
        id: t.id(),
        total: t.numeric({ precision: 12, scale: 2 }).notNull().default(0),
        status: t.text().notNull().default("pending"),
        customer_id: t.ref("customers").notNull(),
      },
    });
  },
};
```

### Sensitive-data facets

Three **declared-only** column facets carry intent the live catalog cannot
recover. Each lands on the wire `IrColumn` in camelCase (`idPrefix` /
`vectorMetric` / `mask`), is **closed** (the engine rejects an out-of-set token
at deserialize; the SDK gives a friendly `OP_INVALID` at authoring time), and is
**checksum-neutral when absent** (a facet-less column is byte-identical to the
pre-facet image).

- **`t.id({ prefix })` — typed-id brand.** Brands the primary key as a typed id
  (`prefix_<base62>`), e.g. `t.id({ prefix: "usr" })`. Valid **only in
  `create()`** — an added column is never the system PK, so `t.id({ prefix })` on
  `.column().add()` is a hard `OP_INVALID`.
- **`t.vector({ dimensions, metric })` — pgvector distance metric.** Pins the
  ivfflat/hnsw operator class. Closed set: `cosine | l2 | innerProduct`.
- **`.mask({ kind, classification? })` — standalone column mask.** The op lower
  emits the mask sentinel (default prefix `zero-migrate:mask:`, a configurable
  knob — see [Encrypted and masked columns](#encrypted-and-masked-columns)) plus
  a hidden `_masked` sibling. `kind` is **required** (closed set `full | last4 |
  first4 | email | name | date-year | date-decade | none`); `classification` is
  optional and defaults to `pii` (closed set `public | pii | spi | phi | pci |
  internal`).

---

## Bridging a db field (`fromDb`)

The migration DSL and a runtime db schema share **one** type lexicon.
`fromDb(field)` lifts a live-schema db field (built with the inlined `dbType.*`
lexicon, exported from `zero-migrate`) into a migration `ColumnDef` through the
identical `ColType` path (`sdks/migrate/src/db-lexicon.ts` / `ops.ts`), so a
`dbType.ref("users")` lowers to the byte-identical neutral type a hand-written
migration column produces. It carries the field's nullability (`.required()` →
`.notNull()`) and uniqueness. A non-storage db field (a json `array`, a nested
`object`, a `union`) has no portable column type and throws
`UnsupportedColTypeError` — a hard boundary, never a silent fallback.

---

## The `table()` surface

`table(name, { schema? })` returns a `TableHandle`. Everything — DDL and DML —
is a method (or a selector terminal) on that handle. Every terminal takes
**exactly one named-object** argument, records eagerly, and **returns the handle**
so calls chain.

### The table itself

```ts
table("audit_log").create({
  columns: {
    id: t.id(),
    org_id: t.ref("orgs").notNull(),
    email: t.text().notNull(),
    role: t.text().notNull().default("member"),
  },
  primaryKey: ["org_id", "email"], // composite PK (else a single PK via t.id()/.primaryKey())
  uniques: [{ name: "members_org_email_uq", columns: ["org_id", "email"] }],
  checks: [{ name: "members_role_nonempty", expr: (col) => col("role").ne("") }],
  foreignKeys: [
    {
      name: "members_org_fk",
      columns: ["org_id"],
      references: { table: "orgs", columns: ["id"] },
      onDelete: "cascade",
    },
  ],
  indexes: [{ name: "members_org_idx", on: ["org_id"] }],
});

table("scratch").drop({ ifExists: true, cascade: true });
table("accounts").rename({ to: "members" }); // ALTER TABLE … RENAME TO …
```

Table-level constraints and indexes are **fields**, each carrying a **required
`name`** (name-first, so a later migration can deterministically drop it).
Foreign-key actions are `cascade | restrict | setNull | setDefault | noAction`;
the closed index method set (`IndexMethod`, `sdks/migrate/src/types.ts`) is
`btree | hash | gin | gist | spgist | brin | ivfflat | hnsw | fts5`.

`.rename({ to })` is a whole-table rename: a single, direct `ALTER TABLE …
RENAME TO …` on both Postgres and SQLite — a metadata change, **not** the online
column expand-contract. It is auto-reversible (the engine emits the inverse
`RENAME TO` as the down-migration).

### Columns — the `.column(name)` selector

```ts
const orders = table("orders");
orders.column("status").add({ type: t.text().notNull().default("new") });
orders.column("legacy").drop({ ifExists: true });
orders.column("label").rename({ to: "display_label", type: t.text() });
orders.column("total").setType({ to: t.numeric({ precision: 14, scale: 2 }), using: (col) => col("total").cast({ to: "real" }) });
orders.column("note").dropNotNull();
orders.column("note").setDefault("memo");
orders.column("note").dropDefault();
```

`.column(name).add({ type })` honors **all** modifiers on `type`, including
`.unique()` (which emits a follow-on `UNIQUE` constraint) and `.primaryKey()` —
they are not silently dropped.

### Constraints and indexes

```ts
const members = table("members");
members.foreignKey("members_org_fk").add({
  columns: ["org_id"],
  references: { table: "orgs", columns: ["id"] },
  onDelete: "cascade",
});
members.unique("members_org_email_uq").add({ columns: ["org_id", "email"] });
table("orders").check("orders_total_nonneg").add({ expr: (col) => col("total").ge(0) });
table("orders").constraint("orders_total_nonneg").drop({ ifExists: true }); // kind-agnostic

members.index("members_email_idx").add({ on: ["email"], unique: true });
members.index("members_active_email_idx").add({
  on: ["email"],
  where: (col) => col("active").isTrue(),
  include: ["id"],
  using: "btree",
});
members.index("members_email_idx").drop();
```

`.foreignKey/.unique/.check(name)` each have one terminal, `.add(...)`;
`.constraint(name)` has one terminal, `.drop(...)` (kind-agnostic, by name).
Indexes are **name-first**. Postgres-specific index options (`using`, `where`,
`include`, `with`, `only`, per-element `opclass`/`collation`) are authored on
the `.index(...)` selector.

### Table data — direct named DML (`Op::Insert` = literal rows)

```ts
const plans = table("plans");

plans.insert({
  rows: [
    { id: "free", price_cents: 0 },
    { id: "pro", price_cents: 2900 },
  ],
});

// PG-only upsert: on a conflicting `id`, update the listed columns.
plans.insert({
  rows: [{ id: "pro", price_cents: 3900 }],
  onConflict: { columns: ["id"], doUpdate: { price_cents: 3900 } },
});

table("orders").update({
  set: { status: (col) => col("status").upper() },
  where: (col) => col("status").eq("pending"),
});

table("sessions").delete({ where: (col) => col("expires_at").lt("2026-01-01T00:00:00Z") });

table("orders").backfill({
  set: { total_norm: (col) => col("total").coalesce(0) },
  cursorColumn: "id", // defaults to the single-column PK ("id")
  batchSize: 1000, // defaults to the engine's chosen size
});
```

- `insert` carries **literal rows** (`Op::Insert`). **`INSERT ... SELECT` is
  deliberately not a feature** — there is no query-sourced insert on this
  surface.
- The predicate keyword is **`where` everywhere** — there is no `filter` synonym.
- `.delete`'s `where` is **mandatory** — an unguarded full-table delete is
  rejected at record time.
- `.backfill` is a batched, per-batch-transactional, resumable loop that persists
  crash-safe cursor progress under the project lock, on both backends.
- Row values may be a string / safe number / `decimal("…")` / boolean / `null`
  / `Uint8Array`. Use `decimal("<n>")` for integers beyond 2^53 or fixed-scale
  numeric values; a `Uint8Array` is normalized to a base64 `{ bytes }` carrier.
- `.insert`'s `onConflict` (upsert) is **Postgres-only**. A SQLite-targeted
  `onConflict` is a hard build error (`dialect_scope = PgOnly`).

---

## Selectors must be terminated

A selector (`.column(x)` / `.foreignKey(x)` / `.unique(x)` / `.check(x)` /
`.constraint(x)` / `.index(x)`) returns a sub-builder that records **only** when
its terminal (`.add` / `.drop` / `.rename` / …) is called. A forgotten terminal
would otherwise silently record nothing — so the recorder makes it a **hard,
structured error**: at `up()`/`down()` drain, any selector handed out but never
terminated throws `{ code: "SELECTOR_NOT_TERMINATED", selector, name }`.
Terminating the same selector twice throws `SELECTOR_ALREADY_TERMINATED`. The
check runs **at drain, not eagerly**, so a selector held in a variable and
terminated on a later line is fine.

---

## The fluent expression surface

Every expression position — a DML `set` value, a `where`, a `check(name).add`
body, a partial-index `where:` — is a callback `(col) => Expr` with a **single
injected builder handle**. It is never a raw string; it constructs a node of the
closed `Expr` AST (`zero-migrate-ir::expr`) via an all-strings fluent builder
(`sdks/migrate/src/ops.ts`).

**`col` is both a column accessor and the function namespace.** `col("first")`
returns an unqualified `ColRef` chain; `col("table", "col")` returns a qualified
`ColRef`. Arguments are plain strings.

**Chainable operator methods** (each builds one closed-AST node; a bare JS value
passed to a method auto-wraps to a `Literal` and is bound via `$n`/`?`, never
interpolated):

- comparison: `.eq`, `.ne`, `.lt`, `.le`, `.gt`, `.ge`
- boolean: `.and`, `.or`, `.not`
- arithmetic: `.add`, `.sub`, `.mul`, `.div`
- string/value: `.concat(...)` (raw `||`, NULL-propagating). The NULL-skipping
  `concatWs` is a top-level import; `.coalesce` is a chain method.
- null/bool tests: `.isNull`, `.isNotNull`, `.isTrue`, `.isFalse`
- cast: `.cast({ to: "text" | "int" | "real" | "boolean" | "bytes" | "uuid" })`

**Scalar chain methods**: `.lower`, `.upper`, `.trim`, `.length`, `.abs`,
`.coalesce`, `.nullif`, `.mod`, `.round`, `.floor`, `.ceil`, `.substr`,
`.replace`, `.extract`, `.splitPart`, and `.case({ branches, else? })` (the
searched `CASE`). The top-level `concatWs(sep, ...parts)` is the NULL-skipping
join, engine-synthesized to be byte-identical across PG (`concat_ws`) and SQLite.

**Top-level value constructors**: `now()`, `genRandomUuid()` — DB-evaluated
apply-time scalars (render to `now()` / `gen_random_uuid()` per dialect). Use
these instead of baking a build-time `Date.now()` / UUID literal into the
artifact.

The expression records as **dialect-neutral data, never SQL** — the engine owns
all per-dialect lowering, so the plan checksum is dialect-stable.

### Determinism: don't bake a clock or RNG into a migration

A **called** `Date.now()` / `Math.random()` / `crypto.randomUUID()` in an op
argument freezes a build-time value for that recording (almost never what you
want). The recorder handles this by translation, not a gate:

- The **bare native symbol** (no parens) — `Date.now`, `Math.random`,
  `crypto.randomUUID` — records as the DB-evaluated fnSynth scalar (identical IR
  to `now()` / `genRandomUuid()`). This is the recommended apply-time value.
- A **call** (`Date.now()`) evaluates and the resulting scalar is recorded
  verbatim; `lintDeterminism(source)` emits an advisory **warning** steering you
  to the symbol / top-level constructor form — advisory-only, never a hard reject.

---

## The DML portability boundary

Portability is real but **bounded**, and the boundary is honest. The engine owns
control flow and statement assembly; the author owns the data-transform
expression — but expresses it only through the closed fluent AST, never raw SQL.

**Portable — works on both PG and SQLite from one op:** `insert` with literal
rows (`onConflict` excepted — PG-only); `delete` with a `where`; one-shot
`update` / `backfill` whose `set`/`where` use only the closed fluent AST (column
refs, auto-wrapped literals, arithmetic, comparison/boolean operators,
`col.case`, the allow-listed provably-identical scalars — `coalesce`, `nullif`,
`lower`, `upper`, `trim`, `length`, `abs`, `.cast({ to })`, `.concat`); and
`concatWs`; and `.splitPart` **within its pinned envelope**.

### The `splitPart` portable-expression envelope

`col.splitPart(delim, n)` lowers to `split_part(col, 'd', n)` on Postgres and to
a pinned `instr`/`substr` expression on SQLite, proven byte-identical against
real SQLite. The envelope admitting it on **both** backends:

- `delim` is a literal, **non-empty, single ASCII character** (one byte);
- `n` is a literal **positive integer** — and on the SQLite leg, `1 ≤ n ≤ 8`;
- `col` is a column ref or an in-AST sub-expression.

Out of envelope is a hard `EXPR_NOT_PORTABLE` on the SQLite leg — **never** a
silent mis-split. The value being split *may* contain multibyte UTF-8; it is the
**delimiter** that is constrained to single-ASCII (an ASCII byte never occurs
inside a UTF-8 multibyte sequence, which is why the byte-wise SQLite scan finds
the same boundaries as PG's character-wise `split_part`).

---

## No raw-SQL escape hatch on the expression surface (property A)

There is no `Raw` *expression* type, no `sql\`\``, no string-fragment route — on
either dialect. Where a transform is dialect-divergent and not expressible in the
closed AST (an exotic PG-only function, a subquery/window, a cross-table
reference, an out-of-envelope split), there is **no raw expression fallback**. It
surfaces as a hard structured error (`UNSUPPORTED` with `kind:"expr"`/`"op"`, or
`EXPR_NOT_PORTABLE`), and the only resolutions are (1) **reshape** into the
portable surface, or (2) **accept `dialect_scope = PgOnly`** (the engine renders
the PG form; the migration is then not authorable on the SQLite dev tier).
`dialect_scope` is *derived* from the ops and the engine's allow-list version,
never author-declared. The one whole-**statement** escape is the trust-gated
top-level `raw({ sql, reason })` DDL op — never reachable from a confined
creator migration.

---

## Encrypted and masked columns

`t.encrypted({ of })` wraps an inner type as an application-level encrypted
column; `.mask({ kind, classification? })` declares a standalone column mask.
Both lower to a persisted **sentinel** the engine writes into the DDL (a
`COMMENT ON COLUMN` body on Postgres; an inline `/* … */` comment that survives
in `sqlite_master.sql` on SQLite) plus, for masks, a hidden `_masked` sibling
column.

The sentinel **prefix** is a configurable engine knob (`SentinelPrefix`,
`crates/zero-migrate/src/schema/mask_codec.rs`), **not** a hard-coded brand — the
standalone defaults are `zero-migrate:enc:` and `zero-migrate:mask:`. A host that
must interoperate with a legacy writer sharing the same schema injects that
writer's prefix (for example the legacy `zsenc:`), so the persisted format stays
a single agreed contract in that schema.

---

## The IR wire contract

A migration records into dialect-neutral IR — the frozen wire contract the
engine loads. You never hand-write it; the recorder produces it from your `.ts`.
The envelope carries the current wire-format version, `ir_version`, which is
`CURRENT_IR_VERSION` (`1`, `crates/zero-migrate-ir/src/ir.rs`); the loader rejects
an unknown *future* version fail-closed. For reference, the hero split-name
migration records (a nullable added column carries `"nullable": true` on the
wire) as:

```json
{
  "ir_version": 1,
  "name": "split_name",
  "ops": [
    { "op": "addColumn", "table": "users", "column": "first_name", "type": "text", "nullable": true },
    { "op": "addColumn", "table": "users", "column": "last_name", "type": "text", "nullable": true },
    {
      "op": "backfill",
      "table": "users",
      "cursorColumn": "id",
      "set": {
        "first_name": { "node": "fnSynth", "fn": "splitPart", "args": [
          { "node": "colRef", "name": "name" },
          { "node": "literal", "value": " " },
          { "node": "literal", "value": 1 }
        ]}
      }
    },
    { "op": "dropColumn", "table": "users", "column": "name" }
  ]
}
```

The `op`/`node` tags, the closed `Op` enum, the `Expr` AST, `SelectAst`,
`ViewQuery`, and the constrained `IrScalar` are all defined in the
`zero-migrate-ir` crate and re-exported for TypeScript ergonomics from
`zero-migrate` (`import type { ir } from "zero-migrate"`). The golden
`*.golden.json` corpus under `crates/zero-migrate/tests/op_fixtures/` is the
source of truth for the wire shape — every committed envelope carries
`ir_version: 1`.

---

## Applying a migration

The op DSL only **authors**. To apply, plan, or inspect a migration, use the
`zero-migrate-engine` package (the host + CLI):

```bash
zero-migrate plan    ./migrations                          # DB-free structural + confinement verify
zero-migrate apply   ./migrations --database-url postgres://…   # apply in order
zero-migrate status  ./migrations --database-url postgres://…   # reconcile against the journal
```

See [`embedding.md`](./embedding.md) for the host/facade surface, the CLI, and
the Rust embedding seams; [`security-model.md`](./security-model.md) for the
defense-in-depth layering that gates what a migration may do; and
[`architecture.md`](./architecture.md) for the crate structure.
