# CLI reference

The `zero-migrate` CLI creates, checks, plans, applies, and inspects JavaScript
or TypeScript migrations. Live commands select their database dialect from the
configured URL. Offline linting can check PostgreSQL, MySQL, and SQLite in one
run.

[Documentation home](README.md) | [Getting started](getting-started.md) |
[Writing migrations](writing-migrations.md) | [Node API](node-api.md) |
[Troubleshooting](troubleshooting.md)

Migration modules are trusted code. The CLI imports them into its own process
and runs `up()` while recording operations. Top-level module code and `up()` have
the same file, network, and environment access as the CLI process. Do not load
untrusted migrations.

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
| `ZERO_MIGRATE_POLICY` | Policy charter path |
| `ZERO_MIGRATE_CONFIG` | Explicit config path |
| `ZERO_MIGRATE_ENV` | Config environment name |

`DATABASE_URL` is the legacy URL fallback. It is used only when no explicit URL,
`ZERO_MIGRATE_URL`, or selected config `url` is present.

An explicit empty value is still explicit and is validated as an error; it does
not fall through to a lower-precedence source. If no config file is present,
the CLI continues to work with flags, environment variables, and defaults.

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
| `--json` | Emit machine-readable output where supported |
| `--help` | Print help and exit 0 |
| `--version` | Print the package version and exit 0 |

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

Each module exports a synchronous named `up()` or `default.up()`:

```ts
export const name = "create_users";

export default {
  up() {
    // zero-migrate operations
  },
};
```

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
only for those migrations using the URL-derived dialect and selected policy.

Human output starts with:

```text
would apply 2 migration(s)
```

It then prints each pending migration and its rendered SQL, with the selected
policy's table-shape injection already applied, so the previewed `CREATE TABLE`
is the one apply runs. `--json` emits the same pending set and SQL as structured
data. The command does not call the apply or resolution APIs and does not
execute the rendered migration SQL.

Live planning is available for PostgreSQL, MySQL, and SQLite. Planning uses a
read-only status path and does not create SQLite journal files on fresh targets.

## `apply`

```bash
zero-migrate apply --env production
```

`apply` loads files in filename order and executes every migration's schema and
data steps in authored order. It supports PostgreSQL, MySQL 8, and SQLite; the
URL selects the dialect.

Deletes, backfills, online rename expansion, and other approval-gated work
require an explicit operator decision:

```bash
zero-migrate apply --env production --approve
```

`--approve` acknowledges the exact reviewed work. It does not weaken structural,
ownership, policy, cursor, checksum, or live database checks. Each file is a
separate apply call. If a later file fails, earlier committed files remain
applied.

The policy is an ordered list of TOML documents. The first is the trusted root
bound; each later layer may narrow it. An installation with no injected shape
still supplies an explicit no-inject charter:

```toml
policy_version = 1
```

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

No duration is reported for a holder. PostgreSQL records no acquisition time for
an advisory lock, so every timestamp available would age the holder's session or
its current statement rather than the lock itself.

`apply` and `squash` still wait for the lock: they are the writers the lock exists
to serialize, and a writer that gave up would leave the deploy undone.

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

The CLI intentionally has no `down` command and no `clean` command. Migrations
are forward-only: restore an applied migration's original source and author a
new migration for the next change. The CLI also does not erase journal state or
drop a project schema/database.

## Next

- [Getting started](getting-started.md)
- [Writing migrations](writing-migrations.md)
- [Operating migrations](operations.md)
- [Dialect support](dialects.md)
- [Troubleshooting](troubleshooting.md)
