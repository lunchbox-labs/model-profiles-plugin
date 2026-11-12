import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, posix } from "node:path";
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
  private?: boolean;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
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
      "--workspace",
      "packages/opencode",
      "--workspace",
      "packages/kilo",
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

test("the workspace packs both host packages at one version and never the private core", async () => {
  assert.equal(core.private, true);
  const names = [];
  for (const host of hosts) {
    const manifest = await manifestOf(join(workspaceRoot, host.workspace));
    assert.equal(manifest.version, core.version, manifest.name);
    names.push(manifest.name);
  }
  assert.deepEqual([...tarballs.keys()].sort(), names.sort());
});

/** Every file under a directory, as forward-slash paths relative to it. */
async function filesUnder(directory: string): Promise<string[]> {
  const entries = await readdir(directory, {
    recursive: true,
    withFileTypes: true,
  });
  return entries
    .filter((entry) => entry.isFile())
    .map((entry) =>
      join(entry.parentPath, entry.name)
        .slice(directory.length + 1)
        .replaceAll("\\", "/"),
    );
}

/** The package names a module imports, without relative and node: imports. */
function importedPackages(text: string): string[] {
  const specifiers = [
    ...text.matchAll(/\b(?:from|import\(|import)\s*["']([^"']+)["']/g),
  ].map(([, specifier]) => specifier);
  return specifiers
    .filter(
      (specifier) =>
        !specifier.startsWith(".") && !specifier.startsWith("node:"),
    )
    .map((specifier) =>
      specifier
        .split("/")
        .slice(0, specifier.startsWith("@") ? 2 : 1)
        .join("/"),
    );
}

for (const host of hosts) {
  test(
    `the packed ${host.label} plugin bundles the core, installs alone and exposes loadable server and TUI entries with declarations`,
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
// The package declares each entry's id as a string, as it always has.
const ids: string[] = [root.id, server.id, tui.id];
console.log(rootModule.id, serverModule.id, tuiModule.id, ids);
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
      const installedRoot = join(root, "node_modules", name);
      const installed = await manifestOf(installedRoot);
      // The core is inlined, so the package installs only its runtime
      // dependencies, at the core's ranges.
      assert.deepEqual(installed.dependencies, core.dependencies);
      for (const field of [
        "dependencies",
        "peerDependencies",
        "optionalDependencies",
      ] as const) {
        assert.equal(
          Object.hasOwn(installed[field] ?? {}, core.name),
          false,
          field,
        );
      }
      assert.equal(installed.peerDependencies, undefined);
      assert.equal(Object.hasOwn(installed.engines ?? {}, "opencode"), false);
      assert.equal(Object.hasOwn(installed.engines ?? {}, "kilo"), false);
      assert.equal(installed.engines?.node, ">=22.18.0");
      await assert.rejects(
        readFile(join(root, "node_modules", core.name, "package.json")),
        { code: "ENOENT" },
        "the core is never installed",
      );
      // Only the host's own plugin types, installed above for the type check,
      // come from @opencode-ai.
      const installedPlugins = await manifestOf(
        join(root, "node_modules", "@opencode-ai", "plugin"),
      ).catch(() => undefined);
      assert.equal(
        installedPlugins !== undefined,
        host.plugin === "@opencode-ai/plugin",
      );

      // What the build bundled and what it left as imports.
      const packedFiles = await filesUnder(installedRoot);
      assert.deepEqual(packedFiles.sort(), [...packedPlugin.paths].sort());
      const runtime = new Set(Object.keys(installed.dependencies ?? {}));
      const coreModules = new Map<string, string>();
      for (const file of packedFiles) {
        const text = await readFile(join(installedRoot, file), "utf8");
        assert.equal(text.includes(core.name), false, `${file} names the core`);
        assert.ok(
          !file.startsWith("dist/") || !text.includes("node_modules"),
          `${file} holds code from node_modules`,
        );
        if (file.endsWith(".d.ts")) {
          for (const imported of importedPackages(text)) {
            assert.equal(imported, host.plugin, `${file} imports ${imported}`);
          }
        } else if (file.endsWith(".js")) {
          for (const imported of importedPackages(text)) {
            assert.ok(runtime.has(imported), `${file} imports ${imported}`);
          }
          // The build marks each inlined module with its source path.
          const modules = [
            ...text.matchAll(/^\/\/(?:#region)? (\S+\.ts)$/gm),
          ].map(([, source]) => posix.normalize(source.replaceAll("\\", "/")));
          for (const source of modules) {
            assert.match(source, /^(?:src|\.\.\/core\/src)\//, file);
            if (source.startsWith("../core/")) {
              assert.equal(
                coreModules.get(source) ?? file,
                file,
                `${source} is in two files`,
              );
              coreModules.set(source, file);
            }
          }
        }
      }
      // The core is inlined once, in a chunk both entries import, so the
      // server and TUI entries share its module state.
      assert.ok(coreModules.has("../core/src/server.ts"));
      assert.ok(coreModules.has("../core/src/tui.ts"));
      assert.equal(new Set(coreModules.values()).size, 1);
      const [chunk] = coreModules.values();
      for (const entry of ["dist/server.js", "dist/tui.js"]) {
        const text = await readFile(join(installedRoot, entry), "utf8");
        assert.ok(
          text.includes(`"./${posix.basename(chunk)}"`),
          `${entry} imports the core's chunk`,
        );
      }
    },
  );
}
