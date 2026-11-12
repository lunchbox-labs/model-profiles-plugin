import { defineConfig } from "tsdown";

// Builds the host package in the current directory (packages/opencode or
// packages/kilo; each one's build script points here). Each export entry gets
// dist/<entry>.js and dist/<entry>.d.ts, with the private core inlined. Code
// both entries use, the core included, goes to one shared chunk, as tsc's
// per-file output did, so the server and TUI entries share one copy of the
// core's module state.
export default defineConfig({
  // Entries and package.json are read from the package being built, not from
  // this file's directory.
  cwd: process.cwd(),
  entry: { server: "src/server.ts", tui: "src/tui.ts" },
  outDir: "dist",
  clean: true,
  format: "esm",
  platform: "node",
  // The packages' engines floor.
  target: "node22.18",
  fixedExtension: false,
  hash: false,
  minify: false,
  sourcemap: false,
  dts: true,
  deps: {
    // Every package import stays an import, as written, except the core's.
    neverBundle: true,
    alwaysBundle: ["@lunchbox-labs/model-profiles-core"],
    // Fails the build if anything from node_modules ends up inlined. The core
    // resolves through its workspace link to packages/core, not node_modules.
    onlyBundle: [],
    dts: {
      neverBundle: true,
      alwaysBundle: ["@lunchbox-labs/model-profiles-core"],
    },
  },
});
