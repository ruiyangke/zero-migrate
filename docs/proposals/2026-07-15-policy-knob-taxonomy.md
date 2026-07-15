# Policy knob taxonomy — domain namespaces + key rationalization

- **Status:** proposal — QUEUED for implementation *after* the compose-refinements cut (`feat/policy-compose-refinements`) lands and its oracle verifies. One dedicated rename+rationalize sweep; no string baked in twice.
- **Date:** 2026-07-15
- **Scope:** the builtin policy-knob registry (`crates/zero-migrate-ir/src/policy_registry.rs`), the op→key mapping, the guard's key lookups, the design doc, the (not-yet-written) `base/dev/prod` policy docs, and the monorepo policy consumers.

---

## 1. Motivation

The current builtin keys use `core.*` / `pg.*` / `op.*` / `sec.*`. That's **three different axes pretending to be one namespace**:

- `pg.*` bakes a **dialect** into a *generic* engine's vocabulary — the exact thing the redesign fought. And roles/grants/schemas/extensions/RLS aren't PG-specific *concepts*; MySQL has them too.
- `core.*` is a **vague dumping ground** ("engine capabilities that aren't pg") — it tells you nothing.
- `op.*`/`sec.*` are **category/polarity** buckets, a third axis.

Nothing is predictable because the prefix means something different each time.

## 2. Principle

**One axis is the namespace: the domain (what the knob governs). Everything else is a declared `KnobDef` field** — `polarity`, `kind`, `object_model`, `enforcement`, `default`, `inherit`, dialect-mapping. This is the OpenTelemetry-style convention (dot = namespace boundary, underscore = words within one name), and our keys are string *values* in TOML (`key = "schema.create_table"`), so dotted keys carry no quoting tax.

Consumer extensions keep their own namespace (`acme.hypertable`) — unchanged.

## 3. The six domains

- **`sql`** — the raw-text escape hatch
- **`schema`** — structural DDL (tables, schemas, columns, partitions)
- **`access`** — access control (roles, grants, RLS, policies)
- **`code`** — programmable / installed objects (functions, materialized views, extensions)
- **`runtime`** — execution & resource behavior (timeouts, index creation, table rewrite)
- **`safety`** — data protection (limits *and* obligations; polarity is the field, so `safety.destructive_ops` and `safety.require_rls` coexist by design)

## 4. Final registry

| Key | Kind | Polarity | Notes |
|---|---|---|---|
| `sql.raw` | Bool | Grant | raw escape hatch (still deny-list-guarded); object set = all referenced |
| `sql.raw_view_body` | Bool | Grant | raw text inside a view body |
| `schema.create_table` | Bool | Grant | |
| `schema.create_schema` | Bool | Grant | per-schema |
| `schema.rename` | Bool | Grant | the namespace-authority *check* (rename-into-inject-scope) stays a guard rule |
| `schema.cross_schema` | Bool | Grant | per-schema |
| `schema.partition` | Bool | Grant | |
| `schema.alter_injected` | Bool | Grant | **`inherit = false`** — power grant; a silent draft must not inherit "override the platform's injected columns" |
| `access.role` | Bool | Grant | SUPERUSER stays a hard-deny regardless of grant |
| `access.grant` | Bool | Grant | |
| `access.rls` | Bool | Grant | |
| `access.policy` | Bool | Grant | |
| `code.extension` | **StrSet** | Grant | **merged** from the old `extension` bool + `extensions` allowlist — the allowlist *is* the knob (empty = deny all); `FORBIDDEN_EXTENSIONS` stays a hard-deny |
| `code.function` | Bool | Grant | CREATE FUNCTION / PROCEDURE |
| `code.materialized_view` | Bool | Grant | |
| `runtime.lock_timeout_ms` | UintCeiling | Grant | `hard_floor = 1` |
| `runtime.statement_timeout_ms` | UintCeiling | Grant | `hard_floor = 1` |
| `runtime.index_creation` | OrderedEnum | Grant | `allow_blocking ⊒ require_concurrent` |
| `runtime.table_rewrite` | OrderedEnum | Grant | `allow ⊒ forbid` |
| `safety.destructive_ops` | OrderedEnum | Grant | `forbid ⊑ warn ⊑ allow`, default `forbid` |
| `safety.require_rls` | Bool | Require | obligation |
| `safety.no_hard_delete` | Bool | Require | obligation |
| `safety.require_approval` | OrderedEnum | Require | `never ⊑ on_destructive ⊑ always`, **`HostEnforced`** |

Every Grant defaults to its tightest (deny/none). `object_model` / `enforcement` / `default` carry over from the current registry unchanged except where noted; only the *keys* and the three structural changes below move.

## 5. Structural changes (beyond the rename)

1. **`extension` (Bool) + `extensions` (StrSet allowlist) → one `code.extension` (StrSet).** Two knobs for one decision collapse into the allowlist.
2. **`skip_static_guard` LEAVES the registry** → an engine-construction **`GuardMode { Enforced | Off }`**, root/host-set only, never in a composable policy. "Run without the deny-list guard" is a *posture* (who-runs-the-engine trust), not a per-app capability — so it can't be granted, inherited, or drafted. It is the single most dangerous switch; quarantining it out of the composable registry is the point. (Migrates the current `core.skip_static_guard` grant + the vendor-lower belt-skip usage.)
3. **`raw_island_role` LEAVES the registry** → folded into the guard's internal vendor-lower logic. It preserves one Platform-vs-Trusted behavior; it is implementation, not operator-authorable policy.

## 6. Old → new mapping (complete)

```
core.raw_sql              → sql.raw
core.raw_view_body        → sql.raw_view_body
core.create_table         → schema.create_table
core.create_schema        → schema.create_schema   (absorbs the old pg.schema capability)
core.rename_into          → schema.rename
core.cross_schema         → schema.cross_schema
core.alter_injected_column→ schema.alter_injected   (+ inherit=false)
pg.role                   → access.role
pg.grant                  → access.grant
pg.rls                    → access.rls
pg.policy                 → access.policy
pg.extension + pg.extensions → code.extension        (single StrSet)
pg.function               → code.function
pg.materialized_view      → code.materialized_view
pg.partition              → schema.partition
op.lock_timeout_ms        → runtime.lock_timeout_ms
op.statement_timeout_ms   → runtime.statement_timeout_ms
op.index_creation         → runtime.index_creation
op.table_rewrite          → runtime.table_rewrite
sec.destructive_ops       → safety.destructive_ops
sec.require_rls           → safety.require_rls
sec.no_hard_delete        → safety.no_hard_delete
sec.require_approval      → safety.require_approval
core.skip_static_guard    → (removed → EngineOptions GuardMode)
core.raw_island_role      → (removed → internal guard vendor-lower logic)
```

## 7. Implementation plan (one sweep, sequenced after compose-refinements)

1. **Registry** (`policy_registry.rs`): rename all keys to the six-domain scheme; merge `code.extension` into a StrSet; add `inherit = false` on `schema.alter_injected`; remove `skip_static_guard` + `raw_island_role`.
2. **`GuardMode`**: add `GuardMode { Enforced | Off }` to `EngineOptions`/guard construction (root/host-set); migrate the belt-skip + vendor-lower relaxation off the two removed knobs.
3. **op→key map + guard lookups**: update `Op`/statement-class → `KnobKey` and every guard `grants(key, …)` call site to the new keys.
4. **Design doc** (`2026-07-14-policy-redesign.md`): update §II.2.1 registry list + every `core.*`/`pg.*`/`op.*`/`sec.*` reference and example.
5. **`base/dev/prod` docs** (written for the compose refinements): author them with the new keys from the start.
6. **Monorepo consumers**: `crates/migrated/policies/*.policy.toml`, `sdks/vite-plugin/src/gen-types/confined-ceiling.ts`, and any `migrated` code referencing knob keys.
7. **Verify**: `zero-migrate-policy` oracle green; engine `guard_security`/`guard_vendor_lower` green (behavior unchanged — pure rename + the 3 structural changes); monorepo builds + `zeroship-migrated`/`plugin-db` green.

**Pre-launch: no back-compat** — rename the strings, delete the old ones, update every producer/consumer in the same pass. No aliases.
