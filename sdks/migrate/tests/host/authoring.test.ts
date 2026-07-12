// Standalone Node-native authoring -> IR -> apply test.
//
// Proves the V8-FREE authoring path end-to-end, entirely in the Node process:
//   1. the pure-JS host recorder (`host-recorder.ts`) evals the migration DSL
//      (`table()`/`t.*` from `zero-migrate`) into a `{ ir_version, name, ops }`
//      op-IR envelope — NO embedded V8, NO in-Rust recorder;
//   2. the `zero-migrate-node` napi addon LOWERs the envelope in Rust (stamps
//      `owner_app`, folds the authoritative `Checksum::of_ir` + the confined system
//      shape) and APPLIES it over the real `pg` npm driver via the `hostDriver`
//      seam — exactly the napi-bridge Phase-D path.
//
// OFFLINE arm (always runs, DB-free): author the envelope and assert its shape
// (ir_version from the addon, op count, op kinds). This is the pure-JS recorder
// proof — no DB, no V8.
//
// FULL arm (pg :5440, auto-skips if unreachable): apply into a fresh unique schema
// and assert the journal recorded the migration AND the `widgets` table + its author
// columns exist. This proves author -> IR -> lower(Rust checksum/fold) -> apply over
// the real `pg` driver.
//
// The addon `.node` is resolved via `ZEROSHIP_MIGRATE_NATIVE` (set below to the
// sibling crate's build output) or the addon loader's dev-fallback.

import { test } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { buildEnvelope } from "zero-migrate/host-recorder";
import { currentIrVersion, apply } from "zero-migrate/host";

const HERE = dirname(fileURLToPath(import.meta.url));

// Point the addon loader at the sibling crate's prebuilt `.node` unless the caller
// already set an explicit path. The napi default triple spelling on Linux is
// `<platform>-<arch>-gnu`.
if (!process.env.ZEROSHIP_MIGRATE_NATIVE) {
  const { platform, arch } = process;
  const abi = platform === "linux" ? "-gnu" : "";
  process.env.ZEROSHIP_MIGRATE_NATIVE = join(
    HERE,
    `../../../../crates/zero-migrate-node/zero-migrate-node.${platform}-${arch}${abi}.node`,
  );
}

const PG_URL =
  process.env.ZERO_MIGRATE_TEST_PG_URL ??
  "postgres://postgres:zeroship@localhost:5440/zero_migrate_test";

/** Import the sample migration (`.ts`) — resolves `zero-migrate` to this
 *  package's dist (one shared recorder singleton). Runs under `node --import tsx`. */
async function loadMigration() {
  return import("./mig/20260711000001_create_widgets.ts");
}

/** A fresh, unique schema so parallel runs / reruns never collide. */
function uniqueSchema(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}_${Math.floor(Math.random() * 1e6).toString(36)}`;
}

// ---------------------------------------------------------------------------
// OFFLINE arm — pure-JS recorder authors the op-IR envelope (no DB, no V8).
// ---------------------------------------------------------------------------
test("Node-native authoring: pure-JS recorder drains the DSL into an op-IR envelope", async () => {
  const mig = await loadMigration();
  const irVersion = currentIrVersion();
  assert.ok(irVersion > 0, "addon irVersion() must be a positive integer");

  const envelope = buildEnvelope(mig as never, {
    irVersion,
    nameFallback: "create_widgets",
  });

  assert.equal(envelope.ir_version, irVersion, "envelope ir_version comes from the addon");
  assert.equal(envelope.name, "create_widgets");
  assert.equal(envelope.ops.length, 2, "two authored ops (createTable + addColumn)");

  const kinds = (envelope.ops as Array<{ op: string }>).map((o) => o.op);
  assert.deepEqual(kinds, ["createTable", "addColumn"], "op kinds in declared order");

  // The recorder does NOT compute a checksum or set owner_app — those are Rust-owned.
  assert.ok(!("checksum" in envelope), "recorder must not fold a checksum");
  assert.ok(!("owner_app" in envelope), "recorder must not stamp owner_app");

  // The author columns are present PRE system-shape fold (the fold happens in the
  // addon's Rust lower, not in the JS recorder).
  const createTable = envelope.ops[0] as { columns: Array<{ name: string }> };
  const authored = new Set(createTable.columns.map((c) => c.name));
  for (const col of ["label", "status"]) {
    assert.ok(authored.has(col), `author column ${col} recorded on createTable`);
  }
});

// ---------------------------------------------------------------------------
// FULL arm — napi addon lowers + applies over the real `pg` driver (pg :5440).
// Auto-skips if the test Postgres is unreachable.
// ---------------------------------------------------------------------------
test("Node-native apply: napi addon lowers + applies the authored IR over the pg driver", async (t) => {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const pg = (await import("pg")).default;

  const probe = new pg.Client({ connectionString: PG_URL });
  try {
    await probe.connect();
  } catch (e) {
    await probe.end().catch(() => {});
    t.skip(`test Postgres unreachable at ${PG_URL}: ${(e as Error).message}`);
    return;
  }

  const mig = await loadMigration();
  const schema = uniqueSchema("node_authoring");
  const meta = `${schema}_migrations`;

  try {
    // The apply pins ops into a pre-existing confined project schema.
    await probe.query(`CREATE SCHEMA "${schema}"`);

    const outcome = await apply({
      migration: mig as never,
      ownerApp: "app_widgets",
      projectSchema: schema,
      driver: { kind: "postgres", url: PG_URL },
      registry: {},
      approved: false,
      appliedBy: "deploy",
      nameFallback: "create_widgets",
    });

    assert.ok(outcome.applied.length > 0, "at least one migration id applied");

    // The `widgets` table exists in the project schema.
    const tbl = await probe.query(
      `SELECT to_regclass('"${schema}".widgets') IS NOT NULL AS ex`,
    );
    assert.equal(tbl.rows[0].ex, true, "widgets table was created");

    // The author columns AND the addon-folded confined system columns are present.
    const cols = await probe.query(
      `SELECT column_name FROM information_schema.columns
        WHERE table_schema = $1 AND table_name = 'widgets'`,
      [schema],
    );
    const colNames = new Set(cols.rows.map((r: { column_name: string }) => r.column_name));
    for (const col of ["label", "status", "qty"]) {
      assert.ok(colNames.has(col), `author column ${col} present`);
    }
    for (const col of ["id", "created_at", "updated_at", "version"]) {
      assert.ok(colNames.has(col), `folded system column ${col} present`);
    }

    // The journal recorded the applied migration steps.
    const journal = await probe.query(
      `SELECT name FROM "${meta}".schema_migrations WHERE event_kind = 'applied' ORDER BY event_seq`,
    );
    const journalNames = journal.rows.map((r: { name: string }) => r.name);
    assert.ok(journalNames.length > 0, "journal has applied rows");
    assert.ok(
      journalNames.includes("create_table_widgets"),
      `journal records the create_table step (got ${JSON.stringify(journalNames)})`,
    );
    assert.ok(
      journalNames.includes("add_column_widgets_qty"),
      `journal records the add_column step (got ${JSON.stringify(journalNames)})`,
    );
  } finally {
    await probe
      .query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE; DROP SCHEMA IF EXISTS "${meta}" CASCADE`)
      .catch(() => {});
    await probe.end().catch(() => {});
  }
});
