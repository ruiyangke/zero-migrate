# CLI reference

The `zero-migrate` CLI creates, checks, plans, applies, and inspects JavaScript
or TypeScript migrations. Live commands select their database dialect from the
configured URL. Offline linting can check PostgreSQL, MySQL, and SQLite in one
run.

[Documentation home](README.md) | [Getting started](getting-started.md) |
[Writing migrations](writing-migrations.md) | [Node API](node-api.md) |
[Troubleshooting](troubleshooting.md)

Migration modules are trusted code. The CLI imports them into its own process
and records their `schema()` or `data()` operations, plus `inverse()` when one is
declared. Top-level module code and every migration callback have the same file,
network, and environment access as the CLI process. Do not load untrusted
migrations.

## Run from this checkout

This is a pre-release checkout. Follow the source setup in
[Getting started](getting-started.md#1-prepare-the-checkout) before running the
examples below. TypeScript migrations need `tsx`, Bun, or another TypeScript
loader. During local development, `ZERO_MIGRATE_ADDON_PATH` can point to the
freshly built native addon; it is a loader override, not a project setting.

## Command surface

```text
zero-migrate new <name> [options]
zero-migrate lint [options]
zero-migrate plan [options]
zero-migrate apply [options]
zero-migrate rollback (--to <version> | --steps <n> | --all) --approve [options]
zero-migrate status [options]
zero-migrate resolve <migration> (--commit | --rollback) --approve [options]
zero-migrate history [options]
zero-migrate --version
```

| Command | Database | Purpose |
| --- | --- | --- |
| `new` | None | Create a timestamped TypeScript migration |
| `lint` | None | Validate migrations for all supported dialects, or one selected dialect |
| `plan` | PostgreSQL or MySQL | Show pending migrations and the SQL that would be applied |
| `apply` | PostgreSQL, MySQL, or SQLite | Apply migrations in filename and authored-step order |
| `rollback` | PostgreSQL, MySQL, or SQLite | Unwind eligible applied migrations, newest first, to a target |
| `status` | PostgreSQL or MySQL | Reconcile migrations with journal state |
| `resolve` | PostgreSQL | Commit or roll back one pending online column rename by migration name |
| `history` | PostgreSQL | Print the append-only migration audit trail |

There are no short flags. Value flags accept `--flag value` and
`--flag=value`. Boolean flags such as `--json`, `--strict`, and `--approve` do
not take values. Unknown commands and flags fail.

Use `--dir` for commands that load migrations. A migration directory is not a
positional argument. The only command positionals are the name passed to `new`
and the migration name passed to `resolve`.

## Project configuration

The optional `zero-migrate.toml` file stores named environments. Each setting
must be inside an `[env.<name>]` block:

```toml
[env.dev]
url = "sqlite:./data/dev.db"
dir = "./migrations"
owner_app = "app_demo"
schema = "public"
registry = "./table-owners.json"
policy = "./policy.toml"

[env.production]
url = "env:DATABASE_URL"
dir = "./migrations"
owner_app = "app_demo"
schema = "app_demo"
registry = "./table-owners.json"
policy = ["./policy-root.toml", "./policy-production.toml"]
```

Supported fields are:

| Field | Meaning |
| --- | --- |
| `url` | PostgreSQL, MySQL, or SQLite URL |
| `dir` | Migration directory |
| `owner_app` | Deploying application ID |
| `schema` | Confined project schema or database |
| `registry` | Trusted JSON table ownership registry |
| `policy` | One charter path or an ordered array of charter paths |

The CLI discovers `zero-migrate.toml` in the current directory and then walks
upward. `--config <path>` selects an explicit file instead. Relative `dir`,
`registry`, and `policy` paths in the file are resolved from the directory that
contains the config file.

Select a block with `--env <name>`. Without `--env`, the CLI selects `dev` when
that block exists. If the file contains exactly one block, that sole block is
selected. A file with multiple blocks and no `dev` block requires an explicit
selection.

Any string value can contain an environment reference of the exact form
`env:VARNAME`. The referenced variable is resolved when the config is loaded,
and an unset variable is an error. This keeps credentials out of committed
configuration. Each entry in a `policy` array is resolved independently.

For every setting, precedence is:

```text
explicit command flag
ZERO_MIGRATE_* environment variable
selected [env.<name>] config value
built-in default
```

The environment variables are:

| Variable | Setting |
| --- | --- |
| `ZERO_MIGRATE_URL` | Database URL |
| `DATABASE_URL` | Database URL fallback |
| `ZERO_MIGRATE_DIR` | Migration directory |
| `ZERO_MIGRATE_OWNER_APP` | Deploying application ID |
| `ZERO_MIGRATE_SCHEMA` | Project schema or database |
| `ZERO_MIGRATE_REGISTRY` | Ownership registry path |
| `ZERO_MIGRATE_POLICY` | Ordered policy charter layers |
| `ZERO_MIGRATE_CONFIG` | Explicit config path |
| `ZERO_MIGRATE_ENV` | Config environment name |
| `ZERO_MIGRATE_TLS_CA` | CA bundle path to pin |
| `ZERO_MIGRATE_HOST_ALLOWLIST` | Comma-separated reachable hosts |
| `ZERO_MIGRATE_QUERY_TIMEOUT_MS` | Per-statement bound in milliseconds |

`DATABASE_URL` is the legacy URL fallback. It is used only when no explicit URL,
`ZERO_MIGRATE_URL`, or selected config `url` is present.

`ZERO_MIGRATE_POLICY` carries an ordered list of charter layers, not a single
path. Separate them with the OS path separator exactly like `PATH` — `:` on
POSIX, `;` on Windows — in root-to-narrowing order, the same order repeated
`--policy` flags use:

```bash
export ZERO_MIGRATE_POLICY="./policy-root.toml:./policy-production.toml"
```

It **replaces** a selected config `policy` array rather than adding to it. Because
layers only ever narrow, dropping one widens effective policy, so replacing a
multi-layer config `policy` with fewer environment layers is a loosening. The CLI
writes a warning naming both layer counts when that happens. A value that is empty
or contains only separators carries no layers and is treated as unset, so the
config `policy` still applies.

Unlike config paths, environment layers are resolved from the current working
directory, not from the directory containing the config file.

An explicit empty value is still explicit: it overrides a lower-precedence source
rather than falling through to it, and is then refused. Setting `--schema ""` or
`ZERO_MIGRATE_SCHEMA=""` does not fall back to the `public` default — it is
rejected by name, which is what makes an unset CI variable such as
`--schema "$DEPLOY_SCHEMA"` a clean failure instead of a deploy against the wrong
schema. `ZERO_MIGRATE_POLICY` is the one exception, described above: it carries a
layer list, so an empty value means zero layers rather than one empty layer, and
the config `policy` still applies.

If no config file is present, the CLI continues to work with flags, environment
variables, and defaults.

## Common flags

| Flag | Meaning |
| --- | --- |
| `--config <path>` | Use an explicit config file |
| `--env <name>` | Select a config environment |
| `--dir <dir>` | Migration directory; default `./migrations` |
| `--database-url <url>` | Override the configured database URL |
| `--registry <file>` | Trusted JSON map of table names to owner application IDs |
| `--policy <file>` | Policy charter layer; repeat in root-to-narrowing order |
| `--owner-app <app>` | Deploying application ID; default `app_cli` |
| `--schema <schema>` | Confined project schema; default `public` |
| `--tls-ca <file>` | Pin a CA bundle for the database TLS connection |
| `--host-allowlist <hosts>` | Comma-separated hosts a connection may reach |
| `--query-timeout <ms>` | Per-statement bound, including the lock acquire |
| `--json` | Emit machine-readable output where supported |
| `--help` | Print help and exit 0 |
| `--version` | Print the package version and exit 0 |
| `--verbose` | `version` only: also report the loaded addon's identity |

## Transport controls

Three flags constrain the connection itself. They are enforced by the host, which
owns the socket, so they apply to the `postgres` and `mysql` drivers only — SQLite
runs in-process and never opens one. Each also reads an environment variable:
`ZERO_MIGRATE_TLS_CA`, `ZERO_MIGRATE_HOST_ALLOWLIST`, and
`ZERO_MIGRATE_QUERY_TIMEOUT_MS`. Flags win over environment variables, and leaving
all three unset leaves the driver defaults untouched.

Unlike every other setting above, these three have **no `zero-migrate.toml`
field**: they are flag or environment only. A config file cannot weaken the
transport controls a deploy runs under.

```bash
zero-migrate apply --env production \
  --tls-ca ./ca.pem \
  --host-allowlist db-primary.internal,db-replica.internal \
  --query-timeout 30000
```

`--tls-ca` takes a **file path**, not PEM text. The bundle is pinned for the
session and the server certificate is verified against it, independently of any
`sslmode` in the connection URL.

`--host-allowlist` refuses the connection before it is opened unless every host
the URL designates is listed. That is every host, not just the one in the URL's
authority: a PostgreSQL URI may also carry a `host` query parameter, which the
driver prefers over the authority, so both must be allowlisted. Comparison is
exact, and the URL parser lowercases the host in a URL's authority, so write
allowlist entries in lowercase. Name each host in full: there is no suffix or
wildcard matching, deliberately, because a suffix rule that accepted
`example.com` would also accept `evil-example.com`.

`--query-timeout` bounds every statement, including the lock acquire described
under [When a deploy is already running](#when-a-deploy-is-already-running).

`zero-migrate version` prints one bare version string and nothing else, so
`$(zero-migrate version)` stays usable, and it answers without loading the native
addon. `zero-migrate version --verbose` additionally reports the loaded addon's
crate version, IR floor, and a sha256 over the workspace source it was built from -
the value that tells you whether the binary in memory matches the code in the tree.
Add `--json` to that form for one machine-readable document:

```
{
  "cliVersion": "0.1.0",
  "addon": { "version": "0.1.0", "irVersion": 1, "sourceDigest": "<64 hex>" }
}
```

`--json` without `--verbose` leaves `version` output unchanged.

`--journal <path>` is an `apply`-only override for the separate SQLite
migration journal. `--approve` is accepted by `apply` and `resolve` for reviewed
destructive work. Command-specific flags are documented below.

### Database URLs and credentials

The URL scheme selects the live dialect:

| URL | Dialect |
| --- | --- |
| `postgres://...` or `postgresql://...` | PostgreSQL |
| `mysql://...` | MySQL 8 |
| `sqlite:<path>` or a `.sqlite`/`.db` path | SQLite plan and apply |

Live commands do not accept `--dialect`. This prevents a flag from disagreeing
with the actual database. Only `lint` accepts `--dialect`.

Prefer `url = "env:DATABASE_URL"` in config, or pass the connection URL through
`DATABASE_URL`. If an explicit `--database-url` contains an inline password, the
CLI prints a warning to standard error but still runs. The warning and errors do
not echo the URL, user name, or password.

## Migration discovery

The CLI reads the top level of the migration directory and accepts `.ts`,
`.mts`, `.cts`, `.js`, `.mjs`, and `.cjs`. It excludes `.d.ts` and sorts files
lexicographically. Timestamp prefixes therefore define apply order.

Each module's default export selects exactly one forward phase. A DDL migration
provides `schema()`:

```ts
export const name = "create_users";

export default {
  schema() {
    // zero-migrate operations
  },
};
```

A DML migration provides `data()` plus exactly one of a recorded `inverse()` or
a non-empty `irreversible: "reason"`. `schema()`, `data()`, and `inverse()` are
synchronous. The recorder enforces the DDL/DML split from the operations that
were actually recorded, not merely from the function name: DML in `schema()` and
DDL in `data()` are both refused. `up()` and `down()` are gone, not deprecated or
aliased.

The exported migration name is durable identity and must be unique within the
directory. Do not rename or edit an applied migration. Add a new migration
instead. TypeScript migrations require `tsx`, Bun, or another TypeScript loader.

## `new`

```bash
zero-migrate new create_users --dir ./migrations
```

Names must match `[A-Za-z0-9_]+`. The command creates the directory when needed
and writes a UTC timestamped TypeScript migration. It refuses to overwrite an
existing file.

## `lint`

```bash
zero-migrate lint --dir ./migrations
```

By default, `lint` runs the offline verifier for `postgres`, `mysql`, and
`sqlite`. Use `--dialect` to narrow the check to one target:

```bash
zero-migrate lint --dir ./migrations --dialect mysql
```

Human output contains one `ok` or `fail` line per migration. The command exits 1
if any migration fails any selected dialect. `--json` emits the structured lint
results.

Add `--explain` to print the offline SQL rendering for every selected dialect:

```bash
zero-migrate lint --dir ./migrations --explain
```

With `--explain`, human output also includes analysis advisories for the lowered
migration. Each advisory names the affected table, the statement kind, and the
lock involved so an operator can assess the risk before deployment. Advisories
are informational: they do not make an otherwise valid migration fail and do
not change the command's exit code.

SQL explanation applies the selected environment's ordered policy charter,
including its table-shape injection: a rendered `CREATE TABLE` carries the
charter-injected columns, pinned primary key, and injected indexes that apply
will create, not just the author's declaration. Operations that require a live
catalog and cannot be fully lowered offline are shown with a
`[runtime-resolved]` label. Explanation does not connect to a database.

Lint renders every migration whether or not `--explain` is passed, and folds a
render failure into the migration's verdict. A migration whose `createTable`
violates the charter -- for example by declaring a column the charter injects --
therefore fails lint with the resolver's message, where it previously passed
lint and failed only at apply. Without `--policy`, lint uses an in-memory
no-inject charter, which injects nothing and leaves this behaviour unchanged.

The optional ownership registry is an independent trusted map:

```json
{
  "users": "app_demo",
  "orders": "app_orders"
}
```

Pass the same registry, owner application, schema, and policy that live commands
use.

## `plan`

```bash
zero-migrate plan --env production
```

`plan` is a live dry run. It requires a database URL, connects to the target,
asks the journal-aware status API which migrations are pending, and renders SQL
only for the migrations `apply` can run using the URL-derived dialect and
selected policy.
Human output also surfaces analysis advisories for the lowered plan, naming the
affected table, statement kind, and lock involved. These advisories are
informational only: they neither block planning nor change a successful exit
code.

Human output starts with:

```text
would apply 2 migration(s)
```

It then prints each runnable pending migration and its rendered SQL, with the
selected policy's table-shape injection already applied, so the previewed
`CREATE TABLE` is the one apply runs. A migration that `apply` would refuse —
for example, one that touches a table with an outstanding online-rename
contract — is excluded from the count and SQL and listed separately:

```text
would apply 0 migrations
blocked: add_note (mig_...): table `people` has an in-flight online rename ...
```

The blocked line uses the same refusal reason as `apply`; blocked work never
silently disappears. `--json` carries the same partition as `pending` and
`blocked` arrays, and `count` is the length of the runnable `pending` array.

`plan` still exits 0 when it reports blocked work: it is a dry run that
describes the target and does not call the apply or resolution APIs or execute
rendered migration SQL. Use `status --strict` when blocked or pending state must
fail a pipeline.

Live planning is available for PostgreSQL, MySQL, and SQLite. Planning uses a
read-only status path and does not create SQLite journal files on fresh targets.

Planning against SQLite is not free of side effects, despite reading only. It
opens the application database with the same hardened connection profile apply
uses, and that profile pins `journal_mode = DELETE`. A SQLite application
database in WAL mode is therefore converted to DELETE journal mode by `plan`,
persistently and without a message, exactly as it would be by `apply` — see
[Security model](security-model.md). The conversion outlives the command and
removes the `-wal` sidecar, so an application relying on WAL's concurrent
readers loses that concurrency until something sets the mode back. Do not run
`plan` against a live WAL database you are not also prepared to apply to.

## `apply`

```bash
zero-migrate apply --env production
```

`apply` loads files in filename order and executes each schema migration's DDL
or each data migration's DML in authored order. DDL and DML cannot share a
module. Apply supports PostgreSQL, MySQL 8, and SQLite; the URL selects the
dialect.

Deletes, backfills, online rename expansion, and other approval-gated work
require an explicit operator decision:

```bash
zero-migrate apply --env production --approve
```

`--approve` acknowledges the exact reviewed work. It does not weaken structural,
ownership, policy, cursor, checksum, or live database checks. Each file is a
separate apply call. If a later file fails, earlier committed files remain
applied.

When an eligible schema step has a reverse, apply writes the exact reverse SQL
produced while lowering the forward operation against the catalog it observed
to the applied journal row's `down` field. That apply-time SQL is the durable
rollback instruction; it is not an author-provided `down()` hook. Structured
data reverses remain recorded `inverse()` operations, so their bound values are
not inlined into this textual field.

The policy is an ordered list of TOML documents. The first is the trusted root
bound; each later layer may narrow it. An installation with no injected shape
still supplies an explicit no-inject charter:

```toml
policy_version = 1
```

## `rollback`

Unwind eligible applied migrations, newest first, to a target. Schema rollback
prefers the apply-time reverse stored in the journal and executes that SQL
verbatim. For a reversible data migration, the reverse is the operations
recorded from its `inverse()`; rollback never calls an authored `down()`.

```bash
zero-migrate rollback --env production --steps 1 --approve
```

```text
rollback: 1 rolled back
  reversed mig_7n42DGM5OoRYCHDiem5nsW
```

A target is required, and exactly one of the three:

| Flag | Meaning |
| --- | --- |
| `--to <version>` | Unwind everything applied **after** this version, keeping it |
| `--steps <n>` | Unwind the `n` most recently applied migrations |
| `--all` | Unwind every applied migration |

Passing none is refused (`rollback needs a target`), and so is passing two.

A version is a `mig_…` ID, not the filename timestamp. `--to` accepts either
spelling a migration has: the logical version `status` reports in `applied` and
`pending`, or the journaled step version `apply` prints and the journal's `version`
column stores. These are different values for the same migration, and both resolve
to the same anchor. A version in neither space is refused with `is not currently
applied`, and nothing is unwound.

`--approve` is required; there is no unapproved rollback. `--dir` must still
point at the migrations, and the **whole** authored set is loaded rather than a
prefix. The CLI records every candidate module again so the engine can verify
its checksum, obtain any structured data inverse, and reconstruct a reverse for
a legacy row if necessary. A stored reverse does not make an edited migration
safe: checksum drift is still refused. Leaving an applied migration out of the
directory is a refusal, not a skip.

Reversibility has two hard limits: the forward plan must lower to exactly **one**
journaled step, and a recorded `inverse()` must lower only to transactional DML.
A module with two authored operations can therefore be ineligible if they lower
to two journaled steps. The complete candidate set is checked before execution,
so a refusal does not unwind an earlier candidate first.

The recorded inverse is lowered through the same guarded IR authoring path as
the forward operations. PostgreSQL, MySQL, and SQLite execute it as parameterized
DML. If both a stored textual reverse and a structured `inverse()` could apply,
the structured inverse wins; rollback never inlines its DML values into SQL
text. The inverse and its `rolled_back` journal event commit together. The
event stream is append-only: rollback does not erase the earlier `applied`
event. Its new net state makes `status` report the plan **pending**, and the next
`apply` replays the forward `data()` operations.

Schema migrations do not accept `inverse()`. Where the engine can derive an
exact reverse for an eligible single-step schema plan, apply stores that
engine-owned structural reverse and rollback replays it without lowering the
inverse again or consulting the current catalog to choose different SQL. It
never invokes author-provided `up()` or `down()`. Destructive DDL for which no
exact reverse exists is refused rather than approximated.

Rows written before stored reverses were introduced have `down = NULL`. For
those legacy rows only, rollback reconstructs the reverse from the migration
source and live catalog as earlier versions did. This compatibility fallback is
visible: human output includes an advisory naming the migration and saying that
its reverse is being reconstructed because no stored reverse is available. It
should be treated as a prompt to review an engine-version-dependent unwind, not
as equivalent to replaying an apply-time reverse.

### Irreversible migrations

A data migration can declare `irreversible: "reason"` instead of `inverse()`.
Rollback refuses it and reports that author-provided reason rather than
inventing a reverse.

For an engine-classified irreversible structural step, `--force` crosses it by
skipping it: the migration's effect stays in place and its version is listed
under `skippedIrreversible`. `--force` does not override an authored
`irreversible` data declaration. It is honored only together with
`--backup-acknowledged`, an explicit statement that a backup exists.

**Read `skippedIrreversible`.** An empty `rolledBack` beside a populated
`skippedIrreversible` means nothing was undone.

### Exit status

Rollback exits 0 whenever it completes, **including when it unwound nothing**:

```text
rollback: 0 rolled back
  nothing was applied in the requested range
```

A pipeline that must fail when there was nothing to undo has to read the output,
not the exit code. `--json` emits the machine-readable form:

```json
{
  "rolledBack": ["mig_7n42DGM5OoRYCHDiem5nsW"],
  "skippedIrreversible": []
}
```

There is deliberately no `applied` list. A caller reading `applied` off a rollback
reply would see an empty array and conclude nothing happened, which is the opposite
of what a successful unwind means.

Rollback is a writer, so it contends for the project lock like `apply`, and the two
engines differ. PostgreSQL's acquire is `pg_advisory_lock`, which is unbounded, so
a rollback **waits**. MySQL's is `GET_LOCK` with the project-lock budget, ten
seconds by default, so a rollback **fails** once that elapses and names the holding
session. See [When a deploy is already running](#when-a-deploy-is-already-running).

## `status`

```bash
zero-migrate status --env production
```

Human output reports applied and pending counts, outstanding contract or journal
drift, and checksum-mismatched plans or steps. Use `--json` for the complete
addon reply, including fields such as:

```json
{
  "currentVersion": "mig_...",
  "applied": ["mig_..."],
  "pending": [],
  "aborted": [],
  "rolledBack": [],
  "pendingContracts": [],
  "blocked": [],
  "unexpectedJournal": [],
  "plans": [
    {
      "version": "mig_...",
      "name": "create_users",
      "state": "applied",
      "steps": [],
      "missingDependencies": []
    }
  ]
}
```

Plan states include `applied`, `aborted`, `pending`, `partial`, `drifted`,
`blocked`, and `unknownDependency`. Step states include `pending`, `inflight`,
`applied`, `aborted`, and `drifted`.

Use `--strict` in CI:

```bash
zero-migrate status --env production --strict
```

Strict status exits 1 when anything is pending, drifted, or checksum-mismatched.
It exits 0 when the supplied migration set and journal are clean, and also when a
peer's deploy held the project lock (see below). `--json` does not change this
exit-code rule.

“Drifted” here means the supplied migration set disagrees with the **journal** —
a reused identity with a changed checksum, a versioned/repeatable kind mismatch,
a backfill whose progress checksum no longer matches. It does **not** mean the
live schema disagrees with the migrations. Structural drift is a separate
comparison that is not run on this path (see
[Security model](security-model.md)), so `status --strict` exits 0 even if a
column, an index, or the whole table has been dropped out of band. The journal
still says the migration applied, and that is all this gate reads. Use a
structural snapshot comparison from a Rust host if you need the schema itself
watched.

Status is available for PostgreSQL and MySQL. The dialect always comes from the
URL.

### When a deploy is already running

`apply` holds a project lock for the whole length of its run. `status` and `plan`
try for that lock without waiting: they make a few attempts a fraction of a second
apart, and if it is still held they report the contention and stop, having read
nothing.

```
$ zero-migrate status --env production --strict
zero-migrate: another deploy holds the project lock; status read nothing and did not wait for it
zero-migrate:   held by pid 4242 (zero-migrate, active): CREATE INDEX CONCURRENTLY ix_widgets_name ...
$ echo $?
0
```

This is the behaviour on PostgreSQL and MySQL alike. The holder line is dialect-
shaped, because the two engines publish different facts about a session:
PostgreSQL names the backend pid, the `application_name`, the activity state and
the current statement; MySQL names the connection id `KILL` takes, the account as
`user@host`, the command, and the statement when the holder is running one. A
deploy waiting between statements shows as `Sleep` with no statement, which is
what a holder normally looks like. MySQL reads the holder from
`performance_schema`, so an account without `SELECT` on it still gets the
contention reported, just with the session unnamed.

They read nothing on purpose. A status read is a sequence of catalog, journal, and
contract queries with no transaction around them, and a non-transactional apply
commits its inflight marker before the DDL and its completed row after it, so a
reader that went ahead without the lock would see a running deploy's own halfway
state and report it as drift.

The exit code is 0 because contention is not a dirty migration set: a strict gate
that failed here would fail on every pipeline that overlaps a deploy. A pipeline
that *wants* to fail on contention opts in through `--json`, where `busy` is
always present and `lockHolders` names the holding sessions:

```bash
zero-migrate status --env production --strict --json > status.json || exit 1
jq -e '.busy | not' status.json    # fail this build if a deploy was running
```

No duration is reported for a holder. Neither engine records an acquisition time
for its advisory lock, so every timestamp available would age the holder's session
or its current statement rather than the lock itself.

`apply` still waits for the lock: it is the writer the lock exists to serialize,
and a writer that gave up would leave the deploy undone. (`squash` waits the same
way, but it is not a CLI verb — `zero-migrate squash` is an unknown command. It is
a `zero-migrate` Rust crate operation, reachable only by an embedder.)

They wait **silently and without a deadline**. A writer queued behind another
deploy prints nothing at all until it gets the lock, so in a pipeline log it is
indistinguishable from one wedged on a slow `CREATE INDEX`. If you need to tell
the two apart, `status` from another shell reports the holder; that is what the
`busy` flag and `lockHolders` above are for. When the lock is released the waiter
picks up where it would have started, sees the other deploy's committed journal,
and applies whatever is still pending.

`--query-timeout` is the only bound on that wait. It applies to the lock acquire
like any other statement, so a writer that cannot get the lock in time gives up
having changed nothing:

```
$ zero-migrate apply --env production --query-timeout 30000
zero-migrate: failed to acquire project lock: db error: Query read timeout
$ echo $?
1
```

Prefer that in a pipeline with a job timeout of its own: a bounded failure you can
retry reads better than a job killed mid-wait, and because the writer gave up
before acquiring the lock, nothing was half-applied.

## `resolve`

PostgreSQL online column rename leaves the old and new columns side by side until
application cutover is complete. Address the obligation by the authored
migration name, not by an internal journal ID.

After every application instance uses the new column, commit the rename:

```bash
zero-migrate resolve rename_users_display_name \
  --commit \
  --approve \
  --env production
```

`--commit` keeps the new column and drops the old column. To reverse the rollout,
move applications back to the old column first, then run:

```bash
zero-migrate resolve rename_users_display_name \
  --rollback \
  --approve \
  --env production
```

`--rollback` keeps the old column and drops the new column. Exactly one action is
required, and both require `--approve`. The CLI reconciles status, maps the
migration name to its outstanding rename obligation, and fails clearly if no
unique pending obligation matches. Resolution is PostgreSQL-only.

## `history`

```bash
zero-migrate history --env production
```

`history` prints the append-only apply and rollback event stream. `--json` emits
the structured reply and serializes exact integer sequence values without
precision loss. History is PostgreSQL-only.

## Exit codes

| Result | Exit code |
| --- | --- |
| Help, version, or a successful command | 0 |
| `lint` finds an invalid migration | 1 |
| `status --strict` finds pending or dirty state | 1 |
| Import, configuration, connection, validation, policy, or runtime error | 1 |

Failures are written as `zero-migrate: <message>` to standard error. Warnings do
not change the exit code.

## Non-goals

The CLI intentionally has no `down` authoring hook or command and no `clean`
command. Reversible DML uses the recorded `inverse()` protocol; other recovery
uses a new forward migration or a tested restore procedure. The CLI does not
erase journal state or drop a project schema/database.

## Next

- [Getting started](getting-started.md)
- [Writing migrations](writing-migrations.md)
- [Operating migrations](operations.md)
- [Dialect support](dialects.md)
- [Troubleshooting](troubleshooting.md)
