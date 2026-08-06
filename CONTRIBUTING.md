# Contributing to zero-migrate

Thanks for helping build zero-migrate. This guide covers the repository layout,
how to build and test, and the commit message conventions.

## Repository layout

- `crates/` - the Rust workspace: the engine (`zero-migrate`), the IR
  (`zero-migrate-ir`), the policy layer (`zero-migrate-policy`), the SQL guard
  (`zero-migrate-guard`), and the N-API addon (`zero-migrate-node`).
- `packages/` - the JavaScript packages: the authoring DSL (`zero-migrate`) and
  the host runtime plus CLI (`zero-migrate-cli`). A pnpm workspace.
- `docs/` - product documentation.

## Development

Prerequisites: a stable Rust toolchain, Node.js 22, and pnpm. The live database
tests expect PostgreSQL 18 and MySQL 8. `docker-compose.test.yml` brings up both
at the versions CI uses.

Rust:

```
cargo fmt --all -- --check
cargo clippy --workspace --all-targets -- -D warnings
cargo build --workspace
cargo test --workspace --exclude zero-migrate-node
cargo test -p zero-migrate-node --no-default-features
```

JavaScript:

```
pnpm install
pnpm -w build
pnpm --filter zero-migrate check
pnpm --filter zero-migrate test
pnpm --filter zero-migrate-cli typecheck
```

Native addon (only when you touch the `#[napi]` surface):

```
cd crates/zero-migrate-node && pnpm build
```

The CLI package's host tests drive the real addon against live databases. Point
them at your servers and build the addon first:

```
cd crates/zero-migrate-node && pnpm build
ZERO_MIGRATE_ADDON_PATH=$PWD/zero-migrate-node.<triple>.node \
ZERO_MIGRATE_TEST_PG_URL=postgres://... \
ZERO_MIGRATE_MYSQL_URL=mysql://... \
pnpm --filter zero-migrate-cli test:host
```

## Commit messages

This repo uses Conventional Commits. Keep `git log` a readable, greppable
changelog.

### Format

```
type(scope): imperative summary of what the change does
```

- One line, lowercase after the colon, no trailing period.
- Optional body after one blank line, for the "why" when it is not obvious.
- Breaking changes add a `!` before the colon: `type(scope)!: ...`.

Examples:

```
feat(migrate): support data migrations across all dialects
fix(schema): preserve authored indexes in generated create operations
refactor(policy)!: remove PolicyProfile from the public API
test(guard): cover conservative namespace authority decisions
docs(guide): rewrite the JavaScript user guide
```

### Type

Pick exactly one. `fix`, `feat`, and `refactor` cover most changes.

- `fix` - a behavior or bug correction
- `feat` - a new user-visible capability
- `refactor` - internal restructuring with no behavior change
- `test` - adding or reworking tests only
- `docs` - documentation only
- `merge` - integrating a completed body of work; subject starts with
  `integrate ...`
- `chore` - repo housekeeping with no source or behavior impact
- `style` - formatting only (rustfmt/prettier), no code change
- `build` - build system, workspace membership, packaging
- `ci` - CI workflows and automation

Do not add a new type (for example `perf` or `revert`) unless there is a real
need; keep it lowercase and single-word.

### Scope

A single lowercase token (may contain `-`) naming the area touched. Reuse an
existing scope before inventing one. Current vocabulary:

- Product and umbrella: `migrate`, `migrate-sdk`, `dsl`, `cli`, `node`, `core`,
  `workspace`, `release`, `guide`, `docs`, `tests`, `workflows`
- Engine domains: `schema`, `expr`, `ir`, `guard`, `policy`, `dml`, `values`,
  `defaults`, `partition`, `views`, `codegen`, `index`, `types`
- Dialects: `postgres`, `mysql`, `sqlite`

Choose the most specific scope that still fits (`fix(postgres): ...` over
`fix(migrate): ...` for a PostgreSQL-only change). A new crate or package earns a
new scope named after it.

### Subject line

- Imperative, present tense: `add`, `reject`, `remove`, `support`, `preserve`,
  `rename`, as if completing "This commit will ...". Not `added` or `adding`.
- Describe the effect, not the mechanics. Be descriptive, not terse: state a real
  outcome ("preserve authored indexes in generated create operations"), not
  "update code". Roughly 50 to 72 characters; never exceed about 80.
- Lowercase first word after the colon; no trailing period.

### Breaking changes

Mark with `!` before the colon (`refactor(postgres)!: ...`). Do not use a
`BREAKING CHANGE:` footer. If the impact needs explaining, put it in the body and
say what to use instead.

### Body

Usually omitted; a good subject carries most changes. Add a body when the
rationale, trade-off, or migration impact is not obvious. Separate it with one
blank line, and write prose paragraphs (one idea each, blank line between), not a
bullet dump.

```
refactor(policy)!: remove PolicyProfile from the public API

Use EffectivePolicy and SealedPolicy; profile presets and legacy sealing types
were removed.
```

### Checklist

- [ ] `type(scope): ...` with a known type and an existing scope
- [ ] Imperative, lowercase after colon, no trailing period
- [ ] Describes a real outcome; about 72 characters or fewer
- [ ] `!` added if and only if it breaks a public contract
- [ ] Body only when the why is not obvious
