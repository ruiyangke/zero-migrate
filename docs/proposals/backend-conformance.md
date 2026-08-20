# Backend conformance proposal

Status: Draft
Date: 2026-08-17

This proposal defines the conformance kit: the suite that decides whether a
thing is a zero-migrate backend. It is step 1 of `pluggable-backends.md`, whose
decision 8 says a backend is defined by the suite it passes rather than by the
trait it implements. That is only true if the suite exists and is hard to pass
dishonestly.

At three backends correctness fits in one head. At twenty it does not, and the
failure mode is not a backend that breaks loudly. It is a backend that agrees
with the others on everything anyone thought to check.

The central design rule is:

> A backend may differ. It may not differ silently.

## Proposed decisions

1. Conformance is measured in three LAYERS: declared disposition (offline),
   outcome class (live), and semantic observation (live). Each layer is a
   separate gate, and the first is free.
2. The differential compares OBSERVATIONS, never SQL text and never whole
   snapshots. An observation is a small dialect-free probe evaluated against the
   live database after an op stream applies.
3. An expected difference must NAME THE OTHER VALUE. "These backends differ" is
   not a test result. A difference with no expected value is a defect.
4. Expected differences are declared by the FIXTURE, never by the backend. A
   backend that can excuse itself has an unfalsifiable declaration.
5. Three tiers. Core is required to ship. Extended may be refused but never
   approximated. Vendor carries no cross-backend obligation.
6. There is no "not implemented yet" cell. Every (op token, backend) pair is
   either proven-Applied or proven-Refused-by-capability. A blank fails the
   build.
7. The corpus is LIFTED from `dialect_table_faithfulness.rs`, not written fresh,
   and stays in bijection with `dialect-support.toml` by the same test that
   already enforces that bijection.
8. Every observation ships with a NEUTER CONTROL that must fail. An observation
   with no control is not admitted to the suite.
9. The differential comparison runs OFFLINE over recorded observation ledgers.
   It never requires two databases up at once, which is the property that makes
   twenty backends affordable.
10. `zero-migrate-conformance` is a crate with a `conformance_suite!()` macro. A
    third-party backend crate adds one dev-dependency and one `tests/` file.

## Goals

- A backend author can tell whether they are done by running one command.
- A capability declaration is PROVEN against a server, not trusted.
- A defect that is wrong on two backends and accidentally right on a third goes
  red.
- The offline layer pays for itself at three backends, in week one.
- Adding a backend does not multiply CI wall clock by the number of backends
  already present.

## Non-goals

- Identical SQL across backends. The core emits no SQL; see
  `pluggable-backends.md`.
- Identical schemas across backends. SQLite rebuilds tables where PostgreSQL
  alters them, and both are correct.
- Proving a backend correct. This proves a backend HONEST, which is the property
  that composes.
- Replacing the existing suites. This sits beside 186 Rust integration tests and
  143 host test files, and lifts their corpus rather than duplicating it.

## What already exists, measured

Every number below came from a command run against `main` at `779ea2f3`. No
`cargo` or `pnpm` gate was run; nothing here needs one.

### The dialect table is the right shape, and it is offline

`crates/zero-migrate/dialect-support.toml` carries 92 hand-authored `[[row]]`
entries over 56 op-kinds (`grep -c '^\[\[row\]\]'`; `grep '^kind = ' | sort -u |
wc -l`). It generates `crates/zero-migrate/src/model/dialect_table.rs`, which
engine code READS via `op_support.rs`. Per-dialect tallies:

| dialect | portable | vendor | transparentDegradable | unsupported | supported |
|---|---|---|---|---|---|
| postgres | 61 | 19 | 0 | 12 | 80 |
| sqlite | 41 | 0 | 2 | 49 | 43 |
| mysql | 34 | 0 | 2 | 56 | 36 |

`crates/zero-migrate/tests/dialect_table_faithfulness.rs` (1383 lines) is
genuinely good prior art and this proposal builds directly on it. It pins four
properties worth keeping verbatim: a representative op per (kind, variant); that
each corpus op's `Op::op_variant()` equals its labelled variant; exhaustiveness
of corpus kinds against the schema's `oneOf` discriminants; and a BIJECTION
between corpus rows and generated table rows. That bijection is the anti-drift
mechanism this proposal reuses wholesale.

CORRECTION to the framing this work was commissioned under. That file is NOT
proven against live behaviour. It is one `#[test]`
(`op_variant_matches_the_corpus_and_the_generated_table_matches_the_sidecar`,
line 1286) and it opens no connection: `grep -niE 'live|connect|DATABASE_URL|
pool|async|tokio|sqlx'` over it returns one hit, and that hit is a comment. What
it proves is that the sidecar, the generated table and `Op::support()` agree with
each other. All three are the engine's OWN opinion. A backend that declares
`portable` and then fails against a server passes this test today. Closing that
specific gap is layer 1 below, and it is the single highest-value thing here.

Two smaller findings from the same file. Its header comment says
`transparentDegradable` is "reserved, and no row in this file uses it"; two rows
do (`createPartition/base` and `createTable/partitionedCollapse`, on both sqlite
and mysql). And the sidecar's prose is hand-authored and not itself under test,
which is exactly the class of claim the kit should mechanize.

### The fold-vs-live oracles exist for two backends of three

VERIFIED. `ls crates/zero-migrate/tests/ | grep -i roundtrip` returns
`fold_roundtrip_pg.rs` (1315 lines) and `fold_roundtrip_sqlite.rs` (393 lines).
There is no MySQL equivalent, and the gap is structural rather than incidental:

```
  grep -rln 'ZERO_MIGRATE_TEST_PG_URL' crates/zero-migrate/tests/   ->  35 files
  grep -rln 'ZERO_MIGRATE_MYSQL_URL'   crates/                      ->   1 file
```

That one file is `src/apply/backend/mysql/mod.rs`, not a test. ZERO Rust tests
run against a live MySQL. `.github/workflows/ci.yml:30` gives the `rust` job a
`postgres` service and nothing else; MySQL appears only in the `host` job
(`ci.yml:238-269`), over the napi addon from TypeScript. `tests/goldens/` holds
`refactor_safety_pg.txt` and `refactor_safety_sqlite.txt` and no MySQL file;
`tests/golden-traces/` holds four `pg_*` and one `sqlite_*` and no MySQL file.
MySQL is covered at render level (`tests/golden/sql_preview_mysql.txt`) and at
CLI level, and nowhere in between.

The PG oracle's own header is instructive for the differential design. It states
that `IndexSnapshot` equality EXCLUDES `opclass`, `nulls_not_distinct` and
`only`, and that `only` joined that list because a case "measured the guaranteed
false red this comment used to merely predict". A comparator with an explicit,
justified exclusion list is the embryo of decision 3. What it lacks is the
expected value on the other side of each exclusion.

### Execution coverage was already measured, and it is uneven

`docs/review-log.md:27085`, entry F877. It instrumented `lower_one_op` and every
backend execution seam, ran both suites, and recorded which op tokens ever come
back from a live server. Results: 654 executions traced from the Rust suite and
1025 from the host suite over 92 tokens; **67 of 80 supported PG tokens, 23 of
43 SQLite, 16 of 36 MySQL** (`review-log.md:27253`). Those denominators are
exactly the "supported" column of the table above, which cross-checks the
instrument.

Three things from that entry are load-bearing here.

- Grep cannot substitute for measurement. "A grep for `Op::` over the 54 live-PG
  test files finds ten distinct variant names; the measurement below finds 67 PG
  tokens actually executing." Any conformance claim derived from reading test
  source is wrong by roughly sevenfold.
- Its own stated ceiling: "A cell says the SQL RAN, not that anything CHECKED
  it. Execution is the floor this inventory measures, not an assertion about
  correctness." That is precisely the (a)/(b) boundary this proposal has to
  cross.
- Its first pass concluded "the MySQL emitter is never executed against a live
  server" and was WRONG, because it traced only the Rust suite. Any conformance
  report must name the suites it traced.

### The host suite is where cross-backend behaviour is checked today

`packages/zero-migrate-cli/tests/host/` holds 143 `*.test.ts` files with 450
`it(`/`test(` call sites (`grep -rhoE "\b(it|test)\((\'|\"|\`)" | wc -l`). 76
files mention Postgres, 71 MySQL, 62 SQLite. It covers what the Rust suite
cannot: the real napi addon, the pg and mysql2 driver adapters, and the CLI.

It also already contains hand-written differential tests, and they are the best
prior art in the tree for layer 3.
`packages/zero-migrate-cli/tests/host/destructive-ops-dialect-parity.test.ts`
runs the same posture on three dialects and asserts a BEHAVIOURAL outcome
(refused, and the table is still there) rather than SQL text. Its header records
the defect that produced it: "Measured before this file existed: PostgreSQL
refused a `DROP TABLE` under the default posture, MySQL and SQLite applied it."
It carries three arms per dialect, two of which exist purely to stop a false
pass. That arm-1b/arm-2 structure becomes decision 8.

Twelve other files are named `*-parity`, `*-agree` or `*-dialect*`. They are
hand-written one at a time, per defect, in TypeScript, outside the Rust engine.
The kit's job is to make that shape systematic and cheap, not to replace it.

### The motivating defect holds, and is worse than reported

`docs/review-log.md:27745`, "An injected system column could not carry a
collation, and `ORDER BY id` paid for it". A charter-injected `id` landed on the
database default collation. Measured emissions:

```
  PG      "id" character varying(255) PRIMARY KEY NOT NULL
  SQLite  "id" TEXT
  MySQL   `id` VARCHAR(255) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_as_cs
```

The entry's own words: "MySQL's `utf8mb4_0900_as_cs` is case-SENSITIVE but
linguistic, not bytewise, so MySQL has the same silent defect PostgreSQL does.
The report named PostgreSQL because that is what the consumer deploys." And:
"Dev is SQLite, whose default is already bytewise, so it reproduces only against
a deployed PostgreSQL and it fails SILENTLY."

So: wrong on PostgreSQL, wrong on MySQL, accidentally right on SQLite. Every
existing suite was green. The framing this work was commissioned under is
confirmed.

It gets sharper. The FIX's test is still asymmetric.
`crates/zero-migrate/tests/injected_column_collation.rs` has seven tests. MySQL
appears only inside `a_pinned_bytewise_collation_is_spelled_per_dialect`, which
compares emitted DDL strings. The live row-ordering legs are
`sqlite_orders_an_injected_id_by_creation_with_and_without_the_pin` and the PG
leg against a live `en_US.utf8` server. **MySQL's half of the defect is verified
by string comparison only.** Nothing in the tree has ever asked a live MySQL what
order those four ids come back in. The kit's first fixture is this one.

### What the tree already gets right and the kit must not lose

`crates/zero-migrate/tests/support/mod.rs:294`, `announce_live_db_skip`. A
skipped live suite "used to be INVISIBLE rather than merely quiet: the early
return still counts as a pass". It now writes to the raw stderr handle to escape
libtest capture, and `ZERO_MIGRATE_REQUIRE_LIVE_DB` turns a skip into a panic.
Conformance inherits this unchanged: a conformance report from a run with no
server is not a partial pass, it is not a report.

## The layers

### Layer 0, declared disposition. Offline, free.

Extends `dialect_table_faithfulness.rs` from three backends to N. Every backend
answers, for every (kind, variant), one of `portable` / `vendor` /
`transparentDegradable` / `unsupported`. The existing checks generalize as they
stand: bijection between corpus and table, corpus kinds exhaustive over the wire
schema's discriminants, `op_variant()` agreement.

One new check, and it is decision 6: the table may contain no blank and no
"unknown". A backend that adds a crate and does not answer all 92 tokens does not
compile its conformance test. This is the whole reason a declaration can be
audited at all.

Layer 0 needs no database, runs in milliseconds, and is where most of the value
at three backends sits.

### Layer 1, outcome class. Live, cheap, and the honesty proof.

For every fixture in the corpus, on every backend, apply through the REAL path
(author -> `load_and_lower_guarded` -> `MigrationEngine::apply_plan`, never
hand-written DDL) and record exactly one outcome:

```
  Applied                 the server accepted it
  RefusedByCapability     the engine refused before emitting, naming the capability
  RefusedByPolicy         guard or charter refused
  ServerError             the server rejected engine-emitted SQL
  EngineError             anything else
```

The conformance rule is a total function of the declared disposition:

| declared | required outcome |
|---|---|
| `portable` | `Applied` |
| `vendor` | `Applied` |
| `unsupported` | `RefusedByCapability` |
| `transparentDegradable` | `Applied` (the degraded form is a layer 2 concern) |

`ServerError` is ALWAYS a conformance failure, on every disposition. That single
row is the layer that would have caught the three retypes at
`review-log.md:27085` that "cleared the authoring gate ... and then died against
the server". `RefusedByCapability` where `portable` is declared is a dishonest
declaration in the generous direction; `Applied` where `unsupported` is declared
is a dishonest declaration in the dangerous direction.

This closes the gap named above: today the table is proven against
`Op::support()`, which is the same opinion restated. Layer 1 proves it against a
server.

Layer 1 is also directly comparable to F877's inventory, so its first run has a
known expected shape: 67 of 80 PG tokens should reach `Applied` immediately, and
the 13 that do not are already enumerated at `review-log.md:27280`.

### Layer 2, semantic observation. The differential, and the hard part.

Do not compare SQL. Do not compare snapshots. Compare a small set of named
probes, each of which returns a DIALECT-FREE value.

An observation is `(name, args) -> Value`, evaluated against the live database
after an op stream has applied. The starting set, each drawn from a defect that
already happened:

```
  row_order(table, key_column, inserted_rows)
        the sequence ORDER BY returns.        -> the collation defect
  accepts(table, row)  /  rejects(table, row)
        does a constraint actually bite.      -> CHECK and FK facets
  null_accepted(table, column) -> bool
        does NOT NULL actually hold.
  default_value(table, column)
        what an omitted insert lands.
  value_roundtrip(table, column, value)
        what a value comes back as.           -> type widening, charset
  op_refused(op) -> Option<reason_class>
        does a posture mean the same thing.   -> destructive-ops parity defect
  object_exists(kind, name) -> bool
        did a rebuild lose an index.          -> SQLite 12-step rebuild
  drift_clean() -> bool
        does the folded snapshot match a fresh introspection.
```

The abstraction level is deliberate and it is the crux. `row_order` is what the
collation defect actually WAS. `COLLATE "C"` versus `utf8mb4_0900_bin` is how
three backends spell the same intent, and a test at that level is a test of
spelling. The review-log entry says this in its own voice: "A test that greps the
emitted statement for `COLLATE \"C\"` measures how the engine spells itself."
Observations sit one level above spelling and one level below "the schemas are
equal", which is the only band where a differential is both meaningful and
survivable.

Observations are also cheap to keep honest, because they are OBSERVABLE from
outside: an operator could run them by hand against their own database.

#### The oracle: what counts as a legitimate difference

Default rule: for one fixture and one observation, every backend must produce the
same value.

Exception rule: the FIXTURE may declare a per-backend expected value.

```toml
[[case]]
id = "injected_id_bytewise_order"
ops = "fixtures/ops/injected_id_collation.json"
observe = "row_order(t, id, [aaa, AAA, zzz, Zzz])"
expect  = "creation_order"

[[case.differs]]
backend = "mysql"
expect  = "creation_order"
reason  = "utf8mb4_0900_bin is bytewise; the spelling differs, the order does not"
```

Three properties make this an oracle rather than a suppression list.

- **It names the value.** `differs` without `expect` is rejected by the loader.
  If SQLite starts returning a third thing, the case fails. A conventional
  `#[ignore]` or an allow-list cannot fail; this can.
- **It is declared by the fixture, not the backend.** Decision 4. A backend crate
  cannot ship its own exceptions, because the corpus lives in
  `zero-migrate-conformance` and a backend depends on it, not the other way
  around. A third-party backend that needs an exception opens a PR against the
  shared corpus, where a human reads the `reason`.
- **It is reviewed as data.** One file, the same restricted-grammar TOML shape
  `dialect-support.toml` already uses and the faithfulness test already parses
  by hand (`parse_sidecar`, line 71). The count of declared exceptions is a
  number you can watch. A rising count is a design smell with a metric attached.

Where a legitimate difference is STRUCTURAL rather than a value, it is expressed
as an observation that abstracts over it rather than as an exception. SQLite
rebuilding a table instead of altering it must produce identical
`object_exists`, `row_order`, `accepts` and `drift_clean` results. If it does
not, the rebuild lost something, which is a defect and not a dialect. That is the
test the 12-step rebuild has wanted since it was written.

Native enum versus inlined CHECK is the same story: `accepts('x')` and
`rejects('q')` must agree; `object_exists(enum_type, ...)` legitimately differs
and is declared once, with values, at the fixture that creates it.

#### The ledger, and why the differential is offline

A backend's conformance run emits a LEDGER: a sorted, canonical
`(case_id, observation, value, outcome_class)` file. Nothing else.

The differential is a separate step that reads N ledgers and compares them. It
opens no connection. Consequences, and decision 9 exists for all three:

- N backends never need to be live simultaneously. Each ledger is produced by a
  job with one service.
- The differential is reproducible, diffable and reviewable in a PR. "This change
  moved 4 observations on MySQL" is a diff, not a log.
- A backend maintained outside this repo can publish a ledger, and the
  differential can include it without CI ever hosting that database.

## Tiers

A backend does not "partially work". It occupies a tier.

**Core.** Required to ship, no exceptions, no `unsupported` cells permitted.
`createTable` with plain columns, primary key, NOT NULL and literal defaults;
`addColumn`; `dropColumn`; `dropTable`; `renameTable`; `createIndex`;
`dropIndex`; `insert`; `update`; `delete`. Plus the engine contract, which is not
DDL and is where a new backend is most likely to be quietly wrong: journal
write/read, advisory or table lock acquisition, checksum stability, drift
detection via `snapshot_schema` + `diff_snapshots`, and clean refusal with the
whole plan aborted. A backend failing Core DOES NOT SHIP. There is no degraded
mode, because every one of these is load-bearing for the safety story.

**Extended.** May be declared `unsupported`, must then be REFUSED, must never be
approximated. Separate `addConstraint`/`dropConstraint`, `setColumnType`, views,
materialized views, triggers, enums, domains, sequences, partitions, RLS,
generated columns, `insert ... on conflict`. A backend that declares
`unsupported` here and ships is a first-class backend; the current SQLite backend
declares 49 of 92 tokens `unsupported` and is not a lesser thing for it. What is
forbidden is `Applied` against a declared `unsupported`, or a `ServerError`
instead of a clean refusal.

**Vendor.** One backend's own constructs (`pgRaw`, exclusion constraints,
PostgreSQL vendor primitives; 19 PG tokens today). No cross-backend obligation.
The only conformance requirement falls on the OTHER backends: they must refuse
by capability, with a message naming the capability, never with a server error.

A backend's tier is not self-asserted. It is the highest tier for which its
ledger contains no failing row.

## Where the suite lives

A crate: `crates/zero-migrate-conformance`. It depends on
`zero-migrate-backend` (the trait crate from `pluggable-backends.md`) and on
nothing else in the workspace, so a third-party backend crate can depend on it
without pulling in the core or another vendor's driver.

```rust
// third-party-backend/tests/conformance.rs
zero_migrate_conformance::conformance_suite!(
    backend = my_backend::MyBackend::from_env,
    tier    = Tier::Extended,
    ledger  = "target/conformance/mybackend.ledger",
);
```

A crate AND a macro, and both parts earn their place. The crate is what keeps the
corpus SHARED. If the corpus were a macro-expanded template each backend
vendored, every backend would drift into its own fixtures and the differential
would compare nothing. The macro exists only for libtest integration: it expands
to one `#[test]` per tier so a failure names the tier, and it writes the ledger.
All logic lives in `run_conformance(&dyn Backend, &Config) -> Report`, callable
without the macro for anyone driving it from elsewhere.

The corpus itself is DATA, not Rust: IR envelopes as JSON (which is what the wire
format already is, so fixtures are exactly what a user would author) plus the
case TOML. Data corpora survive a trait redesign; Rust fixture functions do not,
and `pluggable-backends.md` decision 10 schedules exactly such a redesign.

## Fixtures

The corpus is not written from imagination. It has three measured sources.

1. **The existing 92-op corpus in `dialect_table_faithfulness.rs`.** It is
   already hand-authored, already one representative op per (kind, variant),
   already proven to select the right support branch, already in bijection with
   the table. Lifting it is why this is startable next week rather than next
   quarter. It moves from a test file to `zero-migrate-conformance`, and the
   faithfulness test imports it back so the existing guarantee is unchanged.
2. **The F877 gap list.** The 13 PG tokens never observed executing, plus the
   SQLite and MySQL columns enumerated at `review-log.md:27280`, are the first
   fixtures that get a live leg. They are a ranked backlog someone already paid
   to produce.
3. **Every cross-backend defect closes with a fixture.** The collation defect
   adds `row_order`. The destructive-ops defect adds `op_refused`. This is a
   rule, not an aspiration, because rule 7 makes it mechanical.

Anti-drift is a test, not a process promise. The bijection already enforced
between corpus and `dialect-support.toml` extends to the case file: adding a row
to the sidecar without a conformance case fails the build. That is what stops the
corpus decaying into "the ops that were easy to write", which is the observed
failure mode of every hand-maintained suite including the two in this tree.

Fixtures must be authored through the PUBLIC path. `sql-preview-parity.test.ts`
already articulates why in its own header: a suite that asserts what its own
recorder emitted is invisible to a self-consistent recorder bug. Conformance
fixtures are IR envelopes because that is the contract a real user's migration
crosses.

## Cost, and what CI looks like

Measured baseline: `.github/workflows/ci.yml` is 298 lines with four jobs. `rust`
runs a PostgreSQL 18 service and `cargo test --workspace --exclude
zero-migrate-node`. `host` runs PostgreSQL 18 AND MySQL 8 and drives the real
addon. `node` and `napi` need no database.

| layer | needs a live server | cost at 3 backends | cost at 20 |
|---|---|---|---|
| 0 declared disposition | no | milliseconds, existing job | milliseconds, existing job |
| 1 outcome class | yes (SQLite embedded, free) | 1 MySQL service added to `rust` | matrix, 1 service per job |
| 2 observations | yes | same job as layer 1 | same matrix |
| differential | NO | seconds, new job | seconds, same job |

At three backends the marginal CI cost is **one service container on an existing
job**. SQLite is embedded and free (`fold_roundtrip_sqlite.rs` needs no DSN by
construction). PostgreSQL is already running on `rust`. MySQL is already running
on `host`, so the image is already pulled and the credentials pattern already
exists; adding `ZERO_MIGRATE_MYSQL_URL` to the `rust` job is a five-line change
that also closes the largest measured asymmetry in the tree.

At twenty backends, `rust` cannot host twenty services. The shape must change,
and the point of decision 9 is that adopting the final shape NOW costs nothing:

```
  conformance (matrix: 1 job per backend, 1 service each)
      -> uploads ledger artifact
  differential (1 job, NO services)
      -> downloads N ledgers, compares, fails with a value diff
```

That is the same topology at 3 and at 20. Wall clock grows with the SLOWEST
backend, not with their sum, because the matrix is parallel. The differential
stays constant-time in database count because it touches none.

Third-party backends fit without CI hosting their database: they run the matrix
job in their own CI and publish a ledger.

## What this makes worse

- **CI wall clock.** One more job now; a matrix later. Mitigated by the ledger
  split, but not eliminated.
- **`f664_scaling` gets worse unless it is moved, and it must be moved first.**
  It asserts a COMPLEXITY RATIO with a 3.0x ceiling, deliberately rather than a
  wall-clock budget, and its own header says a timing threshold "turns into a
  flake on a loaded machine". It still flakes: `review-log.md:28599` records
  three of its four tests failing together at 3.6x, 3.6x and 3.8x while "two
  other projects' live-DB suites held the machine at load average 26", passing on
  the idle re-run. It is the one failure hardest to distinguish from a real
  regression at a glance. A conformance matrix multiplies exactly the load that
  causes this. The fix is a prerequisite, not an afterthought: move
  `f664_scaling` and `f665_scaling` to a dedicated CI job with no services and
  nothing else scheduled on it, and exclude them from the workspace `cargo test`.
  A ratio measured on a quiet runner is a measurement; on a loaded one it is
  noise in both directions, and the second direction (a real regression hidden
  under a wide noise floor) is the one the test exists to catch.
- **New instrument, new false results.** An observation implemented wrong fails
  toward a false green as readily as a false red. Decision 8 is the mitigation
  and it is not optional: every observation ships with a neuter control that must
  FAIL, in the shape `injected_column_collation.rs` already uses
  (`injected_id_without_a_pinned_collation_loses_creation_order`) and
  `destructive-ops-dialect-parity.test.ts` already uses (arm 1b and arm 2).
  Beyond that, the whole kit must be shown to fail once: reintroduce the
  collation defect and confirm the differential goes red on PostgreSQL and MySQL
  and stays green on SQLite, which was genuinely correct.
- **The corpus becomes public API.** Once a third-party backend runs it, changing
  a fixture breaks their CI. The corpus needs a version and a deprecation
  window. This is a real cost and it is the price of decision 4.
- **Friction on adding an op.** A new op means a sidecar row, a fixture, and an
  outcome on every backend. Intentional, but it is friction and it will be felt.
- **Layer 2 will find legitimate differences nobody has articulated.** The first
  run will produce exceptions that are neither clearly defects nor clearly
  legitimate. Budget for that argument rather than assuming the corpus arrives
  clean.

## Implementation sequence

Each step is independently valuable at THREE backends and leaves the tree green.
Nothing here waits on `DialectId` or on crate extraction.

1. ~~**Move `f664_scaling` and `f665_scaling` off the shared runner.**~~ **DONE** —
   they run in their own `scaling:` job, separate from `rust:`. One footnote worth
   keeping: that job invoked `--test f664_scaling --test f665_scaling`, and
   consolidating the tests into themed subdirectories turned those binaries into
   MODULES under `authoring_surface`. The invocation had been exiting **101** with
   `error: no test target named f664_scaling` — the job had timed nothing since the
   move. Fixed to name `authoring_surface`, whose ignored set is exactly these five
   guards. The job's own anti-silence check did not catch it: that check watches for
   a run that SUCCEEDS while measuring nothing, and a missing target fails loudly
   just outside its aim.
2. ~~**Layer 0, offline, three backends.**~~ **DONE, with one deliberate
   deviation.** All three sub-items, measured:
   - *Corpus lift* — DONE, but into `tests/dialect_corpus/mod.rs`, **not** a
     `zero-migrate-conformance` crate. That is decision 7 at the smallest scope
     that buys it, and the module says why in its own header: a crate is only
     needed once a backend lives outside this repo, which is `pluggable-backends.md`
     step 4 / this document's step 7. The 92 rows are byte-identical to the ones
     the faithfulness test built, and it now has FOUR consumers —
     `dialect_table_faithfulness.rs`, `dialect_conformance_live.rs`,
     `checksum_corpus_stability.rs`, `unsupported_reason_is_operator_facing.rs`.
     **Do not create the crate to tick this box.** Its absence is the design.
   - *No-blank-cells rule* — **ALREADY ENFORCED, so nothing was added.** Proven by
     counterfactual rather than by reading: blanking one cell (`pg = ""` on
     `alterPrimaryKey/base`) fails
     `op_variant_matches_the_corpus_and_the_generated_table_matches_the_sidecar`,
     because the sidecar⟷table bijection compares against a generated disposition
     token that the empty string matches none of. A dedicated rule would be
     redundant coverage.
   - *Stale `transparentDegradable` comment* — FIXED, and it was staler than
     described. The legend claimed the token was "NOT produced by the current
     engine; reserved, and no row in this file uses it"; **both halves were false.**
     Two rows use it on both non-PostgreSQL dialects, the generated table carries
     it, `op_support.rs` treats it as SUPPORTED, and lowering collapses a partition
     child into its parent because of it.
3. ~~**Give the `rust` job a MySQL service and write `fold_roundtrip_mysql.rs`.**~~
   **DONE.** `crates/zero-migrate/tests/fold_live/fold_roundtrip_mysql.rs` exists
   and CI carries the MySQL service. The oracle has all three legs, so the largest
   measured asymmetry in the tree is closed.

**Steps 1, 2, 3 and 4 are complete. 5 and 6 are open**, measured by artifact
rather than by phrase: `row_order` and `op_refused` have zero occurrences in
`crates/`, and CI has no differential job. Step 7 is deferred by design (see
step 2).

An earlier revision of this line said 4 was open too. It was not — that came from
grepping "outcome ledger", which is this document's name for the thing and not
the code's.
4. ~~**Layer 1, outcome ledger, three backends.**~~ **DONE**, on all three, in
   `tests/dialect_matrix/dialect_conformance_live.rs` (2,131 lines). It carries the
   five-outcome vocabulary, the disposition→required-outcome rule, `pg_verdict` /
   `mysql_verdict` / `sqlite_verdict`, and one live entry point per dialect
   (`every_{postgres,mysql,sqlite}_row_of_the_dialect_table_answers_to_a_live_*`).
   The exception file exists too — `tests/dialect_conformance/expectations.rs`
   `ALLOWANCES` — and a `ServerError` allowance fails the BUILD by const-eval
   rather than being silently tolerated.

   **Beware searching for this by the name used above.** The code calls it a
   `Verdict`, not an "outcome ledger", so a grep for the proposal's phrase returns
   zero and reads exactly like "not built". That mistake was made here and it is
   the same shape as counting a symbol's mentions instead of its calls: **search
   for the artifact, not for the prose that describes it.**
5. **Layer 2, seeded with two defects.** `row_order` for the collation defect
   (including the live MySQL leg that has never existed) and `op_refused` for the
   destructive-ops parity defect. Two observations, two controls, one exception
   file.
6. **The differential job.** Reads three ledgers offline.
7. **`conformance_suite!()` and the corpus version.** Only needed when a backend
   lives outside this repo, which is `pluggable-backends.md` step 4.

Steps 1 through 5 pay for themselves at three backends. Step 3 alone is worth
more than the rest of the sequence if the project stops here.

## Required test matrix

The kit is test infrastructure, so what follows is the tests that prove the KIT
works. A conformance suite nobody has seen fail is a green light with no bulb.

- **Corpus/sidecar bijection.** Adding a `[[row]]` to `dialect-support.toml`
  without a conformance case fails the build, and the reverse. Extends the check
  at `dialect_table_faithfulness.rs:20`.
- **No blank cells.** Every (token, backend) pair carries a disposition. A
  backend added without answering all 92 does not compile its test.
- **Every observation has a failing control.** Enforced structurally: the case
  loader rejects an observation whose control is absent, and the control's
  expected result is FAIL.
- **The exception file cannot suppress.** A `[[case.differs]]` with no `expect`
  is rejected at load. A `differs` whose expected value matches the default
  expectation is rejected as dead weight.
- **Mutation check, run once per layer and recorded.** Reintroduce the collation
  defect: the differential must go red on PostgreSQL and MySQL and green on
  SQLite. Reintroduce the destructive-ops divergence: red on MySQL and SQLite.
  Declare a `portable` token the backend actually refuses: layer 1 red.
- **Ledger determinism.** Two runs of the same backend against the same server
  produce byte-identical ledgers. Without this the differential's diffs are
  noise.
- **Skip is not a pass.** A conformance run with no DSN produces NO REPORT, not
  an empty passing one. Inherits `announce_live_db_skip` and
  `ZERO_MIGRATE_REQUIRE_LIVE_DB` (`tests/support/mod.rs:271`), and CI sets the
  require flag on the conformance matrix.
- **Report names its scope.** Every ledger records the backend, the server
  version, and the suites traced. F877's first pass was confidently wrong because
  it did not; that failure mode is now a required field.
- **Checksum stability.** Fixture IR envelopes are recorded migrations, so
  `Checksum::of_ir` over the corpus must be byte-stable across every step. This
  is `pluggable-backends.md`'s wire-format constraint, and the corpus is the
  natural place to hold its guard.

## Risks and open questions

- **The observation set may not generalize.** Eight observations drawn from two
  defects is a small sample. Whether they cover a document store or a columnar
  engine is UNVERIFIED and cannot be verified until a fourth backend exists.
  Layers 0 and 1 do not depend on the answer.
- **`RefusedByCapability` is not currently a distinguishable outcome class.** The
  engine refuses in several places with several error types; whether they can be
  classified without ambiguity was NOT CHECKED. If they cannot, layer 1's table
  needs a coarser vocabulary, and that is a design question worth settling before
  step 4.
- **Unattributed executions.** F877 recorded 222 unattributed of 654 traced Rust
  executions, largely from the declarative differ, which never passes through
  `lower_one_op`. A conformance case drives ops explicitly so it should not have
  this problem, but the DECLARATIVE authoring lane is a second path into the same
  engine and this proposal says nothing about conformance for it. That is a gap,
  stated rather than solved.
- **Nothing here was executed.** This proposal is docs-only. No `cargo build`,
  `cargo test` or pnpm gate was run; every claim above is from reading files and
  running `grep`, `ls` and `wc`, and the commands are cited so they can be
  repeated. The line counts, file counts and disposition tallies are VERIFIED.
  The predicted first-run layer 1 results are INFERRED from F877's inventory and
  will differ if the tree has moved since it was measured.
