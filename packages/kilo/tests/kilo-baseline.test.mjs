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
const workspace = "packages/kilo";

/** The lockfile entry Node resolves from this package: its own node_modules first, then the hoisted copy. */
const resolved = (name) =>
  lock.packages[`${workspace}/node_modules/${name}`] ??
  lock.packages[`node_modules/${name}`];

test("published package has no Kilo engine gate and retains the Node requirement", () => {
  assert.equal(Object.hasOwn(manifest.engines, "kilo"), false);
  assert.equal(manifest.engines.node, ">=22.18.0");
  assert.equal(Object.hasOwn(lock.packages[workspace].engines, "kilo"), false);
  assert.equal(lock.packages[workspace].engines.node, manifest.engines.node);
});

test("SDK and plugin build dependencies share one exact version within the supported host range", async () => {
  const support = JSON.parse(
    await readFile(new URL("./kilo.json", import.meta.url), "utf8"),
  );
  const plugin = manifest.devDependencies["@kilocode/plugin"];
  assert.equal(manifest.devDependencies["@kilocode/sdk"], plugin);
  for (const name of ["@kilocode/plugin", "@kilocode/sdk"]) {
    assert.equal(resolved(name).version, plugin, name);
  }
  assert.match(plugin, /^\d+\.\d+\.\d+$/);
  const version = (text) => text.split(".").map(Number);
  const compare = (left, right) =>
    left.reduce((order, part, index) => order || part - right[index], 0);
  const [, lowest, below] = /^>=(\S+) <(\S+)$/.exec(support.range);
  assert.equal(lowest, support.floor);
  assert.ok(
    compare(version(plugin), version(lowest)) >= 0 &&
      compare(version(plugin), version(below)) < 0,
    `${plugin} is outside the supported range ${support.range}`,
  );
});

test("TUI dev dependencies match the copies every supported Kilo host loads", () => {
  // Kilo 7.8.x maps a plugin's @opentui/* and solid-js imports to its own
  // bundled copies (@opentui 0.5.11 and a patched solid-js 1.9.12). Building
  // against newer releases would let code use APIs no supported host provides.
  // solid-js stays at 1.9.12, the exact peer of @opentui 0.5.11.
  for (const name of ["@opentui/core", "@opentui/keymap", "@opentui/solid"]) {
    assert.equal(manifest.devDependencies[name], "0.5.11", name);
    assert.equal(resolved(name).version, "0.5.11", name);
  }
  assert.equal(manifest.devDependencies["solid-js"], "1.9.12");
  assert.equal(resolved("solid-js").version, "1.9.12");
});

test("the package depends on the core at its own version", async () => {
  const core = JSON.parse(
    await readFile(new URL("../../core/package.json", import.meta.url), "utf8"),
  );
  assert.deepEqual(manifest.dependencies, {
    "@lunchbox-labs/model-profiles-core": manifest.version,
  });
  assert.equal(core.version, manifest.version);
});
