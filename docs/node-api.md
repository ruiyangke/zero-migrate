# Node API

`zero-migrate-engine` is the JavaScript/TypeScript API for validating migration
modules, applying PostgreSQL or MySQL schema changes, and reading PostgreSQL
journal state.

[Documentation home](README.md) · [Getting started](getting-started.md) ·
[CLI reference](cli.md) · [Writing migrations](writing-migrations.md) ·
[Troubleshooting](troubleshooting.md)

> **DDL-only apply:** the current public `apply()` function executes schema/DDL
> migrations only. Inserts, updates, deletes, and backfills may validate and may
> appear in `plan().envelope`, but they are not executed. In a mixed migration,
> the DDL can run while the data step is omitted; a data-only migration can
> resolve successfully with no data change. Do not use this API for data
> migrations or backfills in this release.

> **Trusted modules only:** the public API imports and executes migration
> JavaScript or TypeScript in the host process with no sandbox. Top-level module
> code and `up()` have the same environment, filesystem, network, and process
> authority as the calling application. Untrusted or generated source must be
> evaluated in an external sandbox with no secrets or ambient authority. Use a
> reviewed Rust/custom-host workflow to move the approved result into deployment.

## Run from this checkout

`zero-migrate` and `zero-migrate-engine` are not published to npm yet. The only
working installation path for this release is the repository checkout. Follow
[Getting started](getting-started.md#1-prepare-the-checkout) to install
workspace dependencies, build the JavaScript packages, and configure the
pre-release runtime.

Run TypeScript integration scripts with the `tsx` setup from that guide, or
compile them to JavaScript first. The current project is tested with Node.js 22,
PostgreSQL 16, and MySQL 8. Offline `plan()` and `validate()` do not open a
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
      email: t.text().notNull(),
    },
  });
}
```

Validate it and apply it:

```ts
import { apply, plan } from "zero-migrate-engine";
import * as migration from "./migrations/20260715153045_create_users.js";

const check = plan({
  migration,
  ownerApp: "app_demo",
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
  status,
  validate,
} from "zero-migrate-engine";

import type {
  ApplyOutcome,
  DriverConfig,
  HostApplyOptions,
  HostPlanOptions,
  HostStatusOptions,
  IrEnvelope,
  MigrationModule,
  PlanReport,
} from "zero-migrate-engine";
```

| Function | PostgreSQL | MySQL | SQLite | Opens a database? |
| --- | --- | --- | --- | --- |
| `currentIrVersion()` | Yes | Yes | Yes | No |
| `validate()` | Yes | Yes | Yes | No |
| `plan()` | Yes | Yes | Yes | No |
| `apply()` | DDL | DDL (MySQL 8) | No | Yes |
| `status()` | Yes | No | No | Yes |
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
`plan()` currently invokes `up()` twice, so side effects would also run twice.

The migration name is chosen from named `name`, `default.name`,
`nameFallback`, or `migration`, in that order.

`down()` is present in the type but is not used by the public Node workflow.
There is no public rollback function. Module flags, dependencies, supersession,
and preconditions are also not accepted by this migration-module format.

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
  dialect?: "postgres" | "mysql" | "sqlite";
  registry?: Record<string, string>;
  nameFallback?: string;
}
```

`dialect` defaults to `postgres`; `registry` defaults to `{}`.

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
  dialect: "postgres",
  registry: {},
});

console.log(report.ok, report.op_count, report.envelope.ops);
```

Note the naming difference: `validate()` returns `irVersion` and `opCount`, while
`PlanReport` uses `ir_version` and `op_count`.

These functions check migration structure, dialect-specific operation forms,
and table ownership. They do not inspect a live database, account for
`projectSchema`, show rendered SQL, or guarantee that apply will succeed. They
also do not report that inserts, updates, deletes, and backfills will be omitted
by public `apply()`.

`plan()` invokes `up()` twice: once for its verdict and once for the returned
preview. This is another reason migration authoring must be deterministic.

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
  migratorRole?: string;
  approved?: boolean;
  appliedBy?: string;
  nameFallback?: string;
}

interface ApplyOutcome {
  applied: string[];
  skipped: string[];
  recovered: string[];
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
| `migratorRole` | No | PostgreSQL role used for migration DDL; ignored by MySQL |
| `approved` | No | Approval for destructive work; default `false` |
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
  migratorRole: "migrator_app_demo",
  approved: false,
  appliedBy: "deploy-service",
});
```

If `migratorRole` is supplied, the connecting credential must be allowed to
switch to that role. Without it, migration DDL runs with the connecting role.

### MySQL

```ts
const outcome = await apply({
  migration,
  ownerApp: "app_demo",
  projectSchema: "app_demo",
  driver: { kind: "mysql", url: process.env.MYSQL_URL! },
  registry: {},
  approved: false,
  appliedBy: "deploy-service",
});
```

For MySQL, `projectSchema` is the project database. Access is controlled by the
connecting user's grants; `migratorRole` has no effect.

### Before applying

The PostgreSQL schema or MySQL database must already exist. The connection needs
permission to create and use the journal namespace
`<projectSchema>_migrations`.

`approved: true` records a trusted operator decision; it is not an interactive
prompt. Review the change before setting it. Approval does not disable
validation or safety checks.

Each call opens and closes its own database connection. The caller does not need
to close it manually.

### Understanding the result

- `applied` contains migration version IDs written in this call;
- `skipped` contains migration version IDs already considered applied; and
- `recovered` contains migration version IDs completed through
  non-transactional recovery.

An empty result does not prove that authored data operations ran. In the current
public path, they did not.

### Current apply behavior

- Only DDL/schema steps run. Insert, update, delete, and backfill steps are
  omitted on both PostgreSQL and MySQL.
- One call can contain several schema changes that commit separately. If a
  later change fails, earlier changes from the same call can remain committed.
  Inspect the database and migration history before retrying.
- Existing target schema state is not inspected before work is generated. Treat
  this as a create-first workflow.
- No platform-specific system columns, indexes, or primary key are added
  automatically; declare the complete shape you need.
- Repeating the same authored DDL is not yet a reliable idempotent-skip workflow.
  A later call can generate new migration version IDs and attempt the DDL again.
- SQLite apply is not exposed.
- There is no rollback, rendered-SQL preview, or full database-backed dry run.
- Driver configuration accepts only a URL; extra TLS, allowlist, or timeout
  objects are not part of the public type.

## `status()`

```ts
interface HostStatusOptions {
  ownerApp: string;
  projectSchema: string;
  driver: DriverConfig;
  registry?: Record<string, string>;
  nameFallback?: string;
}

interface StatusReply {
  currentVersion?: string;
  applied: string[];
  pending: string[];
  rolledBack: string[];
}

function status(options: HostStatusOptions): Promise<StatusReply>;
```

```ts
const state = await status({
  ownerApp: "app_demo",
  projectSchema: "app_demo",
  driver: { kind: "postgres", url: process.env.DATABASE_URL! },
});

console.log(state.currentVersion, state.applied, state.rolledBack);
```

Status is currently supported only for PostgreSQL. It reads net-applied and
rolled-back journal state, but it does not accept a migration set for comparison.
`pending` is therefore always empty.

`ownerApp` is required by the public options type but does not currently filter
the journal. `registry` and `nameFallback` also have no effect on status.

On a fresh project, the call may create the journal namespace before returning
an empty state. It is not a strictly read-only database probe.

## `history()`

`history()` takes the same `HostStatusOptions` and is currently PostgreSQL-only:

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

function history(options: HostStatusOptions): Promise<HistoryReply>;
```

```ts
const audit = await history({
  ownerApp: "app_demo",
  projectSchema: "app_demo",
  driver: { kind: "postgres", url: process.env.DATABASE_URL! },
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

Node can run the offline check for SQLite even though it cannot apply SQLite
migrations:

```ts
const report = plan({
  migration,
  ownerApp: "app_demo",
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
| `status()` | rejects | rejects with driver or journal error |
| `history()` | rejects | rejects with driver or journal error |

`apply()`, `status()`, and `history()` close their connection whether the main
operation succeeds or fails. A close failure can itself reject the call. Log the
complete error and inspect journal/schema state before deciding whether to retry.

## Practical limitations

- Public apply is DDL-only; data operations and backfills are not executed.
- PostgreSQL and MySQL DDL apply are available; SQLite apply is not.
- Status and history are PostgreSQL-only.
- Plan and validate are offline structural/ownership checks, not live plans.
- Plan invokes `up()` twice.
- Status cannot calculate pending migrations.
- Follow-up table changes require a trusted ownership registry.
- Apply is create-first and does not inspect existing target state first.
- Repeated DDL apply is not yet an idempotency guarantee.
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
| Apply succeeds but data is unchanged | Public apply omits insert/update/delete/backfill operations; move data separately and verify it |
| Destructive work is refused | Review the change, then set `approved: true` in trusted operator code |
| MySQL status/history fails | Use `status()` and `history()` only with PostgreSQL |
| `Do not know how to serialize a BigInt` | Use the JSON replacer shown above |
| Repeated DDL does not skip | Do not rely on repeat apply for idempotency in this release |

See [Troubleshooting](troubleshooting.md) for longer diagnostic flows.

## Next

- [Getting started](getting-started.md)
- [Writing migrations](writing-migrations.md)
- [CLI reference](cli.md)
- [Operating migrations](operations.md)
- [Dialect support](dialects.md)
