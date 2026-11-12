import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execute = promisify(execFile);
const npm = process.env.npm_execpath;
assert.ok(npm !== undefined, "Run package tests through npm");
const workspaceRoot = fileURLToPath(new URL("../", import.meta.url));

interface Manifest {
  name: string;
  version: string;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  engines?: Record<string, string>;
}

async function manifestOf(directory: string): Promise<Manifest> {
  return JSON.parse(
    await readFile(join(directory, "package.json"), "utf8"),
  ) as Manifest;
}

const core = await manifestOf(join(workspaceRoot, "packages/core"));

const hosts = [
  {
    workspace: "packages/opencode",
    label: "OpenCode",
    plugin: "@opencode-ai/plugin",
    title: "OpenCode Model Profiles",
    builtins: [
      "build",
      "compaction",
      "explore",
      "general",
      "plan",
      "summary",
      "title",
    ],
  },
  {
    workspace: "packages/kilo",
    label: "Kilo",
    plugin: "@kilocode/plugin",
    title: "Kilo Model Profiles",
    builtins: [
      "ask",
      "build",
      "code",
      "compaction",
      "debug",
      "explore",
      "general",
      "orchestrator",
      "plan",
      "scout",
      "summary",
      "title",
    ],
  },
];

let packed = "";
const tarballs = new Map<string, { filename: string; paths: string[] }>();

before(async () => {
  packed = await mkdtemp(join(tmpdir(), "model-profiles-packed-"));
  const { stdout } = await execute(
    process.execPath,
    [
      npm,
      "pack",
      "--workspaces",
      "--ignore-scripts",
      "--json",
      "--pack-destination",
      packed,
    ],
    { cwd: workspaceRoot, timeout: 60_000 },
  );
  for (const { name, filename, files } of JSON.parse(stdout) as {
    name: string;
    filename: string;
    files: { path: string }[];
  }[]) {
    tarballs.set(name, { filename, paths: files.map((file) => file.path) });
  }
});

after(() => rm(packed, { recursive: true, force: true }));

function tarball(name: string): { file: string; paths: string[] } {
  const entry = tarballs.get(name);
  assert.ok(entry !== undefined, `${name} was not packed`);
  return { file: join(packed, entry.filename), paths: entry.paths };
}

function assertOnlyPacked(paths: string[], files: string[]): void {
  for (const path of files) {
    assert.ok(paths.includes(path), `Missing ${path}`);
  }
  for (const path of paths) {
    assert.ok(
      path.startsWith("dist/") ||
        ["README.md", "LICENSE", "package.json", ...files].includes(path),
      `Unexpected packed file: ${path}`,
    );
  }
}

test("the workspace packs the core and both host packages at one version", async () => {
  const names = [core.name];
  for (const host of hosts) {
    const manifest = await manifestOf(join(workspaceRoot, host.workspace));
    assert.equal(manifest.version, core.version, manifest.name);
    names.push(manifest.name);
  }
  assert.deepEqual([...tarballs.keys()].sort(), names.sort());
  assertOnlyPacked(tarball(core.name).paths, [
    "dist/index.js",
    "dist/index.d.ts",
    "README.md",
    "LICENSE",
    "package.json",
  ]);
});

for (const host of hosts) {
  test(
    `the packed ${host.label} plugin installs with the packed core and exposes loadable server and TUI entries with declarations`,
    { timeout: 180_000 },
    async (t) => {
      const manifest = await manifestOf(join(workspaceRoot, host.workspace));
      const { name } = manifest;
      const packedPlugin = tarball(name);
      assertOnlyPacked(packedPlugin.paths, [
        "dist/server.js",
        "dist/server.d.ts",
        "dist/tui.js",
        "dist/tui.d.ts",
        "schema.json",
        "README.md",
        "LICENSE",
        "package.json",
      ]);
      const root = await mkdtemp(join(tmpdir(), "model-profiles-package-"));
      t.after(() => rm(root, { recursive: true, force: true }));
      const pluginVersion = manifest.devDependencies?.[host.plugin];
      const nodeTypes = (await manifestOf(workspaceRoot)).devDependencies?.[
        "@types/node"
      ];
      assert.ok(pluginVersion !== undefined && nodeTypes !== undefined);
      await execute(
        process.execPath,
        [
          npm,
          "install",
          "--prefix",
          root,
          "--ignore-scripts",
          "--no-audit",
          "--no-fund",
          tarball(core.name).file,
          packedPlugin.file,
          `${host.plugin}@${pluginVersion}`,
          `@types/node@${nodeTypes}`,
        ],
        { timeout: 120_000, signal: t.signal },
      );
      await writeFile(
        join(root, "consumer.mjs"),
        `import assert from 'node:assert/strict';
import root from '${name}';
import server from '${name}/server';
import tui from '${name}/tui';
import { createRequire } from 'node:module';
const schema = createRequire(import.meta.url)('${name}/schema.json');
assert.equal(schema.title, '${host.title}');
assert.equal(schema.$id, 'https://cdn.jsdelivr.net/npm/${name}/schema.json');
assert.deepEqual(Object.keys(schema.properties.builtins.properties).sort(), ${JSON.stringify(host.builtins)});
assert.equal(root, server, 'the root export is the server entry');
assert.equal(server.id, 'model-profiles');
assert.equal(typeof server.server, 'function');
assert.equal(Object.hasOwn(server, 'tui'), false);
assert.equal(typeof (await server.server({}, {})), 'object');
assert.equal(tui.id, 'model-profiles');
assert.equal(typeof tui.tui, 'function');
assert.equal(Object.hasOwn(tui, 'server'), false);
const commands = [];
const api = {
  state: {
    provider: [],
    path: { directory: process.cwd(), worktree: process.cwd() },
  },
  client: { config: { get: async () => ({ data: {} }) } },
  keymap: { registerLayer: (layer) => { commands.push(...layer.commands); return () => {}; } },
  event: { on: () => () => {} },
  lifecycle: { onDispose: () => () => {} },
  ui: { toast: () => {} },
};
await tui.tui(api, undefined, {});
assert.deepEqual(commands.map((command) => command.slashName), ['model-config']);
`,
      );
      await execute(process.execPath, [join(root, "consumer.mjs")], {
        cwd: root,
        timeout: 60_000,
        signal: t.signal,
      });
      await writeFile(
        join(root, "consumer.mts"),
        `import type { PluginModule } from '${host.plugin}';
import type { TuiPluginModule } from '${host.plugin}/tui';
import root from '${name}';
import server from '${name}/server';
import tui from '${name}/tui';
const rootModule: PluginModule = root;
const serverModule: PluginModule = server;
const tuiModule: TuiPluginModule = tui;
console.log(rootModule.id, serverModule.id, tuiModule.id);
`,
      );
      await execute(
        process.execPath,
        [
          join(workspaceRoot, "node_modules/typescript/bin/tsc"),
          "--noEmit",
          "--strict",
          "--skipLibCheck",
          "--module",
          "NodeNext",
          "--target",
          "ES2023",
          join(root, "consumer.mts"),
        ],
        { cwd: root, timeout: 60_000, signal: t.signal },
      );
      const installed = await manifestOf(join(root, "node_modules", name));
      assert.deepEqual(installed.dependencies, { [core.name]: core.version });
      assert.equal(Object.hasOwn(installed.engines ?? {}, "opencode"), false);
      assert.equal(Object.hasOwn(installed.engines ?? {}, "kilo"), false);
      assert.equal(installed.engines?.node, ">=22.18.0");
      const installedCore = await manifestOf(
        join(root, "node_modules", core.name),
      );
      assert.deepEqual(Object.keys(installedCore.dependencies ?? {}), [
        "jsonc-parser",
      ]);
      assert.equal(installedCore.engines?.node, ">=22.18.0");
      // The core's declarations reference OpenCode's types without installing them.
      const installedPlugins = await manifestOf(
        join(root, "node_modules", "@opencode-ai", "plugin"),
      ).catch(() => undefined);
      assert.equal(
        installedPlugins !== undefined,
        host.plugin === "@opencode-ai/plugin",
      );
    },
  );
}
