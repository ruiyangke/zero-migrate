# Policy model

Policy lets a platform operator decide what a migration may do, where it may do
it, and which safety requirements it must satisfy.

> Custom policy can currently drive Rust planning, table-shape, and host
> decisions. JavaScript database verbs require an ordered table-shape charter
> stack through `policy`; CLI database verbs accept the same stack by
> repeating `--policy <file>`. The first entry is the trusted root/bound
> and later entries may only narrow it. These inputs are not a general custom
> executor policy, which is not exposed yet.

## The model

```text
trusted root charter
        │
        ├── optional trusted environment rules
        │
        ▼
finalized charter
        ▲
        │ admits
untrusted project draft
        │
        ▼
effective policy
        ├── table-shape decisions
        ├── migration guard decisions
        └── host approval decisions
```

A project draft can narrow a trusted charter. It cannot grant itself authority
that the charter did not allow.

## Public Rust types

| Type | Purpose |
| --- | --- |
| `PolicyRegistry` | Defines available policy keys and their value/scope rules |
| `KnobDef` / `KnobKey` / `KnobKind` | Define a policy capability or obligation |
| `RootCharter` | Trusted outer authority |
| `TrustedDoc` | Trusted environment/catalog policy |
| `PolicyDoc` | Ordinary policy document, including an untrusted project draft |
| `AssembledCharter` | Trusted layers waiting for final validation |
| `Charter` | Finalized trusted charter accepted by admission |
| `EffectivePolicy` | Admitted, queryable result used by the engine and host |
| `SealedPolicy` | Authenticated representation for crossing a storage/process boundary |

## Quick start

For one simple trusted charter, no separate project draft, and no mandatory
injection rule:

```rust
use zero_migrate::{
    GuardConfig, SqlDialect, effective_policy_from_charter_toml,
};

let effective = effective_policy_from_charter_toml(policy_toml)?;
let guard =
    GuardConfig::from_policy(effective.clone(), SqlDialect::Postgres);
```

Use the effective policy consistently for table-shape resolution, planning, and
host approval decisions. Applying an arbitrary custom policy requires a host
integration beyond the current public executor configuration; do not advertise a
custom plan as an end-to-end apply guarantee.

The convenience helper admits a single root. Use the layered flow below when a
root is combined with environment or project layers.

## Layering more than one document

Pass the layers ROOT FIRST. Each later layer is loaded as
`LoadContext::NonRootLayer` and admitted as an untrusted narrowing draft, so a
later layer may only tighten what an earlier one granted:

```rust
use zero_migrate::effective_policy_from_charter_layers;

let effective = effective_policy_from_charter_layers(&[
    root_toml,
    environment_toml,
    project_toml,
])?;
```

This is the composition the engine itself runs, and it is the one to build on.
Creator-controlled documents are non-root layers by construction here; there is
no way to pass one as trusted.

The composed policy is refused if it can create tables outside a mandatory
inject's scope, or if one layer carries two injects that conflict on overlapping
scope. Both refusals name what collided.

## The trusted charter algebra

`zero_migrate_policy` also exposes `TrustedDoc`, `overlay`, `restrict` and
`finalize_charter`, which assemble a charter from trusted layers before admitting
a draft.

NOTHING IN THIS ENGINE CALLS THEM. `effective_policy_from_charter_layers` above
is the only composition any shipped code path performs, and the two checks that
once justified reaching for `finalize_charter` - the creatable-escape bound and
the inject/inject conflict scan - now run on that path too. A third,
inject-versus-validate contradiction, is caught by the document loader before
composition begins.

They remain exported for a host that wants to assemble a charter itself, and are
documented here so nobody builds on them believing the engine does. Prefer the
layered flow.

## Policy document

Documents are strict TOML or JSON and begin with:

```toml
policy_version = 1

[default_scope]
include = ["app_acme"]
```

Unknown fields, keys, value shapes, and future policy versions are rejected.

A practical charter:

```toml
policy_version = 1

[default_scope]
include = ["app_acme"]

[[grant]]
key = "schema.create_table"
value = true

[[grant]]
key = "schema.rename"
value = true

[[grant]]
key = "safety.destructive_ops"
value = "warn"
scope = "all"

[[require]]
key = "safety.require_approval"
value = "on_destructive"

[[inject]]
scope = { include = ["app_acme.*"] }
mandatory = true
columns = [
  { name = "created_at", type = "timestamptz", nullable = false },
]
```

## Rule sections

| Section | Meaning |
| --- | --- |
| `[[grant]]` | Capability or resource charter |
| `[[require]]` | Safety obligation |
| `[[inject]]` | Operator-owned columns, indexes, or primary-key shape |
| `[[validate]]` | Column names an `[[inject]]` may not contribute |

Grants become tighter as they move downward through admission. Requirements and
injections accumulate; an untrusted draft cannot remove them.

## Scopes

A rule can target everything, nothing, schemas, or tables:

```toml
scope = "all"
scope = "nothing"
scope = { include = ["app_*", "staging.orders"], exclude = ["app_test"] }
```

Examples:

- `app_acme` matches that schema and its tables;
- `app_acme.orders` matches one table;
- `tenant_*.audit` matches `audit` in each matching tenant schema.

Keep grants as narrow as possible. Global policy keys require
`scope = "all"` explicitly.

## Built-in policy areas

The standard registry covers:

| Area | Examples |
| --- | --- |
| Raw text | PostgreSQL raw statements and raw view bodies |
| Schema | Create/rename/cross-schema access, partitions, injected shape |
| Access | Roles, grants, RLS, and row-security policies |
| Code | Extensions, functions, and materialized views |
| Runtime | Lock/statement timeout and rewrite/index postures |
| Safety | Destructive changes, required RLS, hard-delete policy, and approval |

Missing grants default to their tightest value.

Important hard boundaries remain even when a grant is present. A policy cannot
make a forbidden privileged role, extension, or dangerous SQL construct safe,
and it cannot grant a database permission the connection does not have.

## Table-shape injection

An `[[inject]]` rule can add operator-owned columns/indexes and choose primary-key
shape for matching table creation. The resolved table shape becomes part of the
migration checksum.

Authors cannot silently replace an injected column. Changing operator-owned
shape needs explicit authority and should be reserved for trusted workflows.

Current injection support is intentionally narrow:

- injected column types are limited to `text`, `timestamptz`, and `integer`;
- injected column defaults use a closed mapping: timestamps accept `now`, `now()`,
  or `current_timestamp`; integers accept an `i64` literal; and text accepts a
  single-quoted SQL string literal (including doubled-quote escaping);
- injected index columns are applied, but the configured index name is not
  preserved in the resolved migration.

Test the resolved migration, not only whether the TOML parses, before deploying a
shape policy.

## Approval

`safety.require_approval` can be:

- `never`;
- `on_destructive`;
- `always`.

This is a host obligation. The host must determine whether approval is required,
show the exact migration/checksum for review, store the decision, and pass
`Approval::Approved` only when that identity still matches.

During apply, pending approval-gated identities are reconciled across the
complete plan before any authored step executes. Approval refusal therefore
cannot partially apply that plan; runtime database failures after execution
begins can still leave earlier completed steps.

The policy document does not store or grant approval by itself.

A PostgreSQL online rename has two separate approval decisions. The initial
apply approves its bounded backfill. A later apply or abort resolution approves
dropping the source or destination column for the returned `pendingVersion`.
Approval for one action does not imply approval for the other. Failed cleanup
is all-or-nothing and leaves both columns and the managed rename trigger intact.
After a resolution succeeds, that migration identity is terminal; retrying an
aborted rename requires a newly named migration and a fresh approval decision.
Approval does not override PostgreSQL rename isolation: the rename must be its
table's only operation in that migration, and same-table follow-up work belongs
in a later migration applied after resolution.

## Sealing

Use `SealedPolicy` when an effective policy crosses a queue, cache, process, or
storage boundary. The seal binds the policy, registry identity, dialect,
versions, and nonce with a host-provided MAC key.

Keep the MAC key in operator-controlled secret storage. A seal proves that the
policy value was not replaced; it does not prove the original root was
trustworthy or that database privileges match policy.

Treat sealing as a trusted process/storage integrity mechanism. Do not expose
policy verification as a public network authentication or timing oracle.

## Enforcement responsibilities

Parsing a policy rule does not by itself make it an active safety control.
Current coverage is:

| Policy area | Current behavior |
| --- | --- |
| Raw/vendor/schema grants, destructive posture, required RLS | Enforced by migration planning/guard paths |
| Table-shape injection | Applied during table creation resolution |
| Required approval | Host-enforced; the host owns review and stored approval |
| Database privilege requirement | Host-enforced through database provisioning |
| Runtime timeout/index/rewrite rules | Declared only; a value above the default is refused at load |
| No-hard-delete obligation | Declared only; a value above the default is refused at load |
| Generic `[[validate]]` rules | Refused at load; only `forbidden_columns` is accepted, and it constrains the policy, not a table |

Do not rely on a declared-only rule as a production control.

The declared-only rows are registered `DeclaredOnly` in the builtin registry, which
means the engine does not implement the control. Such a knob may be stated at its
default, where it advertises nothing, but a document that raises it is rejected at
load rather than composed and sealed. A sealed policy therefore never claims one of
these controls.

`[[validate]]` is refused the same way, and for the same reason. No seam evaluates a
predicate against a table, so `has_primary_key`, `require_index`, `table_name_forbidden`,
`column_name_pattern` and `type_nullability` are rejected at load rather than sealed as
controls the engine does not apply. `forbidden_columns` is the one predicate that is
read, and what it constrains is the policy: a document that both injects a column and
forbids it on an overlapping scope is rejected, as is a composition where the collision
is across layers. It is never checked against a table being created or altered.

Use policy together with:

- the migration guard;
- a complete ownership registry;
- least-privilege database credentials;
- an approval store;
- protected journal access;
- an independently stored manifest when using verified apply.

Some policy values describe host responsibilities rather than automatic engine
behavior. In particular, approval storage and database privilege provisioning
belong to the host. Confirm the [Security model](security-model.md) for every
capability you enable.

## Checklist

- Keep root policy and trusted catalog entries outside project-controlled
  storage.
- Load project drafts as untrusted layers.
- Finalize trusted composition before admission.
- Use one registry definition throughout load, compose, seal, and verify.
- Keep scopes narrow.
- Use one effective policy for table shape, planning, and host decisions, and
  keep custom apply behind a reviewed integration until the public executor
  accepts that policy directly.
- Bind approval to exact immutable content.
- Match policy grants with database grants.
- Test both allowed and denied migrations.

## Next

- [Rust API](embedding.md)
- [Security model](security-model.md)
- [Operating migrations](operations.md)
- [Documentation home](README.md)
