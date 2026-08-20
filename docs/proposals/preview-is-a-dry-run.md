# Preview is a dry run proposal

Status: Draft
Date: 2026-08-20

This proposal settles what the SQL preview is FOR, and closes the gaps between
what it says and what apply does.

The rule is one sentence:

> Preview is apply with the writes suppressed.

Everything else follows. For any input, preview must reach the SAME verdict apply
reaches. Where it cannot decide offline, it must say so explicitly, and it must
never present as executable something apply would refuse or never run.

This is the same shape as `one-sided-preflight.md` applied at a second seam. There,
a model may REFUSE a plan but may never APPROVE one from absence. Here, a preview
may refuse, and may say "I cannot know this offline", but may never let silence
read as approval.

## Proposed decisions

1. Preview and apply must agree on verdict. Divergence is a defect in preview, not
   a documented difference.
2. Where preview cannot decide offline, it emits an explicit UNDECIDED marker. It
   never omits the op and never renders it as settled.
3. **Silence may never mean clean.** Any surface that returns "no findings" must
   distinguish "checked, found nothing" from "not checked". This rule already
   exists in this codebase for one case and is generalized here.
4. A statement stream that omits operations may not describe itself as safe to
   execute. Either it reports what it dropped, or it does not exist.
5. The policy charter's REFUSAL rules run in preview, not only its injection rules.
6. Every preview entry point consumes its options or is deleted. An entry point
   that silently discards policy is a trapdoor.

## Goals

- A clean preview means "apply would accept this", not "the renderer had nothing to
  say".
- An operator can read a preview as a decision, because the two cannot drift.
- What the preview cannot know is visible in the preview, not in the source.

## Non-goals

- Making preview omniscient. Some outcomes are runtime catalog probes and cannot be
  decided offline. This proposal makes that VISIBLE rather than eliminating it.
- Executing anything. Preview stays read-only.
- Changing the apply path's verdicts. Preview moves toward apply, never the reverse.

## What is measured

At `6dcbec14`.

### What already agrees, and says so

The path the CLI uses (`previewSql` -> `render_ir_envelope_sql`) already runs
`resolve_create_table_policy`, lowers each op through the real author, and returns
the author's own refusal. Its comment states the intent this proposal is
generalizing:

> "the same verdict apply gives, delivered before the deploy rather than during it,
> in the planner's own words so the two cannot drift."

Guard-carrying ops render under a `[runtime-resolved]` label because their outcome
is a runtime catalog probe. That is decision 2 already implemented for one case.

`PreviewOpts::effective_policy` is MANDATORY. Preview is not policy-free.

**An earlier note in `docs/open-decisions.md` claimed the preview "runs with no
policy attached at all". That was false and is corrected by this document.**

### Gap 1: policy shapes, but does not refuse

`PreviewOpts::effective_policy`'s own doc:

> "It does NOT drive anything beyond create-table injection and the lowering
> context."

So a charter forbidding a `dropColumn` still renders the `DROP COLUMN` as an
executable statement. Injection is honoured; refusal is not consulted.

### Gap 2: the statement stream omits operations while advertising itself as executable

`render_ir_envelope_sql_statements` documents both of these:

> "For MySQL, a non-empty statement stream includes the same save/pin/restore
> `sql_mode` envelope as the human preview, so it is also **safe to execute as-is**."

> "An op that degrades to a `[runtime-resolved]` label in the human preview has **NO
> entry here at all**, so a short stream is not evidence of a short plan."

Executable, and silently partial. Under decision 1 that combination is the defect.

### Gap 3: that doc is also stale, and the consumer is shipped

The same doc says:

> "Nothing in this repository calls it."

VERIFIED FALSE. `crates/zero-migrate-node/src/bridge.rs:1292` calls it inside
`advisories_for`, which `packages/zero-migrate-cli/src/cli.ts:1057` reaches through
`addon.advisoriesFor` under `--explain`.

So the omitting stream is not an embedder-only escape hatch. It feeds the shipped
advisory report.

**INFERRED, NOT EXECUTED:** advisories are therefore computed over a statement set
that is missing every runtime-resolved op, so those ops can receive no advisory and
the report does not say so. This follows from the two documented facts above but has
not been run. The test matrix below exists to execute it. Do not cite it as measured
until it does.

### The precedent: this codebase already solved this once

`advisories_for` contains the rule already, for a different cause. On MySQL the
analyzer parses PostgreSQL, so it returns an empty vector for SQL this engine emits
and is about to run. Rather than let that read as clean, it emits an advisory:

> `analyzer_dialect_unsupported` ... "operational advisories are not available for
> {}: the analyzer reads PostgreSQL syntax, so no rule was evaluated against these
> statements. **An empty advisory list here means UNCHECKED, not clean**"

Decision 3 is that rule, generalized from "wrong dialect" to "any reason the check
did not run", including omission.

### Gap 4: two entry points discard their options

`render_plan_sql` and `render_set_sql` take `_opts: &PreviewOpts` - underscore, so
unused. 3 and 2 real call sites respectively. Whatever policy the caller composed is
discarded.

## The design

### Verdict parity

```
   PREVIEW                                 APPLY

   policy resolve      ------ same ------> policy resolve
   author lower        ------ same ------> author lower
   charter refusal     ---- gap 1 -------> charter refusal
   guard / catalog     -- UNDECIDABLE ---> runtime catalog probe
   execute             ---- suppressed     execute
```

Everything above the catalog line must produce identical verdicts. The catalog line
is where honesty replaces agreement.

### Three outcomes per op, never two

```
   Rendered(stmts)   preview and apply agree: this is what runs
   Refused(reason)   apply would refuse, in apply's own words
   Undecided(why)    needs the live catalog. NOT omitted, NOT rendered as settled.
```

`Undecided` is today's `[runtime-resolved]` label, promoted from a formatting
detail in the human preview to a value every surface must carry. The statement
stream's current behaviour, dropping the op entirely, is what decision 2 forbids.

### Silence is a claim, and must be justified

Any "no findings" result carries why it is empty:

```
   Empty(Checked)              nothing to report
   Empty(NotChecked(reason))   the check did not run
```

The existing `analyzer_dialect_unsupported` advisory becomes one instance of
`NotChecked`, alongside a new one for omitted operations.

## What this makes worse

**Previews get noisier.** Ops that today vanish will appear as `Undecided`, and
reports that today look clean will carry `NotChecked` lines. That is the intended
trade: a shorter report that lies is worse than a longer one that does not.

**A charter refusal now surfaces twice**, once in preview and once at apply. That
duplication is deliberate, the same as the step-level check in
`one-sided-preflight.md`, and must be documented where it is written or someone will
"simplify" it away.

**Embedders consuming the statement stream will see a shape change.** Under decision
4 it either grows an omissions channel or is removed. The doc claiming nothing calls
it is already wrong, so its true blast radius is unknown until the shipped consumer
is counted.

## Required test matrix

Every row proven RED before it is believed.

1. **Parity, over the existing corpus.** For every op in `tests/dialect_corpus`, on
   each dialect, preview's verdict must equal apply's verdict. Layer 1 of
   `backend-conformance.md` already computes the apply side live
   (`pg_verdict` / `mysql_verdict` / `sqlite_verdict` returning `Verdict`), so this
   is a differential against machinery that exists rather than a new harness.
   Any op where preview says "executable" and apply refuses is a failure.
2. **The omission is executed, not inferred.** Build an envelope with a
   guard-carrying op, call `render_ir_envelope_sql_statements`, and assert the op is
   absent from the stream. Then assert the result carries an explicit omissions
   entry. Row 2 is the one that turns Gap 3 from INFERRED to measured.
3. **Advisories over an omitted op.** Same envelope through `advisoriesFor`. Assert
   the report does NOT read as clean.
4. **A charter refusal is refused in preview.** A charter forbidding `dropColumn`,
   a plan containing one: preview must refuse, and its reason string must match the
   apply-time refusal.
5. **Silence carries its cause.** Force the analyzer-unsupported path and assert
   `NotChecked`, not `Empty`. This one passes today and is included so a refactor
   cannot silently lose the precedent.
6. **Every entry point consumes its options.** A compile-level or structural check
   that no public preview function takes `_opts`. Prove it by adding one back.

## Risks and open questions

- **Does `Undecided` belong in the machine-readable stream at all?** A caller
  executing the stream cannot execute an `Undecided`. Two answers: carry it as a
  non-executable entry the caller must handle, or keep the stream executable-only
  and require callers to read a separate omissions list. The second is easier to
  misuse in exactly the way Gap 2 describes. UNRESOLVED.
- **How far does "same verdict" reach?** Preview cannot take the apply lock or see
  concurrent DDL. Parity is therefore over OFFLINE-decidable verdicts, and
  `Undecided` is the honest boundary. Whether preconditions that could be answered
  from a live catalog should be, and thereby move the boundary, is the question
  `one-sided-preflight.md` answers for a different surface, and the two should be
  settled consistently.
- **Do `render_plan_sql` / `render_set_sql` have out-of-tree callers?** They are
  `pub`. Deleting them is a semver break at `0.1.0`. Wiring them up may be the
  cheaper option purely because it is not a break.

## What was verified, and what was not

VERIFIED at `6dcbec14`: `PreviewOpts`'s three fields and that `effective_policy` is
mandatory; its doc's "does NOT drive anything beyond create-table injection and the
lowering context"; that `render_plan_sql` and `render_set_sql` take `_opts` and have
3 and 2 real call sites; that `render_ir_envelope_sql_statements` documents both
"safe to execute as-is" and "NO entry here at all"; that its "Nothing in this
repository calls it" is FALSE, contradicted by `bridge.rs:1292` inside
`advisories_for`, reached from `cli.ts:1057` under `--explain`; that
`advisories_for` already emits `analyzer_dialect_unsupported` with the wording
"An empty advisory list here means UNCHECKED, not clean"; and that the preview's
author-error path already states the verdict-parity intent in its own comment.

INFERRED, NOT EXECUTED: that advisories computed from the omitting stream are blind
to runtime-resolved ops. It follows from two documented facts and is test-matrix row
2 and 3's job to prove. Not to be cited as measured until then.

NOT MEASURED AT ALL: how many out-of-tree embedders consume the statement stream,
and whether any preview surface other than the four named here exists.
