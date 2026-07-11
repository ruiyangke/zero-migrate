// PLACEHOLDER embedded-recorder bundle.
//
// The real artifact is the `tsup` build output of `sdks/migrate/src/embedded-recorder.ts`
// (the `@zeroship/migrate` op.* DSL recorder), which is EXTERNAL-marked against
// `@zeroship/db`. Building it requires the `@zeroship/db` package, which is not
// vendored in this standalone repo. This placeholder lets the engine crate compile
// (the `include_str!` in `frontend/embedding.rs` needs a file to exist); the V8-host
// AUTHORING tests that actually evaluate this module are gated behind `v8-host` and
// require the real bundle. See the repo README (V8-host authoring: partial).
export function lintDeterminism() { return []; }
export default {};
