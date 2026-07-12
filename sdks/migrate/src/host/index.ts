// `zero-migrate/host` — the creator-facing HOST facade (design §D.3).
//
// A thin async layer over the prebuilt N-API addon (`crates/zero-migrate-node`,
// Phase C). The creator never sees N-API, `driver::Row`, or the `hostDriver` callback:
//
//   import { apply, plan, status, history } from "zero-migrate/host";
//   await apply({ migration, ownerApp, projectSchema, driver: { kind:"postgres", url } });
//
// The flow for `apply` (§D.1/§D.3):
//   1. the pure-JS HOST RECORDER (`host-recorder.ts`) drains the migration's `up()`
//      into a `{ ir_version, name, ops }` ENVELOPE — `ir_version` sourced from the
//      addon's `irVersion()` (single source of truth); NO `owner_app`, NO checksum;
//   2. the addon's `applyIr` LOWERS the envelope in Rust (stamps `owner_app`, folds
//      the authoritative `Checksum::of_ir`), then drives `executor::apply` over the
//      chosen host driver (`driver-pg.ts`).
//
// NO `dryRun` verb in v1: the host-side shadow harness (§F) is deferred; on the
// `host-pg` addon build `backend.shadow()` is `None`, so a shadow dry-run would
// return `DryRunError::ShadowUnsupported`. `plan` (the DB-free pre-check) IS
// provided.

import {
  loadAddon,
  currentIrVersion,
  type MigrateAddon,
  type AddonHostDriver,
  type ApplyReply,
  type StatusReply,
  type HistoryReply,
} from "./addon.js";
import { openPgSession, type HostDriver } from "./driver-pg.js";
import { openMysqlSession } from "./driver-mysql2.js";
import { buildEnvelope, type IrEnvelope, type MigrationModule } from "../host-recorder.js";

export { currentIrVersion } from "./addon.js";
export type { IrEnvelope, MigrationModule } from "../host-recorder.js";

/** A driver target the facade opens a pinned host session against.
 *
 *  Both NETWORK dialects ride the SAME `SqlSession` seam: `postgres` (`pg`) and
 *  `mysql` (`mysql2`). Each dialect's lock / journal / placeholder SQL lives in
 *  its own `MigrationBackend` (`PostgresBackend` — `pg_advisory_lock`, `SET ROLE`;
 *  `MysqlBackend` — `GET_LOCK`, `?` placeholders), and the addon selects the
 *  backend from the `dialect` string. SQLite is NOT a host driver — it runs
 *  in-process via rusqlite and never crosses the seam. */
export type DriverConfig =
  | { kind: "postgres"; url: string }
  | { kind: "mysql"; url: string };

/** The dialect string the addon lower + load-verify + backend-select expect. */
function dialectOf(driver: DriverConfig): "postgres" | "mysql" {
  return driver.kind;
}

/** Open the pinned host session for a driver and return its `hostDriver` callback +
 *  a `close()`. PG uses `driver-pg.ts` (connection-scoped exact-integer parsers);
 *  MySQL uses `driver-mysql2.ts` (real `mysql2/promise` over node:net, BIGINT/DECIMAL
 *  as exact strings). */
async function openSession(
  driver: DriverConfig,
): Promise<{ hostDriver: HostDriver; close: () => Promise<void> }> {
  if (driver.kind === "postgres") {
    const s = await openPgSession(driver.url);
    return { hostDriver: s.hostDriver, close: s.close };
  }
  if (driver.kind === "mysql") {
    const s = await openMysqlSession(driver.url);
    return { hostDriver: s.hostDriver as HostDriver, close: s.close };
  }
  throw new Error(`zero-migrate/host: unsupported driver ${JSON.stringify((driver as { kind: string }).kind)}`);
}

/** Common inputs to the host verbs. */
export interface HostApplyOptions {
  /** The migration module (an imported `.ts`/`.js` exporting `up()` or
   *  `default.up`). Resolved to an envelope by the host recorder. */
  migration: MigrationModule;
  /** The deploying app id (`app_…`) — stamped as `owner_app` + folded into the
   *  checksum by the addon (§D.1). */
  ownerApp: string;
  /** The confined project schema the lower pins ops to (§2.7). */
  projectSchema: string;
  /** The target DB driver. */
  driver: DriverConfig;
  /** The project's `{ table: owner_app }` registry (ownership check, §8.6).
   *  Defaults to `{}` (a fresh single-app project). */
  registry?: Record<string, string>;
  /** The migrator role to `SET ROLE` under (least-privilege apply). Optional. */
  migratorRole?: string;
  /** Whether destructive changes are pre-approved. Default `false`. */
  approved?: boolean;
  /** The audit `applied_by` label recorded in the journal. Default `"host"`. */
  appliedBy?: string;
  /** Override the migration's declared name (else recorder-resolved). */
  nameFallback?: string;
}

/** The typed `applyIr` reply (§D.1) — re-exported from the generated addon DTOs. */
export type ApplyOutcome = ApplyReply;

/**
 * Author the envelope (pure JS) then drive the addon's host-authoring `applyIr`
 * over the chosen driver — the full §D.1/§D.3 apply. Resolves to the typed
 * `ApplyReply`. The pinned session is always closed (success or throw).
 */
export async function apply(opts: HostApplyOptions): Promise<ApplyOutcome> {
  const addon = loadAddon();
  const envelope = authorEnvelope(addon, opts.migration, opts.nameFallback);
  const { hostDriver, close } = await openSession(opts.driver);
  try {
    // The verb boundary is TYPED (redesign step 5a): pass an `ApplyRequest`, get an
    // `ApplyReply` — no JSON stringify/parse. The `envelope` crosses as a JS value.
    return await addon.applyIr(hostDriver as AddonHostDriver, {
      ownerApp: opts.ownerApp,
      projectSchema: opts.projectSchema,
      migratorRole: opts.migratorRole,
      dialect: dialectOf(opts.driver),
      registry: opts.registry ?? {},
      envelope,
      approved: opts.approved ?? false,
      appliedBy: opts.appliedBy ?? "host",
    });
  } finally {
    await close();
  }
}

/** Options for {@link plan} — the DB-free pre-check (no driver needed). */
export interface HostPlanOptions {
  migration: MigrationModule;
  ownerApp: string;
  dialect?: "postgres" | "mysql" | "sqlite";
  registry?: Record<string, string>;
  nameFallback?: string;
}

/** A DB-free plan pre-check verdict (the load-verify report, §C.5). */
export interface PlanReport {
  ok: boolean;
  ir_version?: number;
  op_count?: number;
  error?: string;
  /** The authored envelope (ops), for inspection. */
  envelope: IrEnvelope;
}

/**
 * The DB-free pre-check (§D.3): author the envelope (pure JS), then run the addon's
 * sync `loadVerify` (fail-closed structural + confinement + ownership validation,
 * no DB). Returns the verdict + the authored ops. This is the fast pre-apply gate;
 * `dryRun` (the full shadow verification) is deferred (§F).
 */
export function plan(opts: HostPlanOptions): PlanReport {
  const addon = loadAddon();
  const envelope = authorEnvelope(addon, opts.migration, opts.nameFallback);
  // Typed boundary (redesign step 5a): `loadVerify` takes the `.ir.json` bytes + a
  // typed `Record<string,string>` registry and returns a typed `LoadVerifyReply`.
  const report = addon.loadVerify(
    JSON.stringify(envelope),
    opts.ownerApp,
    opts.dialect ?? "postgres",
    opts.registry ?? {},
  );
  return {
    ok: report.ok,
    ir_version: report.irVersion,
    op_count: report.opCount,
    error: report.error,
    envelope,
  };
}

/** Options for {@link status}/{@link history}. */
export interface HostStatusOptions {
  /** The migrations to reconcile against the journal. Each is an authored
   *  envelope's module; the facade lowers via the addon. For the create-first
   *  posture, pass the same modules `apply` used. */
  migrations?: MigrationModule[];
  ownerApp: string;
  projectSchema: string;
  driver: DriverConfig;
  registry?: Record<string, string>;
  nameFallback?: string;
}

/**
 * `status` (§C.5) — reconcile the supplied migrations against the live journal over
 * the host driver. Returns the typed `StatusReply` (redesign step 5a — no JSON
 * parse; `currentVersion` camelCase).
 *
 * NOTE: the addon `status` entry takes pre-lowered migrations (a typed
 * `Vec<Migration>`); lowering an arbitrary module needs the addon's lower. For v1
 * the facade supports the empty-journal / no-migrations status query (the "pending"
 * flow) by passing `[]`; lowering N modules for a populated status query reuses
 * `applyIr`'s lower and is a small follow-up. The oracle drives `status` with `[]`
 * (empty journal) to prove the read path.
 */
export async function status(opts: HostStatusOptions): Promise<StatusReply> {
  const addon = loadAddon();
  const { hostDriver, close } = await openSession(opts.driver);
  try {
    return await addon.status(hostDriver as AddonHostDriver, {
      projectId: opts.projectSchema,
      projectSchema: opts.projectSchema,
      migrations: [], // v1: the read path / empty-journal flow (see doc).
    });
  } finally {
    await close();
  }
}

/** `history` (§C.5) — the journal audit trail over the host driver. Returns the
 *  typed `HistoryReply` (redesign step 5a — no JSON parse; `eventSeq` is a `bigint`). */
export async function history(
  opts: Omit<HostStatusOptions, "migrations">,
): Promise<HistoryReply> {
  const addon = loadAddon();
  const { hostDriver, close } = await openSession(opts.driver);
  try {
    return await addon.history(hostDriver as AddonHostDriver, {
      projectId: opts.projectSchema,
      projectSchema: opts.projectSchema,
    });
  } finally {
    await close();
  }
}

/**
 * `generate` (§D.3) — the schema-diff → IR autogenerate step. This is a sync,
 * DB-free differ that compares a desired `t.*` schema snapshot to a live snapshot;
 * it is NOT yet wired through the host addon (the addon exposes no `generate`
 * entry in Phase C). Deferred — throws an explicit error rather than a fake result.
 */
export function generate(): never {
  throw new Error(
    "zero-migrate/host: `generate` (schema-diff autogenerate) is not wired in v1 " +
      "— the Phase-C addon exposes no generate entry. Author migrations with the DSL and " +
      "use `apply`/`plan`.",
  );
}

/** Author the `{ ir_version, name, ops }` envelope from a migration module, sourcing
 *  `ir_version` from the addon (single source of truth, §D.1). */
function authorEnvelope(
  addon: MigrateAddon,
  migration: MigrationModule,
  nameFallback?: string,
): IrEnvelope {
  return buildEnvelope(migration, { irVersion: addon.irVersion(), nameFallback });
}
