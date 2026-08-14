# Node API

`zero-migrate-cli` is the JavaScript/TypeScript API for validating migration
modules, applying ordered PostgreSQL, MySQL, or SQLite schema and data changes, unwinding
them again, resolving PostgreSQL online column renames, and reading migration
state.

[Documentation home](README.md) · [Getting started](getting-started.md) ·
[CLI reference](cli.md) · [Writing migrations](writing-migrations.md) ·
[Troubleshooting](troubleshooting.md)

> **Complete ordered apply:** `apply()` executes DDL, insert, update, delete, and
> backfill steps on PostgreSQL and MySQL 8 in the order authored. One-shot data
> statements keep values separate from statement structure. Pending deletes and
> backfills require `approved: true`; matching completed steps skip without
> renewed approval. Approval is preflighted across the complete plan before its
> first authored step.

> **Trusted modules only:** the public API imports and executes migration
> JavaScript or TypeScript in the host process with no sandbox. Top-level module
> code and `up()` have the same environment, filesystem, network, and process
> authority as the calling application. Untrusted or generated source must be
> evaluated in an external sandbox with no secrets or ambient authority. Use a
> reviewed Rust/custom-host workflow to move the approved result into deployment.

## Run from this checkout

`zero-migrate` and `zero-migrate-cli` are not published to npm yet. The only
working installation path for this release is the repository checkout. Follow
[Getting started](getting-started.md#1-prepare-the-checkout) to install
workspace dependencies, build the JavaScript packages, and configure the
pre-release runtime.

Run TypeScript integration scripts with the `tsx` setup from that guide, or
compile them to JavaScript first. The current project is tested with Node.js 22,
PostgreSQL 18, and MySQL 8. Offline `plan()` and `validate()` do not open a
database, but they still require the completed source setup.

## Quick start

Given a migration module:

```ts
// migrations/20260715153045_create_users.ts
import { table, t } from "zero-migrate";

export const name = "create_users";

export function up() {
  table("users").create({
    columns: {
      email: t.string({ length: 254 }).notNull(),
    },
  });

  table("users").insert({
    rows: { email: "first@example.com" },
  });
}
```

Validate it and apply it:

The host must supply an operator-controlled policy document. For an
author-owned table shape, `policy.toml` can contain the explicit no-inject
charter `policy_version = 1`.

```ts
import { readFile } from "node:fs/promises";
import { apply, plan } from "zero-migrate-cli";
import * as migration from "./migrations/20260715153045_create_users.js";

const policy = [await readFile("./policy.toml", "utf8")];

const check = plan({
  migration,
  ownerApp: "app_demo",
  projectSchema: "app_demo",
  dialect: "postgres",
  registry: {},
});

if (!check.ok) {
  throw new Error(check.error ?? "migration validation failed");
}

const outcome = await apply({
  migration,
  ownerApp: "app_demo",
  projectSchema: "app_demo",
  driver: {
    kind: "postgres",
    url: process.env.DATABASE_URL!,
  },
  registry: {},
  policy,
  appliedBy: "deploy-service",
});

console.log(outcome);
```

The project schema must already exist. For a create-first migration, an empty
registry is sufficient because the module establishes ownership of the table it
creates.

## Public exports

```ts
import {
  apply,
  currentIrVersion,
  history,
  plan,
  resolvePending,
  status,
  validate,
} from "zero-migrate-cli";

import type {
  ApplyOutcome,
  DriverConfig,
  HostApplyOptions,
  HostHistoryOptions,
  HostPlanOptions,
  HostStatusOptions,
  IrEnvelope,
  MigrationModule,
  PlanReport,
  ResolvePendingOptions,
} from "zero-migrate-cli";
```

| Function | PostgreSQL | MySQL | SQLite | Opens a database? |
| --- | --- | --- | --- | --- |
| `currentIrVersion()` | Yes | Yes | Yes | No |
| `validate()` | Yes | Yes | Yes | No |
| `plan()` | Yes | Yes | Yes | No |
| `apply()` | DDL + all data steps | DDL + all data steps (MySQL 8) | No | Yes |
| `resolvePending()` | Online column rename | No | No | Yes |
| `status()` | Yes | Yes, with supplied migrations | No | Yes |
| `history()` | Yes | No | No | Yes |

## Migration module contract

The public `MigrationModule` type accepts named or default exports:

```ts
interface MigrationModule {
  up?: () => void;
  down?: () => void;
  name?: string;
  default?: {
    up?: () => void;
    down?: () => void;
    name?: string;
  };
}
```

A named `up` takes precedence over `default.up`. A module without either one
throws.

Importing a module runs its top-level code, and zero-migrate invokes `up()` with the
caller's full process permissions. There is no in-process sandbox. `up()` must
be synchronous and should be deterministic: keep database calls, file I/O,
timers, randomness, and clock-dependent behavior out of trusted authoring code.
That guidance improves reproducibility; it is not a security boundary.
Async functions and returned promises are rejected. `plan()` invokes `up()`
once and validates the exact envelope it returns.

The migration name is chosen from named `name`, `default.name`,
`nameFallback`, or `migration`, in that order.

The name is durable identity, not just display text. Keep it unique within the
project and do not rename it after apply. Editing the operations or bound values
of an applied migration keeps its identity but changes its checksum, so apply
stops with checksum drift.

A module that authors a `down()` is refused with `AUTHORED_DOWN_UNSUPPORTED`
rather than built: the envelope carries no rollback slot, so the body would be
discarded and rollback would run the engine's synthesised inverse instead. There
is no public rollback function. Module flags, dependencies, supersession, and
preconditions are also not accepted by this migration-module format.

The structured preview returned in `plan().envelope` is:

```ts
interface IrEnvelope {
  ir_version: number;
  name: string;
  ops: unknown[];
}
```

When running compiled ESM, import the emitted `.js` file. When executing `.ts`
directly, start Node with a TypeScript loader such as `tsx`.

## `currentIrVersion()`

```ts
function currentIrVersion(): number;
```

Returns the migration format version supported by the installed runtime. The
current value is `1`, but code should call the function instead of hard-coding
it. It throws if the zero-migrate runtime cannot load.

## `validate()` and `plan()`

Both functions use the same options:

```ts
interface HostPlanOptions {
  migration: MigrationModule;
  ownerApp: string;
  projectSchema?: string;
  dialect?: "postgres" | "mysql" | "sqlite";
  registry?: Record<string, string>;
  nameFallback?: string;
}
```

`projectSchema` defaults to `public`, `dialect` defaults to `postgres`, and
`registry` defaults to `{}`. Pass the same project schema to offline checks and
apply so explicit schema references are reviewed against the same confinement
boundary.

### `validate()`

```ts
function validate(options: HostPlanOptions): {
  ok: boolean;
  irVersion?: number;
  opCount?: number;
  error?: string;
};
```

```ts
const verdict = validate({
  migration,
  ownerApp: "app_demo",
  projectSchema: "app_demo",
  dialect: "mysql",
  registry: {},
});

if (!verdict.ok) {
  console.error(verdict.error);
}
```

Invalid migration structure returns `{ ok: false, error }`. A missing `up()`, an
exception thrown by `up()`, or a runtime setup failure throws normally.

### `plan()`

```ts
interface PlanReport {
  ok: boolean;
  ir_version?: number;
  op_count?: number;
  error?: string;
  envelope: IrEnvelope;
}

function plan(options: HostPlanOptions): PlanReport;
```

```ts
const report = plan({
  migration,
  ownerApp: "app_demo",
  projectSchema: "app_demo",
  dialect: "postgres",
  registry: {},
});

console.log(report.ok, report.op_count, report.envelope.ops);
```

Note the naming difference: `validate()` returns `irVersion` and `opCount`, while
`PlanReport` uses `ir_version` and `op_count`.

These functions check migration structure, dialect-specific operation forms,
project-schema confinement, and table ownership. They do not inspect a live
database, show rendered SQL, or guarantee that apply will succeed. They do
preserve insert, update, delete, and backfill operations in the reviewed document
that public `apply()` executes.

`plan()` records once, validates that operation list, and returns the same list
in `envelope`.

## Ownership registry

`registry` maps an existing table to the application that owns it:

```ts
const registry = {
  users: "app_demo",
  organizations: "app_accounts",
};
```

An operation targeting an existing table must match `ownerApp`. A missing entry
fails closed as `<unregistered>`; ownership is not inferred from the database.

A module that creates `users` establishes ownership for later operations in the
same module. A follow-up module needs the current mapping:

```ts
await apply({
  migration: addUserProfile,
  ownerApp: "app_demo",
  projectSchema: "app_demo",
  registry: { users: "app_demo" },
  driver: { kind: "postgres", url: process.env.DATABASE_URL! },
  policy,
});
```

Your application must obtain this registry from trusted project metadata. The
package does not discover or update it.

## `apply()`

```ts
type DriverConfig =
  | { kind: "postgres"; url: string }
  | { kind: "mysql"; url: string };

interface HostApplyOptions {
  migration: MigrationModule;
  ownerApp: string;
  projectSchema: string;
  driver: DriverConfig;
  registry?: Record<string, string>;
  policy: readonly string[];
  migratorRole?: string;
  approved?: boolean;
  appliedBy?: string;
  nameFallback?: string;
}

interface ApplyOutcome {
  applied: string[];
  skipped: string[];
  recovered: string[];
  pendingContracts: Array<{
    table: string;
    fromColumn: string;
    toColumn: string;
    pendingVersion: string;
  }>;
}

function apply(options: HostApplyOptions): Promise<ApplyOutcome>;
```

| Option | Required | Meaning |
| --- | --- | --- |
| `migration` | Yes | Imported synchronous migration module |
| `ownerApp` | Yes | Application ID stamped onto the migration identity |
| `projectSchema` | Yes | PostgreSQL schema or MySQL database |
| `driver` | Yes | Database kind and URL |
| `registry` | No | Table-owner map; default `{}` |
| `policy` | Yes | Ordered TOML documents; first is the trusted root/bound, later entries may only narrow |
| `migratorRole` | No | PostgreSQL role used for migration work; ignored by MySQL |
| `approved` | No | Approval for destructive work and backfills; default `false` |
| `appliedBy` | No | Audit actor; default `host` |
| `nameFallback` | No | Name used when the module declares none |

### PostgreSQL

```ts
const outcome = await apply({
  migration,
  ownerApp: "app_demo",
  projectSchema: "app_demo",
  driver: { kind: "postgres", url: process.env.DATABASE_URL! },
  registry: {},
  policy,
  migratorRole: "migrator_app_demo",
  approved: false,
  appliedBy: "deploy-service",
});
```

If `migratorRole` is supplied, the connecting credential must be allowed to
switch to that role. Without it, migration work runs with the connecting role.

### MySQL

```ts
const outcome = await apply({
  migration,
  ownerApp: "app_demo",
  projectSchema: "app_demo",
  driver: { kind: "mysql", url: process.env.MYSQL_URL! },
  registry: {},
  policy,
  approved: false,
  appliedBy: "deploy-service",
});
```

For MySQL, `projectSchema` is the project database. Access is controlled by the
connecting user's grants; `migratorRole` has no effect. The migration account
must be able to read MySQL Performance Schema transaction state. The
`transaction` instrument and `events_transactions_current` consumer must be
enabled so zero-migrate can verify that its dedicated session is idle. Apply and
status fail before migration work when that state cannot be verified.

### Before applying

The PostgreSQL schema or MySQL database must already exist. The connection needs
permission to create and use the journal namespace
`<projectSchema>_migrations`.

`approved: true` records a trusted operator decision; it is not an interactive
prompt. Review the change before setting it. Approval does not disable
validation or safety checks.

Apply checks completed step identities and checksums before asking for approval.
This means a repeat call can leave `approved` false and still skip an unchanged
completed delete or backfill. A partially completed backfill still needs
approval before it resumes. Approval is preflighted across the complete plan
before any authored step runs, so a later unapproved delete or backfill cannot
follow an already-committed earlier step from that plan.

Each call opens and closes its own database connection. The caller does not need
to close it manually.

`policy` is a required, non-empty ordered array of table-shape policy
documents. The first document is the trusted root charter and bound. Each later
document is an untrusted narrowing layer; only the root may declare mandatory
injects. There is no ambient default: callers that want author-owned columns
must explicitly pass a one-element no-inject array such as
`["policy_version = 1\n"]`. These are not migration-supplied settings or a
general custom executor policy, and they do not make privileged PostgreSQL
operations available through this API.

### Understanding the result

- `applied` contains stable step IDs written in this call;
- `skipped` contains stable step IDs already considered applied;
- `recovered` contains step IDs completed through
  non-transactional recovery; and
- `pendingContracts` contains every outstanding PostgreSQL online column rename
  after the call. Each `pendingVersion` is the stable key accepted by
  `resolvePending()` and the CLI `resolve` command.

One authored migration can contribute several IDs because each ordered DDL, DML,
or backfill step is journaled independently. Use plan-aware `status()` when you
need the aggregate state of the migration.

### Current apply behavior

- DDL, insert, update, delete, and backfill steps run on PostgreSQL and MySQL in
  authored order. Values are bound separately from statement structure.
- Pending delete and backfill steps require `approved: true`. A backfill also
  requires an exact ordered, non-null primary or unique candidate-key tuple with
  compatible comparison semantics and explicit cursor stability; the transform
  must not assign any component. Every MySQL
  insert, update, delete, and backfill target must use InnoDB and have no user
  triggers. A MySQL backfill cursor cannot be a generated column or be
  automatically updated. PostgreSQL backfills reject pre-existing enabled user
  triggers; the managed online rename workflow remains supported.
- Before the first batch, a backfill captures a fixed terminal cursor. It commits
  bounded batches, resumes after its saved cursor, and stops at that original
  boundary. The bounded cohort does not cover concurrent inserts by itself: make
  new rows fail the filter before capture or arrange a final catch-up while
  writes are stopped. Integer and decimal cursors remain exact across the
  JavaScript boundary. Final completion is recorded in the normal journal.
- Keep paging primary-key values unchanged until the backfill completes. The
  migration cannot assign its own cursor, and application writes must not move
  it either. A key moved behind the saved cursor can be missed; a processed key
  moved ahead of the cursor can be updated again.
- MySQL rejects an `update`, `backfill`, or `onConflict.doUpdate` when one
  assigned value reads another column assigned in the same operation. This
  avoids MySQL's sequential assignment behavior changing results that are
  simultaneous on PostgreSQL and SQLite. Self-references remain supported.
- One call can contain several changes that commit separately. If a later
  change fails, earlier changes from the same call can remain committed.
  Inspect the database and migration history before retrying.
- Apply reads the current target catalog before preparing work, so checks that
  depend on existing tables, columns, and indexes use the current database
  shape. This is not a complete structural-drift comparison or a database-backed
  dry run, and normal database errors can still occur during execution.
- No platform-specific system columns, indexes, or primary key are added
  automatically; declare the complete shape you need.
- Repeating an unchanged migration uses stable step identities and skips work
  already recorded with the same checksum. Renaming or editing an applied
  migration is not a way to rerun it; use a new uniquely named migration.
- SQLite schema and data apply and status are available through Node, the CLI,
  and Rust, via the bundled in-process backend (`applyIrSqlite`/`statusIrSqlite`)
  with cross-process coordination.
- There is no rollback, rendered-SQL preview, or full database-backed dry run.
- Driver configuration accepts only a URL; extra TLS, allowlist, or timeout
  objects are not part of the public type.

## PostgreSQL online column rename

On PostgreSQL, a column rename is an online, multi-deployment workflow. Author
the change with the normal column API:

```ts
import { table, t } from "zero-migrate";

export const name = "rename_users_display_name";

export function up() {
  table("users").column("display_name").rename({
    to: "full_name",
    type: t.text(),
  });
}
```

On PostgreSQL, the rename must be the only operation in this migration that
targets `users`. Other operations may target different tables. Move every other
schema or data operation on `users` into a later migration, and apply that
migration only after this rename is resolved.

The first `apply()` prepares and backfills the destination column. It requires
`approved: true` because it changes existing row data:

```ts
import { readFile } from "node:fs/promises";
import { apply, resolvePending } from "zero-migrate-cli";
import * as renameUsersDisplayName from "./migrations/20260716120000_rename_users_display_name.js";

const policy = [await readFile("./policy.toml", "utf8")];

const outcome = await apply({
  migration: renameUsersDisplayName,
  ownerApp: "app_demo",
  projectSchema: "app_demo",
  registry: { users: "app_demo" },
  driver: { kind: "postgres", url: process.env.DATABASE_URL! },
  policy,
  approved: true,
  appliedBy: "deploy:rename-start",
});

const pending = outcome.pendingContracts.find(
  (contract) => contract.table === "users",
);

if (!pending) {
  throw new Error("users rename did not produce a pending contract");
}
```

The initial apply succeeds only when all of these conditions hold:

- the source column exists in the live table;
- the destination column does not already exist;
- the declared `type` matches the source column's live PostgreSQL type;
- no other operation in this migration targets the same table;
- `id` is the table's complete, non-null, single-column primary key and has a
  supported orderable cursor type;
- the table has no pre-existing enabled user triggers, and row-level policy
  allows every selected backfill row to be updated;
- the same trusted owner, project schema, registry, and migration identity are
  used for planning, apply, and resolution; and
- the initial apply is explicitly approved so the bounded backfill can run.

Supported PostgreSQL `id` cursor families are small integers, integers, big
integers, numeric or decimal, text or character strings, dates, timestamps, and
UUIDs. Floating-point, JSON, binary, and geometric types are not supported
backfill cursors.

After that call, the source and destination columns coexist and remain suitable
for a staged application rollout. A write through either name keeps their values
aligned; if one statement supplies different values for both, the destination
value wins. Avoid writing both names in one statement. Deploy the application
version that reads and writes the destination column, wait until every
application instance and other database consumer has moved away from the source
column, and verify the rollout. The table remains blocked from other migration
changes until the rename is resolved.

The destination is nullable but otherwise keeps the source's exact live
PostgreSQL type, including modifiers such as numeric precision and scale or
character length. Resolution refuses modifier drift. Equivalent PostgreSQL
spellings such as `timestamptz` and `timestamp with time zone`, `decimal` and
`numeric`, or `varchar` and `character varying` compare as the same type without
discarding modifiers.

The rename does not transfer `NOT NULL`, defaults, unique or primary-key rules,
indexes, comments, or dependent objects. Review those semantics before rollout,
put the required changes in separate follow-up migrations, and apply them only
after resolution. Do not use this workflow to rename the `id` primary key.
Dependencies on the source can block resolution, so audit them before starting
the rollout.

That describes the destination **column**, not the **writes**. Until the rename
resolves, the dual-write trigger copies every write to the source, so the
source's constraints still reject writes made through the destination name. A
destination column that reads as nullable will still refuse a `NULL` if the
source is `NOT NULL`, and a destination with no unique index will still refuse a
duplicate if the source has one — and PostgreSQL names the **source** column in
the error, which the application has usually stopped referencing by then:

```text
null value in column "display_name" of relation "users" violates not-null constraint
duplicate key value violates unique constraint "users_display_name_key"
```

Plan the cutover accordingly: an application may read and write the new name
during coexistence, but it cannot write values the old column would have
rejected until the rename is resolved and the source is gone.

Complete the rename with `resolvePending()`:

```ts
interface ResolvePendingOptions {
  ownerApp: string;
  projectSchema: string;
  pendingVersion: string;
  action: "apply" | "abort";
  driver: { kind: "postgres"; url: string };
  approved: true;
  migratorRole?: string;
  policy: readonly string[];
  appliedBy?: string;
}

function resolvePending(
  options: ResolvePendingOptions,
): Promise<ApplyOutcome>;
```

```ts
await resolvePending({
  ownerApp: "app_demo",
  projectSchema: "app_demo",
  pendingVersion: pending.pendingVersion,
  action: "apply",
  driver: { kind: "postgres", url: process.env.DATABASE_URL! },
  approved: true,
  migratorRole: "migrator_app_demo",
  policy,
  appliedBy: "deploy:rename-finish",
});
```

`action: "apply"` keeps the destination column and drops the source column. Use
it only after the application cutover is complete. `action: "abort"` keeps the
source column and drops the destination column. Move the application back to
the source column before aborting. Both actions drop a column, so both require
`approved: true`.

The resolved `ApplyOutcome.pendingContracts` no longer contains that version.
Confirm with plan-aware `status()` before scheduling the next migration on the
table.

If the initial apply is interrupted, rerun the unchanged migration with the
same identity and approval. Completed work skips, and an interrupted backfill
resumes from its saved cursor. If the pending contract was already opened, the
repeat apply returns it again and does not resolve it automatically.

Resolution cleanup is all-or-nothing. If it fails, both columns and the managed
rename trigger remain intact, the pending contract stays outstanding, and the
table remains blocked. Correct the reported cause, then retry the same action
with the same `pendingVersion`.

After either resolution succeeds, the original rename is terminal. Replaying
the exact migration does not open a new pending contract. An applied resolution
stays applied, while an aborted resolution stays aborted. To attempt the rename
again after an abort, author a new migration with a new exported name. Calling
`resolvePending()` again for the settled version reports that it is not pending.

Use plan-aware `status()` during the coexistence window. Its
`pendingContracts` field is the durable source for obligations that must be
resolved, even if the original `apply()` output is unavailable.

## `status()`

```ts
interface HostStatusBaseOptions {
  ownerApp: string;
  projectSchema: string;
  driver: DriverConfig;
  registry?: Record<string, string>;
  policy: readonly string[];
}

interface HostReconciledStatusOptions extends HostStatusBaseOptions {
  migrations: readonly MigrationModule[];
  nameFallbacks?: readonly string[];
  nameFallback?: string;
}

interface HostJournalStatusOptions extends HostStatusBaseOptions {
  migrations?: undefined;
  nameFallbacks?: never;
  nameFallback?: never;
}

type HostStatusOptions =
  | HostReconciledStatusOptions
  | HostJournalStatusOptions;

interface PlanStatusStep {
  version: string;
  name: string;
  kind:
    | "ddl"
    | "dml"
    | "backfill"
    | "onlineExpand"
    | "onlineContract"
    | "sqliteRebuild";
  state: "pending" | "inflight" | "applied" | "aborted" | "drifted";
}

interface PlanStatus {
  version: string;
  name: string;
  state:
    | "applied"
    | "aborted"
    | "pending"
    | "partial"
    | "drifted"
    | "blocked"
    | "unknownDependency";
  steps: PlanStatusStep[];
  missingDependencies: string[];
}

interface PendingContractStatus {
  table: string;
  pendingVersion: string;
  orphaned: boolean;
}

interface BlockedPlan {
  blocked: string;
  dependency: string;
  pendingVersion: string;
}

interface UnexpectedJournalEntry {
  version: string;
  state: "applied" | "inflight";
  journalChecksum: string;
  journalKind?: "apply" | "baseline" | "squash" | "repeatable";
}

interface RollbackTargetDto {
  /** `"toVersion"` unwinds everything applied AFTER the named version, keeping it;
   *  `"steps"` unwinds the n most recently applied; `"all"` unwinds everything.
   *  Required: every default would be a guess about how much schema to tear down. */
  kind: "toVersion" | "steps" | "all";
  /** The version to stop at. Only for `"toVersion"`. */
  version?: string;
  /** How many migrations to unwind. Only for `"steps"`. */
  steps?: number;
}

interface RollbackOutcome {
  /** Versions whose `down` ran and were journaled `rolled_back`, in the order they
   *  were unwound: reverse topological order of `depends_on`. */
  rolledBack: string[];
  /** Versions crossed WITHOUT running a `down`, because they declare none and the
   *  request carried both `force` and `backupAcknowledged`. Empty otherwise. */
  skippedIrreversible: string[];
}

function rollback(options: HostRollbackOptions): Promise<RollbackOutcome>;

interface StatusReply {
  currentVersion?: string;
  applied: string[];
  pending: string[];
  aborted: string[];
  rolledBack: string[];
  pendingContracts: PendingContractStatus[];
  blocked: BlockedPlan[];
  unexpectedJournal: UnexpectedJournalEntry[];
  plans?: PlanStatus[];
}

function status(options: HostStatusOptions): Promise<StatusReply>;
```

### Rolling back

`rollback()` takes the same migrations, owner, registry and policy charter as
`apply()`, plus a `target` saying how far to unwind. `approved` is required: a
`down` is destructive by construction, so the engine refuses without it.

A migration that declares no `down` is IRREVERSIBLE and rollback refuses it by
default rather than inventing a reverse — re-adding a dropped column would look
like a restore while its values stayed gone. Passing `force` together with
`backupAcknowledged` does not fabricate one either: it CROSSES that migration,
leaves its effect in place, and names it in `skippedIrreversible`. Read that field;
an empty `rolledBack` with a populated `skippedIrreversible` means nothing was
undone.

The reply deliberately carries no `applied` list. A host reading `applied` off a
rollback reply would see an empty array and conclude nothing happened, which is the
opposite of what a successful unwind means.

See [Operating migrations](operations.md) for the recovery playbook these options
belong to.

```ts
import { readFile } from "node:fs/promises";
import * as createUsers from "./migrations/20260715153045_create_users.js";
import * as backfillUsers from "./migrations/20260715154500_backfill_users.js";

const policy = [await readFile("./policy.toml", "utf8")];

const state = await status({
  ownerApp: "app_demo",
  projectSchema: "app_demo",
  driver: { kind: "postgres", url: process.env.DATABASE_URL! },
  registry: { users: "app_demo" },
  policy,
  migrations: [createUsers, backfillUsers],
  nameFallbacks: ["20260715153045_create_users", "20260715154500_backfill_users"],
});

for (const plan of state.plans ?? []) {
  console.log(plan.name, plan.state, plan.steps);
}
```

Pass the ordered `migrations` set and the same required `policy` stack
used by apply for plan-aware status on PostgreSQL or MySQL.
The modules follow the same planning rules as apply, so `plans[].steps` includes
every DDL, insert/update/delete, backfill, and online step. Top-level `applied`,
`pending`, and `aborted` contain logical migration-plan IDs; the nested entries
contain the actual journaled step IDs. A mixed migration is fully applied only
when all of its required steps are applied with the expected checksum.

The complete reply has these additional diagnostics:

- `pendingContracts` lists outstanding PostgreSQL online renames.
  `orphaned: true` means the supplied migration set no longer contains the
  migration that opened the obligation. Restore that immutable migration source
  for diagnosis, then resolve the returned `pendingVersion` explicitly.
- `blocked` identifies a plan that cannot proceed because a dependency still has
  the named pending rename. It is retained work, not a failed apply.
- `aborted` lists terminal logical plan IDs whose online rename was explicitly
  aborted. These IDs are not included in `applied` or `pending`.
- `unexpectedJournal` lists completed or inflight step identities that do not
  appear in any supplied plan. This usually means the supplied set is incomplete
  or an applied migration's identity changed. Investigate before applying.
- `plans` is present, including as an empty array, when `migrations` is supplied.
  It is absent from the journal-only form.

`currentVersion` is the last fully applied supplied plan in dependency and input
order for plan-aware status.
`applied` contains fully applied supplied plan IDs. `aborted` contains terminal
aborted plan IDs. `pending` contains supplied plan IDs that are in neither of
those terminal lists, including partial, drifted, blocked, and unknown-dependency
plans. `rolledBack` contains versions whose latest event is a rollback. An
expanded but unresolved online rename normally appears as a `partial` plan: its
`onlineExpand` steps are applied and its `onlineContract` steps remain pending.
After abort, the plan state is `aborted`, its completed expansion steps stay
`applied`, and its deferred `onlineContract` steps become `aborted`. `orphaned`
is meaningful relative to the supplied `migrations` set; use plan-aware status
for that diagnosis.

Plan states are exactly `applied`, `aborted`, `pending`, `partial`, `drifted`,
`blocked`, and `unknownDependency`. Step kinds are exactly `ddl`, `dml`,
`backfill`, `onlineExpand`, `onlineContract`, and `sqliteRebuild`. Step states
are exactly `pending`, `inflight`, `applied`, `aborted`, and `drifted`. An
unexpected journal entry has state `applied` or `inflight`; a completed entry
can report journal kind `apply`, `baseline`, `squash`, or `repeatable`.

An aborted plan does not satisfy `dependsOn`. A supplied dependent plan remains
`blocked`, and apply refuses to run it. To continue after an abort, author a new
replacement migration and update the dependency to that new migration identity.

`dependsOn` is an IR-level field, and **a JavaScript migration module cannot set
it**. A module exports `up`, `down`, and `name` only; a `dependsOn` property on
the module, on its `default` export, or spelled `depends_on` is ignored, and the
envelope the host builds carries no dependency list. The field is reachable from
Rust embedders through `IrAuthor` and from hand-authored IR envelopes.

For JavaScript-authored migrations this means the paragraph above describes a
state you cannot reach: with no dependency to declare, no plan is ever `blocked`
on an aborted one. After an abort, author a new replacement migration — there is
no dependency to repoint. The `blocked` and `unknownDependency` plan states, and
the ordering guarantees `dependsOn` provides, apply to IR-level authoring.

When a backfill has saved at least one progress checkpoint but has no final
journal completion event, its step state is `inflight` and the containing plan
is `partial`. A progress checksum that no longer matches the supplied migration
is `drifted`.

If `nameFallbacks` is present, it must have the same length as `migrations`.
Supply the same `ownerApp`, registry, names, and policy charter stack used for
apply so status derives the same identities and plan shape.

When `migrations` is omitted, status preserves the older journal-only view. It
does not lower a table shape, but still requires the executor's explicit
`policy` stack. It cannot calculate pending plans or complete mixed-plan
state, so prefer the supplied-set form for deployment decisions.

On a fresh database, the call may create the journal namespace. With supplied
migrations it reports those plans as pending; the journal-only form can return
an empty state. It is not a strictly read-only database probe.

## `history()`

`history()` takes journal-only `HostHistoryOptions` and is currently
PostgreSQL-only:

```ts
interface HostHistoryOptions {
  ownerApp: string;
  projectSchema: string;
  driver: DriverConfig;
  policy: readonly string[];
}
```

```ts
interface HistoryEvent {
  eventSeq: bigint;
  version: string;
  name: string;
  kind: string; // "applied" or "rolled_back"
  at: string;
  appliedBy: string;
  checksum: string;
}

interface HistoryReply {
  events: HistoryEvent[];
}

function history(options: HostHistoryOptions): Promise<HistoryReply>;
```

```ts
const audit = await history({
  ownerApp: "app_demo",
  projectSchema: "app_demo",
  driver: { kind: "postgres", url: process.env.DATABASE_URL! },
  policy,
});

for (const event of audit.events) {
  console.log(event.eventSeq, event.kind, event.name, event.appliedBy);
}
```

Events are ordered by the journal sequence. `eventSeq` is a JavaScript `bigint`
so large values remain exact.

Plain `JSON.stringify(audit)` throws because JSON has no bigint type. Convert it
to a decimal string:

```ts
const json = JSON.stringify(
  audit,
  (_key, value) => typeof value === "bigint" ? value.toString() : value,
  2,
);
```

Like status, history can create a missing journal namespace before reading it.
`ownerApp`, `registry`, and `nameFallback` do not currently change its result.

## SQLite validation

Node can run the offline check for SQLite before applying SQLite
migrations:

```ts
const report = plan({
  migration,
  ownerApp: "app_demo",
  projectSchema: "public",
  dialect: "sqlite",
  registry: {},
});

if (!report.ok) {
  throw new Error(report.error ?? "SQLite validation failed");
}
```

This checks authored structure only; it does not open or inspect a SQLite file.

## Errors and connection lifecycle

| Function | Validation/configuration failure | Operational failure |
| --- | --- | --- |
| `currentIrVersion()` | throws | n/a |
| `validate()` | returns `ok: false` for an invalid migration | throws for module/runtime errors |
| `plan()` | returns `ok: false` for an invalid migration | throws for module/runtime errors |
| `apply()` | rejects | rejects with validation, approval, driver, or database error |
| `resolvePending()` | rejects | rejects with approval, identity, driver, or database error |
| `status()` | rejects | rejects with driver or journal error |
| `history()` | rejects | rejects with driver or journal error |

`apply()`, `resolvePending()`, `status()`, and `history()` close their connection
whether the main operation succeeds or fails. A close failure can itself reject
the call. Log the complete error and inspect journal/schema state before deciding
whether to retry.

## Practical limitations

- PostgreSQL and MySQL apply execute DDL and all structured data steps; SQLite
  apply is not exposed by Node.
- Plan-aware status supports PostgreSQL and MySQL when `migrations` is supplied;
  history remains PostgreSQL-only.
- Online column rename and `resolvePending()` are PostgreSQL-only. The rename
  must be its table's only operation in that migration; operations on other
  tables are allowed. Later changes to the renamed table remain blocked until
  resolution.
- Plan and validate are offline structural, confinement, and ownership checks,
  not live plans.
- Journal-only status cannot calculate pending migrations; supply the ordered
  migration modules for the complete view.
- Follow-up table changes require a trusted ownership registry.
- Migration names must remain unique and stable; content edits after apply are
  checksum drift.
- `down`, flags, dependencies, supersession, and preconditions are not carried.
- Rollback, rendered SQL, and a full database-backed dry run are not exposed.
- Database driver configuration is URL-only.
- Node `apply()` accepts executable migration modules only. A platform that
  accepts untrusted source therefore needs a separate sandbox and a reviewed
  Rust/custom-host integration.

## Troubleshooting

| Symptom | Action |
| --- | --- |
| Required runtime cannot load | Repeat Getting started for this OS/architecture and set the documented absolute `ZERO_MIGRATE_ADDON_PATH` before the first call |
| `Cannot find package 'pg'` or `'mysql2'` | Run the repository's `pnpm install --frozen-lockfile` setup again |
| `Unknown file extension ".ts"` | Run Node with `--import=tsx`, or import compiled JavaScript |
| Migration exports no `up()` | Export a synchronous named `up` or `default.up` |
| `<unregistered>` ownership error | Pass the authoritative `{ table: ownerApp }` registry |
| Plan succeeds but apply rejects | Plan is offline and does not run every apply-time check |
| PostgreSQL rename conflicts with another operation | Keep the rename as that table's only operation; move same-table schema and data work to a later migration applied after resolution |
| A delete or backfill is refused | Review the exact migration, then set `approved: true` in trusted operator code |
| A backfill cursor is rejected | Use an exact ordered, non-null primary or unique candidate-key tuple with compatible comparison semantics and choose `guardUpdates` or an approved named `externalInvariant` |
| A MySQL data step is refused | Use an InnoDB target without user triggers |
| Destructive work is refused | Review the change, then set `approved: true` in trusted operator code |
| MySQL status lacks pending/step detail | Pass the ordered `migrations` set and matching registry to `status()`; MySQL `history()` is not public |
| `Do not know how to serialize a BigInt` | Use the JSON replacer shown above |
| Repeat apply reports checksum drift | Restore the immutable applied source and create a new uniquely named migration for the new change |
| A table is blocked by a pending rename | Finish the application cutover and call `resolvePending()` with `action: "apply"`, or move back to the source column and use `action: "abort"`; both require approval |

See [Troubleshooting](troubleshooting.md) for longer diagnostic flows.

## Next

- [Getting started](getting-started.md)
- [Writing migrations](writing-migrations.md)
- [CLI reference](cli.md)
- [Operating migrations](operations.md)
- [Dialect support](dialects.md)
