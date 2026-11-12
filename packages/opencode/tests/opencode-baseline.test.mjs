import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

const lock = JSON.parse(
  await readFile(
    new URL("../../../package-lock.json", import.meta.url),
    "utf8",
  ),
);
const manifest = JSON.parse(
  await readFile(new URL("../package.json", import.meta.url), "utf8"),
);
const workspace = "packages/opencode";

/** The lockfile entry Node resolves from this package: its own node_modules first, then the hoisted copy. */
const resolved = (name) =>
  lock.packages[`${workspace}/node_modules/${name}`] ??
  lock.packages[`node_modules/${name}`];

test("published package has no OpenCode engine gate and retains the Node requirement", () => {
  assert.equal(Object.hasOwn(manifest.engines, "opencode"), false);
  assert.equal(manifest.engines.node, ">=22.18.0");
  assert.equal(
    Object.hasOwn(lock.packages[workspace].engines, "opencode"),
    false,
  );
  assert.equal(lock.packages[workspace].engines.node, manifest.engines.node);
});

test("SDK and plugin build dependencies share one exact version within the supported host range", async () => {
  const support = JSON.parse(
    await readFile(new URL("./opencode.json", import.meta.url), "utf8"),
  );
  const plugin = manifest.devDependencies["@opencode-ai/plugin"];
  assert.equal(manifest.devDependencies["@opencode-ai/sdk"], plugin);
  for (const name of ["@opencode-ai/plugin", "@opencode-ai/sdk"]) {
    assert.equal(resolved(name).version, plugin, name);
  }
  assert.match(plugin, /^\d+\.\d+\.\d+$/);
  const [major, minor, patch] = plugin.split(".").map(Number);
  const [floorMajor, floorMinor, floorPatch] = support.floor
    .split(".")
    .map(Number);
  assert.equal(`${major}.${minor}.x`, support.range);
  assert.ok(
    major === floorMajor && minor === floorMinor && patch >= floorPatch,
    `${plugin} is below the supported floor ${support.floor}`,
  );
});

test("TUI dev dependencies match the copies every supported OpenCode host loads", () => {
  // OpenCode 1.19.x maps a plugin's @opentui/* and solid-js imports to its own
  // bundled copies (@opentui 0.4.5 and a patched solid-js 1.9.10). Building
  // against newer releases would let code use APIs no supported host provides.
  // solid-js stays at 1.9.12, the exact peer of @opentui 0.4.5.
  for (const name of ["@opentui/core", "@opentui/keymap", "@opentui/solid"]) {
    assert.equal(manifest.devDependencies[name], "0.4.5", name);
    assert.equal(resolved(name).version, "0.4.5", name);
  }
  assert.equal(manifest.devDependencies["solid-js"], "1.9.12");
  assert.equal(resolved("solid-js").version, "1.9.12");
});

test("the core builds against the same OpenCode and TUI types as this package", async () => {
  const core = JSON.parse(
    await readFile(new URL("../../core/package.json", import.meta.url), "utf8"),
  );
  for (const [name, version] of Object.entries(core.devDependencies)) {
    assert.equal(manifest.devDependencies[name], version, name);
  }
  assert.equal(
    manifest.dependencies["@lunchbox-labs/model-profiles-core"],
    core.version,
  );
});
