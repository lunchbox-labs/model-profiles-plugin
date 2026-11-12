import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { parse } from "jsonc-parser";

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

test("the package bundles the private core and depends on the core's runtime dependencies itself", async () => {
  const core = JSON.parse(
    await readFile(new URL("../../core/package.json", import.meta.url), "utf8"),
  );
  const coreName = "@lunchbox-labs/model-profiles-core";
  assert.equal(core.name, coreName);
  assert.equal(core.private, true);
  assert.equal(core.version, manifest.version);
  // The build inlines the core through the link npm makes for every
  // workspace package, so the published manifest never names it.
  for (const field of [
    "dependencies",
    "devDependencies",
    "peerDependencies",
    "optionalDependencies",
  ]) {
    assert.equal(Object.hasOwn(manifest[field] ?? {}, coreName), false, field);
    assert.equal(
      Object.hasOwn(lock.packages[workspace][field] ?? {}, coreName),
      false,
      field,
    );
  }
  // The bundle imports the core's runtime dependencies, so the package
  // installs them, each at the core's range.
  assert.deepEqual(manifest.dependencies, core.dependencies);
  for (const [name, range] of Object.entries(manifest.dependencies)) {
    assert.match(range, /^[\^~]\d+\.\d+\.\d+$/, name);
    assert.equal(
      resolved(name).version.split(".")[0],
      range.slice(1).split(".")[0],
      name,
    );
  }
  // An optional peer pinned to a host range would block installs next to a
  // newer host, so neither the package nor the core names one.
  for (const field of ["peerDependencies", "peerDependenciesMeta"]) {
    assert.equal(Object.hasOwn(manifest, field), false, field);
    assert.equal(Object.hasOwn(core, field), false, field);
  }
});

test("the core typecheck against Kilo's types maps each host type to the version this package pins", async () => {
  const config = new URL("../tsconfig.core.json", import.meta.url);
  const { paths } = parse(await readFile(config, "utf8")).compilerOptions;
  const pinned = {
    "@opencode-ai/plugin": "@kilocode/plugin",
    "@opencode-ai/plugin/tui": "@kilocode/plugin",
    "@opentui/core": "@opentui/core",
    "@opentui/keymap": "@opentui/keymap",
    "@opentui/keymap/extras": "@opentui/keymap",
    "@opentui/solid": "@opentui/solid",
  };
  assert.deepEqual(Object.keys(paths).sort(), Object.keys(pinned).sort());
  for (const [name, [target]] of Object.entries(paths)) {
    const file = new URL(target, config);
    await readFile(file);
    // Walk up from the mapped declaration file to its package's manifest.
    let directory = dirname(fileURLToPath(file));
    let owner;
    while (owner === undefined) {
      try {
        const candidate = JSON.parse(
          await readFile(`${directory}/package.json`, "utf8"),
        );
        if (candidate.name !== undefined) {
          owner = candidate;
        }
      } catch {
        // No manifest here; keep walking up.
      }
      const parent = dirname(directory);
      assert.notEqual(parent, directory, `No package owns ${target}`);
      directory = parent;
    }
    assert.equal(owner.name, pinned[name], name);
    assert.equal(owner.version, manifest.devDependencies[pinned[name]], name);
  }
});
