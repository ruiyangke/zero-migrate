import { defineConfig, type Options } from "tsup";

const shared = {
  format: ["esm"],
  dts: true,
  target: "es2022",
  outDir: "dist",
  sourcemap: true,
  treeshake: true,
  splitting: true,
} satisfies Options;

export default defineConfig([
  {
    ...shared,
    // The public DSL entry (`.`) + the HOST facade (`./host`, §D.3) + the pure-JS
    // host recorder (`./host-recorder`, §D.1). `pg`/`mysql2` are optionalDependencies
    // resolved at runtime — external so the bundle never inlines them; the addon is
    // loaded via `createRequire` at runtime (a `.node`), never bundled.
    entry: {
      index: "src/index.ts",
      host: "src/host/index.ts",
      "host-recorder": "src/host-recorder.ts",
    },
    external: ["pg", "mysql2", "mysql2/promise"],
    clean: true,
  },
  // The recorder artifact (DSL redesign S0.5): ONE self-contained ESM file
  // exposing the FULL recorder surface — the internal recorder seam
  // (`__begin`/`__drain`), the producer census (`opProducers`), the value-position
  // `cCase` helper, the internal `__pgDomain`/`__pgSequence` handles, AND the whole
  // public vendor surface — in one module. The SDK's recorder-internal tests import
  // it (`tests/{ops,sequences-exclusion,column-facets-lockstep}.test.ts`). No
  // code-splitting (single file), no `.d.ts` (build artifact only). The inlined db
  // type-builder (`./db-types.ts`) is bundled in — there is no external db dep.
  {
    ...shared,
    entry: { "embedded-recorder": "src/embedded-recorder.ts" },
    splitting: false,
    dts: false,
    clean: false,
  },
]);
