# zero-migrate — writing a `SqlSession` driver

The network dialects (Postgres, MySQL) never talk to a database directly. The
engine issues its whole apply as a strictly one-verb-at-a-time sequence over a
small, dialect-neutral seam — `driver::SqlSession` — and a **host** supplies the
concrete driver. This document is the contract a driver author implements.

SQLite is **not** a `SqlSession` driver: it runs in-process via `rusqlite` and
never crosses the seam. If you are targeting SQLite, there is nothing to
implement here.

The reference drivers ship in the `zero-migrate-engine` npm package:
`sdks/engine/src/driver-pg.ts` (over the `pg` npm module) and
`sdks/engine/src/driver-mysql2.ts` (over `mysql2`). Read them alongside this
doc — they are the canonical implementations.

---

## The trait

`zero_migrate::driver::SqlSession` (behind the `pg_seam` cfg, lit by the
`host-pg` feature):

```rust
pub trait SqlSession {
    /// DDL / txn control / multi-statement session setup. Simple-query protocol:
    /// one `&str`, may contain `;`-separated statements, no params, no rows.
    async fn batch(&self, sql: &str) -> Result<(), DbError>;

    /// Parameterized DML → rows affected.
    async fn exec(&self, sql: &str, binds: &[Bind]) -> Result<u64, DbError>;

    /// Schema-blind DML: all params as server-inferred TEXT (see below).
    async fn exec_text(&self, sql: &str, params: &[Option<String>]) -> Result<u64, DbError>;

    /// Parameterized SELECT → all rows.
    async fn query(&self, sql: &str, binds: &[Bind]) -> Result<Vec<Row>, DbError>;

    /// Parameterized SELECT → exactly one row (errors otherwise).
    async fn query_one(&self, sql: &str, binds: &[Bind]) -> Result<Row, DbError>;
}
```

These are exactly the in-session verbs the engine issues on a live connection:
`batch` (DDL / transaction control / session setup), `exec` / `exec_text`
(parameterized DML → rows affected), and `query` / `query_one`
(catalog / journal introspection → rows). The seam carries **no** transaction or
lock abstraction — `BEGIN`/`COMMIT`/`ROLLBACK`, advisory locks, and confinement
`SET`s are SQL strings each dialect's `Backend` issues through `batch`/`exec`.
They are engine logic, not driver methods.

The trait uses `async fn` in trait and is `!Send` by design (single-thread host
runtime), so no `Send` bound is imposed.

---

## The five verbs, in detail

| Verb | Signature | Returns |
| --- | --- | --- |
| `batch` | `batch(&self, sql: &str)` | `Result<(), DbError>` — no params, no rows. |
| `exec` | `exec(&self, sql: &str, binds: &[Bind])` | `Result<u64, DbError>` — rows affected. |
| `exec_text` | `exec_text(&self, sql: &str, params: &[Option<String>])` | `Result<u64, DbError>` — rows affected. |
| `query` | `query(&self, sql: &str, binds: &[Bind])` | `Result<Vec<Row>, DbError>` |
| `query_one` | `query_one(&self, sql: &str, binds: &[Bind])` | `Result<Row, DbError>` |

### Why `exec_text` exists (load-bearing)

`exec_text` is deliberately distinct from `exec`. The executor runs lowered
op.* DML through it to dodge Postgres's concrete-OID binary-bind refusal of a
`text → timestamptz` coercion: a concrete-OID binary bind of a text value
against a `timestamptz` column makes Postgres *refuse* the coercion, so the
assembler needs **text-format** inference instead. Its bind side is already
neutral (`&[Option<String>]` — every param crosses as server-inferred text, a
`None` is a SQL `NULL`); its error side widens to `DbError` uniformly with the
other verbs.

- **Postgres driver**: send the params **text-format with no explicit OID** so
  the server infers the target type. In `pg` (node) this is
  `client.query(sql, values)` with plain string/`null` values — no param type
  array. **Do not remove.**
- **MySQL driver**: MySQL has no equivalent OID refusal, so `exec_text` is an
  **alias for `exec`** (bind the text params positionally).

---

## `Bind` / `Value` / `Row` / `DbError`

### `Bind` — a param bound into `exec`/`query`/`query_one`

```rust
#[non_exhaustive]
pub enum Bind { Null, Bool(bool), Int(i64), Decimal(String), Text(String) }
```

It mirrors the engine's internal bind value exactly, so the IR-fold path and the
seam bind path share one neutral shape. `Int` is an exact 64-bit integer (the
only integer domain the IR admits); `Decimal` is carried as its canonical string
form (there is no `f64` in the IR identity). `#[non_exhaustive]` — a driver
author matches with a wildcard arm.

### `Value` — a decoded cell

```rust
#[non_exhaustive]
pub enum Value {
    Null,
    Text(String),                 // text/name/varchar, "char"-as-1-char, to_char timestamps
    Int(i64),                     // int2/int4/int8 all widened to i64
    Bool(bool),
    Decimal(String),              // numeric carried as canonical string (no f64)
    TextArray(Vec<Option<String>>), // text[]; element NULLs preserved
}
```

The value universe is text-biased to match the SQL the apply path already emits
(every timestamp is `to_char`-cast to text, every count is `bigint`, most arrays
are `array_agg`). Both `Bind` and `Value` carry `Decimal` so they cover the
closed IR value universe (`IrScalar` includes `Decimal`), and both are
`#[non_exhaustive]`.

> **Exact-integer discipline.** The IR's `event_seq` / `version` domain must
> never lose precision. In `pg`, `int8`/`numeric`/`int8[]` are pinned to cross as
> **strings** via connection-scoped type parsers (immune to a global
> `pg.types.setTypeParser` override); in `mysql2`, `BIGINT`/`DECIMAL` cross as
> strings via `supportBigNumbers` + `bigNumberStrings`. Never `Number(x)` an
> exact integer (it truncates above 2^53).

### `Row` — a decoded row, non-panicking

```rust
pub struct Row { /* columns + values */ }

impl Row {
    pub fn new(columns: Vec<String>, values: Vec<Value>) -> Self;
    pub fn len(&self) -> usize;
    pub fn is_empty(&self) -> bool;
    pub fn try_get<I: ColIndex, T: FromValue>(&self, idx: I) -> Result<T, DbError>;
}
```

`Row` exposes **only `try_get`** — there is deliberately no panicking `get`. A
decode failure is always a `Result`. `ColIndex` is implemented for both `&str`
(name) and `usize` (position), so call sites read by name (`r.try_get("relkind")`)
or by position (`r.try_get::<_, bool>(0)`). Decoding resolves through the small,
closed `FromValue` trait (implemented for `String`, `Option<String>`, `bool`,
`i64`, `Option<i64>`, `i32`, `Option<i32>`, `i8`, `char`, `Vec<String>`,
`Option<Vec<String>>`) — not the open `FromSql` ecosystem.

Build a `Row` from parallel column-name / cell-value vectors with `Row::new`
(debug-asserts the two vectors are the same length).

### `DbError` — a neutral error

```rust
pub struct DbError { pub message: String, pub sqlstate: Option<String> }
```

Every seam consumer treats the error opaquely (wraps it as `#[source]`/
`Display`). A non-empty `message` satisfies all consumers; no seam consumer reads
`sqlstate` today — it is carried so the conformance kit can assert a real
Postgres SQLSTATE (check 4 below) and so a future retry/branch classifier has a
home without another widening. Construct a message-only error with
`DbError::message("…")`.

---

## The single-connection pinning requirement

The engine relies on the driver holding **one** connection across every verb of
an apply. A temp object created by one verb (a `TEMP TABLE`, a `SET`, an open
transaction) MUST be visible to the next verb on the same session. A driver that
silently round-robins a pool would corrupt a real apply — the `BEGIN` would land
on one backend, the `COMMIT` on another.

Both reference drivers open **one pinned client per session**: `driver-pg.ts`
constructs a single `pg.Client`; `driver-mysql2.ts` a single `mysql2` connection.
The addon guarantees it drives the host one verb at a time
(`hostDriver([request, done]) => void`), so the driver never needs to serialize
concurrent verbs — it must only avoid handing out a *different* physical
connection per verb.

---

## The conformance kit

Before shipping a driver, run the seam conformance suite against a live, empty
session:

```rust
zero_migrate::driver::conformance::run(&session, "zm_conf_scratch").await?;
```

`run<S: SqlSession>(session: &S, scratch_table: &str)` returns `Ok(())` if the
driver honours all four seam invariants, or the first `ConformanceFailure`
(which check failed, and a precise reason). It is schema-agnostic — it creates
and drops its own scratch `TEMP` objects and rolls back its transaction check, so
it leaves no residue. The four checks:

1. **Session pinning** — a `TEMP TABLE` created by one verb is visible to a later
   verb on the same session (a pooled driver fails here).
2. **Transaction visibility** — a row written inside an explicit `BEGIN` is
   visible to a `query` on the same session before commit, and `ROLLBACK`
   discards it (the exact `apply_transactional` discipline).
3. **`exec` vs `exec_text` semantics** — `exec_text` sends every param as
   server-inferred TEXT (the `text → timestamptz` coercion), a `None` text param
   is a SQL `NULL`, and `exec`'s `Bind::Null` also lands as a SQL `NULL`.
4. **Error + SQLSTATE mapping** — a failing statement surfaces a `DbError` with a
   non-empty message and (when the driver carries it) the real Postgres SQLSTATE
   (e.g. `42P01` undefined_table), and the session stays usable after the caught
   error.

The suite is the first external consumer of the seam beyond the engine itself.
It is Postgres-flavoured by design (it issues `BEGIN`/`ROLLBACK`, a `TEMP TABLE`,
and a text-coercion); a MySQL profile would render the dialect equivalents,
keeping the same shape (four checks, one verdict). The in-crate dev-only PG test
session is the reference conformance consumer.

---

## Checklist

- [ ] One pinned physical connection per session, held across all verbs.
- [ ] `exec_text` sends text-format params with no explicit OID (Postgres) or
      aliases `exec` (MySQL).
- [ ] Exact integers (`int8`/`numeric`/BIGINT/DECIMAL) cross as **strings**,
      never `Number(x)`.
- [ ] Errors map to `DbError` with a non-empty message and the real SQLSTATE
      when available; the session survives a caught error.
- [ ] `Row` cells are typed to the neutral `Value` variants; decode via
      `try_get` only.
- [ ] `zero_migrate::driver::conformance::run` passes against a live session.

See [`architecture.md`](./architecture.md) for where the seam sits and
[`embedding.md`](./embedding.md) for how a host wires a driver into an apply.
