// PLACEHOLDER @zeroship/db bundle.
//
// The real artifact is the built `@zeroship/db` schema DSL (`t.*` builders +
// `TypeBuilder.toFieldDef()`), consumed by the migrate JS authoring front-end. It is
// not vendored in this standalone repo. This placeholder lets the engine crate
// compile; the V8-host authoring tests that evaluate this module require the real
// bundle. See the repo README (V8-host authoring: partial).
export const t = {};
export class TypeBuilder {}
export function schema(x) { return x; }
export default {};
