// `zero-migrate` — the command-line surface for the host runtime (redesign step 5c).
//
// The Rust `[[bin]] zero-migrate` (a `#[compio::main]` clap tool) was retired in
// redesign step 5c; this TS CLI is its replacement. It is a THIN arg-parser over the
// host verbs this package already exports (`apply`/`plan`/`status`/`validate`) plus
// pure-JS `new` scaffolding — the engine facade does the real work over the native
// addon and the `pg`/`mysql2` driver seam. NO Rust bin, NO compio, NO clap.
//
// Commands (design §D.3):
//   new <name>          Scaffold a fresh `<14-digit-ts>_<name>.ts` op-DSL migration
//                       (imports `{ table, t } from "zero-migrate"`). OFFLINE.
//   plan   [dir]        DB-free load + structural/confinement/ownership VERIFY of every
//                       migration in `dir` (the fast pre-apply gate). OFFLINE.
//   preview [dir]       DB-free: print the authored `{ ir_version, name, ops }`
//                       envelope for each migration (the op-IR the addon would lower).
//                       OFFLINE.
//   apply  [dir]        Apply every migration in `dir` over the `--database-url`
//                       driver (`pg`/`mysql2` seam) in filename order.
//   status [dir]        Reconcile against the live journal over the `--database-url`
//                       driver.
//
// Migration discovery: `*.{ts,mts,cts,js,mjs,cjs}` under `dir` (default `./migrations`),
// excluding `.d.ts`, sorted by filename (the migration order contract). Each is
// dynamically `import()`ed; the module must export `up()` (or `default.up`). Plain
// Node cannot import `.ts` — run the CLI under a `.ts` loader (e.g. `tsx`/`bun`) or
// point it at pre-built `.js`/`.mjs`.

import { readdir, mkdir, writeFile, access } from "node:fs/promises";
import { join, resolve, isAbsolute } from "node:path";
import { pathToFileURL } from "node:url";
import { apply, plan, status, currentIrVersion, type DriverConfig } from "./index.js";
import {
  buildEnvelope,
  deriveNameFromPath,
  type MigrationModule,
} from "zero-migrate/internal/recorder";

/** The default migration directory (dbmate/Flyway convention). */
const DEFAULT_DIR = "./migrations";
/** The default confined project schema the lower pins ops to (§2.7). */
const DEFAULT_SCHEMA = "public";
/** The default deploying app id when none is given. */
const DEFAULT_OWNER_APP = "app_cli";

/** A migration source file + its dynamic-import URL. */
interface MigrationFile {
  path: string;
  /** Filename-derived label (the recorder's `nameFallback`). */
  label: string;
}

/** The parsed CLI invocation. */
interface Args {
  command: string;
  /** The positional after the command (a `dir` for most verbs, a `name` for `new`). */
  positional?: string;
  dir: string;
  databaseUrl?: string;
  ownerApp: string;
  projectSchema: string;
  /** `--json` — machine-readable output where a verb supports it. */
  json: boolean;
}

/** Parse `--flag value` / `--flag=value` / positionals. Unknown flags error. */
function parseArgs(argv: string[]): Args {
  const args: Args = {
    command: "",
    dir: DEFAULT_DIR,
    ownerApp: process.env.ZERO_MIGRATE_OWNER_APP ?? DEFAULT_OWNER_APP,
    projectSchema: process.env.ZERO_MIGRATE_SCHEMA ?? DEFAULT_SCHEMA,
    json: false,
  };
  const positionals: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const tok = argv[i];
    if (!tok.startsWith("--")) {
      positionals.push(tok);
      continue;
    }
    const eq = tok.indexOf("=");
    const key = eq === -1 ? tok.slice(2) : tok.slice(2, eq);
    const inlineVal = eq === -1 ? undefined : tok.slice(eq + 1);
    const takeVal = (): string => {
      if (inlineVal !== undefined) return inlineVal;
      const next = argv[++i];
      if (next === undefined) throw new CliError(`flag --${key} needs a value`);
      return next;
    };
    switch (key) {
      case "dir":
        args.dir = takeVal();
        break;
      case "database-url":
        args.databaseUrl = takeVal();
        break;
      case "owner-app":
        args.ownerApp = takeVal();
        break;
      case "schema":
        args.projectSchema = takeVal();
        break;
      case "json":
        args.json = true;
        break;
      case "help":
        args.command = "help";
        break;
      default:
        throw new CliError(`unknown flag --${key}`);
    }
  }
  if (!args.command) args.command = positionals.shift() ?? "";
  args.positional = positionals.shift();
  // `DATABASE_URL` fallback (empty-is-unset, like the retired CLI's MED-1 rule).
  if (!args.databaseUrl) {
    const env = process.env.DATABASE_URL;
    if (env && env.length > 0) args.databaseUrl = env;
  }
  return args;
}

/** A CLI-level failure with a clean message (mapped to a non-zero exit, no stack). */
class CliError extends Error {}

/** Derive the driver seam config from a DB URL scheme. SQLite is NOT a host driver
 *  (it runs in-process in the addon, not over the seam) — a `sqlite:` URL is refused
 *  here with a clear message. */
function driverFor(databaseUrl: string): DriverConfig {
  const lower = databaseUrl.trimStart().toLowerCase();
  if (lower.startsWith("postgres://") || lower.startsWith("postgresql://")) {
    return { kind: "postgres", url: databaseUrl };
  }
  if (lower.startsWith("mysql://") || lower.startsWith("mariadb://")) {
    return { kind: "mysql", url: databaseUrl };
  }
  if (lower.startsWith("sqlite:") || lower.endsWith(".sqlite") || lower.endsWith(".db")) {
    throw new CliError(
      "sqlite runs in-process, not over the host driver seam — the CLI host verbs " +
        "(apply/status) target the network dialects (postgres/mysql). Use a " +
        "postgres:// or mysql:// database URL.",
    );
  }
  throw new CliError(
    `could not infer a driver from the database URL (expected a postgres:// or ` +
      `mysql:// scheme): ${JSON.stringify(databaseUrl)}`,
  );
}

/** Discover migration source files under `dir`, sorted by filename (order contract). */
async function discover(dir: string): Promise<MigrationFile[]> {
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch (e) {
    throw new CliError(`read migrations dir ${dir}: ${(e as Error).message}`);
  }
  const files = entries
    .filter((n) => /\.(ts|mts|cts|js|mjs|cjs)$/i.test(n) && !/\.d\.ts$/i.test(n))
    .sort();
  return files.map((n) => {
    const path = resolve(dir, n);
    return { path, label: deriveNameFromPath(n) };
  });
}

/** Dynamic-import a migration module by absolute path. */
async function importMigration(path: string): Promise<MigrationModule> {
  const url = isAbsolute(path) ? pathToFileURL(path).href : path;
  return (await import(url)) as MigrationModule;
}

/** `new <name>` — scaffold a fresh op-DSL migration. Validates the name, refuses to
 *  clobber, and prints the created path. The scaffold imports `{ table, t }` from the
 *  `zero-migrate` DSL package (the current fluent surface). */
async function runNew(args: Args): Promise<number> {
  const name = args.positional;
  if (!name) throw new CliError("`new` needs a migration name: zero-migrate new <name>");
  if (!/^[A-Za-z0-9_]+$/.test(name)) {
    const suggested = name.replace(/[^A-Za-z0-9_]+/g, "_").replace(/^_+|_+$/g, "");
    const hint = suggested ? ` (did you mean \`${suggested}\`?)` : "";
    throw new CliError(
      `invalid migration name ${JSON.stringify(name)}: allowed characters are ` +
        `[A-Za-z0-9_] (use \`_\` for spaces/dashes)${hint}`,
    );
  }
  const stamp = timestamp14(new Date());
  const filename = `${stamp}_${name}.ts`;
  const path = resolve(args.dir, filename);
  try {
    await access(path);
    throw new CliError(`refusing to overwrite existing file: ${path}`);
  } catch (e) {
    if (e instanceof CliError) throw e;
    // ENOENT — the file does not exist, which is what we want.
  }
  await mkdir(args.dir, { recursive: true });
  await writeFile(path, scaffold(name), "utf8");
  process.stdout.write(`Creating migration: ${path}\n`);
  return 0;
}

/** The op-DSL migration scaffold body (redesign step 5c — replaces the Rust
 *  `scaffold.rs` that emitted `@zeroship/migrate`; now the standalone `zero-migrate`
 *  DSL, per the naming table). */
function scaffold(name: string): string {
  return `import { table, t } from "zero-migrate";

export const name = ${JSON.stringify(name)};

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
`;
}

/** Format a 14-digit \`YYYYMMDDHHMMSS\` UTC timestamp (the migration-file ordering key). */
function timestamp14(now: Date): string {
  const p = (n: number, w = 2) => String(n).padStart(w, "0");
  return (
    p(now.getUTCFullYear(), 4) +
    p(now.getUTCMonth() + 1) +
    p(now.getUTCDate()) +
    p(now.getUTCHours()) +
    p(now.getUTCMinutes()) +
    p(now.getUTCSeconds())
  );
}

/** One `plan` verdict line. */
interface PlanLine {
  label: string;
  ok: boolean;
  opCount: number;
  irVersion?: number;
  error?: string;
}

/** `preview [dir]` — DB-free: print the authored op-IR envelope for each migration. */
async function runPreview(args: Args): Promise<number> {
  const files = await discover(args.dir);
  if (files.length === 0) throw new CliError(`no migrations found in ${args.dir}`);
  const irVersion = currentIrVersion();
  const envelopes = [];
  for (const f of files) {
    const mod = await importMigration(f.path);
    envelopes.push(buildEnvelope(mod, { irVersion, nameFallback: f.label }));
  }
  if (args.json) {
    process.stdout.write(JSON.stringify(envelopes, null, 2) + "\n");
  } else {
    for (const env of envelopes) {
      process.stdout.write(
        `preview ${env.name}: ir_version=${env.ir_version} ops=${env.ops.length}\n`,
      );
      process.stdout.write(JSON.stringify(env.ops, null, 2) + "\n");
    }
  }
  return 0;
}

/** `apply [dir]` — apply every migration over the `--database-url` driver in order. */
async function runApply(args: Args): Promise<number> {
  if (!args.databaseUrl) {
    throw new CliError(
      "missing database URL (pass --database-url or set DATABASE_URL)",
    );
  }
  const driver = driverFor(args.databaseUrl);
  const files = await discover(args.dir);
  if (files.length === 0) throw new CliError(`no migrations found in ${args.dir}`);
  for (const f of files) {
    const migration = await importMigration(f.path);
    const outcome = await apply({
      migration,
      ownerApp: args.ownerApp,
      projectSchema: args.projectSchema,
      driver,
      nameFallback: f.label,
    });
    process.stdout.write(`apply ${f.label}: ${JSON.stringify(outcome)}\n`);
  }
  return 0;
}

/** `status [dir]` — reconcile against the live journal over the `--database-url`
 *  driver. (Reads the journal; the migration set is discovered for the pending view.) */
async function runStatus(args: Args): Promise<number> {
  if (!args.databaseUrl) {
    throw new CliError(
      "missing database URL (pass --database-url or set DATABASE_URL)",
    );
  }
  const driver = driverFor(args.databaseUrl);
  const reply = await status({
    ownerApp: args.ownerApp,
    projectSchema: args.projectSchema,
    driver,
  });
  if (args.json) {
    process.stdout.write(JSON.stringify(reply, null, 2) + "\n");
  } else {
    process.stdout.write(`status: ${JSON.stringify(reply)}\n`);
  }
  return 0;
}

/** The `--help` / usage text. */
const USAGE = `zero-migrate — the zero-migrate host CLI

Usage:
  zero-migrate new <name> [--dir <dir>]
  zero-migrate plan    [--dir <dir>] [--owner-app <app>] [--schema <schema>] [--json]
  zero-migrate preview [--dir <dir>] [--json]
  zero-migrate apply   [--dir <dir>] --database-url <url> [--owner-app <app>] [--schema <schema>]
  zero-migrate status  --database-url <url> [--owner-app <app>] [--schema <schema>] [--json]

Flags:
  --dir <dir>           Migration directory (default ./migrations)
  --database-url <url>  postgres:// or mysql:// DSN (or the DATABASE_URL env)
  --owner-app <app>     Deploying app id stamped as owner_app (default app_cli)
  --schema <schema>     Confined project schema (default public)
  --json                Machine-readable output where supported
  --help                This help

new/plan/preview are OFFLINE (no DB). apply/status target the network dialects
(postgres/mysql) over the host driver seam; SQLite runs in-process in the addon.
`;

/** Entry point: parse, dispatch, map thrown `CliError` to a clean non-zero exit. */
export async function main(argv: string[]): Promise<number> {
  let args: Args;
  try {
    args = parseArgs(argv);
  } catch (e) {
    process.stderr.write(`zero-migrate: ${(e as Error).message}\n`);
    return 1;
  }
  if (args.command === "" || args.command === "help") {
    process.stdout.write(USAGE);
    return args.command === "" ? 1 : 0;
  }
  try {
    switch (args.command) {
      case "new":
        return await runNew(args);
      case "plan":
        return await runPlanResolved(args);
      case "preview":
        return await runPreview(args);
      case "apply":
        return await runApply(args);
      case "status":
        return await runStatus(args);
      default:
        process.stderr.write(`zero-migrate: unknown command ${JSON.stringify(args.command)}\n`);
        process.stdout.write(USAGE);
        return 1;
    }
  } catch (e) {
    process.stderr.write(`zero-migrate: ${(e as Error).message}\n`);
    return 1;
  }
}

/** `plan` with the async import resolved (the discover→import→validate loop). */
async function runPlanResolved(args: Args): Promise<number> {
  const files = await discover(args.dir);
  if (files.length === 0) throw new CliError(`no migrations found in ${args.dir}`);
  const reports: PlanLine[] = [];
  for (const f of files) {
    const mod = await importMigration(f.path);
    const report = plan({
      migration: mod,
      ownerApp: args.ownerApp,
      dialect: "postgres",
      nameFallback: f.label,
    });
    reports.push({
      label: report.envelope.name || f.label,
      ok: report.ok,
      opCount: report.op_count ?? report.envelope.ops.length,
      irVersion: report.ir_version,
      error: report.error,
    });
  }
  if (args.json) {
    process.stdout.write(JSON.stringify(reports, null, 2) + "\n");
  } else {
    for (const r of reports) {
      const head = r.ok ? "ok" : "ERROR";
      process.stdout.write(`plan ${r.label}: ${head} (${r.opCount} ops)\n`);
      if (r.error) process.stdout.write(`  ${r.error}\n`);
    }
  }
  return reports.every((r) => r.ok) ? 0 : 1;
}
