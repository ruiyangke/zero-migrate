# Policy redesign: mechanism in the engine, content from the consumer

**Status:** proposal (design only — no code changed)
**Date:** 2026-07-14
**Scope:** the policy/profile system of the standalone `zero-migrate` engine —
`crates/zero-migrate/src/model/profile.rs`, `policy-profiles/*.toml`,
`crates/zero-migrate/src/model/table_shape.rs`, `crates/zero-migrate/src/conn.rs`,
`crates/zero-migrate-ir/src/{capability,policy}.rs`,
`crates/zero-migrate-guard/src/guard/mod.rs`, and the profile touchpoints in
`crates/zero-migrate-node/src/{api,lower}.rs` and
`crates/zero-migrate/src/render/declarative.rs`.

`zero-migrate` is positioned as a general-purpose migration engine that outside
operators embed. Its policy system today is a **zeroship org chart compiled into a
library**. This document is (I) a harsh, evidence-grounded review of the current
design, and (II) a redesign that keeps every fail-closed / no-escalation guarantee
while making the engine actually generic and extensible.

---

# Part I — Review

## I.1 Genericity: zeroship content baked into the engine

### G1 (CRITICAL) — Omitting `[system_shape]` silently injects zeroship's data model

`PolicyProfile.system_shape` is `#[serde(default)]`
(`profile.rs:59-60`), `Default for TableSystemShapePolicy` is `confined()`
(`profile.rs:186-190`), and `confined()` hardcodes **seven zeroship system columns**
(`id/created_at/updated_at/created_by/updated_by/version/deleted_at`), three system
indexes, `primary_key = ["id"]`, and `author_primary_key = Forbid` — in Rust
(`profile.rs:192-248`), duplicated byte-for-byte in `policy-profiles/confined.toml:2-18`,
pinned a third time in the test at `profile.rs:1748-1785`, and consumed a fourth time by
the declarative renderer (`render/declarative.rs:1736-1738`, whose comments even cite
zeroship's `plugin-db` `query.rs:900` — a file in a *different product's repo* —
as the thing it must stay in sync with).

Consequence for an outsider: write a profile TOML that configures only
`[capabilities]`, forget `[system_shape]`, and `resolve_create_table_policy`
(`table_shape.rs:61-80`) **prepends seven columns you never asked for to every table,
overrides your primary key to `["id"]`, and errors on any table that already has a
`created_at` column** (`TableShapeError::SystemColumnCollision`, `table_shape.rs:14-19`).
The *absence* of configuration injects another company's product data model. This is
the single worst defect in the design: the fail-closed default is not "do nothing
extra", it is "do what zeroship does".

`Default for PolicyProfile` is likewise `Self::confined()` (`profile.rs:63-67`), so
`PolicyProfile::default()` — the most innocent-looking expression in the API — carries
the zeroship shape.

### G2 (CRITICAL) — Fail-closed is also fail-*silent*, and "closed" means "zeroship"

`from_toml_or_confined` swallows parse errors with `.ok()` (`profile.rs:95-99`): a
typo'd operator profile silently degrades to the confined preset — zero capabilities
*plus the seven-column shape injection of G1* — with no diagnostic. `load_ir_document`
does the same when handed `None` (`model/load.rs:60-66`). Fail-closed is the right
instinct; failing *silently into another consumer's table-rewriting preset* is not a
security posture, it is a data-corruption vector for every embedder who typos a key.
(`deny_unknown_fields` makes typos *likely* to hard-fail — and then the `.ok()` throws
the error away.)

### G3 (HIGH) — The preset catalog is closed, compiled in, and named after zeroship's org model

`CONFINED_PROFILE_TOML` / `PLATFORM_PROFILE_TOML` are `include_str!` constants
(`profile.rs:34-39`); `PolicyProfile::preset()` resolves exactly `"confined"` and
`"platform"` and nothing else (`profile.rs:118-124`); the doc comment enshrines a
product decision — "There is deliberately no `permissive` preset"
(`profile.rs:115-116`) — and a test pins it (`profile.rs:1745`). "Confined vs.
platform" is zeroship's *creator-vs-operator* trust framing. A general-purpose engine
has no business knowing these names, let alone refusing to know others. Meanwhile
`VendorCapabilities::local()` — a genuinely useful dev/CI composition — exists at the
capability layer (`capability.rs:236-252`) but is *not* reachable as a profile preset:
the preset registry and the capability presets have already diverged inside one repo.

### G4 (HIGH) — The posture an outside user actually wants is test-gated

The `Trusted` posture — "the public dbmate-like posture where the operator owns the
database" (`zero-migrate-ir/src/policy.rs:39-52`) — is precisely the default mode of
every general-purpose migration tool (dbmate, Flyway, Atlas, goose). In this engine:
`ExecutorConfig::trusted` is `#[cfg(test)]` (`conn.rs:316-332`), and `SealedPosture`
deliberately has no `Trusted` variant (`profile.rs:1053-1059`). The mainstream use case
of the standalone product is unrepresentable on the sealed path and unreachable in a
production build of the executor. The zeroship threat model (untrusted creator code on
shared infra) has been promoted to *the* threat model.

### G5 (HIGH) — zeroship's operational SLOs are compile-time constants, enforced at *parse* time

`PLATFORM_LOCK_TIMEOUT_CEILING_MS = 3_000` and
`PLATFORM_STATEMENT_TIMEOUT_CEILING_MS = 60_000` (`profile.rs:30-31`) are engine
constants — note the *name*: "PLATFORM". They are enforced inside the serde
deserializers (`deserialize_lock_timeout_ms` / `deserialize_statement_timeout_ms`,
`profile.rs:643-667`): an outside operator **cannot even author**
`statement_timeout_ms = 300000` in their own profile file — the TOML fails to parse.
A ten-minute single-tenant backfill migration, utterly ordinary for a self-hosted
user with a maintenance window, is unrepresentable. These numbers are zeroship's
shared-multi-tenant-Postgres availability envelope (the excellent rationale in
`conn.rs:46-77` says so explicitly) hardcoded into a product that claims to be
generic. And because the same `validate_timeout_ms` runs against the *ceiling* inside
`meet_timeout_ms` (`profile.rs:743-755`), no ceiling profile can lift it either.

### G6 (MEDIUM) — Policy contaminates artifact identity

`resolve_create_table_policy` rewrites `CreateTable` ops *before* canonical bytes /
checksum are computed (`table_shape.rs:56-60`), and the engine's own test demonstrates
that the same author input yields different checksums under different profiles
(`table_shape.rs:496-515`, `active_profile_changes_resolved_ops_and_checksum`). So a
consumer who changes their shape policy invalidates the checksum of every previously
applied migration. Policy (a deployment-time stance) is fused into artifact identity
(a forever contract). For zeroship pre-launch this is survivable; for an outside user
with an existing journal it is a trap with no exit but a fork.

### G7 (MEDIUM) — The napi host hardcodes the zeroship profile at call sites that make no policy decision

`gen_artifacts_from_envelopes` constructs `PolicyProfile::confined()` unconditionally
(`zero-migrate-node/src/api.rs:121`), as does the envelope lower path
(`zero-migrate-node/src/lower.rs:86`), and the declarative snapshot renderer reaches
into `PolicyProfile::confined().system_shape` to learn what the system fields are
(`render/declarative.rs:1736-1738`). These call sites don't want a *policy*; they want
the *table shape*, and the only way to get one is to summon zeroship's preset. This is
the smoking gun that `system_shape` is not policy at all (see I.4).

### G8 (LOW) — Vocabulary

`owner_app`, `deploying_app` (`api.rs:52-63`), `SealedPosture::Platform`,
`VendorCapabilities::operator()`, "creator profile", "the platform image" — the whole
lexicon is zeroship-tenancy-shaped. Cosmetic individually; collectively it tells an
outside embedder "you are integrating someone else's internal tool".

## I.2 Elegance / API

### E1 (CRITICAL) — The capability set is closed and defined five times

Adding one capability (say `trigger`) requires editing, at minimum:

1. `VendorCapability` enum (`zero-migrate-ir/src/capability.rs:79-102`),
2. `VendorCapabilities` bool struct + all three presets (`capability.rs:150-252`),
3. `PolicyCapabilities` bool struct (`profile.rs:343-386`, `deny_unknown_fields`),
4. the two hand-written converters `from_vendor_capabilities` /
   `to_vendor_capabilities` (`profile.rs:397-437`),
5. the hand-written meet (`profile.rs:439-488`),
6. the static `POLICY_KNOB_SEMANTICS` table (`profile.rs:931-1047`),
7. `migrator_unbacked_capability`'s if-chain (`profile.rs:1434-1470`),
8. the guard's grant plumbing, and both embedded TOML presets.

That is ~8 sites across 3 crates, all of which must stay mutually consistent by hand.
They already haven't: `cross_schema` exists as a bool in `VendorCapabilities`
(`capability.rs:177`) and `PolicyCapabilities` (`profile.rs:378-379`) but has **no
variant in the `VendorCapability` enum** (`capability.rs:79-102`) — the "closed set a
vendor op can require" cannot even name one of the flags the structs carry. The design
has drifted against itself before a single outside user showed up. A domain-specific
capability from an embedder ("allow_timescale_hypertable") is impossible without a
fork.

### E2 (HIGH) — The polarity table is documentation cosplaying as mechanism

`POLICY_KNOB_SEMANTICS` (`profile.rs:931-1047`) declares polarity + meet-op per knob —
exactly the right idea — and then **nothing consumes it**. Its only accessor is
`polarity_table()` (`profile.rs:132-136`); the actual composition is hand-coded
per-struct (`PolicyCapabilities::meet_ceiling_draft`, `OperationalConfig::…`,
`DataSecurityConfig::…`, `TableSystemShapePolicy::…`). The table also omits
`system_shape` and `extends` entirely — the two knobs whose composition semantics are
the most exotic (see E3). Declarative metadata that does not drive the machine is a
drift guarantee, not an architecture.

### E3 (HIGH) — The composition "algebra" is not an algebra, and two knobs don't fit it

- The doc comment promises a lattice meet — "permission knobs meet by tightening…
  boolean-AND, set intersection, minimum" (`profile.rs:138-143`) — but the
  implementation **rejects** a looser draft instead of clamping
  (`meet_bool_permission`, `profile.rs:702-707`; `meet_timeout_ms`,
  `profile.rs:743-755`; `OperationalConfig::meet_ceiling_draft` errors first at
  `profile.rs:566-577` and *then* computes `tightest(…)` on values that are now
  provably equal-or-tighter — dead generality). Reject-on-exceed is a legitimate
  *ingress* policy, but it is not a meet: it is not defined on all pairs, so you cannot
  use the same operation to chain ceilings (operator → org → project), which the
  memoized server architecture explicitly wants ("effective = operator_ceiling ⊓
  creator_draft"). One name, two semantics needed, one implemented.
- `system_shape`'s "meet" (`profile.rs:261-271`) is neither AND, OR, min, nor
  intersection: *if the ceiling is exactly the platform preset, take the draft;
  otherwise the draft must be byte-equal to the ceiling*. That is a third polarity —
  "pinned by ceiling unless ceiling delegates" — that the model has no word for, so it
  lives as an unexplained special case comparing against a named preset by equality.
- `DestructiveOps` mixes an ordering with a workflow state: `RequireApproval` ranks as
  the *tightest* value (`policy.rs:119-127`) yet is "a server composition value" that
  sealed configs reject (`profile.rs:1163-1167`), the meet special-cases
  `ceiling == RequireApproval` (`profile.rs:862-869`), and the guard silently projects
  it to `Forbid` (`guard/mod.rs:233-245`). One enum, three enforcement regimes,
  labeled `Permission/Min` in the semantics table (`profile.rs:1042-1046`) — which is
  wrong for the `RequireApproval` row of its own rank table.
- `lock_timeout_ms` is labeled `MinNonZero` in the table (`profile.rs:1017-1021`) but
  the real composition (`meet_timeout_ms`) rejects zero outright and rejects
  draft > ceiling — a third behavior. The `min_non_zero_timeout_ms` helper that
  matches the label exists only under `#[cfg(test)]` (`profile.rs:687-695`).

### E4 (HIGH) — Half the config surface is theater: it parses, but can never seal

`validate_for_seal` rejects, at the enforcement boundary, config the schema happily
accepts:

- any capability composition strictly between `confined()` and `operator()` —
  `SealError::UnsupportedProfileKnob { "capabilities.granular" }`
  (`profile.rs:1136-1148`). The entire per-flag capability surface collapses to a
  **binary** at seal time; `SealedEffectiveProfile::from_profile` then infers its
  posture by *equality with the operator preset* (`profile.rs:1074-1091`).
- `role.attrs` non-empty (`profile.rs:1130-1134`);
- `no_hard_delete`, `sensitive_columns`, `destructive_ops = require_approval`
  (`profile.rs:1151-1170`);
- `index_creation = require_concurrent`, any non-`allow` `table_rewrite`
  (`profile.rs:610-632`);
- any `system_shape` that is not byte-equal to one of the two presets
  (`profile.rs:273-280`) — so the "declarative" columns/indexes/pk schema in the TOML
  is a lie: a custom shape parses and then can never be applied on the sealed path.

Refusing to seal unenforced authority is the *right guarantee* (it is the best idea in
this file). But the honest version of that guarantee is metadata on each knob
("declared-only vs enforced"), not a scattering of hand-written rejections that make
the authoring surface advertise ~2× the engine's real capability. An outside operator
reading `confined.toml` has no way to know which half of what they're editing does
anything.

### E5 (MEDIUM) — `extends` is parsed, serialized, and ignored

`PolicyProfile.extends` (`profile.rs:47-48`) — "composition is a later server task" —
and `platform.toml:2` proudly declares `extends = "confined"`, which does nothing.
A config key that round-trips but has no semantics is worse than absent: every reader
of `platform.toml` now believes inheritance exists.

### E6 (MEDIUM) — The `OperatorCapability` token's security story is stale — it is now forgeable by design

`capability.rs:39-46` claims: "The token has a PRIVATE `()` field, so an external
crate can name the type but **cannot construct one**… external crates cannot call
[`new`] usefully because there is no `pub` API that accepts the token except the
`pub(crate)` privileged constructors." Both halves are now false:
`OperatorCapability::new()` is `pub const fn` (`capability.rs:54-56`), and both
`GuardConfig::platform` (`guard/mod.rs:253`) and `ExecutorConfig::platform`
(`conn.rs:277`, whose doc *celebrates* being made `pub`: "Making this `pub` closes the
asymmetry", `conn.rs:270-275`) are public and accept it. Any embedding crate can mint
the token and build a Platform executor/guard in two lines. For the *standalone*
product that outcome is arguably correct (the embedder owns their database) — but then
the token is pure ceremony, and every comment that sells it as the trust boundary
(`policy.rs:10-21`, `conn.rs:162-171`) is documenting a lock whose key is taped to the
door. The real boundary that remains is the `SealedProfile` MAC — which is confined to
the control-plane path. One system, two contradictory trust stories.

### E7 (LOW) — TOML strictness without versioning

`deny_unknown_fields` (`profile.rs:43`) is the right call for typo-safety, but there is
no `profile_version`/schema marker in the document. A profile authored against engine
v(N+1) with one new knob hard-fails to parse on vN — and then G2's `.ok()` turns that
hard failure into a silent fall-through to zeroship-confined. Strict parsing + silent
fallback + no versioning is the worst possible combination of the three.

## I.3 Extensibility scorecard (1 = config change, 5 = fork the engine)

| An outsider wants to… | Today | Why |
|---|---|---|
| Add a new capability (e.g. `trigger`, or vendor `timescale.hypertable`) | **5 — fork** | closed enum + closed struct + 8 hand-synced sites (E1) |
| Use **no** system shape | **2** | authorable (`columns = []`, `primary_key = "author"`) — but only because the platform preset happens to be that; must know to copy it; default is G1 |
| Use a **different** system shape (their own 3 columns) | **4 — fork for the sealed path** | parses, but `validate_for_seal` rejects non-preset shapes (`profile.rs:273-280`); shape column types limited to text/timestamptz/integer (`table_shape.rs:181-191`) |
| Add a custom obligation ("every table has `tenant_id`", "FKs must be indexed") | **5 — fork** | no hook; the two shipped obligations are hardwired into the guard (`guard/mod.rs:99-101,720-758,1770+`) |
| Add a third trust tier ("staff": grants X,Y, not raw_sql) | **5 — fork** | granular caps can't seal (E4); `TrustProfile` closed in a foreign crate; `SealedPosture` two-valued |
| Raise `statement_timeout` past 60 s | **5 — fork** | compile-time constant enforced at parse (G5) |
| Rename/replace the preset catalog | **5 — fork** | `include_str!` + match on two names (G3) |

A "generic engine" where five of seven ordinary extension requests require forking is
generic in aspiration only.

## I.4 Layering

**`system_shape` is not policy.** Capabilities, operational limits, and data-security
obligations *judge* a migration (accept/reject/warn). `system_shape` *rewrites* it —
it is a schema-authoring transform, evidence:

- it runs in the authoring/lowering pipeline, not the guard
  (`table_shape.rs:61`, called from `render/lower.rs`, `render/fold.rs`,
  `zero-migrate-node/src/lower.rs:86`);
- pure-codegen call sites that make no trust decision must fabricate
  `PolicyProfile::confined()` just to obtain the column list (G7);
- it changes artifact checksums (G6) — no judging knob does that;
- its "composition" isn't tighten/union but pin-or-delegate (E3), because shapes
  don't have a security ordering — a 7-column shape is not "more secure" than a
  3-column one, it's just *different product furniture*.

The only genuinely policy-shaped residue in it is *"may the author own the PK / may
the author deviate from the shape the operator pinned?"* — which is a pinning
decision about the transform, not the transform itself.

**The engine↔consumer seam is inverted.** The intended architecture (generic engine;
server injects managed profiles) implies the engine exports *mechanism* — parse,
compose, seal, enforce — and the consumer supplies *content* — presets, names, shapes,
ceilings. Today the engine ships the content (`policy-profiles/` embedded at
`profile.rs:34-39`; the shape in Rust at `profile.rs:192-248`; the ceilings at
`profile.rs:30-31`; the preset names at `profile.rs:118-124`) and the consumer
supplies… a string ("confined") to select among the engine's opinions. Every layer
violation above (G1–G7) is a downstream symptom of that one inversion.

---

# Part II — Redesign

## II.0 Principles

1. **Mechanism/content split.** The engine ships a policy *machine*: the knob
   registry, the four scoped rule kinds (`grant`/`require`/`inject`/`validate`), the
   composition algebra, sealing, and enforcement hooks. Every piece of *content* —
   preset documents, preset names, trust-tier vocabulary, the *rules themselves*
   (which columns to inject, which predicates to validate, which capabilities to
   grant), operational ceilings — is injected by the consumer. The engine's only
   intrinsic profile is the one it can derive from its own type system:
   **grant nothing, require nothing, inject nothing, validate nothing.** Crucially,
   moving injection/validation *into* policy as scoped, consumer-supplied rules does
   not violate this split — the engine ships the rule *evaluator*, the consumer ships
   the rule *content* (see II.4).
2. **The metadata drives the machine.** Polarity/meet/enforcement-status are declared
   once per knob and *executed* by one generic composer — never hand-coded per struct.
   The four rule kinds compose by their declared polarity too.
3. **Fail closed means "do less", never "do what zeroship does".** The fallback state
   grants nothing, requires nothing, injects nothing, and validates nothing. Missing/
   malformed policy at a host boundary is a hard, loud error.
4. **No escalation by construction.** The only path from documents to an enforceable
   effective policy is a monotone composition below a host-supplied root ceiling; the
   effective type is unforgeable outside that path. A draft can never widen a grant's
   *scope*, drop a ceiling `inject` rule, or remove a ceiling `validate` rule.
5. **Honest surface.** A knob or rule kind the engine cannot enforce cannot be
   authored at a non-default value on an enforced path. This generalizes today's
   `validate_for_seal` scatter into declared metadata.
6. **Scope is universal, name-based, and bounded.** Every rule — of every kind —
   carries a name scope: `Nothing` (⊥), `All` (⊤), or a proper `Of{include, exclude}`
   over schema and schema-qualified table patterns, with distinct ⊥ and ⊤ (II.2.3).
   Scope semantics are purely intensional over *names* (never a live catalog); ⊥ and ⊤
   are distinguished values so a disjoint meet is empty, never the universe. Composition
   is evaluated *pointwise per (key, object)*; the no-escalation invariant is a
   scope-lattice property (II.3).

## II.1 Crate layout and the policy/guard (PDP/PEP) seam

```
zero-migrate-policy       (new leaf; no SQL deps) — the Policy Decision Point (PDP)
  ├─ knob model: KnobDef, Polarity, KnobValue, EnforcementStatus, object_model
  ├─ registry:   PolicyRegistry (engine builtins + consumer extensions) + registry digest
  ├─ scope:      Scope { Nothing | All | Of { include, exclude } }, ScopePattern,
  │              name normalization, the scope lattice (⊥/⊤, ⊑, ⊓, ⊔) — II.2.3/II.3.1
  ├─ rules:      Rule { scope, kind } — kind ∈ Grant | Require | Inject | Validate
  │              + the rule evaluator (inject-then-validate over createTable/alter/rename IR)
  ├─ document:   PolicyDoc (strict TOML/JSON, registry-validated, versioned,
  │              default_scope + per-rule scope)
  ├─ algebra:    overlay (trusted config cascade) + restrict (trusted tightening
  │              gradient), the two TOTAL trusted combinators, in this module;
  │              finalize_ceiling (the fallible trusted-side conflict gate);
  │              TrustedDoc (provenance newtype — constructible ONLY from host-injected
  │              sources: RootCeiling + catalog entries registered at Engine::builder();
  │              overlay/restrict accept only TrustedDoc — H-1);
  │              Ceiling / EffectivePolicy (unforgeable, LAYERED — H-4)
  ├─ boundary:   admit(ceiling, draft) — the SOLE untrusted trust-boundary crossing (the
  │              only escalation-bearing operator; returns Result, rejects escalation).
  │              `ceiling` is a finalized `Ceiling`/`EffectivePolicy` (TrustedDoc-descended);
  │              `draft` is an untrusted `PolicyDoc`. Deliberately its OWN module, apart
  │              from the trusted combinators, so the one place a security check lives is
  │              unmissable.
  ├─ decide:     the DECISION-QUERY API (pure PDP; the only thing the guard calls):
  │                 grants(key, object)      -> Option<Value>   (loosest covering grant
  │                                              WITHIN the highest layer that covers the
  │                                              object, else fall through; II.3.2, H-4)
  │                 obligations(object)      -> Vec<Require>     (all covering requires)
  │                 injects_for(object)      -> Vec<InjectSpec>  (all covering inject rules)
  │                 validates_for(object)    -> Vec<ValidatePredicate>
  │              + scope resolution (pattern matching, normalization) lives ENTIRELY here
  └─ seal:       SealedPolicy (HMAC over rule set + registry digest + matcher version)
zero-migrate-ir           keeps op → required-grant-key mapping (string keys)
zero-migrate-guard        the Policy Enforcement Point (PEP) — a THIN adapter. Parses
                          SQL/IR → the set of (key, object) pairs an op touches, then
                          calls the PDP decision-query API. It MUST NOT re-implement
                          scope matching, normalization, or any lattice operation — it
                          holds no Scope and computes no ⊑/⊓; it only asks the PDP.
zero-migrate (engine)     runs the inject/validate rule evaluator during authoring/
                          lowering (also a PDP consumer via injects_for/validates_for),
                          consumes EffectivePolicy via EngineOptions;
                          optional TableShapeTransform escape hatch (II.4)
```

**The policy/guard seam (PDP/PEP).** Scope resolution — glob compilation, name
normalization (II.2.7), `⊑`/`⊓`/`⊔`, "which rules cover object *o*" — is a single
implementation living in `zero-migrate-policy`. The guard is a *policy-enforcement
point*: its whole job is (1) parse an op into the `(key, object)` pairs it references
(a `core.raw_sql` statement expands to one pair per referenced object, II.4.4), and
(2) ask the decision-query API. If the guard held its own `Scope` and matched names
itself, we would have two matcher implementations to keep bit-identical — the exact
class of drift Part I indicts (E1/E2). One matcher, one normalizer, one lattice;
everyone else queries. The decision-query API is therefore the *only* public policy
surface the guard, the engine's rule evaluator, and the declarative renderer see.

`crates/zero-migrate/policy-profiles/` is **deleted from the engine**. zeroship's
`confined.toml`/`platform.toml` move to the zeroship consumer (its control-plane repo
or a `zeroship-migrate-profiles` package) and are injected at engine construction.

## II.2 The knob model and the scoped rule model

### II.2.1 Knobs: an open registry with declared semantics

```rust
/// One policy knob, declared once. The declaration IS the machine.
pub struct KnobDef {
    /// Namespaced key: "core.raw_sql", "pg.role", "pg.rls",
    /// "op.lock_timeout_ms", "sec.require_rls", "acme.hypertable".
    pub key: KnobKey,
    pub kind: KnobKind,          // Bool | StrSet | UintCeiling { hard_floor } | OrderedEnum(&[...]) | Digest
    pub polarity: Polarity,      // see below
    pub default: KnobValue,      // the deny/none value — ALWAYS the tightest
    pub enforcement: Enforcement,// Enforced | DeclaredOnly — see II.6
    /// How a value of this knob attributes to database objects (II.2.5). Governs
    /// which scopes are LEGAL on a rule naming this key, and how the guard maps an
    /// op to the objects a grant must cover.
    pub object_model: ObjectModel,   // PerTable | PerSchema | Global
    /// Whether granting this knob presupposes a matching DB-role privilege — drives the
    /// least-privilege backing check (II.10.5): the executor refuses a policy that
    /// grants such a knob while it has SET ROLE'd into a floor role that lacks it. Part
    /// of the sealed registry digest (II.2.1 digest / II.7) because it is enforcement-
    /// affecting metadata; a seal minted under a def with a different `requires_db_privilege`
    /// must not verify.
    pub requires_db_privilege: bool,
    pub docs: &'static str,
}

/// The object granularity at which a knob's authority is meaningful.
pub enum ObjectModel {
    /// Authority is per table. Scopes may name schemas or tables. (columns, RLS,
    /// destructive-ops, raw-SQL-over-tables, index creation, table rewrite.)
    PerTable,
    /// Authority is per schema; table-granular scopes are illegal on this key.
    /// (`core.create_schema` — the authority to create a schema matching a
    /// schema-name scope — and other CREATE-in-schema effects that are not
    /// table-specific.)
    PerSchema,
    /// Authority is database-global — it cannot be attributed to any object subset.
    /// (`pg.extension`, `pg.role`.) A Global knob's `scope` is a legality marker whose
    /// only admissible value is ⊤ (`All`); it is EXEMPT from the `default_scope` meet
    /// (II.2.4/II.2.5). Any authored scope other than `All` is a hard load error at
    /// document-load time (II.2.5), never a silent narrowing.
    Global,
}

pub enum Polarity {
    /// Grants tighten downward: effective must satisfy draft ⊑ ceiling.
    /// Bool: implication. StrSet: subset. UintCeiling: ≤. OrderedEnum: rank ≤.
    Grant,
    /// Obligations tighten upward: effective = join(ceiling, draft);
    /// ceiling requirements can never be removed. Bool: OR. StrSet: union.
    Require,
    /// Opaque/pinned content: draft must equal ceiling unless the ceiling marks
    /// it delegable. Used for content that has no security ordering and cannot
    /// be statically inspected — digests of programmatic transforms (II.4),
    /// engine ids. NOTE: this is *no longer* how the system shape is pinned —
    /// declarative injection is a `Require`-polarity rule (II.2.2), and its
    /// mandatory-by-composition property subsumes the old `system_shape`
    /// pin. `Pinned` now only backs the opaque `TableShapeTransform` digest.
    Pinned { delegable: bool },
}
```

- **The engine registers its builtin knobs** (the current eleven vendor capabilities
  as `pg.*`/`core.*` grant keys, the two timeouts, `index_creation`, `table_rewrite`,
  `require_rls`, `no_hard_delete`, `sensitive_columns`, `destructive_ops`, and
  **`sec.require_approval`** — an OrderedEnum obligation `never ⊑ on_destructive ⊑ always`,
  `Require` polarity, `DeclaredOnly` enforcement, default `never` (M-2; the workflow-flag
  that II.7 formerly said was "not a policy knob at all" is now a first-class registered
  knob, host-read via the sealed decision query)). One table, one place; the guard, the
  seal validator, the composer, and the diagnostics all iterate the same registry. E1's
  five parallel definitions and E2's dead table collapse into this.
- **Consumers register extensions** at engine construction:
  `PolicyRegistry::with(&[KnobDef { key: "acme.hypertable", … }])`. Ops or
  consumer-side validators may require consumer keys; the guard's grant check is
  `effective.grants("acme.hypertable", object)` — string-keyed and scope-aware
  (II.2.3), no engine edit. The current `Op::vendor_capabilities()` mapping changes
  from returning enum variants to returning `KnobKey`s.
- **Strictness survives, but against the registry:** a document key unknown to the
  *registry* is a hard error (this is `deny_unknown_fields` with a runtime-extensible
  "known set"). `cross_schema`-style drift (a flag with no enum variant) becomes
  impossible: there is only one definition to drift from.
- **The registry has a canonical digest.** `PolicyRegistry::digest()` is a hash over the
  **full canonical `KnobDef` encoding** of every knob — the complete tuple
  `(key, kind, polarity, default, enforcement, object_model, requires_db_privilege)` — in
  key-sorted order. The digest MUST cover *every* enforcement-affecting field, including
  `requires_db_privilege` (II.10.5): two registries that agree on key/kind/polarity/
  default/enforcement/object_model but disagree on whether a `pg.*` knob presupposes a DB
  privilege enforce differently, so a seal minted under one must not verify against the
  other. This digest is bound into the seal (II.7): a `key` string means nothing without
  the *whole* def it resolves to, so a seal is only valid against the registry that minted
  it.

### II.2.2 Rules: four scoped kinds

A policy is not a flat map of knob values — it is a **list of scoped rules**. Every
rule pairs a `Scope` (II.2.3) with one of four kinds:

```rust
pub struct Rule {
    pub scope: Scope,      // which schema/table objects this rule addresses
    pub kind: RuleKind,
}

pub enum RuleKind {
    /// Capability permission — references a Grant-polarity KnobDef.
    /// Composes DOWNWARD (tighten), evaluated PER SCOPE (II.3).
    Grant   { key: KnobKey, value: KnobValue },
    /// Obligation — references a Require-polarity KnobDef.
    /// Composes UPWARD (union); ceiling requirements are un-droppable.
    Require { key: KnobKey, value: KnobValue },
    /// Content rule: columns/indexes/PK to add to matching createTable ops.
    /// Composes UPWARD (obligation polarity): a ceiling injection is mandatory
    /// and cannot be dropped by a draft (II.4). Static, declarative content.
    Inject  { spec: InjectSpec },
    /// Content rule: a structural predicate a matching table/op must satisfy;
    /// violations are rejected at resolve time. Composes UPWARD (accumulate).
    Validate { pred: ValidatePredicate },
}
```

`Grant`/`Require` reference registry knobs (their key's `KnobDef` supplies polarity,
kind, enforcement). `Inject`/`Validate` are *content* rule kinds that carry their own
payload (`InjectSpec` / `ValidatePredicate`, detailed in II.4) and do not reference
the knob registry — but they compose by declared polarity exactly like `Require`
knobs do: **union-up, ceiling wins, un-droppable.** That single fact is what lets
injection-as-a-rule deliver the "pin the shape" security property (II.4).

The engine default is the empty rule list: **no rules ⇒ grant nothing, require
nothing, inject nothing, validate nothing** (G1 stays dead — see II.4).

### II.2.3 Scope: a bounded lattice with distinct ⊥ and ⊤

The single most dangerous bug in a scope model is conflating **the empty set** with
**the universe**. The earlier sketch made empty-`include` mean "all objects" (a ⊤),
which collides with the natural representation of an empty scope (a ⊥). That collision
turns `⊓` of two *disjoint* scopes into the universe — the `restrict` of `raw_sql@staging`
and `raw_sql@analytics` becomes `raw_sql` **everywhere**, a straight privilege
escalation. So `Scope` gets an explicit three-case representation in which ⊥ and ⊤ are
distinguished values and `Of { include }` is **never empty**:

```rust
pub enum Scope {
    /// ⊥ — the empty scope, matches NO object. The identity of ⊔, the annihilator
    /// of ⊓. This is what a disjoint meet produces (never the universe).
    Nothing,
    /// ⊤ — every object. The identity of ⊓, the annihilator of ⊔.
    All,
    /// A proper scope. `include` is a NON-EMPTY union of patterns (empty `include`
    /// is illegal at construction — use `Nothing`). `exclude` subtracts; exclude
    /// WINS on overlap.
    Of { include: Vec<ScopePattern>, exclude: Vec<ScopePattern> },
}

/// A name pattern over schema and schema-qualified table names.
/// Exact ("app_main", "app_main.events") or glob ("app_*", "app_*.events",
/// "*.audit"). NOT regex — deliberately blunt for a security surface.
pub enum ScopePattern { /* compiled glob over one or two dot-separated segments */ }
```

Construction rules (enforced at document load and in the `Scope` smart constructor):

- `Scope::of(include, exclude)` with `include == []` is a **hard error** — the author
  must write `Nothing` (deny) or `All` (universe) explicitly. There is no empty-vector
  spelling of either extreme, so the ⊥/⊤ collision is unrepresentable.
- `Of { include, exclude }` where `exclude ⊇ include` (excludes cover every included
  object) **normalizes to `Nothing`**; the constructor is total.
- **⊤ is `All`, a SYNTACTIC token — `Of { include = ["*"] }` is NOT ⊤ for legality/
  attribution purposes, even though it denotes the same object set 𝒰.** `Of{["*"]}` and
  `All` are *semantically* equal (`Objects(Of{["*"]}) = Objects(All) = 𝒰`, so the
  **lattice** treats them interchangeably — `⊑`/`⊓`/`⊔` are defined over `Objects`), but
  the two **security legality gates that ask "is this scope ⊤?" use the SYNTACTIC test
  `scope == All`, not the semantic test `Objects(scope) == 𝒰`**:
  - The **Global-knob legality** check (II.2.5) admits only the literal `All` token; a
    Global rule authored `Of{ include = ["*"] }` is a load error, not a silent accept. A
    database-global grant must be spelled loudly and unambiguously.
  - The **unattributable-reference / unqualified-name check** (II.2.5) "matches only a
    ⊤-scoped grant" means only a grant whose `effective_scope` is the literal `All`; a
    `core.raw_sql` grant scoped `Of{ include = ["*"] }` does **not** admit an
    unattributable statement. Fail-closed: an author who wants "raw SQL truly everywhere,
    including things I can't attribute" must write the explicit `All`, so the blunt
    universal grant is never obtained by an incidental `"*"` glob.

  Everywhere else — ordinary object matching, the lattice, `default_scope` inheritance —
  `Of{["*"]}` and `All` behave identically (both cover every attributable object). The
  syntactic distinction is *only* the two loud-by-construction legality gates above.
- A `ScopePattern` addresses either a **schema** (one segment: `staging`, `app_*`) or a
  **schema-qualified table** (two segments: `app_main.events`, `tenant_*.audit`). A
  bare schema pattern matches every table in matching schemas — it is normalized to
  `schema.*` before any lattice operation (II.3.1, cross-arity).
- The object set a scope denotes:
  `Objects(Nothing) = ∅`, `Objects(All) = 𝒰` (the universe of all objects),
  `Objects(Of{inc,exc}) = Objects(inc) \ Objects(exc)`. **Exclude always wins**, so a
  rule can never be tricked into applying to an excluded object by adding includes.
- Scope semantics are **purely NAME-based / intensional** (A1): `Objects(S)` is defined
  over the *space of possible names*, never over a live catalog snapshot. `⊑`/`⊓`/`⊔`
  are decided by pattern algebra alone (II.3.1). No lattice operation ever reads
  `pg_catalog` or a connection; a scope's meaning does not depend on which tables
  happen to exist. (The guard, when enforcing, matches a *concrete* op's normalized
  object name against the resolved rules — but that is enforcement-time matching, not a
  lattice operation, and it too is name-based.)

Scope applies to **all four rule kinds**. Examples the design owner named:
  - `grant "core.raw_sql"` scoped `Of { include = ["staging"] }` — raw SQL only in
    schema `staging`.
  - `require "sec.require_rls"` scoped `Of { include = ["tenant_*"] }` — RLS obligation
    on tenant tables only.
  - `inject { audit columns }` scoped `Of { include = ["*"], exclude = ["*.journal"] }`
    — audit columns everywhere except the journal. (Note: "everywhere except X" is a
    proper `Of` with an explicit universe-include `*`, *not* `All` and *not* empty
    include; `All` carries no excludes.)
  - `validate { has_primary_key }` scoped `Of { include = ["app_*"] }`.

Because grants are now scoped, a Grant is no longer `(capability, value)` but
`(capability, scope, value)` — and the `draft ⊑ ceiling` check becomes **per-scope**
(II.3.2). Scope pattern-matching against a concrete op's normalized object name is a
pure function resolved in the PDP (II.1); the guard resolves the applicable rules for
an object only via the decision-query API.

### II.2.4 Per-policy default scope (narrow-only, provably)

A `PolicyDoc` carries an optional `default_scope` (a `Scope`; omitted = `All`). Every
**object-filterable** rule inherits it; a rule that declares its own scope has that
scope **met** with the default:

```
effective_scope(rule) =
    default_scope ⊓ rule.scope    if rule's key is NOT a Global knob   (scope-lattice meet, II.3.1)
    All                            if rule's key IS a Global knob        (Global exemption, II.2.5)
```

**The default-scope meet applies only to non-Global rules.** A Grant/Require rule whose
key has `object_model = Global` (II.2.5) carries a `scope` that is a *legality marker*,
not an object filter, and its only admissible authored value is `All`; that `All` is its
effective scope unconditionally — `default_scope` never narrows it. (`Inject`/`Validate`
rules carry no knob key and are always object-filterable — never Global — so they always
take the meet branch.) The narrow-only invariant below is therefore stated over the rules
where narrowing *means* something (every `PerTable`/`PerSchema` rule and every
inject/validate rule); Global-key rules are exempt by construction, which is exactly what
keeps the doc's `default_scope = app_*` + `pg.extension scope = all`
example legal (II.2.5).

Because `⊓` is a genuine greatest-lower-bound on the scope lattice (II.3.1), we have
`default_scope ⊓ rule.scope ⊑ default_scope` **for every input**, including the
adversarial ones the old empty-include model broke on:

- `rule.scope = Nothing` → `default ⊓ Nothing = Nothing ⊑ default`. ✓
- `rule.scope = All` → `default ⊓ All = default ⊑ default` (⊤ is the ⊓ identity — a
  rule that says "everywhere" gets exactly the default, never wider). ✓
- `rule.scope` disjoint from `default` → `Nothing ⊑ default` (disjoint meet is ⊥, the
  old bug's escalation to 𝒰 is gone). ✓
- `rule.scope ⊑ default` → the narrower scope. ✓

So `effective_scope(rule) ⊑ default_scope` holds **by the lattice law, not by a
runtime check** — widening is unrepresentable, and the previous "empty-include silently
becomes the universe" widening cannot occur because empty include is no longer a
representable scope (II.2.3). Since the whole document's authority is bounded by
`default_scope`, and each grant's effective scope is `⊑ default_scope`,
`effective = default ⊓ rule.scope ⊑ default` is a proven per-rule invariant, and the
property suite (II.9) asserts it on the ⊥/⊤/disjoint cases explicitly.

### II.2.5 Per-knob object attribution (the `object_model` contract)

A scope is only meaningful for a knob whose authority *can* be attributed to objects.
`KnobDef.object_model` (II.2.1) declares this, and the document loader enforces it:

- **`Global`** (`pg.extension`, `pg.role` — authority the database applies
  database-wide; a Global knob cannot be attributed to any object subset): a rule naming
  a Global key **must be authored with `scope = All`**. On a Global key the `scope` is
  **not an object filter — it is a legality marker** whose only admissible value is
  `All`; any *authored* scope other than `All` (an `Of{...}` or `Nothing`) is a **hard
  load error** (`ScopeIllegalForGlobalKnob`). This is *not* a silent normalize-to-⊤:
  refusing is the fail-closed choice, because "grant `pg.extension` on `app_*`" is a
  category error the author must see, not a request the engine can honor
  object-by-object.
  - **Global knobs are EXEMPT from the `default_scope` meet (Defect: global-knob vs
    default-scope contradiction).** Because a Global rule's `scope` is a legality marker
    and not an object filter, the II.2.4 narrowing `effective_scope = default_scope ⊓
    rule.scope` is **not applied to Global-key rules**: their effective scope is `All`,
    full stop, and `default_scope` never touches it. This is the specific carve-out that
    makes the doc's own example TOML below (`default_scope = { include = ["app_*"] }`
    together with `pg.extension … scope = "all"`) **LEGAL**: without the exemption, the
    meet `app_* ⊓ All = app_*` would silently produce a non-⊤ effective scope and the
    Global-legality check would then reject the very config the design intends. With the
    exemption, a Global rule authored `scope = All` stays `All` regardless of
    `default_scope`, and the narrow-only invariant (II.2.4) is preserved for every
    *non-Global* rule where object filtering is meaningful. A document with a narrow
    `default_scope` must still give every Global-key rule an *explicit* `scope = All`
    (omission does **not** inherit the narrow default for a Global key — it is a load
    error, so a Global grant is loud by construction); the exemption governs how that
    explicit `All` composes, not whether it must be written.
- **`PerSchema`**: scopes may name schemas; a two-segment (table-granular) pattern on
  such a key is a load error (`ScopeTooGranularForKnob`).
- **`PerTable`**: scopes may name schemas or tables freely.

**Op → object-set attribution.** The guard maps an op to the objects a grant must
cover *through* `object_model`:

- A `PerTable`/`PerSchema` op names its object(s) directly (the table/schema it
  targets, normalized per II.2.7).
- A `core.raw_sql` op's object set is **every object the statement references** —
  every table, view, and schema named anywhere in the parsed statement. The grant
  check succeeds only if the resolved `core.raw_sql` grant covers **every one** of
  those objects (∀-quantified, II.3.2). This is why "`raw_sql` only in `staging`" is a
  **statement-level referenced-object containment** guarantee: a statement that touches
  `staging.a` *and* `app.b` is denied, because `app.b` is outside the grant's scope.
  (This is not absolute containment — a body-carrying construct can reference objects
  the outer statement never names; those constructs are handled below. The backstop for
  what statement-level attribution cannot see is the DB-role least-privilege floor,
  II.10.5.)

**Raw-statement classification — a raw statement must ALSO clear the structured gate
for whatever it does (Defect: raw create/DDL bypass).** Injection is an IR transform
(II.4.4) and *cannot rewrite raw SQL text*. A raw statement the engine cannot
structurally attribute must therefore be denied under any scoped grant, never waved
through on the strength of "every referenced object is inside `core.raw_sql`". The
guard classifies every `core.raw_sql` statement by parsed shape and layers the matching
structured-grant checks **on top of** the referenced-object check above:

- **Raw DML** (`INSERT`/`UPDATE`/`DELETE`/`SELECT` with no schema-object side effect):
  passes on the referenced-object `core.raw_sql` check alone.
- **Raw create** (`CREATE TABLE`, `CREATE TABLE … AS` / CTAS, `SELECT … INTO`,
  `CREATE TABLE … (LIKE …)`, `CREATE TABLE … PARTITION OF …`, and every other spelling
  that brings a table into existence): must **additionally** pass the
  `core.create_table` grant at the new table's normalized name (II.2.6a) — the raw path
  gets no exemption from the namespace anchor. **AND — because injection cannot be
  applied to raw DDL — a raw create is DENIED whenever ANY `inject` rule (mandatory or
  not) covers the target object.** The structured DSL path is the *only* way to create a
  table inside any inject scope; a raw `CREATE TABLE app_x.t (…)` under a
  `core.raw_sql@app_*` grant is denied because an `inject` rule covers `app_x.t` and the
  engine cannot inject into raw text (`RawCreateInInjectScope`). A raw create is admitted
  only where **no** inject rule covers the target *and* `core.create_table` grants it.
- **Raw `CREATE SCHEMA`**: must additionally pass `core.create_schema` at the target
  schema (II.2.6a).
- **Raw rename / move** (`ALTER TABLE … RENAME TO`, `ALTER TABLE … SET SCHEMA`): must
  additionally pass `core.rename_into` at the *target* scope **and** is subject to the
  same post-move re-evaluation as the structured op (II.2.6b/d). Because the engine
  cannot re-run injection over the moved object via IR when the mover is raw text, a raw
  rename **into** any scope covered by an `inject` rule is DENIED (`RawRenameIntoInjectScope`) —
  the moved table would owe an injection the raw path cannot supply.
- **Raw alter of an injected object** (`ALTER TABLE … DROP COLUMN`/`RENAME COLUMN`/
  `ALTER COLUMN`, `DROP CONSTRAINT` of a pinned PK/index): must additionally pass the
  injected-shape-immutability checks (II.4.4 / `is_injected_shape`, II.2.6b) exactly as
  the structured op does; a raw statement gets no exemption from injected-shape immutability.
- **Opaque-body constructs** (`CREATE FUNCTION`, `CREATE PROCEDURE`, `CREATE TRIGGER`,
  `DO $$…$$`, and any construct whose body carries statements the outer parse does not
  model): see below — DENIED under any non-⊤ `core.raw_sql` grant.

The corresponding structured ops (`createTable`, `createSchema`, `renameTable`,
`alterTable`, …) already run these checks natively; the classification simply routes a
*raw* statement into the *same* gate so raw text can never be the escape hatch around
`core.create_table`, injection, or injected-shape immutability. If the parser cannot
classify a raw statement into exactly one of these shapes, it is treated as
unattributable (below).

- **Unqualified names / `search_path` are unattributable under a scoped grant
  (Defect: `search_path` attribution).** Under a non-⊤ `core.raw_sql` grant an object
  reference written **without an explicit schema** is UNATTRIBUTABLE — the engine will
  not run schema-resolution heuristics (there is no live `search_path` state to consult
  intensionally, and guessing is an escalation vector). An unqualified name therefore
  matches **only a ⊤-scoped grant** (like any unattributable reference below), so any
  raw statement containing an unqualified object reference is **denied under every scoped
  `core.raw_sql` grant** (`UnqualifiedNameUnderScopedRawSql`). Correspondingly,
  `SET search_path` (and every equivalent: `SET LOCAL search_path`,
  `SELECT set_config('search_path', …)`, a `search_path` `GUC` set in `ALTER ROLE`/
  `ALTER DATABASE`) is **REFUSED under any non-⊤ `core.raw_sql` grant**
  (`SearchPathUnderScopedRawSql`): a scoped grant cannot admit a statement that mutates
  the very name-resolution context attribution depends on. Only a ⊤-scoped `core.raw_sql`
  grant may carry unqualified names or touch `search_path`.

- **Opaque-body constructs are denied under scoped raw_sql (Defect: body indirection).**
  A `CREATE FUNCTION staging.f()` whose body writes `app.b`, a `CREATE TRIGGER`, or a
  `DO $$ … $$` block defeats statement-level attribution: the body's referenced objects
  are not visible to the outer parse, so a body-level write to `app.b` would sail past a
  `core.raw_sql@staging` grant. Therefore **`CREATE FUNCTION`, `CREATE PROCEDURE`,
  `CREATE TRIGGER`, `DO`, and any other opaque-body construct are DENIED under any non-⊤
  `core.raw_sql` grant** (`OpaqueBodyUnderScopedRawSql`) — only a ⊤-scoped `core.raw_sql`
  grant may author them, and even then the DB-role least-privilege floor (II.10.5) is the
  real backstop, because the engine cannot statically bound what a function body will do
  at execution time.

- An **unattributable or unparseable** reference (a statement the guard cannot resolve
  to a concrete normalized object set — dynamic SQL, an unqualified name under a scoped
  grant, a construct the parser does not model) matches **only a ⊤-scoped grant**. If the
  effective `core.raw_sql` grant is anything narrower than `All`, an unattributable
  reference is **denied**. Fail-closed: "I can't tell what this touches" resolves to
  "deny unless you were trusted with everything."

### II.2.6 Namespace authority: anchoring what a tenant may create, move, and drop

Scoped rules answer "what may this policy *do* to object *o*", but the "un-droppable
injection" guarantee (II.4) is **scope-relative**: it only pins objects that *exist and
match the inject scope*. Nothing yet stops a draft from creating a table whose name
falls *outside* every mandatory inject scope, or from renaming a table across a scope
boundary to escape an injection or a validation. We close all four evasions
(name-outside-scope, step-into-exclude, rename-TOCTOU, alter-drop) by making creation,
movement, and destruction of the *namespace itself* first-class, default-deny grants,
and by defining rule evaluation for `ALTER`/`RENAME`, not only `createTable`.

**(a) Scoped creation-gating as default-deny grants.** Three new `Grant`-polarity
knobs, each `default = deny` (the tightest value), `Enforced`:

```
core.create_table   (PerTable)   — may create a table matching this scope
core.create_schema  (PerSchema)  — may create a schema matching this scope
core.rename_into    (PerTable)   — may name/move a table INTO this scope
                                    (target of a RENAME / SET SCHEMA / CREATE-as)
```

Now the operator can *anchor* the namespace: an object can only come into existence
where `core.create_table` is granted, and a grant is bounded by the root ceiling like
any other. Crucially this lets the operator guarantee the **creatable ⊑ injected**
containment that makes injection un-evadeable:

> **Compose-time creatable-scope lint.** An operator may mark an `inject` rule
> `mandatory = true` in the root ceiling. At compose time, the composer computes, for
> each mandatory inject rule *I*, the effective `core.create_table` scope *K* the
> policy grants, and **errors unless `K ⊑ scope(I)`** (`CreatableEscapesMandatoryInject`,
> blame the draft when it is the draft that widened *K*). Because `⊑` is decidable and
> **sound** (a false "not-contained" only ever tightens — it can conservative-reject but
> never wrongly accept, II.3.1) and creatable-grants compose downward while injects
> compose upward, the lint is a decidable per-pair check that fails closed. Result: a
> tenant can create a table **only where a mandatory injection already covers it** — the
> injection can never be dodged by choosing a name the operator's inject scope forgot,
> because the tenant cannot create that name at all.
>
> **Injection can never be dodged (structured *or* raw path).** The un-evadeability
> above holds for the structured `createTable` op *and* for raw SQL: a raw `CREATE TABLE`
> (in any form — CTAS, `SELECT INTO`, `CREATE TABLE … LIKE`, `PARTITION OF`) is **denied
> wherever ANY `inject` rule covers the target object**, mandatory or not (II.2.5,
> `RawCreateInInjectScope`), because injection is an IR transform and cannot rewrite raw
> SQL text. The structured DSL path is therefore the *only* way to create a table inside
> an inject scope, and on that path a mandatory injection is un-droppable by union-up
> composition (II.4.2). A raw rename **into** an inject scope is likewise denied
> (II.2.5, `RawRenameIntoInjectScope`). So neither "choose a name the inject scope
> forgot", "create it raw", nor "create it elsewhere then rename it in" produces an
> un-injected table inside an inject scope.

**(b) Injected-shape immutability (columns, indexes, and the pinned PK).** Rule
evaluation is defined for the mutating ops, not just create. What counts as "injected"
is a **name-match-at-op-time** decision resolved by the PDP, *not* a
creation-provenance record:

> **`is_injected_shape(object, element)` — a pure PDP decision query.** The guard holds
> no `Scope`, no `InjectSpec`, and no normalization (II.1); it asks the PDP whether a
> concrete shape element on a concrete object is contributed by some covering inject
> rule. The PDP answers by: normalize `object` (II.2.7); gather the covering inject rules
> (`injects_for(object)`); and test whether `element` (a column name, an index name/key,
> or the primary-key constraint) name-matches an element any covering `InjectSpec`
> contributes. This is **name-match-at-op-time**: an object is treated as carrying an
> injected column/index/PK **iff a covering inject rule *right now* contributes a
> matching one** — regardless of how or when the object came to exist. In particular a
> table **renamed INTO** an inject scope that already carries a column/index/PK whose
> name matches the scope's injection is, from that moment, treated as injected and
> immutable; the guard need not know whether the author "declared" it or the injector
> produced it. Provenance is not tracked and cannot be spoofed by re-declaring an
> injected name as an author column.
>
> **[H3 SPEC FIX — full-conformance, symmetric with the create path] (spec-only;
> no code this phase).** Name-match is sufficient for *immutability* (whom to forbid
> altering), but it is NOT sufficient for *rename-into re-evaluation* (whether a
> renamed-in table already SATISFIES a mandatory injection). A table renamed into an
> inject scope could carry a column with the injected *name* but a divergent
> *type / nullability / default*, or an index with the injected name but a different
> *key*. Treating that as "already injected" on name alone would let a rename smuggle in
> a table that name-matches the operator's floor while structurally violating it. So the
> rename-into re-evaluation (bullet below) must require **FULL `InjectSpec` conformance**
> of every name-matching element — column type, nullability, and default must equal the
> injected column's; an injected index's key must equal the covering rule's; the pinned
> PK's columns must equal `InjectSpec.primary_key`. Any name-match with a structural
> **mismatch is a DENY** (`InjectedShapeConformanceMismatch`), never a silent accept.
> This is exactly **symmetric with the create path's `SystemColumnCollision`**: on
> create, an author column colliding with an injected name is rejected; on rename-into,
> a name-matching-but-diverging element is likewise rejected. The author must either
> present a fully-conformant shape or let the injector own those elements.

- An `ALTER TABLE … DROP COLUMN` / `RENAME COLUMN` / `ALTER COLUMN` (type/nullability)
  **on a column for which `is_injected_shape(object, column)` holds** is a guard denial
  (`InjectedColumnImmutable`) unless an explicit `core.alter_injected_column` grant
  (default deny, `Enforced`, PerTable) covers the object. Injected columns are the
  operator's floor; a draft cannot quietly strip them post-creation.
- An `ALTER TABLE … DROP CONSTRAINT <pk>` / a PK-replacing `ALTER` **on a table whose
  primary key `is_injected_shape` pins** (the covering inject rule carries
  `primary_key: Some(...)`) is a guard denial (`InjectedPrimaryKeyImmutable`) unless the
  same `core.alter_injected_column` grant covers the object. The pinned PK is part of the
  injected shape (`InjectSpec.primary_key`); dropping it is as forbidden as dropping an
  injected column.
- A `DROP INDEX` / index-replacing `ALTER` **on an index for which `is_injected_shape`
  holds** (the index name/key matches one a covering inject rule's `InjectSpec.indexes`
  contributes) is a guard denial (`InjectedIndexImmutable`) unless the same
  `core.alter_injected_column` grant covers the object. Injected indexes are part of the
  operator's floor exactly as injected columns are.
- A `RENAME TABLE` / `ALTER TABLE … SET SCHEMA` that would move a table **across a
  scope boundary** — i.e. the object's set of covering inject/validate/grant rules
  before ≠ after the move — requires `core.rename_into` on the *target* scope AND is
  subject to **re-evaluation**: after the rename, the engine re-runs inject
  applicability and every covering `validate` predicate against the moved table
  (II.4.4). A rename that would land a table in a scope whose mandatory injection it
  now lacks, or whose validation it now fails, is denied. **[H3]** For every element the
  target scope's mandatory injection contributes, the moved table must present a
  **fully `InjectSpec`-conformant** element of that name (type/nullability/default for
  columns; key for indexes; column list for the pinned PK) — a name-match with a
  structural mismatch is a DENY (`InjectedShapeConformanceMismatch`), symmetric with the
  create path's `SystemColumnCollision`. This closes the rename-TOCTOU: you cannot create
  `staging.t` (injection-free scope) and then rename it into `app_*` (mandatory-injection
  scope) to obtain an un-injected — or a lookalike-but-divergent — `app_*` table; the
  rename re-checks applicability *and full conformance* and denies.

**(c) A table-NAME `ValidatePredicate` (journal-lookalike defense).** Excludes on
mandatory injects are *published doors*: `inject … exclude = ["*.schema_migrations"]`
tells an attacker exactly which name dodges the injection. To keep excludes safe, the
operator pairs them with a **name predicate** that forbids a *tenant* from creating
names in the excluded set. `ValidatePredicate::TableNameForbidden { patterns }`
(II.4.2) is scoped over the creatable region and rejects, at resolve time, any
author-created table whose normalized name matches a reserved/lookalike pattern
(`*.schema_migrations`, `*.journal`, the operator's own bookkeeping). The exclude keeps
the *operator's* objects un-injected; the name predicate keeps a *tenant* from minting a
collision. Both are consumer-supplied rules — the engine ships only the predicate kind.

**(d) Rule evaluation covers `ALTER`/`RENAME`, not only `createTable`.** The rule
evaluator (II.4.4) dispatches per op class: `createTable` → inject + validate;
`alterTable`/`renameColumn`/`dropColumn`/`dropConstraint`/`dropIndex` →
injected-shape-immutability check (columns, pinned PK, and indexes, each via
`is_injected_shape`, II.2.6b) + covering validates that mention affected columns;
`renameTable`/`setSchema` → `core.rename_into` + re-run inject applicability + re-run
covering validates on the post-move object; `createSchema` → `core.create_schema`. An op
class with no defined policy interaction is a no-op for the evaluator (but still subject
to grant checks for its own key).

### II.2.7 Name normalization for scope matching

Scope matching compares an op's object name against patterns. Both must be reduced to
the *same* canonical form first, or an attacker escapes a scope by exploiting
identifier folding. Normalization is a single function in the PDP (II.1), applied to
**both** the pattern literals (at document load) and a concrete op's object name (at
enforcement), and it is part of the scope-matcher-semantics version sealed in II.7.

Rules (PostgreSQL identifier semantics; other dialects declare their own fold):

1. **Fold unquoted identifiers to lowercase.** PG downcases an unquoted identifier, so
   the catalog name of `App_x` is `app_x`. A pattern `app_*` therefore matches a table
   the author wrote as `App_x`. This is the fold an evasion tries to exploit ("I'll
   name it `App_x` so `app_*` misses it") — normalization defeats it.
2. **A quoted identifier is preserved verbatim** and is **distinct** from its unquoted
   fold: `"App_x"` normalizes to the byte-exact `App_x` and is a *different object* from
   `app_x`. A pattern must itself be quoted to match a quoted name; `app_*` does **not**
   match `"App_x"`.
3. **After folding, matching is byte-exact and case-sensitive.** Globs match over the
   post-fold bytes. No locale, no Unicode case-folding beyond PG's own ASCII downcasing
   of unquoted identifiers.
4. **Dots are structural only when unquoted.** `schema.table` is two segments;
   `"my.table"` is **one** segment (a table literally named `my.table` in the default
   schema), never `my`-schema/`table`-table. The segmenter splits on unquoted dots
   only, so a quoted dot cannot be smuggled past a two-segment pattern, and a table
   named `"a.b"` is not matched by the schema pattern `a`.

This closes the folding/quoting evasion lever: two names that PG considers the same
object normalize identically, and two names PG considers distinct never collide under a
pattern. Because the exact fold rules are **dialect-specific** and security-load-bearing
(PG downcases unquoted identifiers; another dialect may fold differently, or not at all),
the seal binds the **pair `(dialect, matcher_version)`** as its matcher-semantics
component (II.7): the same sealed scope `app_*` can fold differently under a different
dialect, so a seal minted for one dialect's normalization must never verify against
another's. The `matcher_version` integer identifies the glob-lattice + normalization
*algorithm*; `dialect` identifies which fold that algorithm applies. Both must match at
verify time or the seal hard-fails.

## II.3 The document and the composition algebra

```toml
# acme-ci.policy.toml
policy_version = 1              # E7: versioned; unknown major = hard error

# Optional policy-wide default scope every rule inherits and may only NARROW.
# Omitted default_scope = `all` (⊤). To deny by default, write `all = false` / an
# explicit include set. There is no empty-include spelling — that would be ⊥ (Nothing).
[default_scope]
include = ["app_*"]            # a proper `Of` scope; ⊤ is spelled `all = true`, ⊥ is `nothing = true`

# Each rule is [scope + kind]. `scope` is optional; omitted = the policy default —
# EXCEPT that a Grant-kind rule with no scope in a doc lacking `default_scope` is a
# hard load error (A3), never a silent ⊤. A grant must state its scope or inherit an
# explicit default; ambient "grant everywhere" is unrepresentable by omission.
[[grant]]
key   = "pg.extension"
value = true
scope = "all"                            # pg.extension is a GLOBAL knob (II.2.5): it MUST
                                         # be authored `scope = "all"` (a legality marker,
                                         # not an object filter). This is LEGAL even
                                         # though default_scope = app_* above, because
                                         # Global knobs are EXEMPT from the default-scope
                                         # meet (II.2.4/II.2.5): effective scope stays
                                         # `All`, NOT `app_* ⊓ All = app_*`. Authoring it
                                         # `app_*`, or OMITTING the scope so it inherits
                                         # the narrow default, is a load error.

[[grant]]
key   = "core.raw_sql"
value = true
scope = { include = ["staging"] }        # narrower than app_* → raw SQL only where EVERY
                                         # referenced object is in `staging` (II.2.5)

[[grant]]
key   = "core.create_table"              # namespace anchor (II.2.6): tenant may create
value = true                             # tables only inside app_* — and (if the ceiling
scope = { include = ["app_*"] }          # marks the inject mandatory) only where an
                                         # injection already covers them

[[require]]
key   = "sec.require_rls"
value = true
scope = { include = ["tenant_*"] }

[[inject]]                                # content rule (II.4)
scope   = { include = ["*"], exclude = ["*.journal", "public.schema_migrations"] }
columns = [ { name = "created_at", type = "timestamptz", nullable = false }, … ]

[[validate]]                              # content rule (II.4): forbid journal-lookalikes
scope     = { include = ["app_*"] }       # so an exclude on the inject is not an open door
predicate = { kind = "table_name_forbidden", patterns = ["*.journal", "*.schema_migrations"] }

[[validate]]
scope     = { include = ["app_*"] }
predicate = { kind = "has_primary_key" }
```

Each `grant`/`require` rule references a registry knob by `key`; the key's `KnobDef`
supplies polarity/kind/enforcement/object_model (the loader lints that a `[[grant]]`
entry names a `Grant`-polarity knob, a `[[require]]` a `Require`-polarity knob, and that
the rule's scope is legal for the key's `object_model` — II.2.5). `inject`/`validate`
carry content payloads. Every rule optionally carries a `scope`; omitting it inherits
`default_scope` (met narrow-only, II.2.4) — **except a Grant-kind rule**, which in a
document with no `default_scope` must state an explicit scope or fail to load (A3): a
grant may never acquire ⊤ by omission.

### II.3.1 The scope lattice

Scopes form a **bounded** lattice under set inclusion on the objects they denote, with
`⊥ = Nothing` and `⊤ = All` (II.2.3):

```
S₁ ⊑ S₂   iff   Objects(S₁) ⊆ Objects(S₂)
S₁ ⊓ S₂   = the scope denoting Objects(S₁) ∩ Objects(S₂)   (greatest lower bound)
S₁ ⊔ S₂   = the scope denoting Objects(S₁) ∪ Objects(S₂)   (least upper bound)
```

`Objects(Nothing) = ∅`, `Objects(All) = 𝒰`,
`Objects(Of{inc,exc}) = Objects(inc) \ Objects(exc)`.

Everything below is *decidable structurally* because patterns are globs over one or two
name segments, not regex. The three primitives — pattern∩pattern, `⊓`, `⊑` — are
specified precisely enough to implement and property-test. **`⊓` must be EXACT** (it
feeds `restrict`, hence the effective policy); **`⊑` for `admit` may
conservative-reject** (a false "not-contained" only ever *tightens*).

**Segment normalization / cross-arity.** Before any pair operation, normalize every
pattern to two segments: a one-segment schema pattern `P` (schema-only) becomes `P.*`
(the schema plus every table in it). Exact schema `staging` → `staging.*`. Now every
pattern is `⟨schemaGlob⟩.⟨tableGlob⟩`, and pair operations reduce to per-segment glob
operations. (Names are first passed through II.2.7 normalization.)

**Per-segment glob intersection `∩seg : Glob × Glob → Set<Glob>`.** A segment glob is a
literal, `*`, or a literal with a single `*` at any position — a **prefix** glob
(`pre_*`), a **suffix** glob (`*_suf`), or a general **infix** glob (`p*s` with a
literal prefix `p` and literal suffix `s`, either possibly empty). The model allows at
most one `*` per segment; this keeps intersection finite and closed. `∩seg` returns a
**set** of globs because the shared-`*` corner cases are not expressible as one glob.
Below, `|x|` is the byte length of literal `x`, and `pre*` denotes the prefix-only glob,
`*suf` the suffix-only glob, `p*s` the general infix glob:

- `* ∩seg g = {g}`;  `lit ∩seg g = {lit}` if `g` matches `lit`, else `∅`.
- `pre1* ∩seg pre2*` (both prefix globs): `{ (longer prefix)* }` if one prefix is a
  prefix of the other, else `∅`.
- `*suf1 ∩seg *suf2` (both suffix globs): symmetric — `{ *(longer suffix) }` if one
  suffix is a suffix of the other, else `∅`.
- **`pre* ∩seg *suf` (the prefix×suffix corner case): the result is a SET enumerating
  ALL consistent overlap lengths, not one or two globs.** A string `w` matches both iff
  `w` starts with `pre` and ends with `suf`. Every such `w` decomposes as "the `pre`
  prefix and the `suf` suffix, sharing an overlap of `o` characters in the middle", where
  the overlap `o` ranges over **`0 .. min(|pre|,|suf|)`** and each `o` yields a
  *distinct, non-subsumed* glob:
  - `o = 0` and the two pieces are separated by at least one character ⇒ the
    non-overlapping glob `pre*suf` (forces a non-empty middle).
  - `o = 0` glued with no separator ⇒ the literal `pre·suf` (empty middle) — only
    when a zero-length middle is a legal name.
  - `o = k` for `k ∈ 1..min(|pre|,|suf|)` ⇒ **valid only if `pre`'s last `k` bytes
    equal `suf`'s first `k` bytes**; if so it yields the literal formed by overlapping
    them (`pre` with `suf`'s tail appended past the shared `k`). An `o` whose forced
    bytes disagree is dropped.

  The enumeration is over the full `0..min(|pre|,|suf|)` range — emitting only "empty
  middle" + "non-empty middle" (two members) **under-approximates** whenever `pre` and
  `suf` share ≥1 character, silently dropping intermediate-overlap matches and breaking
  `∩`'s exactness. Every emitted overlap literal is ALSO subject to the joint length
  floor (the [H1 FIX] above): a literal shorter than `max(|pre_input|+|suf_input|)` is
  dropped.

  **[H2 FIX — corrected worked example, oracle-verified].** For `a_a_* ∩seg *_a_a`:
  `pre = "a_a_"`, `suf = "_a_a"`, `base = |pre|+|suf| = 8`, `floor = 4`. Enumerating
  overlaps `o` (where `pre`'s last `o` bytes equal `suf`'s first `o` bytes), witness
  length `= base − o`:
  - `o = 1`: `"_" == "_"` ✓ → literal `"a_a_" · "a_a"` = **`a_a_a_a`** (len 7).
  - `o = 2`: `"a_" == "_a"` ✗ — dropped.
  - `o = 3`: `"_a_" == "_a_"` ✓ → literal `"a_a_" · "a"` = **`a_a_a`** (len 5).
  - `o = 4`: `"a_a_" == "_a_a"` ✗ — dropped.

  Plus the infix `a_a_*_a_a` for the non-overlapping (`|w| ≥ base`) witnesses. So the
  EXACT set is **`{ a_a_a, a_a_a_a, a_a_*_a_a }`** — the design owner's vector, confirmed
  correct by the oracle. The instruction's extra fully-glued literal `a_a` (length 3) is
  **absent**: it is below the length floor 4, so admitting it would over-approximate (it
  is not matched by either input `a_a_*` / `*_a_a`, each of which needs `|w| ≥ 4`). The
  simpler `a_* ∩seg *_x` (no shared characters between `a` and `x`) is `{ a_x, a_*_x }`.
  The algorithm emits every consistent `o` that clears the floor, drops any glob subsumed
  by another in the set, and drops the whole result to `∅` only when no `o` is consistent.
- **`p1*s1 ∩seg p2*s2` (the general infix×infix case): reduce to the corner case under
  fixed end-constraints, THEN apply a per-input length floor.** A string matches both iff
  it starts with `p1` **and** `p2` (so one must be a prefix of the other — else `∅`; take
  `p = longer(p1,p2)`) and ends with `s1` **and** `s2` (one a suffix of the other — else
  `∅`; take `s = longer(s1,s2)`). The intersection is then `p* ∩seg *s` computed by the
  prefix×suffix rule above.

  **[H1 FIX — length floor, oracle-verified].** The prefix×suffix reduction alone
  OVER-approximates: it can emit a witness shorter than one of the two INPUT globs
  requires. Each input `pi*si` matches only strings of length `≥ |pi|+|si|` (a `*` spans
  *at least* the characters neither `pi` nor `si` account for; an infix `a*a` does NOT
  match `"a"`). So every emitted overlap witness `w` MUST be filtered by the joint floor
  `|w| ≥ max(|p1|+|s1|, |p2|+|s2|)`. Concretely `a*a ∩seg a*a` must be exactly `{a*a}`
  and must **NOT** contain the literal `"a"` (whose length 1 is below the floor 2) — and
  because it excludes `"a"`, `∩seg` is idempotent: `g ∩seg g` denotes exactly
  `Objects(g)`. (In the implementation, `p = longer(p1,p2)` and `s = longer(s1,s2)` give
  `base = |p|+|s| ≥ floor` always, so the infix `p*s` itself always clears the floor and
  is emitted verbatim; the floor only ever clips the finitely-many shorter *overlap
  literals*.) Prefix×prefix, suffix×suffix, and prefix×suffix are the special cases where
  one of `p1/s1/p2/s2` is empty.

Because `∩seg` returns a *set*, the two-segment `pattern ∩ pattern` is the Cartesian
product across segments, flattened:
`(sA.tA) ∩ (sB.tB) = { s.t | s ∈ sA ∩seg sB, t ∈ tA ∩seg tB }` (∅ if either segment
set is ∅). This is why `include` is a **union (Vec) of patterns and must stay one** — a
single-pattern representation cannot hold the multi-overlap corner cases.

**Scope meet `⊓` (EXACT).**

```
Nothing ⊓ S = Nothing        S ⊓ Nothing = Nothing        (⊥ annihilates)
All     ⊓ S = S              S ⊓ All     = S              (⊤ is identity — the OTHER operand, never 𝒰)
Of{iA,eA} ⊓ Of{iB,eB} = normalize( Of {
    include = ⋃_{a∈iA, b∈iB} (a ∩ b),        // pairwise pattern∩pattern, flattened (a Set<Pat>)
    exclude = eA ∪ eB                          // exclude-wins: unioning excludes only shrinks
} )
```

`normalize` folds an empty `include` set to `Nothing` and an `exclude` that covers
`include` to `Nothing`. **Two disjoint proper scopes therefore meet to `Nothing`, never
to the universe** — the old escalation (`raw_sql@staging ⊓ raw_sql@analytics` →
everywhere) is structurally impossible: disjoint includes give an empty pairwise
intersection, which normalizes to ⊥. `⊓` is exact because `∩` enumerates every glob in
the true intersection (including the corner case) with no over- or under-approximation.

**Scope join `⊔`** is `All`-absorbing / `Nothing`-neutral, else
`Of{ include = iA ∪ iB, exclude = eA ∩ eB }` **followed by a repair step**: an object
excluded by only one side but included by the other must survive, so the naive
`exclude = eA ∩ eB` over-includes; the exact join subtracts from `exclude` any pattern
region now covered by the other side's include.

**Scope-`⊔` is `⊒`-conservative (may denote a *superset*), and MUST NOT be used on any
security-enforced path.** Its only sanctioned consumers are **domain ESTIMATES** where
"cover at least the union" is the safe direction — never a coverage claim the escalation
check subtracts against:

- `coveredScope(P,k)` / `grantedScope(P,k) = ⋃ Objects(r.effective_scope)` (II.3.2) —
  folding one policy's several grant rules on a key into a single object-set *estimate*.
  Over-approximating this **widens the region the escalation check must clear**, which is
  the fail-closed direction.

**The `admit` escalation check MUST NOT `⊔`-materialize the ceiling side (C-1).** Because
`⊔` **drops excludes** (`exclude = eA ∩ eB` discards an exclude present on only one side),
a `⊔`-folded ceiling coverage OVER-states what the ceiling grants; used as the subtrahend
of `∖` it would UNDER-approximate the uncovered region and let `admit` **accept an
escalation** (the C-1 defect). So the `admit` grant path computes the uncovered region by
**iterated per-ceiling-rule `∖` subtraction** (II.3.2), where each ceiling rule's own
`effective_scope` (excludes intact) is subtracted individually — `⊔` never touches the
ceiling coverage. The `restrict`/`overlay` Require/Inject/Validate paths likewise do **not**
`⊔` two scopes into one — they union the *rule sets*, each rule kept at its own
`effective_scope`. (The earlier claim that "join's conservatism … can never widen an
enforced grant's value" was FALSE and is deleted: a `⊔`-folded ceiling in the antitone
position of `∖` widens exactly the region the check treats as *already covered*, which is
an escalation. The fix is structural — the enforced path never calls `⊔` on the ceiling.)

**Scope subset `⊑` (SOUND, including excludes).** `D ⊑ C` must hold iff *every* object
`D` denotes is one `C` denotes. Excludes make this non-trivial: `D`'s objects are
`Objects(D.include) \ Objects(D.exclude)`, and they must all be inside
`Objects(C.include)` **and** none may fall in `Objects(C.exclude)`. Formally:

```
D ⊑ C   iff   Objects(D.include \ D.exclude) ⊆ Objects(C.include)
        AND   Objects(D.include \ D.exclude) ∩ Objects(C.exclude) = ∅
```

with the base cases `Nothing ⊑ anything`, `S ⊑ All`, and `All ⊑ C` iff `C ≡ All`.
Decision procedure (structural, sound; may conservative-reject for `admit`):

1. Compute `Dobj = D.include \ D.exclude` as a scope (via `⊓` with the complement — in
   practice: for each `d ∈ D.include`, subtract `D.exclude`, keeping the pattern minus
   excluded regions as a `(include-pattern, local-excludes)` pair).
2. **Containment in `C.include`:** every `d`-region must be covered by *some* pattern in
   `C.include`. A glob `d` is covered by a glob `c` iff `Objects(d) ⊆ Objects(c)`, which
   for single-`*` segment globs is decided by the per-segment cover relation
   (`c = *` covers anything; `c = pre_*` covers `d` iff `d`'s matches all start with
   `pre`; etc.). A `d` not covered by any single `c` ⇒ **reject** (conservative: we do
   not attempt to prove coverage by a *union* of several `c` patterns — that is the
   sanctioned conservative-reject for the `admit` path).
3. **Disjointness from `C.exclude`:** `Dobj ∩ Objects(C.exclude)` must be empty, i.e.
   for every `d`-region and every `e ∈ C.exclude`, `d ∩ e = ∅` OR the overlap is
   itself already carved out by `D.exclude`. If any `C.exclude` pattern clips a
   `d`-region that `D` still includes ⇒ **reject**.

**The counterexample, resolved.** `D = Of{ include=[app_*] }` vs
`C = Of{ include=[app_*], exclude=[app_tmp_*] }`. Step 2 passes (`app_* ⊆ app_*`). Step
3 fails: `C.exclude = app_tmp_*` overlaps `D`'s region `app_*`, and `D` does not carve
`app_tmp_*` out, so `Dobj ∩ Objects(C.exclude) ≠ ∅` ⇒ **`D ⋢ C`**. Correct: `C` forbids
`app_tmp_*` and `D` would grant it, so `D` is *not* below `C`, and `admit`
rejects the escalation. (A naive "include ⊆ include" check would have wrongly accepted
it — that is precisely the excludes-aware hole this closes.)

**Scope difference `A ∖ B` (the partition primitive, fail-closed).** The ∀-object grant
check (II.3.2) needs one more operation the meet/join/subset trio does not provide: the
**uncovered region** of the draft's granted scope relative to the ceiling — the objects
the draft grants but the ceiling does *not* cover. This is a set difference
`A ∖ B = Objects(A) \ Objects(B)`, and unlike `⊓`/`⊔` it is not always cleanly
representable as a single `Of{include, exclude}` over one-`*`-per-segment globs (the
complement of a glob is not a glob). We therefore specify it as a **structural, best-
effort-but-fail-closed** operation, not an exact one:

**[C1 FIX — CRITICAL, oracle-verified]. The doc's earlier formula
`A∖B = Of{A.include, A.exclude ∪ B.include}` was WRONG — it silently dropped
`B.exclude` and UNDER-approximated the difference, which is the *escalation* direction.**
`A∖B` under-approximated means a truly-non-empty uncovered region can compute empty, so
the `admit` uncovered-region check (II.3.2) would wrongly ACCEPT an escalation.
The settled counterexample `A = {app_*}` vs `B = {app_*, exclude app_tmp_*}` **must stay
a reject**: `A ∖ B = Objects(app_tmp_*)` is non-empty (B excludes `app_tmp_*`, so those
objects are in `A \ B`), and the old formula would have carved `app_tmp_*` out of A's
excludes-plus-`B.include` and computed **empty** → wrongly accepted. The correct
semantics are **`Objects(A∖B) ⊇ Objects(A) \ Objects(B)`** (OVER-approximate — an
over-approx can only turn an accept into a reject, which is safe). Construct it as:

```
A ∖ B  ≝  ( Of { include = A.include, exclude = A.exclude ∪ B.include } )   // term 1:
                                                                             //  A minus B.include
       ⊔  ( A ⊓ Of { include = B.exclude } )                                // term 2: the
                                                                             //  B-exclude HOLES
                                                                             //  the old formula
                                                                             //  dropped
```

Term 1 denotes `Objects(A) \ Objects(B.include)`. Term 2 denotes
`Objects(A) ∩ Objects(B.exclude)` — the part of A that B *excluded* and therefore still
belongs to `A \ B`. Their `⊔` is `⊇ Objects(A) \ Objects(B)` (exact when B has no
excludes; the `⊔` may over-approximate, which is the safe direction). The base cases:
`A ∖ ⊤ = ∅`, `A ∖ ∅ = A`, `∅ ∖ B = ∅`, and `⊤ ∖ B` (B a proper scope) is
**not representable** (the complement of a glob is not a glob) ⇒ reject.

- **Soundness / fail-closed direction.** The construction OVER-approximates or rejects —
  it **never under-approximates**. In the one place `∖` is consumed — "is there a draft-
  granted region the ceiling does not cover?" — over-approximation is safe: a *larger*
  computed uncovered region can only turn an accept into a reject. The check is stated as
  "**if the uncovered region is non-empty ⇒ reject**". To make the fallback unambiguous:
- **CONSERVATIVE FALLBACK.** If `A ∖ B` **cannot be exactly represented** by the
  construction above (the residual excludes would require multi-`*` globs, or the
  emptiness of the result is not decidable by the structural `⊑`/`∩seg` machinery), the
  operation **returns "non-empty / not cleanly representable", and the caller REJECTS**
  (`UncoveredRegionNotRepresentable`). The engine never guesses that an
  un-representable difference is empty. This is the sanctioned conservative-deny: where
  the partition cannot be computed exactly, the security check fails closed, consistent
  with the "conservative deny, not best-effort analysis" stance for the whole grant path.

> **The scope lattice is now CODE-VERIFIED, not prose-reviewed.** This entire section
> (`normalize`, `⊑`, `⊓`, `⊔`, `∖`, and the per-segment `∩seg`) is implemented in the
> `zero-migrate-policy` crate's `scope` module and proven by a **brute-force oracle**
> (`scope::oracle`): over a bounded universe of concrete object names (alphabet
> `{a, b, _}`, segment length ≤ 3, one- and two-segment names) and a bounded universe of
> scopes, the oracle enumerates each object set with a DIRECT matcher (never the lattice
> ops) and asserts `Objects(a ⊓ b) == Objects(a) ∩ Objects(b)` (EXACT),
> `a ⊑ b ⟺ Objects(a) ⊆ Objects(b)`, `Objects(a ⊔ b) ⊇ Objects(a) ∪ Objects(b)`, and
> `Objects(a ∖ b) ⊇ Objects(a) \ Objects(b)` OR rejected — **never a strict subset**
> (the escalation direction is thereby provably impossible), plus `normalize`
> idempotence and the `∩seg` exactness meta-property over the full glob universe. Three
> prior prose reviews could not get the glob algebra right; where the doc and the
> oracle-green code disagree, **the code is authoritative and this section follows it.**
> The two escalation cases the corrections above target — a `∖` under-approximation and
> `a*a ∩seg a*a ∋ a` — are both asserted impossible by the oracle.

### II.3.2 Three composition operators — pointwise over (key × object)

There are **three** composition operators, and only ONE of them crosses a **trust
boundary**. Keeping them distinct is the whole security architecture: an operator authors
and combines *their own* policies with two **total, infallible, trusted** combinators
(`overlay`, `restrict`); a separate trusted-side gate `finalize_ceiling` lints the assembled
ceiling for *misconfiguration* (colliding injects/PKs — a loud operator error, NOT a trust
crossing, H-3); and the *untrusted* creator draft is admitted through exactly **one
escalation-bearing trust boundary** (`admit`). So "can reject" is true of both
`finalize_ceiling` (trusted-side config lint) and `admit` (untrusted escalation check), but
"crosses a trust boundary" is true of `admit` **alone** — the two properties are distinct
and only `admit` carries both.

| operator | relationship | semantics | inputs | crosses a trust boundary? | can reject? |
|---|---|---|---|---|---|
| `overlay(base, over)` | trusted config cascade (`base` + `env`) | **last-wins** (presence-based override) | `TrustedDoc × TrustedDoc` | no | **no — TOTAL** |
| `restrict(a, b)` | trusted tightening gradient (host ⊒ org ⊒ project) | **meet** (⊓) | `TrustedDoc × TrustedDoc` | no | **no — TOTAL** |
| `finalize_ceiling(assembled)` | trusted ceiling-conflict gate | conflict lint pass (identity on success) | assembled ceiling | no | **YES — but trusted-side (loud operator error, not a trust crossing)** |
| `admit(ceiling, draft)` | untrusted draft vs. **finalized** ceiling | layered `[draft] over [ceiling]` + **ceiling-inherited**, presence-override grants | `Ceiling/EffectivePolicy × PolicyDoc` | **YES — the only trust crossing** | **YES** |

Only `admit` carries **trust-boundary** security weight; `overlay`/`restrict` are the
operator's own algebra over policies **they author** (both inputs `TrustedDoc`, H-1) — the
operator is trusted with both inputs, so neither can escalate anything and both are TOTAL
(never reject). Ceiling *misconfigurations* (colliding injects, PK conflicts) are not
silently merged nor rejected inside the total combinators — they surface at the explicit
`finalize_ceiling` gate (H-3), which every assembled ceiling passes before it may be
`admit`'s ceiling; it is a **trusted-side loud error** (operator fixes their own config),
not a trust crossing. `admit` is the sole place an *untrusted* input (the creator's
`draft`) meets a *trusted* ceiling, so it is the sole place **escalation** is checked. It
stands apart in its own module (II.1 `boundary`) precisely so this asymmetry is impossible
to miss when reading or auditing.

The three used together (II.5): `overlay` assembles an operator's *own* per-environment
ceiling from co-authored profiles (`base + env`); `restrict` chains a *trust gradient*
of operator-authored ceilings (host ⊒ org ⊒ project); `admit` bounds the *untrusted*
creator against whatever ceiling those trusted steps produced.

#### The value-lattice primitives (shared by all three)

The grant check is **not** scope-containment-plus-a-scalar-value. A grant is a partial
function `Object → Value`: at an object `o`, the value a policy grants for key `k` is
the **loosest value any covering grant rule on `k` supplies at `o`** (there may be
several grant rules on one key in one layer — the earlier "one scalar `C_k`"
formulation could not express `timeout=60s@app_* + 600s@staging` and so missed the
escalation it hides).

Two DISTINCT rule-significance notions are needed and must never be conflated (the H-2
soundness split — collapsing them makes narrow-to-default impossible). Define, per
policy `P`, key `k`, object `o`, **within one layer** (H-4: `value`/`grants`/`covers`
are all layer-local; a layered `EffectivePolicy` queries the top covering layer, below):

```
value(P, k, o) = ⨆_value { r.value : r ∈ P.grants(k), o ∈ Objects(r.effective_scope) }
                 (the LOOSEST — join over the knob's value order — of all covering
                  grant rules; the knob default (tightest) if no rule covers o)

--- (a) the OVERRIDE / MASKING set — PRESENCE-based -----------------------------
coveredScope(P, k) = ⋃ Objects(r.effective_scope)
                       over ALL r ∈ P.grants(k)          // ANY value, incl. == default
                     (the object set where P has ANY grant rule on k, regardless of its
                      value — this is where P's value WINS over an inherited value, even
                      when P narrows k DOWN TO its default. "P.covers(k, o)" ≝
                      o ∈ coveredScope(P,k).)

--- (b) the ESCALATION-CHECK domain — NON-DEFAULT ------------------------------
grantedScope(P, k) = ⋃ Objects(r.effective_scope)
                       over r ∈ P.grants(k) WHERE r.value ≠ default
                     (the object set where P RAISES k above default; precisely the object
                      set where value(P,k,o) ≠ default. This — NOT coveredScope — is the
                      domain the ⊑-ceiling escalation check ranges over: a rule that only
                      restates the default cannot escalate, so it need not be checked.)
```

`grantedScope(P,k) ⊆ coveredScope(P,k)` always (a non-default rule is a covering rule).
They differ **exactly** on the objects where `P` explicitly *narrows `k` to its default*
— e.g. a draft writing `raw_sql = false` on a ceiling that grants `raw_sql = true`:
that object is in `coveredScope` (presence, so the draft's `false` WINS) but not in
`grantedScope` (value == default, so it is exempt from the escalation check — narrowing
never needs checking). This is what makes **narrow-to-default representable** (H-2): the
old single-notion definition (`grantedScope` = "raises above default") classified
`raw_sql = false` as *silent*, so the draft inherited the ceiling's `true` — the creator
asked for LESS and got MORE. The presence/non-default split fixes it. It also makes a
Global-knob narrowing (`pg.extension = false` over an inherited `true`) representable.

For a Bool knob "loosest" = OR; StrSet = union; UintCeiling = max; OrderedEnum =
rank-max. (Within one layer, more grant rules on a key can only *loosen* — a tenant
authoring multiple grants on one key never tightens itself by accident; the ceiling
check below is what bounds them.)

> **`overlay` already uses presence-based override** (its scalar last-wins is "where
> `over` has a covering rule, `over` wins" = `over.covers(k,o)`, II.3.2 overlay). `admit`
> now uses the SAME `covers`-based override for the inherit-vs-override decision, so the
> two operators' rule-significance rule is **explicit and consistent**: *presence* decides
> who wins the value; *non-default* decides who is escalation-checked.

#### `overlay(base: TrustedDoc, over: TrustedDoc) -> Ceiling` — trusted config cascade (last-wins), TOTAL

`overlay` assembles ONE operator's own ceiling from co-authored profile fragments
(`base + env`, II.5). It is **trusted-side only, enforced by the type system (H-1)** —
both inputs are `TrustedDoc`, a newtype constructible ONLY from host-injected sources
(the `RootCeiling` and catalog entries registered at `Engine::builder()`), so an untrusted
creator `PolicyDoc` **cannot be passed to `overlay`** (it is not a `TrustedDoc` and there
is no conversion). This closes the II.7 `extends`-laundering hole (H-1): a creator draft
can never reach `overlay` as an operand. `overlay` never rejects and never crosses a trust
boundary. **It is NEVER applied to an
untrusted creator draft.** Its semantics are **last-wins**: for every key `over` sets,
`over` wins; keys only in `base` pass through unchanged. Because `over` can set a knob
to *any* legal value, overlay can **ENABLE or DISABLE** — loosen *or* tighten — which is
exactly what a config cascade needs (dev enables `raw_sql`; prod tightens a timeout).
There is **no `⊑` constraint** on overlay: it is not a security combinator, it is the
operator composing their own layered configuration.

Semantics, pointwise, **per (key, object)**:

- **Scalar knobs — LAST-WINS, PRESENCE-based.** For grant/obligation values and the
  operational knobs (grants, obligation-knob values, and all per-op operational scalars —
  `op.statement_timeout_ms`, `op.lock_timeout_ms`, `sec.require_approval`,
  `sec.destructive_ops`, …): **where `over` has ANY covering rule on key `k` at object
  `o`** (`over.covers(k, o)`, presence — even one that restates the default), the result
  value at `(k, o)` is **`over`'s** value; otherwise it is `base`'s value. `over` wins
  outright — it may raise or lower the value with no ordering constraint, and it may lower
  `k` **to its default** (presence, not raises-above-default, is the override trigger — the
  same H-2 masking notion `admit` uses). (A key `over` does not mention at `o` inherits
  `base`'s value there.)
- **Rule LISTS — ACCUMULATE (union), in a fixed order.** The `inject` and `validate` rule
  lists are **unioned** across the two layers: every `inject` rule and every `validate`
  predicate from *both* `base` and `over` is kept, each at its own `effective_scope`.
  `over` does not *replace* `base`'s inject/validate rules; it *adds to* them. **[M-3]
  Inject-list order is `base`-first then `over`** — `overlay(base, over)`'s effective
  inject list is `base`'s inject rules (in document order) followed by `over`'s (in
  document order). This is the innermost two links of the cross-layer inject total order
  (II.4.4): a `base+env` pair sits with `base` OUTSIDE `env` (`… host → org → base → env →
  … → draft`), so the assembled ceiling's inject order is stable and drives the canonical
  column order → checksum deterministically. (These are the two content rule kinds; they
  have no single "value" a last-wins rule could overwrite — they are obligations, and
  obligations accumulate.)

So the split is precise: **scalar knobs are last-wins/presence-based (`over` overwrites
where it has any covering rule), rule lists (inject/validate) accumulate (union) in
base-then-over order.** `overlay` is total, associative-enough for `base + env` layering,
and consumes only the value-lattice primitives above — no `⊑` check anywhere, because it
is the trusted operator's own algebra. **`overlay` is TOTAL — it never rejects** (H-3);
inject/PK/index collisions between `base` and `over` are NOT rejected here — they are
caught by the fallible `finalize_ceiling` step every assembled ceiling passes before it
can be `admit`'s ceiling (II.3.2 `finalize_ceiling`, II.4.4).

#### `restrict(a: TrustedDoc, b: TrustedDoc) -> Ceiling` — trusted tightening gradient (MEET), TOTAL

`restrict` chains a **trust gradient** of operator-authored ceilings (host ⊒ org ⊒
project): it produces the **narrower of two ceilings** — the greatest lower bound — so
that each inner tier can only ever tighten the tier above it. It is **trusted-side only,
type-enforced (H-1)** — both `a` and `b` are `TrustedDoc` (host-injected), so an untrusted
draft cannot be a `restrict` operand — **total** (defined on every pair), and **never
rejects**. It is a genuine lattice **meet** (⊓), so it is associative and
commutative and a chain re-associates freely. **Pointwise**, per key:

- **Grant:** the restricted grant is the pointwise meet
  `value(restricted, k, o) = value(a, k, o) ⊓_value value(b, k, o)` (Bool AND, StrSet ∩,
  Uint min, rank-min) — and its domain is the scope meet
  `grantedScope(a,k) ⊓ grantedScope(b,k)`. Represented as the finite set of grant rules
  obtained by intersecting each `a`-rule's scope with each `b`-rule's scope (via `⊓`)
  and meeting their values; empty-scope products drop out. This is exact because `⊓` is
  exact — no `⊔`-scalar approximation anywhere on the grant path.
- **Require / Inject / Validate:** rule sets join upward (union, each rule at its own
  scope); valued Requires accumulate per-object as above.

`restrict` never rejects because a meet is defined on all pairs — that is exactly the
property `admit` lacks and why the two must be different operators (E3's "one name, two
semantics" is now two names). A `restrict` chain of ceilings composes below the root and
the final untrusted draft lands through `admit`. **`restrict` is TOTAL (H-3):** it unions
the two ceilings' inject/validate lists without inspecting them for conflict, exactly like
`overlay` — inject/PK/index collisions between two co-authored ceilings are NOT rejected
here. They are surfaced by the separate fallible `finalize_ceiling` step (below) that every
assembled ceiling must pass before it may be `admit`'s ceiling argument. Keeping `restrict`
total preserves the meet laws (associativity/commutativity) that the `restrict`-chain
equivalence theorem relies on — a *fallible* meet would break re-association.

#### `finalize_ceiling(assembled) -> Result<Ceiling, PolicyError>` — the ceiling-conflict gate (H-3)

`overlay` and `restrict` are total precisely so the composition algebra stays lawful, but
a trusted ceiling assembled by them can still contain a *misconfiguration* — two inject
rules that collide, a PK-pin conflict, a duplicate index name, an inject-vs-validate
self-contradiction across the merged layers. Those are real errors that must surface
**loudly** before enforcement; they simply must not live inside the total combinators.
So they move to one explicit, **fallible finalization step**:

```
finalize_ceiling(assembled: Ceiling) -> Result<Ceiling, PolicyError>
```

`finalize_ceiling` runs the ceiling-side conflict lints over the whole assembled rule set:

- **overlapping-scope inject/inject same-column** (two inject rules add a column of the
  same normalized name on scopes whose `⊓` is non-`Nothing`) → `CeilingInjectColumnConflict`;
- **PK-pin conflicts** (two inject rules pin different `primary_key` on overlapping scope,
  or conflicting `author_primary_key` Allow-vs-Forbid) → `CeilingPrimaryKeyConflict`;
- **duplicate index name** on overlapping scope → `CeilingIndexNameConflict`;
- **inject-vs-validate contradiction** across the merged layers (a `ForbiddenColumns` /
  `ColumnConstraint` that a ceiling-injected column can never satisfy on overlapping scope)
  → `CeilingInjectValidateContradiction`.

These are the **same lints** that II.4.4 attributes to "ceiling-vs-ceiling collisions" and
that admit's draft-vs-ceiling and single-doc load-time lints mirror — here run once over
the finalized ceiling. **Every assembled ceiling MUST pass `finalize_ceiling` before it may
be passed as `admit`'s `ceiling` argument** (the resolve-time "already collision-free
composed list" assumption of II.4.4 is *discharged by* this gate, not assumed). Concretely
the two-phase pipeline is:

```
env_ceiling = finalize_ceiling( overlay(base, env) )?          # trusted assembly, then finalize
effective   = admit(env_ceiling, creator_draft)?              # the sole untrusted crossing
# with a trust gradient:
ceiling     = finalize_ceiling( restrict(host_env, org_env) )?
effective   = admit(ceiling, creator_draft)?
```

`admit`'s `ceiling` parameter type is the finalized `Ceiling` (or an `EffectivePolicy`,
which is already finalized-by-construction), so "un-finalized ceiling reaches admit" is a
**type error**, not a runtime hazard. `finalize_ceiling` is idempotent and, being a pure
lint pass, does not change the rule set on success.

#### `admit(ceiling: Ceiling, draft: PolicyDoc) -> Result<EffectivePolicy, PolicyError>` — the SOLE trust boundary

`admit` is the **only** untrusted boundary crossing and the **only** place *escalation*
is checked. `ceiling` is a **finalized** `Ceiling` (or `EffectivePolicy`) — trusted,
`TrustedDoc`-descended, `overlay`/`restrict`-assembled and `finalize_ceiling`-passed
(H-1/H-3); the type forbids passing an un-finalized ceiling. `draft` is the **untrusted**
creator's `PolicyDoc` (H-1: the untrusted operand type is distinct from `TrustedDoc`, so
provenance is not something prose has to promise). `admit` returns `Ok(EffectivePolicy)` iff the draft escalates nothing, else it
`Err`s with a precise blame. Evaluated **pointwise per (key, object)**:

- **Grant rules — CEILING-INHERITED, narrow-only, PRESENCE-overridden (the footgun fix).**
  Grants in `admit` are **inherited from the ceiling and may only be NARROWED by the
  draft**, *not* draft-authoritative. `admit` produces a **LAYERED `EffectivePolicy`**
  (H-4) — it does NOT flatten draft + ceiling into one loosest-covering rule set, because
  a flat set cannot represent an OVERRIDE where the draft is *narrower* than a ceiling rule
  it overlaps (e.g. ceiling `timeout=30000@All` + draft `timeout=10000@app_*`: a flat
  loosest-covering query on `app_main.t` returns `30000`, discarding the narrower draft
  value; the draft's narrowing is silently lost). The complement region (`All ∖ app_*`)
  is not glob-representable, so the two rules cannot be flattened into one layer. Instead
  the effective grant value is defined **layer-by-layer with precedence**:

  ```
  # The admit layer stack (top precedence first):
  #     [ draft ]  over  [ ceiling ]          (ceiling itself may be layered, H-4 below)
  #
  value(effective, k, o) =
      value(draft, k, o)     if draft.covers(k, o)   # PRESENCE — the draft has ANY grant
                                                     #  rule on k covering o (H-2 masking
                                                     #  set), so the draft's value WINS here,
                                                     #  even a narrow-to-default value.
                                                     #  Admissible only if the escalation
                                                     #  check below passed; else admit REJECTS.
      value(ceiling, k, o)   otherwise               # the draft is SILENT here (no covering
                                                     #  rule) → INHERIT the ceiling's value,
                                                     #  by falling through to the next layer.
  ```

  Two changes from the earlier single-notion definition:
  - **Override is PRESENCE-based, not raises-above-default (H-2).** "The draft wins at
    `(k,o)`" means `o ∈ coveredScope(draft,k)` — the draft has *any* covering grant rule
    on `k` at `o`, at *any* value (II.3.2). So a draft that writes `raw_sql=false` over a
    ceiling `raw_sql=true` **narrows to default and wins** (the creator asked for less and
    gets less). Under the old `grantedScope` (raises-above-default) definition that draft
    was classified *silent* and inherited the ceiling's `true` — the footgun this closes.
  - **The result is a LAYERED policy, queried top-down (H-4).** `value`/`grants` fall
    through: query the **top layer** (`draft`) first, joining loosest-covering **only
    within that layer**; if the top layer has no rule covering `o` for `k`, fall through
    to the next layer (`ceiling`). The seal binds the **layer boundaries** (II.7) — a
    re-flattened rule set changes meaning, so it must fail the MAC. Everywhere the draft
    is *silent*, the effective value is the **ceiling's**, inherited — it does **not** fall
    to the knob default.

  This reverses the old draft-authoritative semantics. **Contrast:** previously the
  effective grant for `k` was the *draft's* grant map — so a draft that simply **omitted**
  a grant the ceiling allowed silently **lost** it (fell to the default-deny). That is the
  footgun: an operator whose ceiling grants `pg.extension@all` would find a creator who
  forgot to re-declare it silently stripped of it, an availability/usability trap that
  pushes creators toward over-broad drafts. Under **inherit-then-narrow**, a silent draft
  simply *keeps* the ceiling's grant; a draft that wants *less* narrows it explicitly
  (presence override, admitted because a narrow is `⊑` the ceiling); a draft that wants
  *more* is **rejected**.

  > **Operator hazard [M-4]: ceiling-inheritance turns a ceiling's grants into live
  > DEFAULTS that every silent creator holds.** Because a silent draft inherits the
  > ceiling's grant value, any grant an operator writes into a ceiling is *automatically
  > held by every creator who does not mention it* — convenient for benign grants
  > (`pg.extension`), but hazardous for grants that should be opt-IN per creator
  > (`core.skip_static_guard`, `core.alter_injected_column`, a ⊤-scoped `core.raw_sql`).
  > An operator must therefore treat "put it in the ceiling" as "grant it to everyone by
  > default". A **future** per-rule `inherit = false` opt-out is noted: an inject/grant rule
  > marked `inherit = false` would still BOUND the draft (a draft may narrow *up to* it) but
  > would NOT be inherited by a silent draft — the draft would fall to the knob default
  > unless it explicitly, admissibly claims the grant. This keeps hazardous grants
  > opt-in-per-creator while the ceiling still caps them. Deferred, not in this cut; called
  > out so the inheritance default is a deliberate, documented choice.

  **The escalation check ranges over `grantedScope` (non-default), not `coveredScope`.**
  For each grant key `k`, the draft is admissible iff **at every object `o` where the draft
  RAISES `k` above default, the draft's value is `⊑` the ceiling's value there**:
  ```
  ∀ o ∈ grantedScope(draft, k):  value(draft, k, o)  ⊑_value  value(ceiling, k, o)
  ```
  (Objects the draft narrows *to default* are in `coveredScope` but not `grantedScope`, so
  they are exempt — a narrowing can never escalate, so it needs no check. This is the
  second half of the H-2 split.) `⊑_value` is the knob's polarity order (Bool implication,
  StrSet ⊆, Uint ≤, rank ≤). This catches the multi-rule escalation the old scope-only
  check missed: with ceiling `timeout=60s@app_* + 600s@staging` and draft
  `timeout=600s@app_*`, the object `app_main.t` has `value(ceiling)=60s` (only the `app_*`
  ceiling rule covers it) but `value(draft)=600s` — `600 ≤ 60` is false ⇒ **reject**.
  Practically the check is decided *symbolically* over the pattern lattice, not by
  enumerating objects: partition the draft's granted scope by which ceiling rules cover
  each region (via `⊓`), and on each region compare the draft's loosest value to the
  ceiling's loosest value over that region.

  **The uncovered region — computed by ITERATED PER-CEILING-RULE SUBTRACTION, never by
  `⊔`-materializing the ceiling (C-1).** The "uncovered region" is the part of the draft's
  granted scope that **no ceiling grant rule on `k` covers** — where the ceiling's value is
  `default` (tightest), so any non-default draft value there is a straight escalation. The
  earlier draft computed it as `grantedScope(draft,k) ∖ grantedScope(ceiling,k)`. **That is
  UNSOUND (C-1):** `grantedScope(ceiling,k)` folds the ceiling's several grant rules into
  ONE scope via the `⊒`-conservative scope-`⊔` (II.3.1), which **drops excludes** and
  therefore denotes a *superset* of the ceiling's true coverage; sitting in the **antitone
  (right) position of `∖`**, an over-approximated subtrahend **under-approximates** the
  uncovered region — the *escalation* direction — so `admit` would ACCEPT an escalation the
  ceiling denies. Counterexample: ceiling grants `raw_sql` on `Of{[app_*], exclude=[app_secret]}`
  **plus** a disjoint `Of{[reports]}`; `⊔` drops the `app_secret` exclude, so
  `grantedScope(ceiling, raw_sql)` computes as covering `app_secret`; a draft
  `raw_sql@app_secret` then computes as *covered* and is **wrongly accepted** — but the
  ceiling explicitly denies `app_secret`.

  The uncovered region is therefore computed by **iterated subtraction of each ceiling
  grant rule's effective scope**, never by materializing the ceiling side with `⊔`:

  ```
  R := grantedScope(draft, k)                       # start with the whole draft-raised region
  for each ceiling grant rule r on k:               # subtract ONE ceiling rule at a time
      R := R ∖ Objects(r.effective_scope)           # ∖ over-approximates → fold stays fail-closed
  # after the fold, R is the (over-approximated) region no single ceiling rule covers
  if R is non-empty  AND  ∃ o ∈ R with value(draft,k,o) ≠ default  ⇒  REJECT
  if any R := R ∖ … step returns "not cleanly representable"       ⇒  REJECT (fail-closed)
  ```

  Each `∖` step **over-approximates** `R` (II.3.1 `∖` is `⊇` the true difference), so every
  step keeps *at least* the truly-uncovered objects; the fold therefore **never
  under-approximates** the uncovered region → `admit` cannot accept an escalation through it.
  Because the excludes on a ceiling rule are carried by `r.effective_scope` and `∖`'s
  construction retains a subtrahend's excluded holes (the C1 fix in II.3.1 keeps
  `B.exclude` as part of `A ∖ B`), the `app_secret` exclude in the counterexample survives:
  `app_secret` stays in `R` after subtracting both ceiling rules, the draft's value there is
  non-default ⇒ **reject** (correct). A non-representable `∖` at any step ⇒ reject
  (`UncoveredRegionNotRepresentable`) — the engine never treats an un-representable
  difference as empty. Errors carry `(knob_key, offending_object_region, draft_value,
  ceiling_value)`.

  > **Theorem (no-escalation is preserved under ceiling-inheritance): `effective ⊑ ceiling`
  > for EVERY key `k` and object `o`.** Take any `(k, o)`. The layered `value(effective,·)`
  > has exactly three arms, split on the draft's **presence** at `(k,o)` (`coveredScope`):
  > - *Case A — the draft is silent at `(k, o)`* (`o ∉ coveredScope(draft, k)`): the top
  >   layer has no covering rule, so the query falls through and
  >   `value(effective, k, o) = value(ceiling, k, o)`, `⊑_value` holds with **equality**.
  >   Inheriting can never exceed the thing inherited from.
  > - *Case B — the draft narrows to default at `(k, o)`* (`o ∈ coveredScope(draft,k)` but
  >   `o ∉ grantedScope(draft,k)`, i.e. the draft has a covering rule whose value == default):
  >   the draft wins by presence, so `value(effective,k,o) = value(draft,k,o) = default`,
  >   and `default ⊑_value value(ceiling,k,o)` holds because the knob default is the tightest
  >   value (II.2.1). This arm needs **no** escalation check — a value pinned at default can
  >   never exceed anything — which is why the check ranges over `grantedScope`, not
  >   `coveredScope`.
  > - *Case C — the draft raises above default at `(k, o)`* (`o ∈ grantedScope(draft, k)`):
  >   `admit` returned `Ok`, so the admissibility check
  >   `value(draft, k, o) ⊑_value value(ceiling, k, o)` passed (including the uncovered-region
  >   check that guarantees `value(ceiling,k,o)` is a real ceiling grant, not a `⊔`-inflated
  >   phantom — C-1), and `value(effective, k, o) = value(draft, k, o) ⊑_value value(ceiling, k, o)`.
  >
  > In all three cases `value(effective, k, o) ⊑_value value(ceiling, k, o)`. Since this holds
  > for every `(k, o)`, `effective ⊑ ceiling` pointwise over the entire (key × object)
  > universe — the no-escalation guarantee. **Inherit-then-narrow can never exceed the
  > ceiling**: the *only* three ways an effective value is produced are "copy the ceiling"
  > (equality), "the draft pinned it at default" (`⊑` trivially), and "a draft value the check
  > proved `⊑` the ceiling" (narrowing above default). There is no fourth path, so no
  > object/key can end up above the ceiling. ∎ (Property-tested over the whole bounded
  > universe in II.9 as the new `effective ⊑ ceiling` invariant, on the silent-inherit,
  > narrow-to-default, and explicit-narrow-above-default arms.)

- **Require rules (incl. valued Require, A5).** effective = ceiling's require rules
  **plus** the draft's, each at its own scope (union-up). A ceiling require can never
  be removed or scope-narrowed by the draft; the draft may only *add*. For a **valued**
  Require knob (e.g. `sec.sensitive_columns : StrSet`), the obligation at object `o` is
  the **per-object union** of every covering require rule's value:
  `obligation(k, o) = ⋃ { r.value : r covers o }` — obligations accumulate pointwise
  exactly as grants join pointwise, so a ceiling's required sensitive-column set can
  only grow, never shrink, under a draft. (Obligations still **union-up** — the
  ceiling-inheritance change touches only the grant arm; obligations were already
  ceiling-preserving by union.)
- **Inject rules:** union-up, each at its own scope; a ceiling injection is
  **mandatory and un-droppable** (II.4). Draft-vs-ceiling inject *collisions* are now
  rejected at **compose time** (II.6/II.4.4), not deferred to resolve time.
- **Validate rules:** union-up, accumulate; the effective predicate set is every
  covering ceiling predicate plus every covering draft predicate. A draft can add but
  never drop a ceiling predicate. A draft `Validate` that contradicts a ceiling
  `Inject` (e.g. `ForbiddenColumns` naming an injected column on overlapping scope) is
  rejected at compose time (II.6).
- **Pinned knobs** (now only the opaque `TableShapeTransform` digest, II.4): error
  unless `draft == ceiling` or the ceiling marks it delegable.

Chains of trusted ceilings compose with `restrict` (and each tier is assembled with
`overlay`, then `finalize_ceiling`); the final untrusted draft lands through `admit`. The
equivalence `admit(finalize_ceiling(restrict(a,b)), draft) ≡` "check `draft` against the
tightest chain" holds **pointwise over (key, object)** — because both trusted operators are
defined pointwise and total (`finalize_ceiling` only lints, it does not alter the rule set
on success), and `⊓_value`/`⊑_value` obey the lattice laws, the restricted ceiling's value
at every object is the meet of the chain's values there, so a draft grant admissible against
the `restrict` is exactly one admissible against every link. (Ceiling-inheritance does not
perturb this: on any object the draft is silent, `admit` against the `restrict` inherits the
restricted value = the meet of the chain's values, which is exactly what admitting against
each link in turn would inherit. Note the ceiling here is ONE layer — `restrict` flattens a
trusted chain into a single meet-layer; the *two-layer* structure `admit` builds is
`[draft] over [that finalized ceiling]`, H-4.)

All three operators are **one generic function each over the registry + the rule list**,
driven by each knob's declared polarity/value-order — no per-facet hand-written meet
remains to drift (E2, E3). The scope-lattice `⊓`/`⊑` and the per-knob value
`⊓_value`/`⊑_value` are the only primitives; every polarity reuses them.

**`EffectivePolicy` is unforgeable AND layered:** private fields, no `Deserialize`,
constructible only by `admit` from a **finalized** `RootCeiling`-descended ceiling — where
that ceiling was itself assembled by the trusted `overlay`/`restrict` combinators over
`TrustedDoc`s (H-1) and passed `finalize_ceiling` (H-3). It carries a **layer stack** —
`[draft] over [finalized ceiling]`, the ceiling itself possibly `[env] over [base]` (H-4) —
NOT a flattened rule set: `grants`/`value` query top-down (II.3.2), and the seal binds the
**layer boundaries** (II.7) so a re-flattened set fails the MAC. This replaces the
`OperatorCapability` token (E6) with a boundary that actually exists: you cannot hold an
`EffectivePolicy` you did not compose under the host's root — and you cannot hold one whose
grants are scoped wider, whose obligations/injections/validations are fewer, than the root
ceiling permitted.

## II.4 Injection & validation as first-class scoped rule kinds

The design owner's decision reverses the earlier "pull the shape out of policy"
framing. Injection and validation are **first-class, scoped policy rules** — not a
separate `TableShapeTransform` bolted alongside policy. This section shows why that is
an *improvement* on the original critique rather than a regression of it.

### II.4.1 Why moving injection back into policy does not reintroduce G1/I.4

The original critique had two distinct complaints, and the scoped-rule model resolves
each without giving up the other:

- **G1(a): injection was hardcoded zeroship CONTENT baked into the engine.** Fixed:
  the engine now ships only the rule **evaluator** (mechanism); the `inject`/`validate`
  *rules* (content) are consumer-supplied, exactly like grants and obligations. The
  mechanism/content split of II.0 principle 1 is preserved — the split is now "rule
  evaluator vs. rule content", not "policy vs. transform".
- **G1(b): injection was conflated with security via an implicit mechanism.** Fixed:
  injection is now *explicitly* a rule with a declared polarity (`Require`/union-up)
  and a declared scope. Nothing is implicit; the artifact records which inject-rules
  applied (II.4.5).
- **The engine default stays dead-simple (G1 stays fixed):** no rules ⇒ inject
  nothing, validate nothing, grant nothing. `PolicyDoc::deny_all` and the empty
  registry both yield the empty rule list. Omitting configuration injects *nothing* —
  the exact property G1 demanded. The old "`PolicyProfile::default()` silently injects
  seven columns" defect is gone because there is no default shape anywhere in the
  engine.
- **I.4's layering finding is resolved, not re-opened.** I.4 complained that
  `system_shape` was a *transform* masquerading as a *judging* policy facet, with a
  bespoke pin-or-delegate "meet" and checksum side-effects. Under the new model
  injection is honestly a rule with a *declared* union-up polarity (not a bespoke
  special case), scoped, and its checksum contribution is auditable via a recorded
  digest (II.4.5). The transform still runs in the authoring/lowering pipeline — but
  now as an evaluator over a declared rule set, not as a hardcoded preset.

### II.4.2 The four kinds, with inject/validate detailed

`inject` and `validate` compose **UNION-UP (obligation polarity)** — the same polarity
as `require`. This is the load-bearing decision:

> Because `inject` composes union-up, **a ceiling's injection is automatically
> mandatory and un-droppable by a draft.** That is *exactly* the "pin the shape"
> security property that the earlier draft's `authoring.shape_digest` `Pinned` knob
> was invented to buy.

So we **eliminate the `authoring.shape_digest` Pinned knob and the whole
"TableShape-out-of-policy" framing.** Injection-as-obligation-rule subsumes it: a
ceiling that injects zeroship's seven columns on `app_*` tables means no draft can
produce an `app_*` table without them, and no draft can drop them — union-up guarantees
it. No separate pin is needed.

```rust
/// Static, declarative injection content (the common case).
pub struct InjectSpec {
    pub columns:      Vec<IrColumn>,   // full IrColumn expressiveness, not a
                                       // 3-type text/timestamptz/integer whitelist
                                       // (fixes table_shape.rs:181-191)
    pub indexes:      Vec<IrIndex>,
    pub primary_key:  Option<Vec<String>>,   // pins the PK when Some
    pub author_primary_key: AuthorPkPolicy,  // Allow | Forbid — collision behavior
    /// Root-ceiling-only: when true, the composer enforces creatable ⊑ inject
    /// (II.2.6a); an author cannot create an in-scope table without this injection,
    /// and cannot create outside the injection's scope at all. `mandatory = true` on
    /// any NON-root layer (a catalog entry or a draft) is a **hard LOAD ERROR**
    /// (`MandatoryInjectOnNonRootLayer`) — never silently ignored — so a draft cannot
    /// author a would-be-mandatory injection and cannot mislead a reader into thinking a
    /// draft-level injection carries the creatable-scope lint. Only the host's root
    /// ceiling may mark an inject rule mandatory.
    pub mandatory:    bool,
}

/// Structural predicate a matching table must satisfy post-injection.
pub enum ValidatePredicate {
    HasPrimaryKey,
    ColumnNamePattern { require: Vec<Glob>, forbid: Vec<Glob> },
    ForbiddenColumns  { names: Vec<String> },
    ColumnConstraint  { column: String, ty: Option<ColType>, nullable: Option<bool> },
    RequireIndex      { columns: Vec<String> },
    /// Table-NAME predicate (II.2.6c): the created/renamed table's NORMALIZED name
    /// (II.2.7) must NOT match any pattern. Guards the "exclude on a mandatory inject
    /// is a published door" hole — forbids a tenant from minting journal-lookalikes
    /// in the excluded region.
    TableNameForbidden { patterns: Vec<Glob> },
    // A FIXED structural set. An open expression language is a noted follow-on
    // (II.7), deliberately deferred: small enough to be safe, enough to be useful.
}
```

All predicates evaluate over **normalized names** (II.2.7) — `ColumnNamePattern`,
`ForbiddenColumns`, and `TableNameForbidden` fold the same way scope matching does, so
a case-fold or quoted-dot trick cannot slip a forbidden name past a predicate.

### II.4.3 Collision, id-folding, and author-PK semantics move into the `inject` rule

The behaviors currently living in `table_shape.rs` move into the `inject` rule's
resolve semantics, **preserving today's behavior byte-for-byte**:

- **Column collision:** when an author-declared column name-collides with an injected
  column, error with `SystemColumnCollision` (today `table_shape.rs:14-19,112-116`) —
  *except* the id-folding cases below.
- **`id` folding:** `id: t.id(prefix)` and the identity-`id` replacement fold into the
  injected `id` column exactly as today (`table_shape.rs:98-127,207-218`): the author's
  prefix/identity is honored, the duplicate author column is dropped, and the injected
  `id` carries the folded prefix. The `validate_id_prefix` and
  `InvalidIdPrefixDeclaration` guards move with it.
- **Author primary key:** when the `inject` rule pins a PK (`primary_key: Some(...)`,
  `author_primary_key: Forbid`), an author-declared PK that is not the folded `id` PK
  is rejected with `AuthorPrimaryKeyForbidden` (today `table_shape.rs:129-137`). When
  the rule does not pin a PK (`primary_key: None`), the author's PK passes through.

### II.4.4 Collision timing and the cross-layer inject total order

The earlier draft deferred *all* inject collisions to resolve time. That is a DoS
vector: a draft could plant a latent `InjectColumnConflict` (a column that collides with
a ceiling-mandated or shared-pipeline injection) and thereby *break* a migration the
ceiling requires. So collision handling is split by **who is to blame**, and most of it
moves to **compose time** (II.6) — plus one check that runs even earlier, at **document
load** on a single document:

- **Single-document self-contradiction → LOAD-TIME lint error.** A single policy
  document (whether the root ceiling, a catalog entry, or a draft) that both `inject`s a
  column `X` and `validate`s `ForbiddenColumns` naming `X` (or a `ColumnConstraint` no
  injected column of `X` can satisfy) on **overlapping scope** is internally
  inconsistent — no in-scope table could ever both carry the injected `X` and pass the
  predicate that forbids it. This is decidable from the one document alone, so it is a
  **hard load error** (`SelfContradictoryInjectValidate`) raised when the document is
  parsed, before any composition. It complements the cross-document
  draft-`Validate`-vs-ceiling-`Inject` check below (which needs *two* layers); the
  single-doc case must not slip through to compose time (or worse, resolve time) as a
  surprise "every table fails validation".
- **Draft-vs-ceiling collisions → `admit` error (blame the draft).** Rejected
  at compose time, not resolve time: a draft `inject` whose column name, `primary_key`
  pin, `author_primary_key` Allow-vs-Forbid, or index name collides with a ceiling
  `inject` on **overlapping scope** fails composition (II.6). A draft can no longer
  weaponize a latent conflict against a ceiling-mandated migration.
- **Draft `Validate` contradicting a ceiling `Inject` → `admit` error.** e.g. a
  draft `ForbiddenColumns`/`ColumnConstraint` that a ceiling-injected column can never
  satisfy on overlapping scope — rejected at compose time (else every in-scope table
  would fail validation post-injection).
- **Ceiling-vs-ceiling collisions → `finalize_ceiling` error (loud operator error)
  [H-3].** Two trusted ceilings that inject conflicting columns/PKs on overlapping scope
  is an operator misconfiguration. It is **NOT** rejected inside `restrict`/`overlay` —
  those stay **TOTAL** (they simply *union* the inject/validate lists), so the composition
  algebra keeps its meet/last-wins laws. The conflict surfaces at the explicit fallible
  **`finalize_ceiling`** gate (II.3.2) that every assembled ceiling passes before it may be
  `admit`'s ceiling — as `CeilingInjectColumnConflict` / `CeilingPrimaryKeyConflict` /
  `CeilingIndexNameConflict` / `CeilingInjectValidateContradiction`. Both operands are
  trusted-side, so a collision is a misconfiguration (a loud operator error), never an
  escalation.
- **Resolve-time `InjectColumnConflict` is kept for exactly ONE case:** an
  *author-declared column* vs an *injected column* (the `SystemColumnCollision` path of
  II.4.3, modulo id-folding). This is a property of the specific migration's author
  input, unknowable at compose time, so it stays at resolve time.

**Cross-layer inject total order (part of the sealed payload).** When several inject
rules apply to one table, their columns must be laid out in a single deterministic
order, because that order becomes the table's column order → canonical bytes → checksum.
The order is a **total order** on applicable inject rules:

```
outermost ceiling layer first, then inward (host → org → project → … → draft);
within a layer, document order.
```

Equivalently: the effective inject list is the **concatenation** of each layer's
inject rules in layer order (outermost first), each layer contributing its rules in
document order. Concatenation is associative, so re-chaining ceilings does not perturb
the order — the composed rule list is order-stable under `restrict` re-association.
Within a resolved table, columns are emitted rule-by-rule in this order, then
author-declared columns (folded per II.4.3) in author order. This total order is
therefore **part of the sealed payload** (II.7): a tamper that reorders inject rules
changes the canonical bytes and fails both the checksum and the seal MAC.

Resolution per op (createTable; `alter`/`rename` per II.2.6d):

1. **`inject` rules apply in the total order above** (already collision-free — ceiling-side
   cross-layer conflicts were rejected by `finalize_ceiling` (H-3) and draft-vs-ceiling
   conflicts by `admit`, both at compose time; only author-vs-injected collisions remain
   and error here per II.4.3).
2. **`validate` rules then see the POST-injection table.** Every predicate whose scope
   covers the object evaluates against the fully-injected column/index/PK set — so
   `has_primary_key` is satisfied by an injected PK, `forbidden_columns` can forbid a
   column the author tried to add next to an injected one, `table_name_forbidden`
   rejects a lookalike name (II.2.6c), etc.
3. **Canonical bytes / checksum** are computed last, over the post-injection IR in the
   sealed inject order — the applied DDL is what gets checksummed, as today.

### II.4.5 The `TableShapeTransform` escape hatch (secondary, opaque)

The `TableShapeTransform` trait is **kept, but only as an optional programmatic escape
hatch** for *dynamic/computed* injection — a rule whose columns are computed at
resolve time rather than listed statically:

```rust
/// Optional programmatic injection: columns computed, not statically listed.
/// Clearly SECONDARY to the declarative `inject` rule; most consumers never
/// touch it.
pub trait TableShapeTransform {
    fn resolve(&self, ir: &MigrationIr) -> Result<MigrationIr, TableShapeError>;
    fn digest(&self) -> ShapeDigest;   // opaque content digest
}
```

Because a transform's content is **not statically inspectable**, it cannot compose as a
union-up obligation (the composer can't diff two opaque transforms). It therefore
composes as a **`Pinned`/opaque rule**: the ceiling pins the transform's `digest()`,
and a draft must present the same digest (unless delegable). *This* is the sole
remaining user of the `Pinned` polarity (II.2.1) — it is what the old draft's
`authoring.shape_digest` knob becomes, but now scoped to the narrow dynamic-injection
case rather than being the primary shape mechanism. Declarative `inject` rules — the
common path — need no pin because union-up already makes them mandatory.

### II.4.6 Checksum honesty (G6) — via digest for auditability, not policy

We keep a `ShapeDigest`/content-digest concept **only for artifact auditability**, not
as a policy knob. The artifact records which `inject` rules (and which programmatic
transform digest, if any) applied — a first-class, auditable field alongside the
checksum. Resolution still happens before canonical bytes (the applied DDL must be what
was checksummed), but *which* injection produced it is now recorded explicitly. A
consumer changing their inject rules gets a precise "injection digest changed"
diagnostic instead of a mystifying checksum drift (G6). The digest is not consulted by
`admit`/`restrict`/`overlay` except in the opaque-transform `Pinned` case above.

## II.5 Trust tiers, presets, and the root ceiling

### II.5.0 The `base + env` two-phase model — assemble trusted, then bound untrusted

An operator assembles a per-environment ceiling from their *own* co-authored profile
fragments with the **trusted** combinators, THEN bounds the **untrusted** creator draft
with the sole boundary operator:

```
env_ceiling = overlay(base, env)              # TRUSTED cascade: base is deny-by-default;
                                              #   dev ENABLES; prod TIGHTENS / adds obligations
effective   = admit(env_ceiling, creator_draft)   # UNTRUSTED boundary: the creator can only
                                                  #   NARROW; it can never escalate
```

Phase 1 (`overlay`) is trusted-side: **both** `base` and `env` are operator-authored, so
`overlay` may freely enable (dev) or tighten (prod) — last-wins, no `⊑` constraint. Between
phase 1 and phase 2 the assembled ceiling passes **`finalize_ceiling`** (H-3), which lints
it for inject/PK/index conflicts; only a finalized ceiling may be `admit`'s argument.
Phase 2 (`admit`) is the *only* trust crossing: whatever ceiling phase 1 produced,
`admit` guarantees the creator's effective policy is `⊑` it (II.3.2 theorem), so the
creator can never exceed the assembled ceiling.

**[M-5] Root-ceiling identity, catalog layers, and who may mark `mandatory`.** The
`RootCeiling` and the `ProfileCatalog` play distinct roles and must be pinned down so
`mandatory` and the creatable-lint have an unambiguous home:

- **The `RootCeiling` is the ONE host-injected document that establishes the floor and the
  `mandatory` injections** — the single document supplied to `Engine::builder().root_ceiling(…)`.
  It is *always* the outermost layer of every assembled ceiling. In the two-phase model the
  `RootCeiling` is **`base`** (the deny-by-default floor); each `env` fragment is a **catalog
  entry** overlaid *inside* it. So the layer order is `[env] over [base = RootCeiling]`, and
  the assembled `env_ceiling = finalize_ceiling(overlay(RootCeiling, env))` — `base` outermost,
  `env` inner, draft innermost at `admit` time.
- **`mandatory = true` is `RootCeiling`-only, and this is where II.4.2's rule bites.** An
  `env` catalog entry is a NON-root layer, so it may **not** set `mandatory = true`
  (`MandatoryInjectOnNonRootLayer`, II.4.2). Therefore **zeroship's 7-column mandatory
  inject must live in zeroship's `RootCeiling` document, NOT in a catalog entry** — this
  corrects the II.8 inventory (below), which previously placed it in "zeroship's catalog".
  It carries `mandatory = true`, which drives the `creatable ⊑ inject` compose-time lint
  (II.2.6a). Non-mandatory inject rules (audit columns, RLS-adjacent shape) may live in
  catalog entries and still compose union-up (mandatory-by-composition for droppability),
  but only a `RootCeiling` inject can carry the creatable-scope anchor.
- **"RootCeiling-descended", given `overlay` may loosen past `base`.** An assembled ceiling
  is **RootCeiling-descended** iff its outermost layer is *the* `RootCeiling` the engine was
  built with — a structural property of the layer stack, checked by construction (the
  combinators only ever place `TrustedDoc`s from this engine's `RootCeiling`+catalog into
  layers, and `finalize_ceiling` preserves the stack). It does **not** mean "tighter than
  `base` at every object": `overlay(base, dev)` legitimately *loosens* `base` (enables
  `raw_sql` in dev), so descent is about **provenance of the layers**, not a `⊑`-relation to
  `base`. The security guarantee that still holds is the *untrusted* one: `admit` proves
  `effective ⊑ assembled_ceiling` regardless of how the trusted layers loosened each other.
  `EffectivePolicy` is constructible only from a RootCeiling-descended, finalized ceiling —
  that is the unforgeability anchor (II.3.2), not a claim that the ceiling is `⊑ base`.

**Concrete fragments.** Three co-authored TOML fragments — deny-by-default `base`, plus
one `env` overlay per environment:

```toml
# base.policy.toml — deny by default; the floor every environment starts from
policy_version = 1
default_scope = "all"                                                 # every scopeless rule inherits ⊤ (A3)
[[grant]]  key = "core.raw_sql"              value = false            # scalar: no raw SQL (scope ⊤)
[[grant]]  key = "pg.extension"  scope="all" value = false            # Global: extensions off (⊤ mandatory)
[[grant]]  key = "op.statement_timeout_ms"   value = 30000            # scalar: 30s budget (scope ⊤)
```

```toml
# dev.policy.toml — dev ENABLES (overlay is trusted, so loosening is allowed)
policy_version = 1
default_scope = "all"                                                 # scopeless rules inherit ⊤ (A3)
[[grant]]  key = "core.raw_sql"              value = true             # ENABLE raw SQL
[[grant]]  key = "pg.extension"  scope="all" value = true             # ENABLE extensions
```

```toml
# prod.policy.toml — prod TIGHTENS a scalar + ADDS an obligation
policy_version = 1
default_scope = "all"                                                 # scopeless rules inherit ⊤ (A3)
[[grant]]  key = "op.statement_timeout_ms"   value = 10000            # tighten 30s → 10s
[[require]] key = "sec.require_approval"      value = "always"        # obligation: always approve (Require/DeclaredOnly, M-2)
```

**`overlay(base, dev)` result** — last-wins on the scalars `dev` sets, `base`
pass-through otherwise:

```
core.raw_sql             = true      # dev wins (base false → dev true; loosened, legal — trusted)
pg.extension @all        = true      # dev wins (ENABLED)
op.statement_timeout_ms  = 30000     # base pass-through (dev is silent)
```

**`overlay(base, prod)` result** — last-wins tightening + obligation accumulation:

```
core.raw_sql             = false     # base pass-through (prod silent)
pg.extension @all        = false     # base pass-through (prod silent)
op.statement_timeout_ms  = 10000     # prod wins (30s → 10s; tightened)
require sec.require_approval = always # obligation ADDED (require rules accumulate/union)
```

(If `base` and `env` each carried `inject`/`validate` rules, those **accumulate** — the
union of both layers' rule lists — rather than last-wins; only the scalar knobs
overwrite. See II.3.2 `overlay`.)

**Profile-catalog resolution `base + {dev, prod}`.** The `ProfileCatalog` (below)
resolves an environment name to its assembled ceiling by overlaying `base` with the
named `env` fragment:

```
catalog.get("dev")  = finalize_ceiling(overlay(base, dev))?    # → the dev env_ceiling above, finalized
catalog.get("prod") = finalize_ceiling(overlay(base, prod))?   # → the prod env_ceiling above, finalized
```

Here `base` is the host's `RootCeiling` (M-5) and `dev`/`prod` are trusted catalog `env`
fragments; both are `TrustedDoc`s (H-1), so `overlay` type-checks. The `overlay` result is
run through `finalize_ceiling` (H-3) so a colliding-inject misconfiguration surfaces loudly
before enforcement. Each finalized ceiling is then the trusted `ceiling` argument to
`admit(ceiling, creator_draft)` — and because `admit`'s `ceiling` param is the finalized
`Ceiling` type, an un-finalized `overlay` result cannot reach it. (A tier that also chains a
trust *gradient* — host ⊒ org ⊒ project — inserts `restrict` before finalize:
`admit(finalize_ceiling(restrict(host_env, org_env))?, draft)`.)

**The security argument, stated explicitly.** `overlay` may **enable** `raw_sql` and
`pg.extension` in `dev` *because it is trusted* — the operator authors both `base` and
`dev`, so there is no adversary on either input and loosening is the operator's own
choice. The **untrusted creator is still bounded by `admit`**: no matter how the
operator assembles the ceiling (which fragments they overlay, whether they enable or
disable in any env), `admit` proves `effective ⊑ env_ceiling` for every key/object
(II.3.2 theorem), so **the creator can never exceed whatever ceiling the operator
assembled.** Enabling in a trusted phase does not weaken the untrusted boundary; it only
sets *where that boundary sits*. The two phases are cleanly separated: trusted assembly
(`overlay`/`restrict`, total, never rejects) then the single untrusted crossing
(`admit`, the only fallible, security-bearing step).

- **`TrustProfile` / `SealedPosture` are deleted as public policy surface.** A "tier"
  is nothing but a named policy document in the *consumer's* catalog:

  ```rust
  pub trait ProfileCatalog {
      // Catalog entries are HOST-injected, hence TrustedDoc (H-1): they may be
      // `overlay`/`restrict` operands. A creator draft is never a catalog entry.
      fn get(&self, name: &str) -> Option<TrustedDoc>;
  }
  ```

  zeroship's catalog = `{confined, platform}` (its TOMLs, now living in its repo);
  the standalone CLI's catalog = `{local, trusted}`; a third tier ("staff") is one
  more document — extensibility score drops from 5 to 1. "There is deliberately no
  permissive" becomes a *zeroship catalog* property (G3), enforced where it belongs.

  > **Catalog trust guidance (H-1).** Every catalog entry is a `TrustedDoc` and therefore
  > an `overlay`/`restrict` operand that can *loosen* the assembled ceiling — so **an `env`
  > fragment must NEVER be creator-sourced.** The host registers catalog entries at
  > `Engine::builder().profile_catalog(…)` from documents *it* authors; a creator-supplied
  > document is always a `draft` passed to `admit`, never a catalog entry and never a
  > `TrustedDoc`. Wiring a creator-editable file into the catalog would let a creator loosen
  > their own ceiling — the exact laundering H-1 forbids. The type (`TrustedDoc` is
  > constructible only from host-injected sources) makes this a construction-site
  > discipline, not a runtime check, but the guidance is stated so no consumer wires an
  > untrusted source into `get()`.
- **The guard becomes posture-free, scope-aware, and matcher-free (PEP).** It consumes
  `EffectivePolicy` only through the decision-query API (II.1): it parses an op into the
  `(key, object)` pairs it references and calls `grants(key, object)` /
  `obligations(object)` / `validates_for(object)` — it holds no `Scope` and runs no
  `⊑`/`⊓` itself. The deny-list belt-skip is an ordinary Grant knob
  `core.skip_static_guard` (default false, `Enforced`). Today's
  `GuardConfig::confined/platform/trusted` constructors and the dialect fail-close
  (`guard/mod.rs:123-215,253-311`) reduce to one constructor
  `GuardConfig::from_policy(&EffectivePolicy, dialect)`; the SQLite/MySQL rule
  "descriptor-diff only, raw SQL refused" keys off `dialect` + the raw-SQL grant
  *evaluated at the op's object scope via the PDP*, not off a preset name.
  - **Raw SQL is checked against ALL referenced objects AND routed through the
    structured gate (II.2.5).** A `core.raw_sql` op's object set is *every*
    table/view/schema the parsed statement names; the guard denies unless
    `grants("core.raw_sql", o)` is loose enough at **every** such `o`. So "`core.raw_sql`
    only in `staging`" grants a statement confined to `staging.*` and denies one that
    also touches `app_main.*` — **statement-level referenced-object containment**, not a
    single-object check (not *absolute* containment — the DB-role least-privilege floor,
    II.10.5, backstops what statement-level attribution cannot see). Beyond the
    referenced-object check, the guard **classifies** the raw statement (II.2.5) and
    layers the matching structured gate on top: a raw create/CTAS/`SELECT INTO`/`LIKE`
    must also pass `core.create_table` and is DENIED wherever any inject rule covers the
    target (injection can't rewrite raw text); a raw `CREATE SCHEMA` must pass
    `core.create_schema`; a raw rename/`SET SCHEMA` must pass `core.rename_into` and is
    denied when it moves a table into an inject scope; a raw alter of an injected shape
    element is subject to injected-shape immutability; and `CREATE FUNCTION`/`TRIGGER`/
    `DO`, unqualified names, and `SET search_path` are DENIED under any non-⊤
    `core.raw_sql` grant. An unparseable/unattributable statement (incl. an unqualified
    name under a scoped grant) matches only a ⊤-scoped raw-SQL grant, else deny.
  - **Namespace ops are guarded too (II.2.6).** `createTable`/`createSchema` check
    `core.create_table`/`core.create_schema` at the target; a `renameTable`/`setSchema`
    across a scope boundary checks `core.rename_into` at the target *and* re-runs inject
    applicability + covering validates on the post-move object; an `ALTER/DROP/RENAME`
    of an injected shape element — column, pinned PK, or index, decided by
    `is_injected_shape` (II.2.6b) — checks `core.alter_injected_column`. These are
    ordinary Grant-knob decisions through the same decision-query API.

  Scoped grants thus make "`core.raw_sql` only in schema `staging`" a first-class guard
  decision. The dbmate posture (G4) is now just the CLI's `trusted` document — reachable
  in production, still impossible to reach *accidentally* because the host must put it in
  its catalog and compose it under its root ceiling.
- **The root ceiling replaces the token, and provenance is a TYPE (H-1).** Whoever
  constructs the engine supplies a `RootCeiling` — once, at build. Trust is encoded in the
  type system: the `overlay`/`restrict` combinators and the `admit` ceiling argument accept
  only `TrustedDoc`, and a `TrustedDoc` is **constructible only from host-injected sources** —
  the `RootCeiling` and catalog entries registered at `Engine::builder()`:

  ```rust
  /// A policy document of HOST provenance. Constructible ONLY here (crate-private
  /// inner), from a RootCeiling or a builder-registered catalog entry — NEVER from a
  /// creator-supplied string. This is the type-level encoding that keeps `overlay`/
  /// `restrict` from ever seeing an untrusted operand (H-1). A creator draft is a
  /// plain `PolicyDoc`; there is no `PolicyDoc -> TrustedDoc` conversion.
  pub struct TrustedDoc(PolicyDoc);           // private field; no public constructor

  pub struct RootCeiling(TrustedDoc);         // the outermost layer of every ceiling (M-5)
  ```

  The `inject`/`validate` *rules* live in the policy documents (root ceiling + catalog
  entries), so there is no separate shape argument; the only shape input to the builder is
  the *optional* programmatic `TableShapeTransform` escape hatch (II.4.5), omitted by almost
  everyone:

  ```rust
  let engine = Engine::builder()
      .registry(registry)
      .root_ceiling(root)               // RootCeiling: grants + obligations + inject/validate rules
      .profile_catalog(catalog)         // optional; catalog get() -> TrustedDoc (H-1)
      .shape_transform(dynamic)         // OPTIONAL escape hatch only; none by default
      .build()?;                        // the builder is the sole TrustedDoc mint site
  ```

  This is exactly the direction already chosen for the server split ("OperatorCapability
  token dissolves; trust = who runs the engine + which config is injected"). The
  standalone embedder's root is typically all-grants (they own the DB); zeroship's
  server root is its platform ceiling. There is no ambient `::new()` to mint (E6) —
  authority flows only through injected documents, and `admit` makes
  escalation a type-system impossibility rather than a code-review promise. The root
  ceiling is also where an operator marks an `inject` rule `mandatory = true` and pairs
  it with a bounded `core.create_table` grant + a `table_name_forbidden` predicate
  (II.2.6) — the three pieces that make an injection un-evadeable rather than merely
  present.
- **Operational ceilings stop being constants (G5).** The engine's *hard* invariants
  shrink to what is genuinely engine-generic: timeouts must be non-zero (the
  no-indefinite-lock invariant, kept as `KnobKind::UintCeiling { hard_floor: 1 }`).
  The 3 s / 60 s numbers move into zeroship's ceiling document. An outside host that
  wants a 10-minute statement budget writes it in *its* root ceiling — no fork.

## II.6 Honest enforcement: `DeclaredOnly` as declared metadata

Every `KnobDef` carries `enforcement: Enforced | DeclaredOnly`. The rules, applied
generically by the composer/sealer (replacing the hand-written `validate_for_seal`
scatter, E4):

- An `Enforced` knob flows into the guard/executor and does what it says.
- A `DeclaredOnly` knob (today: `no_hard_delete`, `sensitive_columns`, `role.attrs`,
  `index_creation=require_concurrent`, `table_rewrite≠allow`) **cannot be set to a
  non-default value in any document composed toward an enforced path** — the same
  fail-closed guarantee as today's `UnsupportedProfileKnob`, but visible in the
  registry, in generated docs, and in error messages ("`sec.no_hard_delete` is
  declared-only in this engine version; it is enforced by a server, not the engine").
  When the engine later grows the enforcement, the def flips to `Enforced` — a
  one-line, self-documenting change.
- Consequence: the authoring surface can no longer advertise capability the engine
  lacks, and granular capability compositions **seal fine** — the binary
  posture-inference (`profile.rs:1074-1091`, `1136-1148`) is deleted; the seal covers
  the effective knob map itself, and the guard is configured from that map, so every
  point of the lattice is realizable, not just the two preset corners.

## II.7 Cleanups the model forces

- **`DestructiveOps` splits** (E3): the ordered enforcement knob
  `sec.destructive_ops ∈ {forbid < warn < allow}` (Grant, OrderedEnum, Enforced). The
  approval workflow is **no longer a non-knob** [M-2]: `sec.require_approval` is now a
  real, registered policy knob (`never ⊑ on_destructive ⊑ always`, OrderedEnum, **`Require`
  polarity** — composes UP, un-lowerable — **`DeclaredOnly`** enforcement, default `never`;
  registered as a builtin, resolved per-object, and read by the HOST via the sealed
  decision query, not gated by the engine's own guard/apply). It appears in the II.2.1
  builtin registry list. The old guard `RequireApproval → Forbid` silent coercion
  (`guard/mod.rs:239-244`) is deleted — `sec.destructive_ops` and `sec.require_approval`
  are now two separate, independently-authorable knobs, so the coercion is unrepresentable.
- **`extends` gets safe semantics or dies** (E5, H-1). It resolves in the *document loader*
  against the injected `ProfileCatalog`, via the trusted cascade **`overlay`** —
  `resolved = overlay(catalog.get(base), this_doc)`. **But `extends` must NEVER launder an
  untrusted operand into `overlay` (H-1).** So the loader is split by provenance:
  - **Creator DRAFTS may NOT use `extends`** — a `draft` document carrying an `extends`
    field is a **hard LOAD ERROR** (`ExtendsForbiddenInDraft`). (Chosen over "resolve draft
    `extends` against trusted bases": a draft has no legitimate need to inherit a catalog
    base — the ceiling it is admitted against already carries the operator's floor — and
    forbidding it removes the whole class of untrusted-`extends` hazards outright.)
  - **Trusted documents** (the `RootCeiling` and catalog entries, both `TrustedDoc`) may use
    `extends`, resolved ONLY against **trusted catalog bases** (`catalog.get(base)` returns a
    `TrustedDoc`; a `base` name not in the trusted catalog is a load error) with **cycle
    detection** (a `base` chain that revisits a name → `ExtendsCycle`). The result is a
    `TrustedDoc`, so `overlay` still sees two trusted operands — provenance is preserved by
    construction, not by the loader remembering to check. This finally means what
    `platform.toml:2` has been implying, without the laundering hole the earlier shared
    loader opened. If not implemented in the same change, the field is removed from the schema.
- **Silent fallback dies** (G2): `from_toml_or_confined` is replaced by
  `PolicyDoc::parse(&str) -> Result<…>` (loud) and `EffectivePolicy::deny_all(&registry)`
  (the engine-derived floor: the **empty rule list** — every Grant at its default-deny,
  no Require rules, no Inject rules, no Validate rules). Hosts that *want* a fallback
  opt into `deny_all()` explicitly — and it never injects columns.
- **`validate` predicate surface starts fixed** (II.4.2): the structural set
  (has-primary-key, column-name-pattern, forbidden-columns, type/nullability
  constraint, require-index). An open predicate expression language is a **noted
  follow-on**, deliberately deferred — small enough to stay safe now, extensible later
  by adding `ValidatePredicate` variants.
- **Seal mechanics are kept, but the payload binds registry + matcher identity** (E6/Q7).
  MAC, nonce set, `issued_at` window, `ceiling_version` are kept as-is
  (`profile.rs:1287-1317` are sound). The MAC'd payload becomes:
  1. the **canonical resolved scoped rule set, WITH its layer boundaries** (H-4) — grants +
     requires + injects + validates, each with its `effective_scope` **and its layer tag**
     (`draft` vs `ceiling`, and within the ceiling `env` vs `base`), in the sealed
     **cross-layer inject total order** (II.4.4). Because `admit` produces a *layered*
     `EffectivePolicy` whose `grants` query falls through top-down (II.3.2), a flattened
     re-encoding that merged the layers into one loosest-covering set would change the policy's
     meaning (an override where the draft is *narrower* than a ceiling rule would be lost). So
     the seal binds the layer boundaries: a re-flatten OR a reorder tamper fails the MAC;
  2. a **registry digest** — the canonical `PolicyRegistry::digest()` (II.2.1) over the
     **full canonical `KnobDef` encoding** of every knob, i.e.
     `(key, kind, polarity, default, enforcement, object_model, requires_db_privilege)`.
     Every enforcement-affecting field is covered, `requires_db_privilege` included
     (II.10.5) — a registry that flips whether a `pg.*` knob presupposes a DB privilege
     enforces differently. A `key` string is meaningless without the whole def it resolves
     to; binding the digest stops a seal minted under registry A being replayed on an
     engine built with registry B where the *same key* means something different (a
     realistic within-fleet attack when a MAC key is shared across engine builds);
  3. a **scope-matcher-semantics component `(dialect, matcher_version)`** — `matcher_version`
     is an integer identifying the normalization + glob-lattice *algorithm* (II.2.7, II.3.1);
     `dialect` identifies which identifier fold that algorithm applies (normalization is
     dialect-specific — PG downcases unquoted identifiers, another dialect may not). If two
     engines disagree on how `app_*` folds (different dialect) or how `⊑`/`⊓` decide
     (different `matcher_version`), the *same sealed scope* would enforce differently;
     binding the **pair** makes that a hard verifier failure.

  The verifier **HARD-FAILS** on any mismatch of (2) or (3) — including a
  `dialect` mismatch or a `matcher_version` mismatch — so a seal is valid only against
  the exact registry and matcher semantics (dialect + algorithm) that minted it.
  `SealedPosture` disappears.
- **`TableShapeTransform.digest()` is HOST-TRUSTED, not a security control** (Q7). The
  transform is supplied by the engine *builder* (the host), so its `digest()` is an
  honor-system content tag used for the `Pinned` equality check and for auditability
  (II.4.5/II.4.6) — it is **explicitly not** a defense against a *hostile* transform. A
  transform that lies about its digest, or mutates IR outside its declared scope, is
  outside the threat model: the host that installs a transform already owns the engine.
  This is documented at the trait so no one mistakes the opaque digest for a
  tamper-proof boundary the way E6's old token was oversold.

## II.8 What zeroship supplies after the split (consumer inventory)

| Was (engine-embedded) | Becomes (zeroship-supplied) |
|---|---|
| `policy-profiles/confined.toml` / `platform.toml` (`profile.rs:34-39`) | documents in zeroship's repo, injected via `ProfileCatalog` |
| 7-column `system_shape` in Rust/TOML/tests (`profile.rs:192-248`) | one **`inject` rule** in zeroship's **`RootCeiling` document** (NOT a catalog entry — `mandatory = true` is `RootCeiling`-only, II.4.2/M-5), scoped `Of{ include = ["*"], exclude = [` system/journal tables `] }` (all app tables minus bookkeeping); carries `mandatory = true` (drives the `creatable ⊑ inject` lint, II.2.6a) — plus mandatory-by-union-up droppability; anchored by a `core.create_table` grant `⊑` the inject scope (II.2.6) and a `table_name_forbidden` predicate over the excluded names |
| RLS obligation / hard-delete / sensitive columns | scoped **`require`**/**`validate`** rules (e.g. `require sec.require_rls scope tenant_*`, `validate has_primary_key scope app_*`) in zeroship's catalog |
| `PLATFORM_*_CEILING_MS` constants (`profile.rs:30-31`) | values in zeroship's root-ceiling document |
| "no permissive preset" (`profile.rs:115-124`) | zeroship's catalog simply doesn't contain one |
| `TrustProfile::Confined/Platform` wiring | two catalog entries; guard reads the composed policy |
| declarative renderer's `PolicyProfile::confined().system_shape` (`declarative.rs:1737`) | inject-rule set handed down from zeroship's toolchain config (or the rule evaluator run at render time) |

## II.9 Breakage & migration

Pre-launch, no external engine users are known; favor the right shape.

- **Breaks:** `PolicyProfile` (4-facet struct), `PolicyCapabilities`,
  `TableSystemShapePolicy`-in-policy, `SealedPosture`, `TrustProfile`-as-API,
  `OperatorCapability`/`SealApplier`, `GuardConfig::{confined,confined_sqlite,confined_mysql,platform,trusted}`,
  `ExecutorConfig::{platform,trusted}` + its `trust/platform_schemas/platform_exts/operator_cap`
  fields, `preset()`, `from_toml_or_confined`, both embedded TOMLs, and every test
  pinning the 7 columns inside the engine (those move to zeroship-side conformance
  tests). `resolve_create_table_policy`'s hardcoded shape logic moves into the
  `inject`-rule evaluator. One PR-train, no shims, per the no-back-compat stance.
- **Wire/journal:** artifacts gain an explicit record of the applied `inject`-rule
  set (+ any opaque transform digest); zeroship's checksums churn once (acceptable
  pre-launch). The seal payload schema changes (in-process contract; no compat needed).
- **Order of work:** (1) `zero-migrate-policy` crate (the PDP): registry + registry
  digest + name normalization (II.2.7) + scope lattice (⊥/⊤, exact `⊓`, sound `⊑`,
  glob `∩seg`) + the four rule kinds + pointwise knob algebra + decision-query API +
  `EffectivePolicy` + property tests. The property suite must include, **as explicit
  enumerated cases (a random generator will not reliably hit them)**:
  - **scope lattice edge cases:** `S ⊓ Nothing = Nothing`, `S ⊓ All = S`,
    **disjoint `⊓` = Nothing** (never 𝒰 — the escalation regression), `S ⊑ All`,
    `Nothing ⊑ S`, `All ⊑ S ⇒ S = All`, `default ⊓ rule.scope ⊑ default` on
    {⊥, ⊤, disjoint, nested} rule scopes (II.2.4);
  - **glob `∩seg` corner cases:** the two-member shared-underscore case
    `a_* ∩seg *_x = {a_x, a_*_x}`; the **multi-overlap case** (oracle-verified)
    `a_a_* ∩seg *_a_a = {a_a_a, a_a_a_a, a_a_*_a_a}` (all *floor-clearing* consistent
    overlap lengths — the too-short `a_a` is excluded by the [H1] length floor); the
    **[H1] idempotence/floor case** `a*a ∩seg a*a = {a*a}` (must NOT contain `a`); the
    **infix×infix case** `p1*s1 ∩seg p2*s2` (e.g. `ab_*_yz ∩seg a_*_z` reduced to
    `ab_* ∩seg *_yz` under joint end-constraints); prefix-nesting, suffix-nesting,
    cross-arity `app_*` vs `app_*.*`, `*`/exact; plus the **exactness meta-property**
    (the oracle's core assertion): for every `w` in a bounded universe, `w` matches BOTH
    inputs iff `w` matches some glob in `∩seg`'s output (no over- or under-approximation);
  - **excludes-aware `⊑`:** the counterexample `{app_*} ⋢ {app_*, exclude app_tmp_*}`;
  - **pointwise grant (`admit`):** `timeout=600s@app_*` rejected under ceiling
    `60s@app_* + 600s@staging` (multiple ceiling rules on one key), and its Bool/StrSet
    analogues;
  - **the three operators — trust/fallibility contracts (the oracle asserts each over
    the whole bounded universe):**
    - **`overlay(base, over)` — TOTAL, last-wins (PRESENCE-based), no `⊑` constraint.**
      Never returns an error (total over all pairs — even when `base`/`over` inject rules
      collide; that surfaces at `finalize_ceiling`, not here). For every **scalar** knob and
      object, the result value == `over`'s value where `over` has ANY covering rule
      (presence), else `base`'s value — asserted by a DIRECT last-wins oracle, INCLUDING the
      loosen case (`base=false, over=true ⇒ true`) to prove overlay is NOT bounded by `⊑`,
      **and the presence-narrow case** (`base=true, over=false ⇒ false`, `over` wins by
      presence even lowering to default). **Rule LISTS** (`inject`/`validate`) == the
      **union** of both layers' rules (accumulate), NOT last-wins, in **base-then-over order**
      [M-3] — assert both a base-only and an over-only inject/validate rule survive the
      overlay, and that the effective inject order is base's rules before over's. Also assert
      the II.5.0 worked results: `overlay(base,dev)` enables `raw_sql`+`pg.extension`,
      `overlay(base,prod)` tightens the timeout `30000→10000` and accumulates the
      `require sec.require_approval` obligation;
    - **`finalize_ceiling(assembled)` — the fallible ceiling gate (H-3).** Assert a
      collision-free assembled ceiling passes and is IDENTITY on the rule set; assert each
      conflict class REJECTS: overlapping-scope inject/inject same-column
      (`CeilingInjectColumnConflict`), PK-pin conflict (`CeilingPrimaryKeyConflict`),
      duplicate index name (`CeilingIndexNameConflict`), inject-vs-validate contradiction
      (`CeilingInjectValidateContradiction`). Assert `admit`'s `ceiling` param TYPE forbids an
      un-finalized ceiling (a compile-time / constructor-level property, exercised by a
      builder test);
    - **`restrict(a, b)` — TOTAL, exact meet.** Never rejects; equals the pointwise value
      meet with scope-meet domain; assert `restrict` associativity & commutativity and
      `Objects(restrict) == meet` exactly (it is the old clamp — same oracle assertions);
    - **`admit(ceiling, draft)` — the SOLE fallible operator.** `Ok` **iff** every grant the
      draft RAISES ABOVE DEFAULT is `⊑` the ceiling pointwise (`∀o ∈ grantedScope(draft,k):
      value(draft,k,o) ⊑ value(ceiling,k,o)`); every escalation case still REJECTS
      (the `600s@app_*` case, uncovered-region non-default, `UncoveredRegionNotRepresentable`);
    - **[C-1] uncovered region via ITERATED per-ceiling-rule subtraction, NOT `⊔`.** The
      exact counterexample (ceiling rule with an exclude + a disjoint second rule): ceiling
      grants `raw_sql` on `Of{[app_*], exclude=[app_secret]}` **and** on a disjoint `Of{[reports]}`;
      draft `raw_sql@app_secret` **MUST REJECT** — assert that the fold
      `R := grantedScope(draft) ; for each ceiling rule r: R := R ∖ r.effective_scope`
      leaves `app_secret ∈ R` (non-empty, non-default) ⇒ reject. Assert the OLD
      `grantedScope(draft) ∖ grantedScope(ceiling)` formula (which `⊔`-folds the ceiling,
      dropping the `app_secret` exclude) would have WRONGLY ACCEPTED — a direct regression
      pin on the escalation the C-1 fix closes;
    - **[H-2] narrow-to-default is representable (presence vs non-default split):** a draft
      `raw_sql = false` over a ceiling `raw_sql = true@app_*` — assert the effective value at
      an `app_*` object is `false` (the draft WINS by presence, `coveredScope`), NOT the
      inherited `true`; and assert this object is NOT escalation-checked (it is in
      `coveredScope` ∖ `grantedScope`). Same for a Global narrow (`pg.extension = false` over
      inherited `true`);
    - **`admit` grants are CEILING-INHERITED + LAYERED (H-4):** effective grants =
      **inherit-then-narrow** over a `[draft] over [ceiling]` layer stack — where the draft is
      SILENT (`o ∉ coveredScope(draft,k)`), `value(effective,k,o) == value(ceiling,k,o)`
      (assert a draft that OMITS a grant the ceiling allows still HAS it — the footgun-fix
      regression); where the draft raises a grant, it must be `⊑` the ceiling (assert an
      explicit narrow succeeds and an explicit widen rejects). **[H-4] the layered override**
      the flat set cannot express: ceiling `timeout=30000@All` + draft `timeout=10000@app_*`
      — assert the query on `app_main.t` returns `10000` (the draft's narrow, top layer),
      NOT the flat-loosest `30000`; and on a non-`app_*` object returns `30000` (fall
      through to the ceiling layer);
    - **`effective ⊑ ceiling` for ALL keys/objects (the NEW no-escalation invariant):**
      over the whole bounded (key × object) universe assert `value(effective,k,o) ⊑
      value(ceiling,k,o)` on BOTH arms — the silent-inherit arm (equality) and the
      explicit-narrow arm — so inherit-then-narrow provably never exceeds the ceiling;
    - **obligations union-up survive:** a ceiling require/inject/validate is present in
      `admit`'s output and un-droppable/un-narrowable by the draft (unchanged);
  - **two-phase soundness (II.5.0):** `admit(overlay(base, env), draft)` is sound — even
    where `env` **enabled** something in the trusted phase (`overlay(base,dev)` raised
    `raw_sql` to true), the untrusted `draft` still cannot exceed `overlay(base,env)`:
    assert `effective ⊑ overlay(base,env)` for every key/object, and that a draft grant
    above the *assembled* ceiling rejects;
  - **algebra laws:** `admit(restrict(a,b), draft) ≡ admit-against-tightest-chain`
    pointwise (including the ceiling-inherited arm — a silent draft inherits the meet of
    the chain's values); `⊓`/`⊔` associativity & commutativity; join monotonicity;
    scope-subset transitivity; inject union-up ⇒ ceiling-injection-un-droppable; validate
    accumulation; valued-Require per-object union;
  - **object_model:** Global knob refuses non-⊤ authored scope; Global knob is EXEMPT
    from the `default_scope` meet — `default_scope = app_*` + `pg.extension scope = all`
    LOADS (effective scope `All`, not `app_*`); PerSchema refuses table scope;
  - **scope difference `∖` [C1, oracle-verified]:** `A ∖ B` OVER-approximates (never
    under-approximates) the true difference — `Objects(A∖B) ⊇ Objects(A) \ Objects(B)`,
    proven by the oracle as "never a strict subset"; the settled counterexample
    `{app_*} ∖ {app_*, exclude app_tmp_*}` is **non-empty** (retains `app_tmp_*`), so the
    `admit` uncovered-region check REJECTS the escalation; a non-representable `∖` returns
    "not cleanly representable" and the `admit` grant check REJECTS
    (`UncoveredRegionNotRepresentable`), never treats it as empty;
  - **normalization:** `App_x`≡`app_x` under `app_*`; `"App_x"` distinct; `"my.table"`
    is one segment;
  - **namespace anchoring:** `CreatableEscapesMandatoryInject` fires when
    `creatable ⋢ inject`; rename-across-boundary re-evaluation denies the TOCTOU;
  - **raw-SQL structured gate (Defect 1/2/4):** raw `CREATE TABLE app_x.t` under
    `core.raw_sql@app_*` DENIED when an inject rule covers `app_x.t`
    (`RawCreateInInjectScope`) — for CTAS / `SELECT INTO` / `LIKE` / `PARTITION OF`
    spellings; raw create outside any inject scope still requires `core.create_table`;
    raw rename INTO an inject scope DENIED (`RawRenameIntoInjectScope`); `CREATE FUNCTION`/
    `CREATE TRIGGER`/`DO` DENIED under scoped raw_sql (`OpaqueBodyUnderScopedRawSql`);
    unqualified name DENIED under scoped raw_sql (`UnqualifiedNameUnderScopedRawSql`);
    `SET search_path` REFUSED under scoped raw_sql (`SearchPathUnderScopedRawSql`); all
    admitted under a ⊤ `core.raw_sql` grant;
  - **injected-shape immutability (Defect 7):** `is_injected_shape` is name-match-at-op-
    time — a table renamed INTO an inject scope carrying a matching column/index/PK is
    immutable; `DROP CONSTRAINT <pk>` on a pinned-PK table → `InjectedPrimaryKeyImmutable`;
    `DROP INDEX` on an injected index → `InjectedIndexImmutable`; each waved only by
    `core.alter_injected_column`;
  - **compose-time collisions:** draft-vs-ceiling inject collision → `admit`
    error; draft `ForbiddenColumns` vs ceiling `Inject` → error; ceiling-vs-ceiling →
    **`finalize_ceiling` error** (H-3: `overlay`/`restrict` stay TOTAL — the conflict is
    caught by the finalize gate, not by the combinator); author-vs-injected kept at resolve
    time; single-doc self-contradiction (inject X + `ForbiddenColumns[X]` on overlapping
    scope) → LOAD-TIME lint error;
  - **provenance / `extends` (H-1):** `overlay`/`restrict` accept only `TrustedDoc` (a
    creator `PolicyDoc` cannot be passed — type-level); a creator DRAFT with an `extends`
    field → LOAD ERROR (`ExtendsForbiddenInDraft`); a trusted doc `extends` resolves only
    against trusted catalog bases with cycle detection (`ExtendsCycle` on a revisit,
    load error on a `base` absent from the trusted catalog);
  - **root-ceiling identity (M-5):** `mandatory = true` on a catalog entry (non-root) →
    `MandatoryInjectOnNonRootLayer` load error; zeroship's 7-column inject in the
    `RootCeiling` carries `mandatory` and fires `CreatableEscapesMandatoryInject` when
    `creatable ⋢ inject`; an assembled `overlay(base,dev)` that LOOSENS past `base` is still
    RootCeiling-descended (descent is layer-provenance, not `⊑ base`);
  - **seal binding:** wrong registry digest (incl. a flipped `requires_db_privilege`),
    wrong `dialect`, or wrong `matcher_version` → verifier hard-fail; **[H-4] a re-flattened
    layer stack** (the `[draft] over [ceiling]` layers merged into one loosest-covering rule
    set) → verifier hard-fail, since the seal binds the layer boundaries and the flattened
    set denotes a different policy.
  (2) The inject/validate rule evaluator (inject-then-validate ordering, cross-layer
  total order); move `table_shape.rs` collision/id-fold/author-PK logic into it; delete
  `system_shape` from policy; add the optional `TableShapeTransform` escape hatch. (3)
  Guard/executor as a thin PEP over the decision-query API (raw-SQL all-referenced-objects
  attribution + raw-statement classification into the structured gate — raw create/rename
  routed through `core.create_table`/`core.rename_into` + inject-scope denial, opaque-body/
  unqualified-name/`search_path` denial under scoped raw_sql; namespace/rename ops;
  injected-shape immutability via `is_injected_shape`); delete
  `TrustProfile`/token. (4) Delete embedded presets; add `RootCeiling`/`ProfileCatalog`/
  optional transform to `EngineOptions` + napi surface. (5) zeroship-side: profile
  documents, the shape as an `inject` rule + `core.create_table` anchor +
  `table_name_forbidden` predicate, RLS/etc as scoped require/validate rules, ceiling
  document, conformance tests.

## II.10 Invariants preserved (the checklist an adversarial review should run)

1. **Fail closed:** absent/malformed policy ⇒ hard error at the host boundary;
   the only engine-internal floor is `deny_all` (the empty rule set — grants nothing,
   requires nothing, injects nothing, validates nothing). *Strictly stronger than
   today* (no silent zeroship-confined fallback, no surprise columns).
2. **No escalation — `admit` is the SOLE trust boundary (pointwise over key × object):**
   `EffectivePolicy` unforgeable and **layered** (`[draft] over [finalized ceiling]`, H-4).
   `admit` is the **only** operator that crosses a trust boundary and the **only** place
   *escalation* is checked; `overlay` and `restrict` are **trusted-side, `TrustedDoc`-only**
   combinators (H-1: an untrusted `PolicyDoc` cannot be an operand — type-enforced) and carry
   **no escalation constraint** — they are total, never reject, and may freely loosen or
   tighten because there is no adversary on either input. Ceiling *misconfigurations*
   (colliding injects/PKs) are caught by the trusted-side `finalize_ceiling` gate (H-3), a
   loud operator error that is **not** a trust crossing; every assembled ceiling passes it
   before it can be `admit`'s (type-enforced) argument. The invariant is: **the effective
   policy produced by `admit` is `⊑` its ceiling for every key/object, whether the draft
   INHERITED, NARROWED-TO-DEFAULT, or NARROWED-ABOVE-DEFAULT a grant.** Formally, for every
   Grant key `k` and object `o`, `value(effective,k,o) ⊑ value(ceiling,k,o)` (II.3.2
   theorem) — proven on all three arms: where the draft is silent (`o ∉ coveredScope(draft,k)`)
   the effective value **is** the ceiling's (inherited, equality); where the draft narrows to
   default it wins by presence at the tightest value (`⊑` trivially); where the draft raises
   above default (`o ∈ grantedScope(draft,k)`) `admit` rejected unless it was `⊑` the ceiling.
   The **inherit-vs-override decision is PRESENCE-based** (`coveredScope`, H-2) while the
   **escalation check ranges over non-default grants only** (`grantedScope`, H-2) — the two
   notions are split so a draft **narrowing to default** (`raw_sql=false` over a ceiling
   `true`) actually takes effect instead of silently inheriting the looser ceiling value.
   Grants are **ceiling-inherited** (inherit-then-narrow), so a draft that *omits* a grant
   keeps the ceiling's — it can neither widen a value nor a scope, and it can no longer
   silently *lose* a ceiling grant (the old draft-authoritative footgun). The
   **uncovered-region check uses ITERATED per-ceiling-rule `∖` subtraction, never a
   `⊔`-materialized ceiling** (C-1) — a `⊔`-folded ceiling drops excludes and would
   under-approximate the uncovered region (the escalation direction), so the fold subtracts
   each ceiling rule's own excludes-intact `effective_scope` individually and stays
   fail-closed. This catches the multi-rule `60s@app_* + 600s@staging` escalation the old
   scope-only check missed **and** the exclude-drop escalation the old `∖`-of-`⊔` formula
   admitted (ceiling `raw_sql@Of{[app_*],exclude=[app_secret]} + Of{[reports]}` denies a
   draft `raw_sql@app_secret`). Scope `⊓` is exact and disjoint-meet is `Nothing` (never 𝒰 —
   II.3.1), so no meet ever escalates. Requires/injects/validates are join-only (valued ones per-object
   union), so a draft can never drop or scope-narrow a ceiling obligation/injection/
   validation. Pinned (opaque transform) digests are equality-checked. A rule's scope can
   only *narrow* its policy's `default_scope`, by the lattice law (II.2.4). An outside
   consumer *extending* the registry can only add knobs whose defaults are their tightest
   value (enforced by `KnobDef` construction), so extension can never widen an existing
   ceiling. **Two-phase (II.5.0):** no matter how the operator assembles a ceiling with the
   trusted `overlay`/`restrict` (even enabling `raw_sql` in dev), `admit` still proves the
   untrusted creator's `effective ⊑ overlay(base,env)`, so trusted assembly never weakens
   the untrusted boundary — it only sets where the boundary sits.
2b. **Namespace can't be escaped (II.2.6):** objects come into existence only where
   `core.create_table`/`core.create_schema` grant; a mandatory-inject scope forces
   `creatable ⊑ inject` at compose time, so a tenant cannot create outside the injection;
   renames across a scope boundary need `core.rename_into` and re-run inject/validate on
   the moved object (no TOCTOU); the injected **shape** — columns, the pinned PK, and
   injected indexes — is immutable without an explicit `core.alter_injected_column` grant,
   decided by the `is_injected_shape` PDP query at op time (name-match, not provenance —
   a table renamed into an inject scope carrying a matching column/index/PK is treated as
   injected, II.2.6b); a `table_name_forbidden` predicate closes the published-exclude
   door. Rule evaluation is defined for create/alter/rename, not just create.
2c. **Raw SQL can't dodge the structured gate (II.2.5):** injection is an IR transform
   and cannot rewrite raw SQL text, so a raw statement the engine cannot structurally
   attribute is denied, never waved through. A raw `CREATE TABLE` (any form — CTAS,
   `SELECT INTO`, `LIKE`, `PARTITION OF`) must additionally pass `core.create_table` and
   is DENIED wherever ANY inject rule covers the target; a raw rename **into** an inject
   scope is denied; a raw alter of an injected column/PK/index is subject to injected-
   shape immutability; `CREATE FUNCTION`/`CREATE TRIGGER`/`DO` and other opaque-body
   constructs, unqualified names, and `SET search_path` are all DENIED under any non-⊤
   `core.raw_sql` grant. The structured DSL path is the only way to create an injected
   table. The residual (function bodies a ⊤-grant admits) is backstopped by DB-role
   least-privilege (II.10.5), not by static analysis.
3. **No unenforced authority:** `DeclaredOnly` knobs cannot reach an enforced path at
   non-default values — the generalized `validate_for_seal`.
4. **Replay/freshness/ceiling-version + identity binding (II.7):** seal mechanics
   unchanged; the sealed payload covers the full scoped rule set **with its layer boundaries
   (H-4) in the cross-layer inject total order** (a tampered scope, a reorder, OR a
   re-flatten that merges the `[draft] over [ceiling]` layers into one loosest-covering set
   fails the MAC — the layered query means the flattened set is a *different policy*), plus
   the **registry digest** over the full `KnobDef` encoding (`requires_db_privilege`
   included) and the
   **`(dialect, matcher_version)`** matcher-semantics pair — the verifier hard-fails a
   seal replayed against a different registry, dialect, or matcher algorithm, so a key's
   meaning cannot drift between mint and verify. The `TableShapeTransform.digest()` is
   host-trusted, not a control against a hostile transform.
5. **Least-privilege DB backing:** the `migrator_unbacked_capability` reconciliation
   (`profile.rs:1353-1367`) survives as a registry-driven check: each `pg.*` Grant
   knob's def carries `requires_db_privilege: bool`, and the executor refuses a policy
   granting such a knob while `SET ROLE`-ing into a floor role — same guarantee, no
   if-chain.

---

*Appendix — primary evidence index:* G1 `profile.rs:59-67,186-248` +
`confined.toml:2-18` + `declarative.rs:1736-1738` + `table_shape.rs:61-145`; G2
`profile.rs:95-99`, `load.rs:60-66`; G3 `profile.rs:34-39,115-124,1745`,
`capability.rs:236-252`; G4 `conn.rs:316-332`, `profile.rs:1053-1059`,
`policy.rs:39-52`; G5 `profile.rs:30-31,643-667,743-755`; G6 `table_shape.rs:56-60,496-515`;
G7 `api.rs:121`, `lower.rs:86`; E1 `capability.rs:79-181`, `profile.rs:343-488,931-1047,1434-1470`;
E2 `profile.rs:132-136,931-1047`; E3 `profile.rs:261-271,566-594,687-707,743-755,862-869`,
`policy.rs:105-144`, `guard/mod.rs:233-245`; E4 `profile.rs:273-280,610-632,1074-1091,1128-1170`;
E5 `profile.rs:47-48`, `platform.toml:2`; E6 `capability.rs:39-56`, `conn.rs:270-290`,
`guard/mod.rs:253`; E7 `profile.rs:43`.
