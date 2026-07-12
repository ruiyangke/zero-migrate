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
    // The host runtime entry (`.`): the facade over the prebuilt N-API addon +
    // the pg/mysql2 driver adapters. `pg`/`mysql2` are optionalDependencies
    // resolved at runtime — external so the bundle never inlines them; the addon
    // is loaded via `createRequire` at runtime (a `.node`), never bundled. The
    // authoring DSL + pure-JS recorder live in the separate `zero-migrate` package
    // (imported here, also external).
    entry: {
      index: "src/index.ts",
    },
    external: ["pg", "mysql2", "mysql2/promise", "zero-migrate"],
    clean: true,
  },
]);
